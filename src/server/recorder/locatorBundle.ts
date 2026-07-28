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
 * Turning the selector generator's ranked list into a stored locator bundle.
 *
 * The generator already produces several ways to find the same element; the
 * recorder used to keep only the first. Keeping the rest is what lets a monitor
 * survive a renamed class or a restructured DOM, because the runner can fall
 * back through them.
 *
 * Ordering is load-bearing and is not cosmetic. Candidates only agree while the
 * markup is unchanged; once it changes — the case fallback exists for — a
 * lower-ranked candidate may match a DIFFERENT element. So the list is ordered
 * by how much a kind survives change, and the runner breaks ties by rank rather
 * than by whichever answers first.
 */

export type LocatorKind = 'test_attribute' | 'role' | 'text' | 'css' | 'xpath';

export type LocatorCandidate = {
  kind: LocatorKind;
  value: string;
};

export type StepLocator = {
  candidates: LocatorCandidate[];
  /** Only an author sets this. The recorder never pins. */
  user_override?: LocatorCandidate | null;
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
 * Classify a single engine token.
 *
 * The generator emits its own prefixes (`internal:testid=`, `internal:role=`,
 * …), so reading the prefix is exact for one token — which is why the runner no
 * longer has to sniff the selector string with a regex.
 */
function classifyToken(token: string): LocatorKind {
  const s = token.trim();
  if (s.startsWith('internal:testid=') || s.startsWith('data-testid=') || /^\[data-test/.test(s))
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
 * Sorted by kind rank, stably — so the generator's own ordering still decides
 * between two candidates of the same kind, and the documented
 * `test_attribute → role → text → css/xpath` order holds across kinds.
 *
 * Capped, because each extra candidate costs probe time on every run of every
 * step forever, and the fifth way to find an element adds almost nothing once
 * the first four have failed.
 */
export function buildLocatorBundle(selectors: string[] | undefined, primary?: string): StepLocator | undefined {
  const all = selectors?.length ? selectors : primary ? [primary] : [];
  const seen = new Set<string>();
  const candidates = all
      .filter(s => {
        if (!s || seen.has(s))
          return false;
        seen.add(s);
        return true;
      })
      .map((value, index) => ({
        candidate: { kind: classifySelector(value), value },
        positional: isPositionalSelector(value),
        index,
      }))
      // Positionality outranks kind, because Playwright's own scoring says so:
      // `kNthScore` is 10000 against kind scores of 500-530. A candidate without
      // an index matched exactly one element when it was recorded; one with an
      // index did not. Better evidence of a WORSE kind still beats worse
      // evidence of a better one, and this restores the ordering spec P2.3.2
      // asks us to preserve rather than override. Sorting positional last
      // additionally means the cap below can no longer evict the only
      // unambiguous way to find the element.
      .sort((a, b) =>
        Number(a.positional) - Number(b.positional) ||
        KIND_RANK[a.candidate.kind] - KIND_RANK[b.candidate.kind] ||
        a.index - b.index)
      .slice(0, MAX_LOCATOR_CANDIDATES)
      .map(c => c.candidate);

  if (!candidates.length)
    return undefined;
  // `user_override` is absent, not null: the recorder has no opinion about which
  // candidate an author will want, and inventing one would make every recorded
  // step look deliberately pinned.
  return { candidates };
}

/**
 * The one selector a bundle resolves to for replay.
 *
 * A pin wins outright — an author who set `user_override` asked for that locator
 * and no other, so it is used exclusively and never falls back (spec P2.4.3).
 * Otherwise the primary candidate: the player resolves a single selector string
 * and does not implement the ordered fallback the probe does, so it replays
 * against `candidates[0]` and the step is reported `primary locator only`
 * (spec P2.S, X-8.2).
 *
 * Returns undefined for a bundle-less v1 step, whose identity is its bare
 * `selector` instead.
 */
export function effectiveSelector(locator: StepLocator | undefined): string | undefined {
  const pinned = locator?.user_override?.value;
  if (pinned)
    return pinned;
  return locator?.candidates?.[0]?.value || undefined;
}
