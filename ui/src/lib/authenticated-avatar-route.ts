type AvatarRouteEntry = {
  blobUrl: string | null;
  consumers: Map<symbol, () => void>;
  controller: AbortController;
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
};

/** Bound protected avatar fetches so a stalled Gateway route cannot pin UI state forever. */
const AUTHENTICATED_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const sharedAvatarRoutes = new Map<string, AvatarRouteEntry>();

function avatarRouteKey(
  url: string,
  authTokens: readonly string[],
  cacheNotFound: boolean,
): string {
  return `${cacheNotFound ? "stable-miss" : "retry-miss"}\0${authTokens.join("")}\0${url}`;
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
    sharedAvatarRoutes.delete(key);
    entry.controller.abort();
    if (entry.blobUrl) {
      URL.revokeObjectURL(entry.blobUrl);
    }
  }, 0);
}

async function fetchAvatarRoute(
  key: string,
  url: string,
  authTokens: readonly string[],
  cacheNotFound: boolean,
  entry: AvatarRouteEntry,
) {
  const timeout = setTimeout(() => entry.controller.abort(), AUTHENTICATED_AVATAR_FETCH_TIMEOUT_MS);
  let blobUrl: string | null = null;
  let notFound = false;
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
    // Avatar misses stay retryable because a later identity publication may make the route valid.
    sharedAvatarRoutes.delete(key);
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
export class AuthenticatedAvatarRouteLoader {
  private readonly owner = Symbol("authenticated-avatar-route-owner");
  private keys = new Set<string>();

  constructor(
    private readonly onUpdate: () => void,
    private readonly options: { cacheNotFound?: boolean } = {},
  ) {}

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
    const cacheNotFound = this.options.cacheNotFound === true;
    const key = avatarRouteKey(url, authTokens, cacheNotFound);
    let entry = sharedAvatarRoutes.get(key);
    if (!entry) {
      entry = {
        blobUrl: null,
        consumers: new Map(),
        controller: new AbortController(),
        releaseTimer: undefined,
      };
      sharedAvatarRoutes.set(key, entry);
      void fetchAvatarRoute(key, url, authTokens, cacheNotFound, entry);
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
