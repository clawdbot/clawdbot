import { AVATAR_MAX_BYTES } from "../../../src/shared/avatar-limits.js";
import {
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
  resolveTrustedAvatarUrl,
} from "./identity-avatar.ts";

const IDENTITY_AVATAR_CACHE_MAX_ENTRIES = 128;
const IDENTITY_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const IDENTITY_AVATAR_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type CachedIdentityAvatar = {
  blobUrl: string | null;
  loaded: boolean;
  promise: Promise<string | null>;
};

const identityAvatarCache = new Map<string, CachedIdentityAvatar>();

function clearIdentityAvatarCache(): void {
  for (const entry of identityAvatarCache.values()) {
    if (entry.blobUrl) {
      URL.revokeObjectURL(entry.blobUrl);
    }
  }
  identityAvatarCache.clear();
}

// The loader is lazy, but once loaded it must release blobs immediately when
// the owning Gateway or credential context changes.
registerAvatarGatewayReset(clearIdentityAvatarCache);

function trimIdentityAvatarCache(protectedEntry?: CachedIdentityAvatar): void {
  while (identityAvatarCache.size > IDENTITY_AVATAR_CACHE_MAX_ENTRIES) {
    let evicted = false;
    for (const [key, entry] of identityAvatarCache) {
      // Pending consumers still need their eventual blob. Only completed LRU
      // entries may be evicted; the request currently resolving stays valid.
      if (!entry.blobUrl || !entry.loaded || entry === protectedEntry) {
        continue;
      }
      identityAvatarCache.delete(key);
      URL.revokeObjectURL(entry.blobUrl);
      evicted = true;
      break;
    }
    if (!evicted) {
      break;
    }
  }
}

function loadIdentityAvatar(url: string): string | Promise<string | null> {
  const cached = identityAvatarCache.get(url);
  if (cached) {
    // Map order is the LRU order; concurrent roster, profile, and chat views
    // must share both the authenticated request and its resulting blob.
    identityAvatarCache.delete(url);
    identityAvatarCache.set(url, cached);
    return cached.loaded && cached.blobUrl ? cached.blobUrl : cached.promise;
  }

  const entry: CachedIdentityAvatar = {
    blobUrl: null,
    loaded: false,
    promise: Promise.resolve(null),
  };
  const { authHeader } = readAvatarGatewayContext();
  entry.promise = (async () => {
    try {
      const response = await fetch(url, {
        credentials: "include",
        ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
        signal: AbortSignal.timeout(IDENTITY_AVATAR_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      if (
        blob.size === 0 ||
        blob.size > AVATAR_MAX_BYTES ||
        !IDENTITY_AVATAR_MIME_TYPES.has(blob.type.toLowerCase())
      ) {
        return null;
      }
      const blobUrl = URL.createObjectURL(blob);
      // A gateway or credential change can finish while its old request is in
      // flight. Never publish an image into the replacement security context.
      if (identityAvatarCache.get(url) !== entry) {
        URL.revokeObjectURL(blobUrl);
        return null;
      }
      entry.blobUrl = blobUrl;
      trimIdentityAvatarCache(entry);
      return blobUrl;
    } catch {
      return null;
    } finally {
      if (!entry.blobUrl && identityAvatarCache.get(url) === entry) {
        // Transient failures and uncached 404s must not hide a later upload.
        identityAvatarCache.delete(url);
      }
    }
  })();
  identityAvatarCache.set(url, entry);
  trimIdentityAvatarCache(entry);
  return entry.promise;
}

/** Fetch connected-gateway profile images once and render CSP-safe blobs. */
export function resolveAvatarImageUrl(value: string): string | Promise<string | null> | null {
  const { authHeader, origin, resourceBasePath } = readAvatarGatewayContext();
  const trusted = resolveTrustedAvatarUrl(value, origin, resourceBasePath);
  if (!trusted) {
    return null;
  }
  // Connected same-origin routes need the loader too: it resolves a missing
  // avatar before Lit can reconcile an <img> error back over its initials.
  const pageOrigin = globalThis.location?.origin;
  const crossOrigin = pageOrigin ? new URL(trusted, pageOrigin).origin !== pageOrigin : false;
  return origin || authHeader || crossOrigin ? loadIdentityAvatar(trusted) : trusted;
}

/** A blob stays live until its image has finished loading or definitively failed. */
export function settleAvatarImageUrl(value: string | null): void {
  if (!value?.startsWith("blob:")) {
    return;
  }
  for (const entry of identityAvatarCache.values()) {
    if (entry.blobUrl === value) {
      entry.loaded = true;
      trimIdentityAvatarCache();
      return;
    }
  }
}
