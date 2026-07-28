/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Recording which API calls a step caused, so the probe can wait for them.
 *
 * The failure class this addresses: an element is momentarily actionable BEFORE
 * hydration completes, the click lands on a page that is not ready, and a step
 * three later fails somewhere far from the cause. Waiting on the application's
 * own network activity is what the in-house Playwright suite already does by
 * hand; this records the evidence needed to do it automatically.
 *
 * Two constraints shape the filtering:
 *
 *  - **Nothing sensitive is ever recorded** (X-4). Request bodies are not read
 *    at all, and query strings are stripped before a URL becomes a pattern —
 *    that is where session tokens and customer identifiers live.
 *
 *  - **Over-capture is worse than under-capture** (R4.a). Every extra pattern is
 *    a signal that can go stale, and annotation noise teaches authors to ignore
 *    annotations. So the filter is a deny-list plus a content-type test plus a
 *    same-site test plus a hard cap, and the recorder always emits
 *    `required: false` — escalating a signal is an author's judgement about the
 *    application, not something a recording can observe.
 */

import { generalizeEndpointPattern, patternWildcardCount } from './urlPattern';

export type CapturedResponse = {
  url: string;
  method: string;
  status: number;
  contentType: string;
  /** When the response arrived, so it can be attributed to an action window. */
  timestamp: number;
  /**
   * When the REQUEST began.
   *
   * A response that arrived inside an action's window is not necessarily caused
   * by it: a call that normally fires before the action, delayed during
   * recording, lands in the window and is stored as that step's signal. On
   * replay the probe arms its watcher at the start of the step, the call has
   * already fired during the PREVIOUS step, and the signal is reported stale on
   * every run forever — burning the full settle budget each time and poisoning
   * the failure attribution of the next real failure.
   *
   * Optional so an older caller that does not supply it keeps today's behaviour
   * rather than having every response silently discarded.
   */
  initiatedAt?: number;
};

/**
 * A stretch of the recording when nothing the author did was in flight.
 *
 * The complement of the action windows. Anything observed here is background —
 * polling, telemetry, websocket keepalives, token refresh — regardless of how
 * many action windows it also appears in.
 */
export type IdleWindow = { start: number; end: number };

export type SettleResponsePattern = {
  url_pattern: string;
  method?: string;
  /** Always false from the recorder — see P4.1.5. */
  required: boolean;
};

/** Never useful as a settle signal, and always present. */
const STATIC_EXTENSIONS = [
  '.js', '.mjs', '.css', '.map',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3', '.wav',
];

/**
 * Hosts and paths that are telemetry rather than application behaviour.
 *
 * A beacon firing is not evidence the page is ready — analytics deliberately
 * fire early and are deliberately unreliable, so waiting on one would be waiting
 * on the least dependable request the page makes.
 */
const DENY_SUBSTRINGS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com',
  'sentry.io', 'bugsnag.com', 'datadoghq.com', 'newrelic.com',
  'hotjar.com', 'fullstory.com', 'intercom.io', 'facebook.net',
  '/collect', '/beacon', '/telemetry', '/analytics', '/rum',
];

const ACCEPTED_CONTENT_TYPES = [
  'application/json',
  'application/ld+json',
  'text/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'application/graphql',
];

/** ≤ 5 patterns per step (P4.1.6) — the same cap the schema enforces. */
export const MAX_SETTLE_PATTERNS = 5;

/**
 * The registrable-domain approximation (Q-2, assumption taken).
 *
 * Strictly correct same-site matching needs a public suffix list, which would
 * add meaningful weight to an extension for a case that barely arises: a
 * monitored journey's API calls are on its own origin or a subdomain of it.
 * Exact host or a dot-suffix of the recorded host covers that without shipping a
 * PSL, and errs toward capturing less rather than capturing a third party.
 */
export function isSameSite(pageUrl: string, requestUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const request = new URL(requestUrl);
    if (page.host === request.host)
      return true;
    return request.hostname.endsWith(`.${page.hostname}`) || page.hostname.endsWith(`.${request.hostname}`);
  } catch {
    return false;
  }
}

export function isStaticAsset(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return true;
  }
  return STATIC_EXTENSIONS.some(ext => path.endsWith(ext));
}

export function isDenied(url: string): boolean {
  const lower = url.toLowerCase();
  return DENY_SUBSTRINGS.some(deny => lower.includes(deny));
}

export function hasAcceptedContentType(contentType: string): boolean {
  const lower = (contentType || '').toLowerCase();
  return ACCEPTED_CONTENT_TYPES.some(accepted => lower.includes(accepted));
}

/** Whether a response is worth remembering as evidence the step completed. */
export function isCandidateSignal(pageUrl: string, response: CapturedResponse): boolean {
  if (!isSameSite(pageUrl, response.url))
    return false;
  if (isDenied(response.url))
    return false;
  if (isStaticAsset(response.url))
    return false;
  if (!hasAcceptedContentType(response.contentType))
    return false;
  return response.status >= 200 && response.status < 400;
}

/**
 * Was this response caused by the action, or merely concurrent with it?
 *
 * A request that BEGAN before the action began was not caused by it. This is the
 * one test that separates the two deterministically; everything else about
 * attribution is a time window and therefore approximate (§7.4).
 *
 * A response with no `initiatedAt` is accepted, so a caller that does not yet
 * supply the field keeps today's behaviour instead of silently recording nothing.
 */
export function isCausedBy(response: CapturedResponse, actionStart: number): boolean {
  return response.initiatedAt === undefined || response.initiatedAt >= actionStart;
}

/**
 * Did this pattern also appear while nothing was happening?
 *
 * The discriminator for background traffic is **periodicity, not repetition**.
 * Counting how often a pattern appears is the wrong test: three "Run Query"
 * steps each firing `**\/_search` should all keep it — identical steps producing
 * identical signals is evidence of correctness. The right question is whether
 * the pattern also fires when the author did nothing, which no amount of
 * repetition across action windows can answer.
 *
 * This reaches what the deny-list cannot: a customer's own first-party analytics
 * passes the same-site, content-type, static-asset and known-vendor tests.
 */
export function isBackground(
  response: CapturedResponse,
  idleResponses: CapturedResponse[],
): boolean {
  const pattern = generalizeEndpointPattern(response.url);
  if (!pattern) return false;
  const method = response.method.toUpperCase();
  return idleResponses.some(
    r => r.method.toUpperCase() === method && generalizeEndpointPattern(r.url) === pattern,
  );
}

/**
 * Turn the responses observed during one action into settle patterns.
 *
 * Two filters run before ranking, and both remove signals that would otherwise
 * cost a full settle budget on every single run of the monitor:
 *
 *  - **caused, not merely concurrent** — see `isCausedBy`.
 *  - **not background** — see `isBackground`.
 *
 * Ranking then puts causal confidence ahead of specificity. Ranking by wildcard
 * count alone meant a clean background path (`/api/v1/config`) outranked the
 * causal call whose ids had been wildcarded (`/api/*\/orgs/*\/search`), so with
 * more than five candidates the cap evicted the signal that mattered.
 */
export function buildSettlePatterns(
  pageUrl: string,
  responses: CapturedResponse[],
  options: { actionStart?: number; idleResponses?: CapturedResponse[] } = {},
): SettleResponsePattern[] {
  const { actionStart, idleResponses = [] } = options;
  const seen = new Set<string>();
  const candidates: Array<{ pattern: SettleResponsePattern; wildcards: number; order: number }> = [];

  responses.forEach((response, order) => {
    if (!isCandidateSignal(pageUrl, response))
      return;
    if (actionStart !== undefined && !isCausedBy(response, actionStart))
      return;
    if (isBackground(response, idleResponses))
      return;
    const url_pattern = generalizeEndpointPattern(response.url);
    if (!url_pattern)
      return;
    const method = response.method.toUpperCase();
    const key = `${method} ${url_pattern}`;
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push({
      // P4.1.5: advisory, always. Requiring a signal is an author act.
      pattern: { url_pattern, method, required: false },
      wildcards: patternWildcardCount(url_pattern),
      order,
    });
  });

  return candidates
      .sort((a, b) => a.wildcards - b.wildcards || a.order - b.order)
      .slice(0, MAX_SETTLE_PATTERNS)
      .map(c => c.pattern);
}

/**
 * Collects responses as they arrive so each action can claim the ones that
 * landed while it was running.
 *
 * Time-windowed rather than causally traced: the browser does not tell us which
 * click caused which request, and a heuristic that pretended otherwise would be
 * wrong in exactly the interesting cases. The window is the action's own
 * start/end plus a short tail, and everything it produces is advisory — a
 * mis-attributed pattern annotates a step, it does not fail one.
 */
export class NetworkRecorder {
  private _responses: CapturedResponse[] = [];
  private _enabled = false;
  /** Bounded so a long recording session cannot grow without limit. */
  private static readonly MAX_RETAINED = 500;

  enable() {
    this._enabled = true;
  }

  disable() {
    this._enabled = false;
    this._responses = [];
  }

  record(response: CapturedResponse) {
    if (!this._enabled)
      return;
    this._responses.push(response);
    if (this._responses.length > NetworkRecorder.MAX_RETAINED)
      this._responses.shift();
  }

  /** Responses that landed within `[startTime, endTime + tail]`. */
  between(startTime: number, endTime: number, tailMs = 1000): CapturedResponse[] {
    return this._responses.filter(r => r.timestamp >= startTime && r.timestamp <= endTime + tailMs);
  }

  /**
   * Responses that landed while no action window was open.
   *
   * `windows` are the action windows, in any order. Everything outside all of
   * them was observed while the author did nothing, which is what makes it
   * background rather than evidence.
   */
  outside(windows: IdleWindow[]): CapturedResponse[] {
    return this._responses.filter(
      r => !windows.some(w => r.timestamp >= w.start && r.timestamp <= w.end),
    );
  }

  clear() {
    this._responses = [];
  }
}
