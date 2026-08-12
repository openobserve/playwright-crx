/**
 * Version-2 capture: unit-level proof for the pure parts of Phases 2–5.
 *
 * These are the pieces that decide what a recorded journey MEANS — which
 * selectors survive, which URL patterns will still match next month, which
 * network calls are worth waiting on, and what the preview is honest about not
 * simulating. All of them are pure functions on purpose (spec P3.1.3), so they
 * can be pinned down here without a browser and without a recording session.
 *
 * The browser-level proof that the recorder actually produces this shape lives
 * in synthetics-v2-recording.spec.ts.
 */
import { expect, test } from '@playwright/test';

import {
  buildLocatorBundle,
  classifySelector,
  isFrameworkGeneratedId,
  isPositionalSelector,
  setLocatorTestIdAttribute,
  MAX_LOCATOR_CANDIDATES,
} from '../../src/server/recorder/locatorBundle';
import {
  generalizeEndpointPattern,
  generalizeUrlPattern,
  isDynamicSegment,
} from '../../src/server/recorder/urlPattern';
import {
  ACTION_REPORTING_LEAD_MS,
  buildSettlePatterns,
  captureWindows,
  isBackground,
  isCandidateSignal,
  isCausedBy,
  isSameSite,
  MAX_CAPTURE_WINDOW_MS,
  MAX_SETTLE_PATTERNS,
  NetworkRecorder,
} from '../../src/server/recorder/networkCapture';
import { describeStepFidelity } from '../../src/server/recorder/replayFidelity';
import {
  isUnsupportedReplayAction,
  mapActionsToBrowserSteps,
  mapActionToBrowserStep,
  mapBrowserStepToAction,
  mapBrowserStepsToActions,
} from '../../src/server/recorder/actionMapper';
import type { BrowserStep } from '../../src/server/recorder/actionMapper';

// ── T2-3: locator bundles ───────────────────────────────────────────────────

test('classifies every selector shape the generator emits', () => {
  expect(classifySelector('internal:testid=[data-testid="login-sign-in"]s')).toBe('test_attribute');
  expect(classifySelector('[data-test="login-sign-in"]')).toBe('test_attribute');
  expect(classifySelector('internal:role=button[name="Sign In"i]')).toBe('role');
  expect(classifySelector('internal:text="Sign In"i')).toBe('text');
  expect(classifySelector('internal:label="Password"i')).toBe('text');
  expect(classifySelector('xpath=//button[1]')).toBe('xpath');
  expect(classifySelector('//button[1]')).toBe('xpath');
  expect(classifySelector('.btn-primary > span')).toBe('css');
});

test('stores the generator order verbatim, kinds and all', () => {
  // Inverted in Phase 2b. We used to sort by kind here, which promoted an
  // INDEXED testid above a unique role — and Phase 2a then added a positional
  // key to undo exactly that. Upstream had it right from the start:
  // chooseFirstSelector returns a unique candidate the moment it finds one, so
  // selectors[0] is positional only when no unique locator exists.
  const bundle = buildLocatorBundle([
    'internal:text="Sign In"i',
    '.btn.btn-primary',
    'internal:testid=[data-testid="login-sign-in"]s',
    'internal:role=button[name="Sign In"i]',
  ]);
  expect(bundle?.candidates.map(c => c.kind)).toEqual(['text', 'css', 'test_attribute', 'role']);
});

test('keeps the generator order between candidates of the same kind', () => {
  const bundle = buildLocatorBundle(['.a', '.b', '.c']);
  expect(bundle?.candidates.map(c => c.value)).toEqual(['.a', '.b', '.c']);
});

test('stamps every candidate as recorded, and claims no author intent', () => {
  const bundle = buildLocatorBundle(['.a', '.b']);
  expect(bundle?.candidates.every(c => c.origin === 'recorded')).toBe(true);
  // Absent, not false: a fresh recording has no author intent in it, and
  // writing the field would claim someone had looked.
  expect(bundle?.author_ordered).toBeUndefined();
});

test('caps the bundle — the fifth way to find an element buys almost nothing', () => {
  const bundle = buildLocatorBundle(['.a', '.b', '.c', '.d', '.e', '.f', '.g']);
  expect(bundle?.candidates).toHaveLength(MAX_LOCATOR_CANDIDATES);
});

test('drops duplicates and falls back to the primary when there is no list', () => {
  expect(buildLocatorBundle(['.a', '.a', '.b'])?.candidates).toHaveLength(2);
  expect(buildLocatorBundle(undefined, '#only')?.candidates).toEqual([
    { kind: 'css', value: '#only', origin: 'recorded' },
  ]);
  expect(buildLocatorBundle([], undefined)).toBeUndefined();
});

test('the recorder writes no pin — there is no pin to write', () => {
  // `user_override` was an exclusive pin: the only way to say "prefer this one"
  // was to turn fallback off entirely. The ordered list says the same thing by
  // deleting the other rows, and can also say "prefer mine, fall back to the
  // recording" — which a pin could not.
  expect(buildLocatorBundle(['.a'])).not.toHaveProperty('user_override');
});

// ── Phase 2a: positional locators ───────────────────────────────────────────

test('recognises every positional shape the generator emits', () => {
  // `nth=` engine token — chooseFirstSelector's last resort.
  expect(isPositionalSelector('[data-test="row"] >> nth=1')).toBe(true);
  // Chained CSS positional — joinTokens.
  expect(isPositionalSelector('div >> :nth-match(button, 2)')).toBe(true);
  // Ancestor-chain positional — cssFallback.
  expect(isPositionalSelector('body > div:nth-child(3) > span')).toBe(true);
  // Not positional.
  expect(isPositionalSelector('[data-test="login-sign-in"]')).toBe(false);
  expect(isPositionalSelector('internal:role=button[name="Sign In"i]')).toBe(false);
  // `nth` inside a text payload is content, not an index.
  expect(isPositionalSelector('internal:text="10th anniversary"i')).toBe(false);
});

test('a chain is classified by its weakest link, not by its prefix', () => {
  // Prefix-only classification called this `test_attribute` and put it at the
  // top of the rank. It is a class name away from breaking, so it is `css`.
  expect(classifySelector('internal:testid=[data-test="row"] >> div.name')).toBe('css');
  // The trailing index says WHICH match to take, not HOW the element was found,
  // so it must not drag the whole chain down to `css`.
  expect(classifySelector('[data-test="row"] >> nth=1')).toBe('test_attribute');
  expect(classifySelector('internal:role=button[name="Save"i] >> nth=0')).toBe('role');
  // Text reached through a structural parent is only as good as that parent.
  expect(classifySelector('div >> internal:has-text=/^Acme Corp$/ >> nth=0')).toBe('css');
  // Single-token behaviour is unchanged.
  expect(classifySelector('.btn-primary > span')).toBe('css');
});

test('a positional primary is upstream saying nothing matched uniquely', () => {
  // The observed org-switcher shape. Phase 2a demoted the indexed candidate
  // here; Phase 2b keeps upstream's order instead, because upstream only
  // reaches for an index when NOTHING identified the element uniquely — so an
  // indexed selectors[0] is a fact about the page, not a ranking mistake.
  // The author fixes it by reordering, or by combining the two.
  const bundle = buildLocatorBundle([
    '[data-test="organization-menu-item-label-item-label"] >> nth=1',
    'internal:role=button[name="Save draft"i]',
  ]);
  expect(bundle?.candidates[0].value).toContain('nth=1');
  expect(isPositionalSelector(bundle!.candidates[0].value)).toBe(true);
});

test('the cap takes upstream\'s last entries, not ours', () => {
  // selectors[0] is upstream's considered best answer and the cap counts from
  // there, so what it drops is what upstream ranked last.
  const bundle = buildLocatorBundle([
    '[data-test="a"] >> nth=0',
    '[data-test="b"] >> nth=1',
    '[data-test="c"] >> nth=2',
    '[data-test="d"] >> nth=3',
    '[data-test="e"] >> nth=4',
    'internal:role=link[name="Only unique"i]',
  ]);
  expect(bundle?.candidates).toHaveLength(MAX_LOCATOR_CANDIDATES);
  expect(bundle?.candidates.map(c => c.value)).not.toContain('internal:role=link[name="Only unique"i]');
});

// ── T3-1: URL generalization ────────────────────────────────────────────────

test('recognises values masquerading as path segments', () => {
  expect(isDynamicSegment('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
  expect(isDynamicSegment('10025512')).toBe(true);
  expect(isDynamicSegment('1721030400000')).toBe(true);
  expect(isDynamicSegment('order-10025512')).toBe(true);
  expect(isDynamicSegment('5f4dcc3b5aa765d61d8327deb882cf99')).toBe(true);
  // …and leaves names alone.
  expect(isDynamicSegment('web')).toBe(false);
  expect(isDynamicSegment('logs')).toBe(false);
  expect(isDynamicSegment('v2')).toBe(false);
});

test('generalizes the canonical login redirect to the spec pattern', () => {
  // The reference target from tests/ui-testing/pages/generalPages/loginPage.js:
  // page.waitForURL(BASE + "/web/") becomes **/web/**.
  expect(generalizeUrlPattern('https://o2.introspect.dev/web/')).toBe('**/web/**');
  expect(generalizeUrlPattern('https://o2.introspect.dev/web')).toBe('**/web/**');
});

test('wildcards ids and strips the query string (X-4)', () => {
  expect(generalizeUrlPattern('https://app.example.com/orgs/10025512/logs?token=abc'))
      .toBe('**/orgs/*/logs/**');
  expect(generalizeUrlPattern('https://app.example.com/web/#/logs')).toBe('**/web/**');
});

test('refuses to invent a pattern for a bare origin', () => {
  // "it navigated to the root" generalizes to something that matches nearly
  // everything, which is not a wait condition. The X-6 backstop covers it.
  expect(generalizeUrlPattern('https://app.example.com/')).toBeNull();
  expect(generalizeUrlPattern('not a url')).toBeNull();
});

test('an endpoint pattern does not absorb everything after it', () => {
  // **/api/users must not also match /api/users/1/delete.
  expect(generalizeEndpointPattern('https://app.example.com/api/users?page=2')).toBe('**/api/users');
  expect(generalizeEndpointPattern('https://app.example.com/api/users/10025512'))
      .toBe('**/api/users/*');
});

// ── T4-1: network capture filtering ─────────────────────────────────────────

test('same-site covers the origin and its subdomains, and nothing else', () => {
  expect(isSameSite('https://app.example.com/login', 'https://app.example.com/api/x')).toBe(true);
  expect(isSameSite('https://example.com/login', 'https://api.example.com/x')).toBe(true);
  expect(isSameSite('https://api.example.com/login', 'https://example.com/x')).toBe(true);
  expect(isSameSite('https://app.example.com/login', 'https://evil.com/x')).toBe(false);
});

test('keeps same-site JSON and drops assets, beacons and third parties', () => {
  const page = 'https://app.example.com/login';
  const base = { method: 'POST', status: 200, timestamp: 0 };

  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/auth/login', contentType: 'application/json; charset=utf-8',
  })).toBe(true);

  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/static/main.js', contentType: 'application/javascript',
  })).toBe(false);
  expect(isCandidateSignal(page, {
    ...base, url: 'https://www.google-analytics.com/collect', contentType: 'application/json',
  })).toBe(false);
  expect(isCandidateSignal(page, {
    ...base, url: 'https://cdn.other.com/data.json', contentType: 'application/json',
  })).toBe(false);
  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/page', contentType: 'text/html',
  })).toBe(false);
});

test('keeps a streamed response — the search that streams is still the search', () => {
  const page = 'https://app.example.com/web/logs';
  const base = { method: 'POST', status: 200, timestamp: 0 };

  // O2's logs search answers with SSE. A JSON-only allow-list could never
  // capture the one call a "Run Query" step is actually waiting on.
  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/api/default/_search_stream?type=logs',
    contentType: 'text/event-stream',
  })).toBe(true);
  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/api/default/_values_stream',
    contentType: 'application/x-ndjson',
  })).toBe(true);
});

test('an endpoint that answered 500 is still the endpoint the step calls', () => {
  const page = 'https://app.example.com/login';
  const base = { method: 'POST', contentType: 'application/json', timestamp: 0 };

  // The endpoint is a property of the application; the status is a property of
  // one afternoon. Dropping the signal would leave the step with no evidence
  // at all, falling back to the X-6 backstop on every future run.
  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/auth/login', status: 500,
  })).toBe(true);
  expect(isCandidateSignal(page, {
    ...base, url: 'https://app.example.com/auth/login', status: 401,
  })).toBe(true);
});

test('ranks patterns by stability, caps them, and never marks one required', () => {
  const page = 'https://app.example.com/login';
  const responses = [
    // Most wildcards — least specific, so it must rank last despite being first.
    { url: 'https://app.example.com/api/orgs/10025512/items/998877', method: 'GET', status: 200, contentType: 'application/json', timestamp: 1 },
    { url: 'https://app.example.com/auth/login', method: 'POST', status: 200, contentType: 'application/json', timestamp: 2 },
    { url: 'https://app.example.com/api/orgs/10025512/profile', method: 'GET', status: 200, contentType: 'application/json', timestamp: 3 },
  ];
  const patterns = buildSettlePatterns(page, responses);
  expect(patterns.map(p => p.url_pattern)).toEqual([
    '**/auth/login',
    '**/api/orgs/*/profile',
    '**/api/orgs/*/items/*',
  ]);
  // P4.1.5 — requiring a signal is an author act, never a recording.
  expect(patterns.every(p => p.required === false)).toBe(true);
});

test('deduplicates by method and pattern, and honours the cap', () => {
  const page = 'https://app.example.com/x';
  const many = Array.from({ length: 12 }, (_, i) => ({
    url: `https://app.example.com/api/e${i}`,
    method: 'GET', status: 200, contentType: 'application/json', timestamp: i,
  }));
  const dupes = [
    { url: 'https://app.example.com/api/a?page=1', method: 'GET', status: 200, contentType: 'application/json', timestamp: 0 },
    { url: 'https://app.example.com/api/a?page=2', method: 'GET', status: 200, contentType: 'application/json', timestamp: 1 },
  ];
  expect(buildSettlePatterns(page, many)).toHaveLength(MAX_SETTLE_PATTERNS);
  expect(buildSettlePatterns(page, dupes)).toHaveLength(1);
});

test('the recorder only collects while enabled, and windows responses per action', () => {
  const recorder = new NetworkRecorder();
  const res = (timestamp: number) => ({
    url: 'https://app.example.com/api/x', method: 'GET', status: 200,
    contentType: 'application/json', timestamp,
  });

  // Disabled by default: a replay must never overwrite recorded evidence (P4.S.2).
  recorder.record(res(1));
  expect(recorder.between(0, 100)).toHaveLength(0);

  recorder.enable();
  recorder.record(res(10));
  recorder.record(res(50));
  recorder.record(res(5000));
  // The window is supplied whole — no tail is added on this side, because the
  // caller derives the end from the NEXT action's start.
  expect(recorder.between(0, 100)).toHaveLength(2);
  expect(recorder.between(4000, 4500)).toHaveLength(0);
  expect(recorder.between(4000, 5500)).toHaveLength(1);

  recorder.disable();
  expect(recorder.between(0, 10000)).toHaveLength(0);
});

test('an action window ends where the author moved on, not one second in', () => {
  // A browser-recorded action's endTime is a microtask after its startTime, so
  // the window can only come from the NEXT action's start.
  const lead = ACTION_REPORTING_LEAD_MS;
  expect(captureWindows([{ startTime: 0 }, { startTime: 3000 }, { startTime: 3200 }])).toEqual([
    { start: -lead, end: 3000 },        // ran until the author did the next thing
    { start: 3000 - lead, end: 3200 },  // two clicks in quick succession
    { start: 3200 - lead, end: 3200 + MAX_CAPTURE_WINDOW_MS },  // last action: capped
  ]);

  // A long pause is capped, so the polling that happens during it stays idle
  // and remains available to the background filter.
  expect(captureWindows([{ startTime: 0 }, { startTime: 60_000 }])).toEqual([
    { start: -lead, end: MAX_CAPTURE_WINDOW_MS },
    { start: 60_000 - lead, end: 60_000 + MAX_CAPTURE_WINDOW_MS },
  ]);

  // openPage has no endTime at all, so it used to get no window — putting the
  // whole first page load into the idle set.
  expect(captureWindows([{ startTime: 100 }])).toEqual([
    { start: 100 - lead, end: 100 + MAX_CAPTURE_WINDOW_MS },
  ]);
  expect(captureWindows([])).toEqual([]);
});

test('a call fired on load and again on click is not mistaken for background', () => {
  // The regression that made OpenObserve's "Run Query" uncapturable: the logs
  // page runs a search on mount AND on click. With page-load traffic sitting
  // outside every window it counted as idle, so the click's own search was
  // filtered as background.
  const page = 'https://app.example.com/web/logs';
  const search = (timestamp: number) => ({
    url: 'https://app.example.com/api/default/_search_stream', method: 'POST',
    status: 200, contentType: 'text/event-stream', timestamp, initiatedAt: timestamp - 50,
  });

  const recorder = new NetworkRecorder();
  recorder.enable();
  recorder.record(search(200));    // on page load
  recorder.record(search(10_300)); // on click

  const actions = [{ startTime: 0 }, { startTime: 10_000 }];
  const windows = captureWindows(actions);
  const idleResponses = recorder.outside(windows);
  expect(idleResponses, 'page-load traffic must belong to the openPage window').toHaveLength(0);

  const patterns = buildSettlePatterns(page, recorder.between(windows[1].start, windows[1].end), {
    actionStart: actions[1].startTime,
    idleResponses,
  });
  expect(patterns.map(p => p.url_pattern)).toEqual(['**/api/default/_search_stream']);
});

test('the buffer spends its retention on calls that could become signals', () => {
  const recorder = new NetworkRecorder();
  recorder.enable();

  // Context-free filters run on the way IN. One application page load is a
  // hundred-plus requests, nearly all of them assets; letting those consume the
  // retention budget silently evicted the earliest steps' evidence.
  recorder.record({
    url: 'https://app.example.com/assets/main.js', method: 'GET', status: 200,
    contentType: 'application/javascript', timestamp: 1,
  });
  recorder.record({
    url: 'https://www.google-analytics.com/collect', method: 'POST', status: 200,
    contentType: 'application/json', timestamp: 2,
  });
  expect(recorder.between(0, 100)).toHaveLength(0);

  // Status is NOT one of them — a failing call is still evidence of which
  // endpoint the step causes.
  recorder.record({
    url: 'https://app.example.com/api/search', method: 'POST', status: 503,
    contentType: 'application/json', timestamp: 3,
  });
  expect(recorder.between(0, 100)).toHaveLength(1);
});

// ── T2-4 / T3-2 / X-9.3: the mapper ─────────────────────────────────────────

function actionInContext(action: any, startTime = 0, endTime?: number) {
  return {
    // 1.62 replaced `frame: { pageGuid, pageAlias, framePath }` with a bare `pageGuid`.
    pageGuid: 'page',
    action,
    startTime,
    endTime,
  };
}

test('a click carries its whole bundle, and no bare selector beside it', () => {
  const [step] = mapActionsToBrowserSteps([
    actionInContext({
      name: 'click',
      selector: 'internal:testid=[data-testid="login-sign-in"]s',
      selectors: [
        'internal:testid=[data-testid="login-sign-in"]s',
        'internal:role=button[name="Sign In"i]',
        '.btn-primary',
      ],
      button: 'left', modifiers: 0, clickCount: 1, signals: [],
    }),
  ]);
  // The version-1 pair. `selector_type` was also a second, older classifier
  // that disagreed with classifySelector's weakest-link rule on chains.
  expect(step).not.toHaveProperty('selector');
  expect(step).not.toHaveProperty('selector_type');
  expect(step.locator?.candidates.map(c => c.kind)).toEqual(['test_attribute', 'role', 'css']);
});

test('a navigation signal becomes a settle block instead of being discarded', () => {
  const [step] = mapActionsToBrowserSteps([
    actionInContext({
      name: 'click',
      selector: '[data-test="login-sign-in"]',
      selectors: ['[data-test="login-sign-in"]'],
      button: 'left', modifiers: 0, clickCount: 1,
      signals: [{ name: 'navigation', url: 'https://o2.introspect.dev/web/' }],
    }, 1_000, 3_400),
  ]);
  expect(step.settle?.navigation).toEqual({ url_pattern: '**/web/**' });
  // Reporting only — never read as a timeout.
  expect(step.settle?.observed_duration_ms).toBe(2_400);
});

test('check and uncheck survive the round trip instead of degrading to a click', () => {
  const [check, uncheck] = mapActionsToBrowserSteps([
    actionInContext({ name: 'check', selector: '#terms', selectors: ['#terms'], signals: [] }),
    actionInContext({ name: 'uncheck', selector: '#news', selectors: ['#news'], signals: [] }),
  ]);
  expect(check.action).toBe('check');
  expect(uncheck.action).toBe('uncheck');

  const actions = mapBrowserStepsToActions([check, uncheck]);
  expect(actions.map(a => a.action.name)).toEqual(['check', 'uncheck']);
});

// ── P2.4.3 / P2.S: what a stored step replays against ───────────────────────
//
// A stored step carries NO bare `selector` — the saved schema has no such field,
// its identity is the bundle. The mapper used to read `step.selector` alone, so
// every element action was built with an empty selector and the player failed
// parsing it before the step ran:
//   Unexpected token "" while parsing css selector "".
// That made every saved journey unreplayable from the editor.

function storedV2Step(overrides: Partial<BrowserStep>): BrowserStep {
  return {
    id: 's1', action: 'click', name: 'Step', startTime: 0,
    pageAlias: 'page', framePath: [], ...overrides,
  } as BrowserStep;
}

test('a stored v2 step replays against its primary candidate, not an empty selector', () => {
  const [action] = mapBrowserStepsToActions([
    storedV2Step({
      locator: {
        candidates: [
          { kind: 'test_attribute', value: '[data-test="login-as-internal-user"]' },
          { kind: 'text', value: 'internal:text="Login as internal user"i' },
          { kind: 'css', value: 'a' },
        ],
      },
    }),
  ]);
  expect((action.action as any).selector).toBe('[data-test="login-as-internal-user"]');
});

test('the author\'s first choice is position 0, with no second channel', () => {
  // This used to check a pin: `user_override` won outright over the whole list.
  // With the author owning the order, "use this one" IS position 0 — the same
  // answer without a second field that three separate copies of
  // effectiveSelector each had to remember to check.
  const [action] = mapBrowserStepsToActions([
    storedV2Step({
      locator: {
        candidates: [
          { kind: 'css', value: '#authored', origin: 'authored' },
          { kind: 'test_attribute', value: '[data-test="a"]', origin: 'recorded' },
        ],
        author_ordered: true,
      },
    }),
  ]);
  expect((action.action as any).selector).toBe('#authored');
});

test('a step with no bundle resolves to an empty selector, not to a stale one', () => {
  // There is no second channel left to fall back to. A bundle-less step cannot
  // be saved (the server refuses it), so reaching here means something upstream
  // is wrong — and an empty selector fails loudly at parse time rather than
  // replaying against whatever a bare `selector` happened to hold.
  const [action] = mapBrowserStepsToActions([storedV2Step({})]);
  expect((action.action as any).selector).toBe('');
});

test('every element action shape resolves the bundle, not just click', () => {
  const locator = { candidates: [{ kind: 'css' as const, value: '#el' }] };
  const actions = mapBrowserStepsToActions([
    storedV2Step({ action: 'type', value: 'hello', locator }),
    storedV2Step({ action: 'press', key: 'Enter', locator }),
    storedV2Step({ action: 'select', options: ['India'], locator }),
    storedV2Step({ action: 'check', locator }),
    storedV2Step({ action: 'uncheck', locator }),
    storedV2Step({ action: 'setInputFiles', files: ['/tmp/a.pdf'], locator }),
    storedV2Step({ action: 'assert', assertion: { kind: 'element_visible' }, locator }),
  ]);
  for (const action of actions)
    expect((action.action as any).selector).toBe('#el');
});

// ── X-9.1 / P2.2.5: the stored v2 vocabulary ────────────────────────────────
//
// `fill` replaces the `type` alias and `upload` is the v2 name for
// setInputFiles. A saved journey arrives with those names; the mapper only knew
// the recorder's internal ones, so both fell through to the `noop` default and
// were skipped while still being reported as passes.

test('a stored v2 fill types, rather than silently becoming a no-op', () => {
  const [action] = mapBrowserStepsToActions([
    storedV2Step({
      action: 'fill',
      value: 'omkar@openobserve.ai',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-user-id-field"]' }] },
    }),
  ]);
  expect(action.action.name).toBe('fill');
  expect((action.action as any).text).toBe('omkar@openobserve.ai');
  expect((action.action as any).selector).toBe('[data-test="login-user-id-field"]');
});

test('a stored v2 upload maps to setInputFiles', () => {
  const [action] = mapBrowserStepsToActions([
    storedV2Step({
      action: 'upload',
      files: ['/tmp/report.pdf'],
      locator: { candidates: [{ kind: 'css', value: '#file' }] },
    }),
  ]);
  expect(action.action.name).toBe('setInputFiles');
  expect((action.action as any).files).toEqual(['/tmp/report.pdf']);
});

test('an upload is reported not-simulated under either spelling', () => {
  // P2.S — the player rejects setInputFiles, so a green here would be a false
  // claim about a file that was never uploaded.
  for (const action of ['setInputFiles', 'upload'] as const) {
    const fidelity = describeStepFidelity(storedV2Step({
      action,
      locator: { candidates: [{ kind: 'css', value: '#file' }] },
    }), 0);
    expect(fidelity.level, action).toBe('not_simulated');
  }
});

// ── P5.1 / P5.S: typed assertions on a stored step ──────────────────────────

test('a stored element_text assertion actually checks the text', () => {
  const [action] = mapBrowserStepsToActions([
    storedV2Step({
      action: 'assert',
      assertion: { kind: 'element_text', expected: 'Signed in' },
      locator: { candidates: [{ kind: 'css', value: '#greeting' }] },
    }),
  ]);
  expect(action.action.name).toBe('assertText');
  expect((action.action as any).text).toBe('Signed in');
});

test('a stored element_visible assertion checks visibility', () => {
  const [action] = mapBrowserStepsToActions([
    storedV2Step({
      action: 'assert',
      assertion: { kind: 'element_visible' },
      locator: { candidates: [{ kind: 'css', value: '#greeting' }] },
    }),
  ]);
  expect(action.action.name).toBe('assertVisible');
});

test('assertion kinds the player cannot evaluate are skipped, not downgraded', () => {
  // P5.S.2 — running assertVisible for a url_matches would be a different,
  // weaker check reported as a pass; the page-level kinds carry no locator at
  // all, so it would fail on an empty selector anyway.
  for (const kind of ['element_not_visible', 'url_matches', 'page_title', 'element_attribute']) {
    const [action] = mapBrowserStepsToActions([
      storedV2Step({ action: 'assert', assertion: { kind: kind as any, expected: 'x' } }),
    ]);
    expect(action.action.name, kind).toBe('noop');
  }
});

test('a version-1 assert still recovers its subtype from the legacy fields', () => {
  const [text, checked] = mapBrowserStepsToActions([
    storedV2Step({ action: 'assert', selector: '#a', text: 'Welcome' }),
    storedV2Step({ action: 'assert', selector: '#b', checked: true }),
  ]);
  expect(text.action.name).toBe('assertText');
  expect(checked.action.name).toBe('assertChecked');
});

test('a bundle-less, selector-less step still yields an empty selector', () => {
  // navigate carries no element; nothing to resolve and nothing to invent.
  const [action] = mapBrowserStepsToActions([
    storedV2Step({ action: 'navigate', url: 'https://x.test' }),
  ]);
  expect((action.action as any).url).toBe('https://x.test');
});

test('recorded asserts arrive as typed assertions', () => {
  const steps = mapActionsToBrowserSteps([
    actionInContext({ name: 'assertVisible', selector: '#a', selectors: ['#a'], signals: [] }),
    actionInContext({ name: 'assertText', selector: '#b', selectors: ['#b'], text: 'Welcome', substring: true, signals: [] }),
    actionInContext({ name: 'assertValue', selector: '#c', selectors: ['#c'], value: 'omkar', signals: [] }),
    actionInContext({ name: 'assertChecked', selector: '#d', selectors: ['#d'], checked: true, signals: [] }),
  ]);
  expect(steps.map(s => s.assertion)).toEqual([
    { kind: 'element_visible' },
    { kind: 'element_text', expected: 'Welcome' },
    { kind: 'element_attribute', attribute: 'value', expected: 'omkar' },
    { kind: 'element_attribute', attribute: 'checked', expected: 'true' },
  ]);
});

// ── P2.S / P3.S / P4.S / P5.S: preview honesty ──────────────────────────────

function step(overrides: Partial<BrowserStep>): BrowserStep {
  return {
    id: 's1', action: 'click', name: 'Step', startTime: 0,
    pageAlias: 'page', framePath: [], ...overrides,
  } as BrowserStep;
}

test('an ordinary step claims nothing it did not do', () => {
  const fidelity = describeStepFidelity(step({ locator: { candidates: [{ kind: 'css', value: '#a' }] } }), 0);
  expect(fidelity.level).toBe('exact');
  expect(fidelity.notes).toEqual([]);
});

test('a bundle with fallbacks is reported as primary-locator-only', () => {
  const fidelity = describeStepFidelity(step({
    locator: { candidates: [{ kind: 'test_attribute', value: '#a' }, { kind: 'css', value: '.b' }] },
  }), 0);
  expect(fidelity.level).toBe('approximate');
  expect(fidelity.notes.join(' ')).toContain('Primary locator only');
});

test('a settle block is reported as not simulated, and a required signal is flagged on top', () => {
  const fidelity = describeStepFidelity(step({
    settle: {
      navigation: { url_pattern: '**/web/**' },
      responses: [{ url_pattern: '**/auth/login', method: 'POST', required: true }],
    },
  }), 0);
  expect(fidelity.level).toBe('not_simulated');
  expect(fidelity.notes.join(' ')).toContain('Settle not simulated');
  // P4.S.1 — an author who escalated a signal must not see a green preview that
  // never evaluated it.
  expect(fidelity.notes.join(' ')).toContain('required signal was not evaluated');
});

test('assertions the player can approximate are labelled, and the rest are not simulated', () => {
  expect(describeStepFidelity(step({ action: 'assert', assertion: { kind: 'element_visible' } }), 0).level)
      .toBe('approximate');
  expect(describeStepFidelity(step({ action: 'assert', assertion: { kind: 'element_text', expected: 'x' } }), 0).level)
      .toBe('approximate');
  for (const kind of ['element_not_visible', 'url_matches', 'page_title', 'element_attribute'] as const) {
    const fidelity = describeStepFidelity(step({ action: 'assert', assertion: { kind, expected: 'x' } }), 0);
    expect(fidelity.level, kind).toBe('not_simulated');
    expect(fidelity.notes.join(' '), kind).toContain('not simulated');
  }
});

test('flow control is reported rather than silently ignored', () => {
  const fidelity = describeStepFidelity(step({ optional: true }), 0);
  expect(fidelity.level).toBe('not_simulated');
  expect(fidelity.notes.join(' ')).toContain('Flow control not simulated');
});

test('a retired action and an upload are never reported as a pass', () => {
  expect(describeStepFidelity(step({ action: 'waitFor' as any }), 0).level).toBe('not_simulated');
  expect(describeStepFidelity(step({ action: 'setInputFiles' }), 0).level).toBe('not_simulated');
});


// ── Phase 3: settle capture fidelity ────────────────────────────────────────
//
// Two failure modes, opposite directions, both verified against a real
// recording. Neither can fail a run — settle signals are advisory — but a
// permanently-stale signal burns the full 30s settle budget on EVERY run and
// poisons the failure attribution of the next real failure.

const R = (url: string, over: Partial<Parameters<typeof isCausedBy>[0]> = {}) => ({
  url,
  method: 'GET',
  status: 200,
  contentType: 'application/json',
  timestamp: 1000,
  ...over,
});

test('a request that began before the action was not caused by it', () => {
  // The mis-attribution case: a call that normally fires during the PREVIOUS
  // step, delayed into this one's window. On replay the probe arms its watcher
  // at the start of this step, the call has already fired, and the signal is
  // stale forever.
  expect(isCausedBy(R('https://x.test/a', { initiatedAt: 100 }), 1000)).toBe(false);
  expect(isCausedBy(R('https://x.test/a', { initiatedAt: 1100 }), 1000)).toBe(true);
  // No timing available — keep today's behaviour rather than drop everything.
  expect(isCausedBy(R('https://x.test/a'), 1000)).toBe(true);
});

test('a response that beat its own action is still caused by it', () => {
  // Measured, not theorised: against a local server the response to a click
  // arrived 59ms BEFORE the click's own startTime, because an action is stamped
  // when the service worker hears about it and the injected recorder holds a
  // single click ~200ms first. Judging causality on the raw stamp discards the
  // one response the step most obviously caused — and the faster the backend,
  // the more reliably it is lost.
  const actionStart = 1000;
  expect(isCausedBy(R('https://x.test/a', { initiatedAt: actionStart - 59 }), actionStart)).toBe(true);
  expect(isCausedBy(
      R('https://x.test/a', { initiatedAt: actionStart - ACTION_REPORTING_LEAD_MS + 1 }), actionStart),
  ).toBe(true);
  expect(isCausedBy(
      R('https://x.test/a', { initiatedAt: actionStart - ACTION_REPORTING_LEAD_MS - 1 }), actionStart),
  ).toBe(false);

  // The window has to agree, or the response is dropped before causality is
  // ever consulted.
  expect(captureWindows([{ startTime: actionStart }])[0].start)
      .toBe(actionStart - ACTION_REPORTING_LEAD_MS);
});

test('a pattern seen while nothing was happening is background', () => {
  const idle = [R('https://x.test/api/v1/config', { timestamp: 5000 })];
  expect(isBackground(R('https://x.test/api/v1/config'), idle)).toBe(true);
  expect(isBackground(R('https://x.test/api/default/_search'), idle)).toBe(false);
});

test('identical steps keep identical signals — repetition is not the test', () => {
  // Three "Run Query" steps each firing **/_search SHOULD all carry it.
  // Counting occurrences across action windows would wrongly drop it; only
  // presence in an IDLE window marks a pattern as background.
  const idle = [R('https://x.test/api/v1/config', { timestamp: 5000 })];
  const search = R('https://x.test/api/default/_search', { method: 'POST' });
  for (let i = 0; i < 3; i++)
    expect(isBackground(search, idle)).toBe(false);
});

test('buildSettlePatterns drops background and uncaused responses', () => {
  const page = 'https://x.test/web/logs';
  const idle = [R('https://x.test/api/v1/config', { timestamp: 5000 })];
  const patterns = buildSettlePatterns(
    page,
    [
      // caused, first-party, not background — kept
      R('https://x.test/api/default/_search', { method: 'POST', initiatedAt: 1100 }),
      // polls during idle — dropped however often it appears here
      R('https://x.test/api/v1/config', { initiatedAt: 1100 }),
      // began well before the action, outside the reporting lead — dropped
      R('https://x.test/api/default/streams', { initiatedAt: 300 }),
    ],
    { actionStart: 1000, idleResponses: idle },
  );
  expect(patterns.map(p => p.url_pattern)).toEqual(['**/api/default/_search']);
});

test('with no options, capture behaves exactly as before', () => {
  // Existing callers must not silently start recording nothing.
  const patterns = buildSettlePatterns('https://x.test/web', [
    R('https://x.test/api/default/_search', { method: 'POST' }),
  ]);
  expect(patterns).toHaveLength(1);
});


// ── Phase 2: the configured test-id attribute ───────────────────────────────

test('a customer attribute outside upstream\'s fallback list is still a test attribute', () => {
  // Upstream hardcodes only data-testid / data-test-id / data-test, so an app on
  // data-qa had its strongest attribute stored as plain `css` — rank 3, behind
  // text. O2 worked by luck: `data-test` happens to be on that list.
  expect(classifySelector('[data-qa="submit"]')).toBe('css');
  setLocatorTestIdAttribute('data-qa');
  try {
    expect(classifySelector('[data-qa="submit"]')).toBe('test_attribute');
    // Upstream's own list keeps working alongside the configured one.
    expect(classifySelector('[data-test="submit"]')).toBe('test_attribute');
    expect(classifySelector('internal:testid=[data-qa="submit"]')).toBe('test_attribute');
  } finally {
    setLocatorTestIdAttribute('data-testid');
  }
});

test('a blank configured attribute falls back rather than matching everything', () => {
  setLocatorTestIdAttribute('   ');
  try {
    expect(classifySelector('[data-testid="x"]')).toBe('test_attribute');
    expect(classifySelector('.plain-class')).toBe('css');
  } finally {
    setLocatorTestIdAttribute('data-testid');
  }
});


// ── Phase 1 L3: framework-generated ids are not stable ids ──────────────────
//
// Upstream emits `#id` at kCSSIdScore (500), ahead of tag-name CSS, and filters
// only GUID-like values via isGuidLike. A per-render id from a component library
// is neither GUID-like nor stable — `#reka-popover-trigger-v-21` appeared in a
// real recording and changes on the next mount.

test('recognises per-render ids from the component libraries in use', () => {
  expect(isFrameworkGeneratedId('#reka-popover-trigger-v-21')).toBe(true);
  expect(isFrameworkGeneratedId('#reka-listbox-item-v-27')).toBe(true);
  // React useId
  expect(isFrameworkGeneratedId('#\\:r0\\:')).toBe(true);
  expect(isFrameworkGeneratedId('[id=":r1a:"]')).toBe(true);
  // Angular view encapsulation
  expect(isFrameworkGeneratedId('div[_ngcontent-abc-c12]')).toBe(true);
  // Emotion / styled-components hashed class
  expect(isFrameworkGeneratedId('.css-1q2w3e4')).toBe(true);
  // Vue scoped-style attribute
  expect(isFrameworkGeneratedId('div[data-v-7ba5bd90]')).toBe(true);
});

test('leaves author-written ids and classes alone', () => {
  expect(isFrameworkGeneratedId('#login-form')).toBe(false);
  expect(isFrameworkGeneratedId('#main-content > .row')).toBe(false);
  expect(isFrameworkGeneratedId('[data-test="login-sign-in"]')).toBe(false);
  expect(isFrameworkGeneratedId('internal:role=button[name="Save"i]')).toBe(false);
  // A word that merely contains "css-" is not a hashed class.
  expect(isFrameworkGeneratedId('.css-grid-wrapper')).toBe(false);
});

test('a framework id is flagged, not demoted', () => {
  // It used to sort last within its kind. Nothing sorts now — the predicate
  // stays because the editor mirrors it to warn per row, which is a better
  // outcome than an invisible reordering: `#reka-popover-trigger-v-21` changes
  // on the next mount, and the author is the only one who can act on that.
  expect(isFrameworkGeneratedId('#reka-popover-trigger-v-21')).toBe(true);
  const bundle = buildLocatorBundle([
    '#reka-popover-trigger-v-21',
    '.org-switcher > button',
  ]);
  expect(bundle?.candidates.map(c => c.value)).toEqual([
    '#reka-popover-trigger-v-21',
    '.org-switcher > button',
  ]);
});

// ── Action vocabulary: every recorder action maps, or fails loudly ──────────

test('an unmapped recorder action fails loudly instead of becoming a click', () => {
  // The forward mapper seeds `base` with action:'click' as a placeholder for the
  // switch to overwrite. Returning that placeholder from `default:` turned any
  // unmapped action into a click the user never performed — which is exactly how
  // 1.56's `hover` reached storage as a click for six minors.
  const action = {
    pageGuid: 'page',
    startTime: 0,
    action: { name: 'someFutureAction', selector: '#x', signals: [] },
  } as any;
  expect(() => mapActionToBrowserStep(action, 0)).toThrow(/unmapped recorder action: 'someFutureAction'/);
});

test('a recorded hover maps to a hover step, not to a click', () => {
  // Playwright 1.56 added `hover` to the recorder action model, reachable from the
  // action picker. Before it was mapped, the picker's Hover entry produced a step
  // indistinguishable from a click on the same element — and clicking a menu
  // trigger that was only meant to be hovered can navigate or submit.
  const recorded = {
    pageGuid: 'page',
    startTime: 0,
    action: { name: 'hover', selector: '#menu', signals: [] },
  } as any;

  const step = mapActionToBrowserStep(recorded, 0);
  expect(step.action).toBe('hover');
});

test('a hover step round-trips back to a hover action', () => {
  const stored = {
    id: 's1',
    action: 'hover',
    name: 'Hover Menu',
    pageAlias: 'page',
    framePath: [],
    startTime: 0,
    locator: { candidates: [{ kind: 'css', value: '#menu', origin: 'recorded' }] },
  } as any;

  expect(mapBrowserStepToAction(stored).action.name).toBe('hover');
});

test('hover is no longer reported as unsimulated', () => {
  // It was on this list only because upstream had no hover action at all. Now that
  // one exists and Frame.hover executes it, reporting "not simulated" would be
  // under-claiming a capability we have.
  expect(isUnsupportedReplayAction('hover')).toBe(false);
  expect(isUnsupportedReplayAction('scroll')).toBe(true);
  expect(isUnsupportedReplayAction('screenshot')).toBe(true);
});

test('a double click survives the round trip as two clicks', () => {
  // The picker offers "Double click" as an explicit choice, so this is a
  // deliberate recording, not an accident of event.detail.
  const recorded = {
    pageGuid: 'page',
    startTime: 0,
    action: { name: 'click', selector: '#x', button: 'left', modifiers: 0, clickCount: 2, signals: [] },
  } as any;

  const step = mapActionToBrowserStep(recorded, 0);
  expect(step.clickCount).toBe(2);

  const back = mapBrowserStepToAction(step);
  expect((back.action as any).clickCount).toBe(2);
});

test('a step with no clickCount replays as a single click', () => {
  // The compatibility half: every journey stored before this field existed omits
  // it, and must still mean one click.
  const stored = {
    id: 's1',
    action: 'click',
    name: 'Sign in',
    pageAlias: 'page',
    framePath: [],
    startTime: 0,
    locator: { candidates: [{ kind: 'css', value: '#x', origin: 'recorded' }] },
  } as any;

  const action = mapBrowserStepToAction(stored).action as any;
  expect(action.clickCount).toBe(1);
  expect(action.button).toBe('left');
});
