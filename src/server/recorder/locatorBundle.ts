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
 * Turning the selector generator's list into a stored locator bundle.
 *
 * The generator already produces several ways to find the same element; the
 * recorder used to keep only the first. Keeping the rest is what lets a monitor
 * survive a renamed class or a restructured DOM, because the runner can fall
 * back through them.
 *
 * **The order is Playwright's, verbatim. We do not decide it.**
 *
 * We used to. A KIND_RANK sort put `test_attribute` ahead of `role`, which
 * promoted an INDEXED testid above a unique role — and Phase 2a then added a
 * positional key to undo exactly that. Both were unnecessary: upstream's
 * `chooseFirstSelector` returns a unique candidate the moment it finds one and
 * only falls back to an indexed one when nothing matched uniquely, and
 * `generateSelector` pins `selectors[0]` byte-identical to the single-selector
 * answer. So `selectors[0]` is positional if and only if no unique locator
 * exists. Playwright's first choice was already right; our sort displaced it.
 *
 * Storing the order verbatim is what P2.3.2 asked for — "the requirement is to
 * classify and preserve it" — and it takes the mirrored KIND_RANK out of the
 * cross-repo surface entirely. What comes after position 0 is Playwright's push
 * order, which is quality-arbitrary; that no longer matters, because the author
 * owns the order from here (Phase 2b).
 */

export type LocatorKind = 'test_attribute' | 'role' | 'text' | 'css' | 'xpath';

/** How one part of a combined locator attaches to the part before it. */
export type CompositeRelation = 'and' | 'has' | 'has_not' | 'descendant';

export type CompositePart = {
  value: string;
  /** Absent on the first (base) part. */
  relation?: CompositeRelation;
};

export type LocatorCandidate = {
  kind: LocatorKind;
  value: string;
  /**
   * Where it came from. The recorder only ever writes `recorded`; the editor
   * writes the other two. It is the heal-suppression signal — healing may
   * replace a recorded value in place and must not touch anything else.
   */
  origin?: 'recorded' | 'authored' | 'composite';
  /** What a combined locator was built from. Editor-written, never recorded. */
  from?: CompositePart[];
};

export type StepLocator = {
  candidates: LocatorCandidate[];
  /**
   * A human has reordered, added, deleted or combined. The recorder never sets
   * it; a fresh recording is by definition not author-ordered.
   */
  author_ordered?: boolean;
};

/** ≤ 5 candidates per step — the same cap the schema enforces. */
export const MAX_LOCATOR_CANDIDATES = 5;

/**
 * Most survivable first.
 *
 * A test attribute exists to be selected on, so it changes only deliberately. A
 * role plus accessible name follows the element's meaning rather than its
 * markup. Text survives restyling but not copy edits or translation. CSS and
 * XPath describe structure, which is exactly what a redesign rewrites.
 *
 * This no longer ORDERS anything. It survives for `weakestLink`, which asks
 * which token in a chain is the least stable — a different question from which
 * candidate to try first, and one whose answer is a property of the string
 * rather than a preference.
 */
const KIND_RANK: Record<LocatorKind, number> = {
  test_attribute: 0,
  role: 1,
  text: 2,
  css: 3,
  xpath: 4,
};

/**
 * Engine tokens that select by position rather than by identity.
 *
 * Playwright appends one only when nothing identified the element uniquely
 * (`selectorGenerator.ts` `chooseFirstSelector`: it returns the tokens unchanged
 * on `result.length === 1`, and otherwise appends `nth`). Their presence is
 * therefore a direct record of "the recorder could not tell these elements
 * apart" — and their ABSENCE is a proof that the selector resolved to exactly
 * one element at record time. That proof is what makes demoting them safe: it
 * promotes verified-unique evidence over known-ambiguous evidence, never
 * something weaker.
 */
const POSITIONAL_TOKEN = /(?:^|>>)\s*nth=|:nth-match\(|:nth-child\(/;

/**
 * Does this selector depend on how many siblings happen to be on the page?
 *
 * Cheap and deliberately syntactic. A false positive is a demotion, never a
 * dropped candidate, so the failure mode is a slightly worse ordering rather
 * than a broken step. (A literal `:nth-child(` inside recorded text would be
 * one; no real page has produced it.)
 */
export function isPositionalSelector(selector: string): boolean {
  return POSITIONAL_TOKEN.test(selector);
}

/**
 * Ids and classes a component library mints per render.
 *
 * Upstream emits `#id` at `kCSSIdScore` (500) — ahead of tag-name CSS — and
 * filters only GUID-like values through `isGuidLike`. A per-render id is neither
 * GUID-like nor stable: `#reka-popover-trigger-v-21` appeared in a real
 * recording and changes on the next mount, so it is a candidate guaranteed to
 * break on the next deploy sitting above one that would not.
 *
 * Each pattern is anchored on the library's own prefix and requires the volatile
 * part, so an author-written `#main-content` or `.css-grid-wrapper` is untouched.
 * A false positive here is a demotion, never a dropped candidate.
 */
const FRAMEWORK_ID_PATTERNS: RegExp[] = [
  // Reka UI / Radix: #reka-popover-trigger-v-21, #radix-:r3:
  /[#[]?"?(?:reka|radix)-[\w-]*v?-?\d+/i,
  // React useId: :r0:, :r1a:. A CSS selector escapes both colons, so the closing
  // one arrives as `\:` — matching only the bare form missed every real case.
  /:r[0-9a-z]+\\?:/,
  // Angular view encapsulation: _ngcontent-abc-c12, _nghost-…
  /_ng(?:content|host)-/,
  // Emotion / styled-components hashed class: .css-1q2w3e4 (hash, not a word)
  /\.css-(?=[a-z0-9]*\d)[a-z0-9]{5,}\b/i,
  // Vue scoped styles: [data-v-7ba5bd90]
  /\[data-v-[0-9a-f]{6,}\]/i,
];

/**
 * Does this selector depend on an id the framework regenerates?
 *
 * Tracked separately from `kind` for the same reason positionality is: it says
 * how long the selector will keep working, not how the element was found.
 */
export function isFrameworkGeneratedId(selector: string): boolean {
  return FRAMEWORK_ID_PATTERNS.some(re => re.test(selector));
}

/**
 * Classify a single engine token.
 *
 * The generator emits its own prefixes (`internal:testid=`, `internal:role=`,
 * …), so reading the prefix is exact for one token — which is why the runner no
 * longer has to sniff the selector string with a regex.
 */
/**
 * The test-id attribute the current recording session was configured with.
 *
 * Upstream's generator hardcodes a fallback list — `data-testid`, `data-test-id`,
 * `data-test` — at `kOtherTestIdScore`, just behind whatever
 * `selectors.setTestIdAttribute` was given. O2's own markup uses `data-test`,
 * which happens to be on that list, so O2 recordings produce `test_attribute`
 * candidates by luck rather than by configuration.
 *
 * A customer on `data-qa`, `data-cy`, `data-pw` or `data-automation-id` gets
 * none: their strongest attribute is emitted as a plain CSS selector, the
 * hardcoded regex below does not recognise it, and it is stored as `css` —
 * rank 3, behind text. Their best selector becomes their fourth choice, silently.
 *
 * A module-level setting rather than a threaded parameter, mirroring
 * `playwright.selectors.setTestIdAttribute` which is global for the same reason:
 * the generator is called from deep inside the recorder with no config in scope.
 */
let configuredTestIdAttribute = 'data-testid';

/** Keep in step with `playwright.selectors.setTestIdAttribute` — see above. */
export function setLocatorTestIdAttribute(attr: string): void {
  configuredTestIdAttribute = attr.trim() || 'data-testid';
}

/** Upstream's own fallback list, which it scores just behind the configured one. */
const UPSTREAM_TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test'];

function isTestIdToken(s: string): boolean {
  if (s.startsWith('internal:testid=') || s.startsWith('data-testid='))
    return true;
  return [configuredTestIdAttribute, ...UPSTREAM_TEST_ID_ATTRS].some(attr =>
    s.startsWith(`[${attr}=`) || s.startsWith(`[${attr}]`));
}

function classifyToken(token: string): LocatorKind {
  const s = token.trim();
  if (isTestIdToken(s))
    return 'test_attribute';
  if (s.startsWith('internal:role=') || s.startsWith('role='))
    return 'role';
  if (
    s.startsWith('internal:text=') ||
    s.startsWith('internal:label=') ||
    s.startsWith('internal:has-text=') ||
    s.startsWith('internal:attr=[placeholder') ||
    s.startsWith('internal:attr=[alt') ||
    s.startsWith('internal:attr=[title') ||
    s.startsWith('text=')
  )
    return 'text';
  if (s.startsWith('xpath=') || s.startsWith('//') || s.startsWith('..'))
    return 'xpath';
  return 'css';
}

/**
 * The least stable identifying token in a chain.
 *
 * `A >> B` finds B within A, so the chain is only as stable as its least stable
 * link — a testid parent does not rescue a class-name child. A trailing `nth=`
 * is excluded because it says WHICH match to take, not HOW the element was
 * found; positionality is tracked separately by `isPositionalSelector`. Folding
 * it into the kind would destroy the information that identification WAS by test
 * attribute, which is exactly what the editor needs to explain the step.
 */
function weakestLink(selector: string): string {
  const parts = selector.split('>>').map(p => p.trim()).filter(Boolean);
  const identifying = parts.filter(p => !/^nth=/.test(p));
  if (!identifying.length)
    return selector.trim();
  return identifying.reduce((worst, part) =>
    KIND_RANK[classifyToken(part)] > KIND_RANK[classifyToken(worst)] ? part : worst);
}

/**
 * Classify one of Playwright's generated selectors, chain included.
 *
 * Prefix-only classification called `internal:testid=[data-test="row"] >> div.name`
 * a `test_attribute` and put it at the top of the rank. It is a class name away
 * from breaking, so it is `css`.
 */
export function classifySelector(selector: string): LocatorKind {
  return classifyToken(weakestLink(selector));
}

/**
 * Build the bundle stored on a step.
 *
 * Deduplicated, classified, capped — and otherwise in Playwright's order,
 * untouched. See the file header for why there is no sort here any more.
 *
 * Capped because each extra candidate costs probe time on every run of every
 * step forever, and the fifth way to find an element adds almost nothing once
 * the first four have failed. The cap is safe to apply to the generator's own
 * order: `selectors[0]` is upstream's considered best answer, so the entries it
 * removes are the ones upstream ranked last.
 */
export function buildLocatorBundle(selectors: string[] | undefined, primary?: string): StepLocator | undefined {
  const all = selectors?.length ? selectors : primary ? [primary] : [];
  const seen = new Set<string>();
  const candidates: LocatorCandidate[] = all
      .filter(s => {
        if (!s || seen.has(s))
          return false;
        seen.add(s);
        return true;
      })
      .slice(0, MAX_LOCATOR_CANDIDATES)
      .map(value => ({ kind: classifySelector(value), value, origin: 'recorded' as const }));

  if (!candidates.length)
    return undefined;
  // `author_ordered` is absent, not false: a fresh recording has no author
  // intent in it, and writing the field would claim someone had looked.
  return { candidates };
}

/**
 * The one selector a bundle resolves to for replay.
 *
 * The first candidate, and nothing else. The player resolves a single selector
 * string and does not implement the ordered fallback the probe does, so it
 * replays against `candidates[0]` and the step is reported `primary locator
 * only` (spec P2.S, X-8.2).
 *
 * There used to be a pin branch in front of this. With the author owning the
 * order, "use this one" IS position 0 — the same answer, without a second
 * channel that had to be checked in three separate copies of this function.
 */
export function effectiveSelector(locator: StepLocator | undefined): string | undefined {
  return locator?.candidates?.[0]?.value || undefined;
}
