import type { ReactiveController, ReactiveControllerHost } from "lit";

type AvatarRouteEntry = {
  blobUrl: string | null;
  consumers: Map<symbol, () => void>;
  controller: AbortController;
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempts: number;
  retryEligibleAt: number | undefined;
};

/** Bound protected avatar fetches so a stalled Gateway route cannot pin UI state forever. */
const AUTHENTICATED_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const AUTHENTICATED_AVATAR_MAX_RETRY_AFTER_MS = 30_000;
const AUTHENTICATED_AVATAR_MAX_RETRIES = 3;
const AUTHENTICATED_AVATAR_RETRY_COOLDOWN_MS = 30_000;
const sharedAvatarRoutes = new Map<string, AvatarRouteEntry>();

function retryAfterMs(response: Response): number | undefined {
  if (response.status !== 503) {
    return undefined;
  }
  // Gateway-owned avatar routes use the delta-seconds form. Reject absent,
  // malformed, immediate, or long-lived hints so one response cannot create an
  // unbounded polling or retention loop in the shared loader.
  const value = response.headers?.get("retry-after")?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const delayMs = Number(value) * 1_000;
  return Number.isSafeInteger(delayMs) &&
    delayMs > 0 &&
    delayMs <= AUTHENTICATED_AVATAR_MAX_RETRY_AFTER_MS
    ? delayMs
    : undefined;
}

function deleteEntry(key: string, entry: AvatarRouteEntry) {
  if (sharedAvatarRoutes.get(key) !== entry) {
    return;
  }
  sharedAvatarRoutes.delete(key);
  if (entry.retryTimer !== undefined) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }
  entry.controller.abort();
  if (entry.blobUrl) {
    URL.revokeObjectURL(entry.blobUrl);
  }
}

function avatarRouteKey(
  url: string,
  authTokens: readonly string[],
  cacheNotFound: boolean,
  retryUnavailable: boolean,
): string {
  return `${cacheNotFound ? "stable-miss" : "retry-miss"}\0${retryUnavailable ? "retry-503" : "drop-503"}\0${authTokens.join("")}\0${url}`;
}

function releaseEntry(key: string, owner: symbol) {
  const entry = sharedAvatarRoutes.get(key);
  if (!entry) {
    return;
  }
  entry.consumers.delete(owner);
  if (entry.consumers.size > 0 || entry.releaseTimer !== undefined) {
    return;
  }
  // Lit can replace one route consumer with another in a later microtask. Finalize
  // unowned routes on the next task so the shared request survives that DOM handoff.
  entry.releaseTimer = setTimeout(() => {
    entry.releaseTimer = undefined;
    if (sharedAvatarRoutes.get(key) !== entry || entry.consumers.size > 0) {
      return;
    }
    deleteEntry(key, entry);
  }, 0);
}

async function fetchAvatarRoute(
  key: string,
  url: string,
  authTokens: readonly string[],
  cacheNotFound: boolean,
  retryUnavailable: boolean,
  entry: AvatarRouteEntry,
) {
  const timeout = setTimeout(() => entry.controller.abort(), AUTHENTICATED_AVATAR_FETCH_TIMEOUT_MS);
  let blobUrl: string | null = null;
  let notFound = false;
  let retryDelayMs: number | undefined;
  try {
    // Ordered credential recovery: a saved token can be stale while the session's
    // password is valid, so a rejected credential falls through to the next one
    // instead of silently leaving the caller on its fallback forever.
    for (const authToken of authTokens.length > 0 ? authTokens : [""]) {
      const response = await fetch(url, {
        ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
        signal: entry.controller.signal,
      });
      if (response.ok) {
        blobUrl = URL.createObjectURL(await response.blob());
        break;
      }
      notFound = response.status === 404;
      retryDelayMs = retryUnavailable ? retryAfterMs(response) : undefined;
      if (response.status !== 401 && response.status !== 403) {
        break;
      }
    }
  } catch {
    // A missing image leaves the owning view's existing text/mascot fallback visible.
  } finally {
    clearTimeout(timeout);
  }

  if (sharedAvatarRoutes.get(key) !== entry) {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
    return;
  }
  if (!blobUrl) {
    if (notFound && cacheNotFound) {
      return;
    }
    if (retryDelayMs !== undefined && entry.consumers.size > 0) {
      if (entry.retryAttempts < AUTHENTICATED_AVATAR_MAX_RETRIES) {
        entry.retryAttempts += 1;
        // The budget belongs to this persistent shared entry. Keeping an
        // exhausted miss prevents Lit rerenders from minting a new poll loop.
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = undefined;
          if (sharedAvatarRoutes.get(key) !== entry || entry.consumers.size === 0) {
            return;
          }
          entry.controller = new AbortController();
          void fetchAvatarRoute(key, url, authTokens, cacheNotFound, retryUnavailable, entry);
        }, retryDelayMs);
      } else {
        // Keep the exhausted entry through a cooldown so render churn cannot
        // remint the budget. A later render may start a fresh bounded window.
        entry.retryEligibleAt = Date.now() + AUTHENTICATED_AVATAR_RETRY_COOLDOWN_MS;
      }
      return;
    }
    // Avatar misses stay retryable because a later identity publication may make the route valid.
    deleteEntry(key, entry);
    return;
  }
  entry.blobUrl = blobUrl;
  for (const update of entry.consumers.values()) {
    update();
  }
}

/**
 * Resolves protected same-origin avatar routes to one browser-local blob shared by all views.
 * The owning view releases its reference on credential change or disconnect.
 */
export class AuthenticatedAvatarRouteLoader implements ReactiveController {
  private readonly owner = Symbol("authenticated-avatar-route-owner");
  private keys = new Set<string>();
  private connected = false;
  private readonly onUpdate = () => {
    if (this.connected) {
      this.host.requestUpdate();
    }
  };

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: { cacheNotFound?: boolean; retryUnavailable?: boolean } = {},
  ) {
    host.addController(this);
  }

  hostConnected() {
    this.connected = true;
    this.host.requestUpdate();
  }

  hostDisconnected() {
    this.connected = false;
    this.reset();
  }

  reset() {
    for (const key of this.keys) {
      releaseEntry(key, this.owner);
    }
    this.keys.clear();
  }

  withActiveRoutes<T>(render: () => T): T {
    const previousKeys = this.keys;
    this.keys = new Set();
    try {
      return render();
    } finally {
      for (const key of previousKeys) {
        if (!this.keys.has(key)) {
          releaseEntry(key, this.owner);
        }
      }
    }
  }

  /** `authTokens` is an ordered candidate list; a rejected credential falls through to the next. */
  resolve(url: string, authTokens: readonly string[]): string | null {
    if (!url.startsWith("/")) {
      return url;
    }
    // Lit can finish a queued render after disconnect. That render must not
    // reacquire a released route and keep an orphaned request or retry alive.
    if (!this.connected) {
      return null;
    }
    const cacheNotFound = this.options.cacheNotFound === true;
    const retryUnavailable = this.options.retryUnavailable === true;
    const key = avatarRouteKey(url, authTokens, cacheNotFound, retryUnavailable);
    let entry = sharedAvatarRoutes.get(key);
    if (!entry) {
      entry = {
        blobUrl: null,
        consumers: new Map(),
        controller: new AbortController(),
        releaseTimer: undefined,
        retryTimer: undefined,
        retryAttempts: 0,
        retryEligibleAt: undefined,
      };
      sharedAvatarRoutes.set(key, entry);
      void fetchAvatarRoute(key, url, authTokens, cacheNotFound, retryUnavailable, entry);
    } else if (
      entry.blobUrl === null &&
      entry.retryTimer === undefined &&
      entry.retryEligibleAt !== undefined &&
      Date.now() >= entry.retryEligibleAt
    ) {
      entry.retryAttempts = 0;
      entry.retryEligibleAt = undefined;
      entry.controller = new AbortController();
      void fetchAvatarRoute(key, url, authTokens, cacheNotFound, retryUnavailable, entry);
    }
    if (entry.releaseTimer !== undefined) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = undefined;
    }
    entry.consumers.set(this.owner, this.onUpdate);
    this.keys.add(key);
    return entry.blobUrl;
  }
}
