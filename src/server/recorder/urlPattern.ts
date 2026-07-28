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
 * Turning one observed URL into a pattern that will still match tomorrow.
 *
 * A recorded URL is a single sample: it contains the session's ids, the
 * session's timestamps, the session's tokens. Stored verbatim it would match
 * exactly once and go stale on the next run, generating annotation noise that
 * teaches authors to ignore annotations. Generalizing is what makes a recorded
 * navigation reusable as a wait condition.
 *
 * Deliberately a pure function over a string (spec P3.1.3): nothing here needs a
 * browser, so all of it is unit-testable, and the same rules can be reasoned
 * about without running a recording session.
 */

/** How long a run of digits must be before it reads as an id or a timestamp. */
const DIGIT_RUN = 4;
/** How long an opaque-looking token must be before it reads as a token. */
const TOKEN_LENGTH = 20;
/** How long a hex string must be before it reads as a hash or object id. */
const HEX_LENGTH = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS = /^\d+$/;
const HEX = /^[0-9a-f]+$/i;
const LONG_DIGIT_RUN = new RegExp(`\\d{${DIGIT_RUN},}`);
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a path segment is a value rather than a name.
 *
 * The test is conservative in one direction on purpose: wildcarding a segment
 * that was actually static costs a slightly looser pattern, while keeping a
 * segment that was actually an id costs a signal that goes stale on every single
 * run. The first mistake is invisible; the second is noise.
 */
export function isDynamicSegment(segment: string): boolean {
  if (!segment)
    return false;
  if (UUID.test(segment))
    return true;
  // A short number is often a legitimate route ("/v2/", "/2fa/"); a long one is
  // an id or a timestamp.
  if (ALL_DIGITS.test(segment))
    return segment.length >= 2;
  if (HEX.test(segment) && segment.length >= HEX_LENGTH)
    return true;
  // "order-10025512" — a name with an id glued onto it.
  if (LONG_DIGIT_RUN.test(segment))
    return true;
  if (OPAQUE_TOKEN.test(segment) && segment.length >= TOKEN_LENGTH && /\d/.test(segment))
    return true;
  return false;
}

/**
 * Generalize a recorded URL into a settle pattern, or `null` when there is
 * nothing worth waiting for.
 *
 * The origin becomes `**` so a monitor keeps working when it is pointed at a
 * different environment — the recorded origin already lives in the journey's
 * navigate step, and repeating it here would only make the pattern brittle. The
 * trailing `**` absorbs whatever the application appends after the route
 * settles, which single-page apps do constantly.
 *
 * Returns `null` for a URL with no path segments: "it navigated to the root"
 * generalizes to a pattern that matches nearly everything, which is not a wait
 * condition. The X-6 backstop already covers that case honestly.
 */
export function generalizeUrlPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // X-4: the query string is never recorded — it is the most likely place for a
  // session token or a customer identifier to appear.
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0)
    return null;

  const generalized = segments.map(s => (isDynamicSegment(s) ? '*' : s));
  return `**/${generalized.join('/')}/**`;
}

/**
 * Generalize a URL for a network settle signal (spec Phase 4).
 *
 * Same segment rules, but no trailing `**`: an endpoint is a specific path, and
 * absorbing everything after it would make `**\/api/users` also match
 * `/api/users/1/delete`.
 */
export function generalizeEndpointPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0)
    return null;
  const generalized = segments.map(s => (isDynamicSegment(s) ? '*' : s));
  return `**/${generalized.join('/')}`;
}

/** How many segments a pattern leaves to chance — the P4.1.6 stability rank. */
export function patternWildcardCount(pattern: string): number {
  return (pattern.match(/\*/g) ?? []).length;
}
