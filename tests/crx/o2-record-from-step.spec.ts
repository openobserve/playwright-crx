/**
 * The whole feature, through the real OpenObserve UI, with the real extension.
 *
 * Everything else about record-from-step is tested one layer at a time: the O2 unit
 * tests prove the wiring, `synthetics-record-from.spec.ts` proves the extension's
 * session. Neither proves the two halves work TOGETHER — that clicking Record in the
 * journey editor restores the journey, that the steps come back into the right slot,
 * and that a failed restore says so on screen.
 *
 * Requires the O2 dev server on :8081 and the extension built into
 * examples/synthetics-recorder/dist. The extension is loaded unpacked in developer
 * mode with incognito access, exactly as a developer would.
 */
import path from 'path';
import { test, expect } from './crxTest';
import type { Page } from '@playwright/test';

const EXTENSION_PATH = path.join(
    __dirname, '..', '..', 'examples', 'synthetics-recorder', 'dist');

/**
 * Where the O2 app is and who to sign in as. Supplied by the environment — never
 * defaulted to a real address, host or password, which would put a working
 * credential in the repository and silently point a run at someone's instance.
 * Empty means "not configured", and the tests skip rather than fail obscurely.
 */
const O2 = process.env.O2_BASE_URL ?? '';
const O2_USER = process.env.ZO_ROOT_USER_EMAIL ?? '';
const O2_PASS = process.env.ZO_ROOT_USER_PASSWORD ?? '';

test.use({
  extensionPath: EXTENSION_PATH,
  ...(process.env.CRX_CHANNEL ? { channel: process.env.CRX_CHANNEL } : {}),
  enabledInIncognito: true,
});

test.slow();

test.beforeEach(() => {
  test.skip(!O2 || !O2_USER || !O2_PASS,
      'Set O2_BASE_URL, ZO_ROOT_USER_EMAIL and ZO_ROOT_USER_PASSWORD to run the O2 UI flow tests.');
});

/** Sign in to the O2 app and land in the journey editor with an empty journey. */
async function openJourneyEditor(page: Page, startUrl: string) {
  await page.goto(`${O2}/web/login`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Login as internal user').click();
  await page.getByRole('textbox', { name: 'User Email' }).fill(O2_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(O2_PASS);
  await page.locator('[data-test="login-sign-in"]').click();
  await page.waitForURL(/\/web\/(\?|$)/, { timeout: 60_000 });

  // Warm the extension BEFORE the editor mounts. `extensionReady` is set by the
  // view's own probe on mount; if the service worker is still cold at that moment the
  // app decides the extension is missing and every Record click opens the setup
  // checklist instead of recording. Warming first is what a returning user's browser
  // state gives them for free.
  await warmBridge(page);

  await page.goto(`${O2}/web/synthetics/add?org_identifier=default`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Starting URL' }).fill(startUrl);
  await page.getByRole('button', { name: 'Build manually' }).click();
  await expect(page.locator('[data-test="synthetics-journey-record-btn"]')).toBeVisible({ timeout: 30_000 });
  await warmBridge(page);
}

/**
 * Wake the extension's service worker before the first Record click.
 *
 * The worker is spun up on demand, and a command that lands before its bridge port is
 * open simply gets no answer — the recording window never opens. That is a harness
 * race, not a product one: a person retries by clicking Record again. Waiting for a
 * getStatus reply is the same thing, done deterministically.
 */
async function warmBridge(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      window.postMessage({ ch: 'oo-bridge-probe' }, '*');
      const nonce = `warm_${Date.now()}_${attempt}`;
      const answered = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 3000);
        window.addEventListener('message', function onMsg(e: MessageEvent) {
          if (e.source !== window || e.data?.ch !== 'oo-bridge' || e.data?.dir !== 'to-page') return;
          if (e.data.nonce !== nonce) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(!!e.data.msg);
        });
        window.postMessage({ ch: 'oo-bridge', dir: 'to-ext', nonce,
          msg: { type: 'synthetics-command', command: { action: 'getStatus' } } }, '*');
      });
      if (answered) return;
    }
  });
}

/** Step rows currently in the editor, as short label strings. */
async function stepRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-test="synthetics-journey-step-record-before-btn"]')]
        .map(btn => {
          const row = btn.closest('[class*="row"], tr, div');
          return (row?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        }));
}

/** How many steps the journey currently holds. */
async function stepCount(page: Page): Promise<number> {
  return page.locator('[data-test="synthetics-journey-step-record-before-btn"]').count();
}

/**
 * The live recording window.
 *
 * The LAST matching page, never the first: stopping a recording leaves its incognito
 * window open so the next session can reuse it, so `find()` happily returns a stale
 * window from a previous capture. Driving that one records nothing into the session
 * that is actually live.
 */
function activeRecordingPage(context: any, urlPart: string): Page | undefined {
  const matches = context.pages().filter((p: Page) => !p.isClosed() && p.url().includes(urlPart));
  return matches[matches.length - 1];
}

/** Wait for a live recording window on `urlPart`. */
async function recordingWindow(context: any, urlPart: string) {
  const deadline = Date.now() + 60_000;
  let found = activeRecordingPage(context, urlPart);
  while (!found && Date.now() < deadline) {
    await context.waitForEvent('page', { timeout: 5_000 }).catch(() => {});
    found = activeRecordingPage(context, urlPart);
  }
  expect(found, `the recording window never opened on ${urlPart}`).toBeTruthy();
  await found!.waitForLoadState('domcontentloaded');
  return found! as Page;
}

/**
 * Dismiss the extension setup checklist if it opened, and say whether it had.
 *
 * The checklist appears whenever `extensionReady` is still false — the app's own probe
 * result — which on a cold service worker it often is for the first seconds after the
 * editor mounts. Completing the checklist from here is not possible: its incognito
 * task is an ATTESTATION (Chrome gives a page no way to read "Allow in incognito"), and
 * ticking it drops `connected` and forces a re-probe that can fail again on the same
 * cold worker.
 *
 * So we do what a person does — close it and click Record again once the probe has
 * landed. Returns true when the dialog was in the way, so the caller knows to retry.
 */
async function dismissSetupDialogIfPresent(page: Page): Promise<boolean> {
  const dialog = page.locator('[data-test="synthetics-journey-extension-setup-dialog"]');
  if (!(await dialog.isVisible().catch(() => false))) return false;

  const skip = page.locator('[data-test="synthetics-setup-dialog-skip"]');
  if (await skip.isVisible().catch(() => false)) await skip.click();
  else await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  return true;
}

/**
 * Click Record (or an anchor's Record-before) and wait for the incognito window.
 *
 * Retries the click once, for the same cold-worker reason warmBridge exists — and
 * because that is exactly the recovery available to a person.
 */
async function clickRecordAndWait(page: Page, context: any, clickTarget: () => Promise<void>, urlPart: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pagesBefore = context.pages().length;
    await clickTarget();

    // The setup checklist means the app had not detected the extension yet. Dismiss
    // and try again — by the next attempt its probe has almost always landed.
    if (await dismissSetupDialogIfPresent(page)) {
      await warmBridge(page);
      await page.waitForTimeout(2_000);
      continue;
    }

    await page.waitForTimeout(3_000);
    const win = activeRecordingPage(context, urlPart);
    if (win && context.pages().length > pagesBefore) {
      await win.waitForLoadState('domcontentloaded');
      return win;
    }
    // The window can also be REUSED across sessions, so a stable page count is not
    // proof of failure — accept a live match that is already on the target.
    if (win && attempt > 0) {
      await win.waitForLoadState('domcontentloaded');
      return win;
    }
    await warmBridge(page);
  }
  const win = activeRecordingPage(context, urlPart);
  expect(win, `the recording window never opened on ${urlPart}`).toBeTruthy();
  await win!.waitForLoadState('domcontentloaded');
  return win! as Page;
}

/**
 * Wait until the session is actually RECORDING, not merely restoring.
 *
 * The restoring banner appears when the restore STARTS. The session only becomes live
 * after every prefix step has replayed, the capture has been reset, and the recorder
 * has been switched on — and anything the author does before that happens in mode
 * 'none' and is then wiped by the reset. Interacting on the strength of the banner
 * alone produced a session that reported no error, no prefix failure, and zero
 * captured steps, which reads exactly like a broken recorder.
 *
 * The Stop button only renders while `isRecording`, so it is the honest signal.
 */
async function waitUntilRecording(page: Page): Promise<void> {
  await expect(page.locator('[data-test="synthetics-journey-stop-btn"]'),
      'the session never became live — the restore did not hand over to recording')
      .toBeVisible({ timeout: 120_000 });
}

/**
 * Scenario 1 — the capability handshake reaches the UI.
 *
 * Everything downstream is gated on it: if O2 does not see `recordFrom`, Record
 * silently keeps its old append-without-restoring behaviour and nothing else in this
 * file means anything.
 */
test('O2 detects the extension and its restore capability', async ({ page, context, extensionServiceWorker }) => {
  await openJourneyEditor(page, 'http://127.0.0.1:3000/v2-login.html');

  const status = await page.evaluate(async () => {
    window.postMessage({ ch: 'oo-bridge-probe' }, '*');
    await new Promise(r => setTimeout(r, 800));
    const nonce = `probe_${Date.now()}`;
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 8000);
      window.addEventListener('message', function onMsg(e: MessageEvent) {
        if (e.source !== window || e.data?.ch !== 'oo-bridge' || e.data?.dir !== 'to-page') return;
        if (e.data.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(e.data.msg);
      });
      window.postMessage({ ch: 'oo-bridge', dir: 'to-ext', nonce,
        msg: { type: 'synthetics-command', command: { action: 'getStatus' } } }, '*');
    });
  });

  expect(status, 'the O2 page could not reach the extension at all').toBeTruthy();
  expect((status as any).capabilities, 'the extension did not advertise restore-then-record')
      .toContain('recordFrom');
});

/**
 * Scenario 2 — recording into an EMPTY journey stays on the cheap path.
 *
 * There is nothing to restore, so the author must not pay for a replay before they can
 * act. This is also the baseline the later scenarios build their journey with.
 */
test('recording an empty journey captures the steps the author performs', async ({ page, context, extensionServiceWorker }) => {
  const target = 'http://127.0.0.1:3000/v2-login.html';
  await openJourneyEditor(page, target);

  const rec = await clickRecordAndWait(page, context,
      () => page.locator('[data-test="synthetics-journey-record-btn"]').click(), 'v2-login.html');

  await rec.locator('[data-test="login-user-id-field"]').click();
  await rec.locator('[data-test="login-user-id-field"]').fill('someone@example.com');
  await rec.waitForTimeout(2_000);

  await page.locator('[data-test="synthetics-journey-stop-btn"]').click();
  await page.waitForTimeout(2_000);

  expect(await stepCount(page), 'nothing was captured into the journey').toBeGreaterThan(0);
});

/**
 * Scenario 3 — the headline: Record on a NON-empty journey restores first.
 *
 * The restore banner is the observable proof that a replay ran before recording, and
 * the new steps must land after the existing ones.
 */
test('recording again restores the journey first and appends after it', async ({ page, context, extensionServiceWorker }) => {
  const target = 'http://127.0.0.1:3000/v2-login.html';
  await openJourneyEditor(page, target);

  // First capture — builds the journey to append to.
  let rec = await clickRecordAndWait(page, context,
      () => page.locator('[data-test="synthetics-journey-record-btn"]').click(), 'v2-login.html');
  await rec.locator('[data-test="login-user-id-field"]').click();
  await rec.locator('[data-test="login-user-id-field"]').fill('someone@example.com');
  await rec.waitForTimeout(2_000);
  await page.locator('[data-test="synthetics-journey-stop-btn"]').click();
  await page.waitForTimeout(2_000);

  const before = await stepCount(page);
  expect(before, 'the first capture produced no steps to append to').toBeGreaterThan(0);

  // Record every setActions push the extension sends to this page. The one thing the
  // UI state cannot tell us is whether the steps were never sent or sent and dropped.
  await page.evaluate(() => {
    (window as any).__pushes = [];
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== window || e.data?.ch !== 'oo-bridge' || e.data?.dir !== 'to-page') return;
      const payload = e.data?.msg?.payload;
      if (!payload) return;
      (window as any).__pushes.push({
        method: payload.method,
        steps: Array.isArray(payload.browserSteps) ? payload.browserSteps.length : undefined,
        mode: payload.mode,
        baseline: payload.baselineStepCount,
      });
    });
  });

  // Second capture — this one must restore before it records.
  await page.locator('[data-test="synthetics-journey-record-btn"]').click();
  await expect(page.locator('[data-test="synthetics-journey-restoring-banner"]'),
      'Record on a non-empty journey did not restore first — the capture would start from the start URL')
      .toBeVisible({ timeout: 30_000 });

  await waitUntilRecording(page);
  rec = await recordingWindow(context, 'v2-login.html');
  // The restore filled the username. Asserting it here proves the window we are about
  // to record into is the one the restore ran in — not a leftover from the first
  // capture, which is where recorded steps silently go nowhere.
  await expect(rec.locator('[data-test="login-user-id-field"]'),
      'the live recording window does not hold the restored state')
      .toHaveValue('someone@example.com', { timeout: 30_000 });
  await rec.locator('[data-test="login-password-field"]').click();
  await rec.locator('[data-test="login-password-field"]').fill('secret');
  await rec.waitForTimeout(2_000);

  await page.locator('[data-test="synthetics-journey-stop-btn"]').click();
  await page.waitForTimeout(2_000);

  // Diagnostics: when this fails the question is always "did the steps never arrive,
  // or did they arrive and not get committed" — so capture what the UI is saying.
  const pushes = await page.evaluate(() => (window as any).__pushes ?? []);
  const diag = await page.evaluate(() => ({
    error: (document.querySelector('[data-test="synthetics-journey-recording-error"]') as HTMLElement)?.innerText
        ?? (document.querySelector('[role="alert"]') as HTMLElement)?.innerText ?? null,
    restoring: !!document.querySelector('[data-test="synthetics-journey-restoring-banner"]'),
    prefixFailed: (document.querySelector('[data-test="synthetics-journey-prefix-failed"]') as HTMLElement)?.innerText ?? null,
    recordBtn: !!document.querySelector('[data-test="synthetics-journey-record-btn"]'),
    stopBtn: !!document.querySelector('[data-test="synthetics-journey-stop-btn"]'),
    stepCount: document.querySelectorAll('[data-test="synthetics-journey-step-record-before-btn"]').length,
  }));
  expect(await stepCount(page),
      `the second capture added nothing.\nUI state: ${JSON.stringify(diag, null, 2)}\nextension pushes: ${JSON.stringify(pushes, null, 2)}`)
      .toBeGreaterThan(before);
});

/**
 * Scenario 4 — "Record before this step" puts the steps in the right slot.
 *
 * The anchor is the last row; the recorded steps must appear BEFORE it, and the anchor
 * must still be last.
 */
test('recording before a step inserts there rather than at the end', async ({ page, context, extensionServiceWorker }) => {
  const target = 'http://127.0.0.1:3000/v2-login.html';
  await openJourneyEditor(page, target);

  let rec = await clickRecordAndWait(page, context,
      () => page.locator('[data-test="synthetics-journey-record-btn"]').click(), 'v2-login.html');
  await rec.locator('[data-test="login-user-id-field"]').click();
  await rec.locator('[data-test="login-user-id-field"]').fill('someone@example.com');
  await rec.locator('[data-test="login-password-field"]').click();
  await rec.waitForTimeout(2_000);
  await page.locator('[data-test="synthetics-journey-stop-btn"]').click();
  await page.waitForTimeout(2_000);

  const before = await stepCount(page);
  expect(before, 'need at least two steps to insert between').toBeGreaterThan(1);
  const rowsBefore = await stepRows(page);
  const lastRowBefore = rowsBefore[rowsBefore.length - 1];

  // Anchor on the LAST row.
  await page.locator('[data-test="synthetics-journey-step-record-before-btn"]').last().click();
  await expect(page.locator('[data-test="synthetics-journey-restoring-banner"]'),
      'anchoring did not restore the steps before the anchor').toBeVisible({ timeout: 30_000 });

  await waitUntilRecording(page);
  rec = await recordingWindow(context, 'v2-login.html');
  await expect(rec.locator('[data-test="login-user-id-field"]'),
      'the live recording window does not hold the restored state')
      .toHaveValue('someone@example.com', { timeout: 30_000 });
  await rec.locator('[data-test="login-sign-in"]').click();
  await rec.waitForTimeout(2_500);

  await page.locator('[data-test="synthetics-journey-stop-btn"]').click();
  await page.waitForTimeout(2_000);

  const rowsAfter = await stepRows(page);
  expect(rowsAfter.length, 'the insert added nothing').toBeGreaterThan(before);
  expect(rowsAfter[rowsAfter.length - 1],
      `the anchor step is no longer last — the steps were appended instead of inserted: ${JSON.stringify(rowsAfter)}`)
      .toBe(lastRowBefore);
});

/**
 * Scenario 5 — a restore that cannot reach the anchor says so, and commits nothing.
 *
 * Built by pointing a step at an element that does not exist, then anchoring past it.
 */
test('a restore that cannot reach the anchor reports the failing step', async ({ page, context, extensionServiceWorker }) => {
  const target = 'http://127.0.0.1:3000/v2-login.html';
  await openJourneyEditor(page, target);

  const rec = await clickRecordAndWait(page, context,
      () => page.locator('[data-test="synthetics-journey-record-btn"]').click(), 'v2-login.html');
  await rec.locator('[data-test="login-user-id-field"]').click();
  await rec.locator('[data-test="login-user-id-field"]').fill('someone@example.com');
  await rec.locator('[data-test="login-password-field"]').click();
  await rec.waitForTimeout(2_000);
  await page.locator('[data-test="synthetics-journey-stop-btn"]').click();
  await page.waitForTimeout(2_000);

  const before = await stepCount(page);
  expect(before).toBeGreaterThan(1);

  // Put a step the restore CANNOT perform into the prefix.
  //
  // Editing a recorded step's locator is the obvious route and the wrong one: a
  // recorded row is collapsed, so its locator field is not in the DOM, and the earlier
  // version of this setup quietly did nothing — the journey stayed valid, the restore
  // succeeded, and the missing failure banner looked like a product defect.
  //
  // "Insert step below" creates a step that is expanded by construction (the editor
  // reveals every new step, because a new step is always incomplete), so its locator
  // field is reliably there to fill with something that matches nothing.
  await page.locator('[data-test="synthetics-journey-step-insert-btn"]').first().click();

  const locatorField = page.getByRole('textbox', { name: /how to find this element/i }).first();
  await expect(locatorField,
      'the inserted step did not reveal its locator field, so the journey was never broken')
      .toBeVisible({ timeout: 20_000 });
  await locatorField.fill('#no-such-element-anywhere');
  await page.waitForTimeout(1_000);

  // The broken step now sits at position 2, so anchoring on the last row puts it in
  // the prefix — the restore must hit it and stop.
  //
  // Re-measure AFTER the insert: `before` was taken before this setup added a step, so
  // comparing against it would count our own edit as steps the failed restore
  // committed.
  const beforeRestore = await stepCount(page);
  await page.locator('[data-test="synthetics-journey-step-record-before-btn"]').last().click();

  await expect(page.locator('[data-test="synthetics-journey-prefix-failed"]'),
      'a restore that could not reach the anchor reported nothing to the author')
      .toBeVisible({ timeout: 120_000 });

  expect(await stepCount(page), 'a failed restore committed steps anyway').toBe(beforeRestore);
});
