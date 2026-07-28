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
};

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
 * Turn the responses observed during one action into settle patterns.
 *
 * Ranking is by stability, not by recency: a pattern with fewer wildcards
 * describes a more specific endpoint and is less likely to be matched by
 * something unrelated. Ties break on observation order, so a deterministic
 * recording produces a deterministic bundle.
 */
export function buildSettlePatterns(
  pageUrl: string,
  responses: CapturedResponse[],
): SettleResponsePattern[] {
  const seen = new Set<string>();
  const candidates: Array<{ pattern: SettleResponsePattern; wildcards: number; order: number }> = [];

  responses.forEach((response, order) => {
    if (!isCandidateSignal(pageUrl, response))
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

  clear() {
    this._responses = [];
  }
}
