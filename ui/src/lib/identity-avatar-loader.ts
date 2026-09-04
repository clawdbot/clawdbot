import { AVATAR_MAX_BYTES } from "../../../src/shared/avatar-limits.js";
import {
  fetchGatewayContextResource,
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "./identity-avatar-context.ts";
import { resolveTrustedAvatarUrl } from "./identity-avatar.ts";

const IDENTITY_AVATAR_CACHE_MAX_ENTRIES = 128;
const IDENTITY_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const IDENTITY_AVATAR_FAILURE_TTL_MS = 60_000;
// Agent identity files also support SVG; these blobs render only as <img>, never inline markup.
const IDENTITY_AVATAR_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

type CachedIdentityAvatar = {
  blobUrl: string | null;
  settled: boolean;
  retryAt?: number;
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

function trimIdentityAvatarCache(): void {
  for (const [key, entry] of identityAvatarCache) {
    if (identityAvatarCache.size <= IDENTITY_AVATAR_CACHE_MAX_ENTRIES) {
      break;
    }
    // Pending consumers still need their eventual blob. Evict only settled
    // images or misses, in the Map's LRU order.
    if (!entry.settled) {
      continue;
    }
    identityAvatarCache.delete(key);
    if (entry.blobUrl) {
      URL.revokeObjectURL(entry.blobUrl);
    }
  }
}

function loadIdentityAvatar(url: string): string | Promise<string | null> {
  const cached = identityAvatarCache.get(url);
  // Map order is the LRU order; concurrent roster, profile, and chat views
  // share the authenticated request and its result, including a cached miss.
  identityAvatarCache.delete(url);
  if (cached && (cached.retryAt === undefined || Date.now() < cached.retryAt)) {
    identityAvatarCache.set(url, cached);
    return cached.settled && cached.blobUrl ? cached.blobUrl : cached.promise;
  }

  const entry: CachedIdentityAvatar = {
    blobUrl: null,
    settled: false,
    promise: Promise.resolve(null),
  };
  entry.promise = (async () => {
    try {
      const response = await fetchGatewayContextResource(url, IDENTITY_AVATAR_FETCH_TIMEOUT_MS);
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
      trimIdentityAvatarCache();
      return blobUrl;
    } catch {
      return null;
    } finally {
      if (!entry.blobUrl && identityAvatarCache.get(url) === entry) {
        // Incidental rerenders share misses; expiry lets unversioned uploads and
        // transient failures recover. New revisions or credentials bypass the miss.
        entry.settled = true;
        entry.retryAt = Date.now() + IDENTITY_AVATAR_FAILURE_TTL_MS;
        trimIdentityAvatarCache();
      }
    }
  })();
  identityAvatarCache.set(url, entry);
  trimIdentityAvatarCache();
  return entry.promise;
}

/** Fetch connected-gateway profile images once and render CSP-safe blobs. */
export function resolveAvatarImageUrl(value: string): string | Promise<string | null> | null {
  const { authTokens, origin, resourceBasePath } = readAvatarGatewayContext();
  const trusted = resolveTrustedAvatarUrl(value, origin, resourceBasePath);
  if (!trusted) {
    return null;
  }
  // Connected same-origin routes need the loader too: it resolves a missing
  // avatar before Lit can reconcile an <img> error back over its initials.
  return origin || authTokens.length ? loadIdentityAvatar(trusted) : trusted;
}

/** A blob stays live until its image has finished loading or definitively failed. */
export function settleAvatarImageUrl(value: string | null): void {
  if (!value?.startsWith("blob:")) {
    return;
  }
  for (const entry of identityAvatarCache.values()) {
    if (entry.blobUrl === value) {
      entry.settled = true;
      trimIdentityAvatarCache();
      return;
    }
  }
}
