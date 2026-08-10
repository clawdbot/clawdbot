type AvatarRouteEntry = {
  blobUrl: string | null;
  consumers: Map<symbol, () => void>;
  controller: AbortController;
};

/** Bound protected avatar fetches so a stalled Gateway route cannot pin UI state forever. */
const AUTHENTICATED_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const sharedAvatarRoutes = new Map<string, AvatarRouteEntry>();

function avatarRouteKey(url: string, authToken: string | null): string {
  return `${authToken ?? ""}\0${url}`;
}

function releaseEntry(key: string, owner: symbol) {
  const entry = sharedAvatarRoutes.get(key);
  if (!entry) {
    return;
  }
  entry.consumers.delete(owner);
  if (entry.consumers.size > 0) {
    return;
  }
  sharedAvatarRoutes.delete(key);
  entry.controller.abort();
  if (entry.blobUrl) {
    URL.revokeObjectURL(entry.blobUrl);
  }
}

async function fetchAvatarRoute(
  key: string,
  url: string,
  authToken: string | null,
  entry: AvatarRouteEntry,
) {
  const timeout = setTimeout(() => entry.controller.abort(), AUTHENTICATED_AVATAR_FETCH_TIMEOUT_MS);
  let blobUrl: string | null = null;
  try {
    const response = await fetch(url, {
      ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
      signal: entry.controller.signal,
    });
    if (response.ok) {
      blobUrl = URL.createObjectURL(await response.blob());
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
    // Do not cache misses: a later identity publication may make this stable route valid.
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
  private readonly keys = new Set<string>();

  constructor(private readonly onUpdate: () => void) {}

  reset() {
    for (const key of this.keys) {
      releaseEntry(key, this.owner);
    }
    this.keys.clear();
  }

  resolve(url: string, authToken: string | null): string | null {
    if (!url.startsWith("/")) {
      return url;
    }
    const key = avatarRouteKey(url, authToken);
    let entry = sharedAvatarRoutes.get(key);
    if (!entry) {
      entry = {
        blobUrl: null,
        consumers: new Map(),
        controller: new AbortController(),
      };
      sharedAvatarRoutes.set(key, entry);
      void fetchAvatarRoute(key, url, authToken, entry);
    }
    entry.consumers.set(this.owner, this.onUpdate);
    this.keys.add(key);
    return entry.blobUrl;
  }
}
