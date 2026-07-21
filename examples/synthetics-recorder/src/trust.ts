/**
 * Trust model for the synthetics recorder extension.
 *
 * Guards access when `externally_connectable` is removed — any page with the
 * content-script bridge can potentially send commands. The trust model replaces
 * Chrome's origin gate with an application-level one.
 *
 * Detachable: flip `TRUST_ENABLED` to `false` to bypass all trust checks.
 * All trust logic is in this single file — delete it to remove the subsystem entirely.
 */

// ---- Configuration ----

/** Set to `false` to disable all trust checks. Commands pass straight through. */
export const TRUST_ENABLED = true;

// ---- Pre-trusted origins ----

/** Origins that are always trusted — no storage entry, no prompt. */
const PRE_TRUSTED: RegExp[] = [
  /^https:\/\/[a-zA-Z0-9.-]*openobserve\.ai$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

export function isPreTrustedOrigin(origin: string): boolean {
  return PRE_TRUSTED.some(p => p.test(origin));
}

// ---- Persistent storage (chrome.storage.local) ----

const TRUSTED_ORIGINS_KEY = 'trustedOrigins';

export async function getTrustedOrigins(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(TRUSTED_ORIGINS_KEY);
    const origins = stored[TRUSTED_ORIGINS_KEY];
    return Array.isArray(origins) ? origins as string[] : [];
  } catch {
    return [];
  }
}

export async function grantTrust(origin: string): Promise<void> {
  const origins = await getTrustedOrigins();
  if (!origins.includes(origin)) {
    await chrome.storage.local.set({ [TRUSTED_ORIGINS_KEY]: [...origins, origin] });
  }
}

export async function revokeTrust(origin: string): Promise<void> {
  const origins = await getTrustedOrigins();
  await chrome.storage.local.set({
    [TRUSTED_ORIGINS_KEY]: origins.filter(o => o !== origin),
  });
}

// ---- Session-level deny cache (cleared on SW restart) ----

const deniedThisSession = new Set<string>();

export function denyOriginThisSession(origin: string): void {
  deniedThisSession.add(origin);
}

// ---- Trust check ----

export type TrustStatus = 'trusted' | 'denied-this-session' | 'unknown';

/**
 * Resolve an origin's trust status. Order:
 * 1. Trust disabled globally? → trusted
 * 2. Pre-trusted pattern? → trusted
 * 3. Denied this session? → denied-this-session (silent drop, no re-prompt)
 * 4. In user-granted storage? → trusted
 * 5. Otherwise → unknown (show prompt)
 */
export async function checkTrust(origin: string): Promise<TrustStatus> {
  if (!TRUST_ENABLED) return 'trusted';
  if (isPreTrustedOrigin(origin)) return 'trusted';
  if (deniedThisSession.has(origin)) return 'denied-this-session';

  const origins = await getTrustedOrigins();
  if (origins.includes(origin)) return 'trusted';

  return 'unknown';
}
