/**
 * Shared harness for the synthetics-recorder extension tests.
 *
 * Everything here drives the REAL extension in a REAL headed Chrome over the same
 * `window.postMessage` bridge the O2 web app uses. Nothing fakes a chrome.* API: the
 * whole point of these tests is to prove the extension works against a real browser,
 * which is what the Playwright 1.54 upgrade needed and what a fake could not have shown.
 *
 * It exists because the bridge plumbing was copy-pasted into four spec files — the same
 * `sendCommand` byte-for-byte, plus 35-172 lines of preamble each. A harness fix had to be
 * applied four times, and the cold-service-worker retry only ever made it into one of them.
 */

import path from 'path';
import type { Page } from '@playwright/test';
import { test as crxTest, expect } from './crxTest';

export const SYNTHETICS_EXTENSION_PATH = path.join(
    __dirname, '..', '..', 'examples', 'synthetics-recorder', 'dist');

/**
 * A recorded step as the O2 page receives it.
 *
 * Declared structurally rather than imported from `playwright-crx`: `BrowserStep` is a runtime
 * export with no type declaration today (one of the gaps the test-strategy doc tracks). When
 * that is fixed, this becomes `import type { BrowserStep }` plus the locator refinement.
 */
export type RecordedStep = {
  id: string;
  action: string;
  name?: string;
  url?: string;
  value?: string;
  startTime?: number;
  endTime?: number;
  pageAlias?: string;
  framePath?: string[];
  locator?: { candidates: Array<{ kind: string; value: string; origin?: string }> };
  settle?: {
    navigation?: { url_pattern: string };
    responses?: Array<{ url_pattern: string; method?: string; required: boolean }>;
    observed_duration_ms?: number;
  };
  [k: string]: unknown;
};

/**
 * Find a recorded step by any of its locator candidates.
 *
 * v2 replaced the bare `selector`/`selector_type` pair with the ranked `locator` bundle, so a
 * step is identified by what its candidates point at. Tests that still look up `step.selector`
 * silently match nothing — the field is never emitted.
 */
export function findStep(steps: RecordedStep[], needle: string): RecordedStep | undefined {
  return steps.find(s => s.locator?.candidates?.some(c => c.value.includes(needle)));
}

/** The candidate values of each step — for a readable failure message. */
export function describeSteps(steps: RecordedStep[]): string {
  return JSON.stringify(steps.map(s => s.locator?.candidates?.[0]?.value ?? s.action));
}

/** A payload the extension pushed over the bridge, as the O2 page sees it. */
export type PushedPayload = { method: string } & Record<string, any>;

/**
 * The O2 web app's side of the bridge.
 *
 * Bound to the `page` fixture, which stands in for the O2 tab in every synthetics spec.
 */
export interface O2Bridge {
  /** Send one command and wait for its nonce-correlated reply. Null on timeout. */
  send<T>(command: unknown, timeoutMs?: number): Promise<T | null>;
  /**
   * Start recording, tolerating a service worker that is still waking up.
   *
   * The worker spins up on demand and the first command can land before the bridge port is
   * open. That is a harness race, not a product one — a person clicking "Record" just clicks
   * again — so this retries rather than asserting on a cold start.
   */
  startRecording(targetUrl: string, options?: { mode?: string; testIdAttr?: string }): Promise<void>;
  stopRecording(): Promise<void>;
  getStatus<T = { isRecording: boolean; tabId?: number }>(): Promise<T | null>;
  replay<T>(steps: RecordedStep[], options?: { targetUrl?: string; testIdAttr?: string; auth?: unknown; headers?: unknown; cookies?: unknown }): Promise<T | null>;
  stopReplay(): Promise<void>;
  /** Begin capturing what the extension pushes. Call before starting a recording. */
  listen(): Promise<void>;
  /** The latest `setActions` step list. `listen()` must have been called. */
  steps(): Promise<RecordedStep[]>;
  /** Every payload pushed since `listen()`, in order — for asserting the protocol itself. */
  pushes(): Promise<PushedPayload[]>;
  /** Wait until the pushed steps satisfy `predicate`, or throw after `timeoutMs`. */
  waitForSteps(predicate: (steps: RecordedStep[]) => boolean, timeoutMs?: number): Promise<RecordedStep[]>;
  /** Wait for a pushed payload matching `predicate` (e.g. a stepReplayResult). */
  waitForPush(predicate: (p: PushedPayload) => boolean, timeoutMs?: number): Promise<PushedPayload>;
  /** The tab the extension opened for recording. */
  recordingTab(urlPart: string, timeoutMs?: number): Promise<Page>;
}

function createBridge(page: Page, context: any): O2Bridge {
  const send = async <T>(command: unknown, timeoutMs = 60_000): Promise<T | null> => {
    return page.evaluate(
        async ({ command, timeoutMs }: any) => {
          window.postMessage({ ch: 'oo-bridge-probe' }, '*');
          await new Promise(r => setTimeout(r, 500));

          const nonce = `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
          return await new Promise(resolve => {
            const timer = setTimeout(() => {
              window.removeEventListener('message', onMessage);
              resolve(null);
            }, timeoutMs);
            function onMessage(event: MessageEvent) {
              if (event.source !== window) return;
              if (event.data?.ch !== 'oo-bridge' || event.data?.dir !== 'to-page') return;
              const { nonce: got, msg } = event.data;
              if (got !== nonce && msg?.nonce !== nonce) return;
              clearTimeout(timer);
              window.removeEventListener('message', onMessage);
              resolve(msg?.response ?? msg);
            }
            window.addEventListener('message', onMessage);
            window.postMessage(
                { ch: 'oo-bridge', dir: 'to-ext', nonce, msg: { type: 'synthetics-command', command } },
                '*');
          });
        },
        { command, timeoutMs });
  };

  const listen = async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.__recordedSteps = [];
      w.__pushes = [];
      // Registered once per page; a second listen() would double-count pushes.
      if (w.__ooBridgeListening)
        return;
      w.__ooBridgeListening = true;
      window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.data?.ch !== 'oo-bridge' || event.data?.dir !== 'to-page') return;
        const payload = event.data?.msg?.payload;
        if (!payload?.method) return;
        w.__pushes.push(payload);
        if (payload.method === 'setActions' && Array.isArray(payload.browserSteps))
          w.__recordedSteps = payload.browserSteps;
      });
      window.postMessage({ ch: 'oo-bridge-probe' }, '*');
    });
  };

  const steps = async (): Promise<RecordedStep[]> =>
    page.evaluate(() => (window as any).__recordedSteps ?? []);

  const pushes = async (): Promise<PushedPayload[]> =>
    page.evaluate(() => (window as any).__pushes ?? []);

  const waitForSteps = async (predicate: (s: RecordedStep[]) => boolean, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last: RecordedStep[] = [];
    while (Date.now() < deadline) {
      last = await steps();
      if (predicate(last))
        return last;
      await page.waitForTimeout(250);
    }
    throw new Error(`waitForSteps timed out after ${timeoutMs}ms; last steps: ${JSON.stringify(last.map(s => s.name))}`);
  };

  const waitForPush = async (predicate: (p: PushedPayload) => boolean, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let seen: PushedPayload[] = [];
    while (Date.now() < deadline) {
      seen = await pushes();
      const hit = seen.find(predicate);
      if (hit)
        return hit;
      await page.waitForTimeout(250);
    }
    throw new Error(`waitForPush timed out after ${timeoutMs}ms; saw methods: ${JSON.stringify(seen.map(p => p.method))}`);
  };

  return {
    send,
    listen,
    steps,
    pushes,
    waitForSteps,
    waitForPush,

    async startRecording(targetUrl: string, options?: { mode?: string; testIdAttr?: string }) {
      let last: { success: boolean; error?: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        last = await send<{ success: boolean; error?: string }>({
          action: 'startRecording',
          mode: options?.mode ?? 'recording',
          testIdAttr: options?.testIdAttr ?? 'data-test',
          targetUrl,
        });
        if (last?.success)
          return;
        await page.waitForTimeout(1_000);
      }
      throw new Error(`startRecording never succeeded: ${last?.error ?? '(no response — is examples/synthetics-recorder/dist built?)'}`);
    },

    async stopRecording() {
      await send({ action: 'stopRecording' });
    },

    async getStatus<T>() {
      return send<T>({ action: 'getStatus' }, 20_000);
    },

    async replay<T>(steps: RecordedStep[], options?: Record<string, unknown>) {
      return send<T>({ action: 'replay', steps, ...options }, 120_000);
    },

    async stopReplay() {
      await send({ action: 'stopReplay' }, 30_000);
    },

    async recordingTab(urlPart: string, timeoutMs = 30_000) {
      const existing = context.pages().find((p: Page) => p.url().includes(urlPart));
      if (existing)
        return existing;
      const opened = await context.waitForEvent('page', {
        predicate: (p: Page) => p.url().includes(urlPart),
        timeout: timeoutMs,
      }).catch(() => context.pages().find((p: Page) => p.url().includes(urlPart)));
      if (!opened)
        throw new Error(`the extension never opened a tab matching "${urlPart}"`);
      await opened.waitForLoadState('domcontentloaded');
      return opened;
    },
  };
}

export const test = crxTest.extend<{ o2: O2Bridge }>({
  // Plain override of crxTest's `extensionPath` option: every spec built on this
  // fixture drives the synthetics extension.
  extensionPath: SYNTHETICS_EXTENSION_PATH,

  o2: async ({ page, context }, run) => {
    await run(createBridge(page, context));
  },
});

export { expect };
