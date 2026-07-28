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
 * Classify one of Playwright's generated selectors.
 *
 * The generator emits its own engine prefixes (`internal:testid=`,
 * `internal:role=`, …). Reading the prefix is exact, which is why the runner no
 * longer has to sniff the selector string with a regex to decide how strictly to
 * match it.
 */
export function classifySelector(selector: string): LocatorKind {
  const s = selector.trim();
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
      .map((value, index) => ({ candidate: { kind: classifySelector(value), value }, index }))
      .sort((a, b) => KIND_RANK[a.candidate.kind] - KIND_RANK[b.candidate.kind] || a.index - b.index)
      .slice(0, MAX_LOCATOR_CANDIDATES)
      .map(c => c.candidate);

  if (!candidates.length)
    return undefined;
  // `user_override` is absent, not null: the recorder has no opinion about which
  // candidate an author will want, and inventing one would make every recorded
  // step look deliberately pinned.
  return { candidates };
}
