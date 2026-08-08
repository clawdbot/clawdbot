import { AVATAR_MAX_BYTES } from "../../../src/shared/avatar-limits.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { formatSenderLabel, type SenderIdentity } from "./chat/sender-label.ts";
import { fnv1aUtf16 } from "./fnv1a.ts";

// NOTE: this is sender-controlled metadata. It must never carry the trusted
// gateway origin — that comes only from the app connection via
// setAvatarGatewayOrigin().
export type IdentityAvatarInput = SenderIdentity & {
  profileAvatarUrl?: string;
};

const ORIGIN_PROBE = "https://origin-probe.invalid";

let appGatewayOrigin: string | null = null;
let appGatewayBasePath = "";
let appGatewayAuthHeader: string | null = null;

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

function toHttpOrigin(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const scheme =
      parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${scheme}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** Keeps avatar routes, credentials, and cached images scoped to the current gateway. */
export function setAvatarGatewayOrigin(
  gatewayUrl: string | null | undefined,
  authHeader: string | null = null,
  controlUiBasePath = "",
): void {
  const nextOrigin = toHttpOrigin(gatewayUrl);
  const documentOrigin = globalThis.location?.origin;
  const nextBasePath =
    nextOrigin && documentOrigin === nextOrigin ? normalizeBasePath(controlUiBasePath) : "";
  const nextAuthHeader = authHeader?.trim() || null;
  if (
    appGatewayOrigin !== nextOrigin ||
    appGatewayBasePath !== nextBasePath ||
    appGatewayAuthHeader !== nextAuthHeader
  ) {
    clearIdentityAvatarCache();
  }
  appGatewayOrigin = nextOrigin;
  appGatewayBasePath = nextBasePath;
  appGatewayAuthHeader = nextAuthHeader;
}

// Mirrors the server's user-profiles-http-path matcher. Sender metadata may
// point only at this image route, never another gateway endpoint.
const USER_AVATAR_PATHNAME = /^\/api\/users\/[^/]+\/avatar$/u;

/**
 * Returns a browser-safe avatar URL, or null. Only the canonical
 * /api/users/<id>/avatar route is trusted (pathname pinned, fragment dropped).
 * The query is preserved: the gateway stamps a ?v=<updatedAt> revision there so
 * replacing an image invalidates its bounded authenticated blob-cache entry.
 * Relative paths resolve against the trusted gateway origin; absolute URLs
 * must match that origin.
 */
function toTrustedAvatarUrl(value: string, gatewayOrigin: string | null): string | null {
  try {
    const parsed = new URL(value, ORIGIN_PROBE);
    const relativeRoute = parsed.origin === ORIGIN_PROBE;
    const canonicalPathname = relativeRoute
      ? parsed.pathname
      : appGatewayBasePath && parsed.pathname.startsWith(`${appGatewayBasePath}/`)
        ? parsed.pathname.slice(appGatewayBasePath.length)
        : parsed.pathname;
    if (!USER_AVATAR_PATHNAME.test(canonicalPathname)) {
      return null;
    }
    const suffix = `${appGatewayBasePath}${canonicalPathname}${parsed.search}`;
    if (relativeRoute) {
      return gatewayOrigin ? new URL(suffix, gatewayOrigin).toString() : suffix;
    }
    return gatewayOrigin && parsed.origin === gatewayOrigin ? gatewayOrigin + suffix : null;
  } catch {
    return null;
  }
}

function loadIdentityAvatar(url: string): string | Promise<string | null> {
  const cacheKey = url;
  const cached = identityAvatarCache.get(cacheKey);
  if (cached) {
    // Map order is the LRU order; concurrent roster, profile, and chat views
    // must share both the authenticated request and its resulting blob.
    identityAvatarCache.delete(cacheKey);
    identityAvatarCache.set(cacheKey, cached);
    return cached.loaded && cached.blobUrl ? cached.blobUrl : cached.promise;
  }

  const entry: CachedIdentityAvatar = {
    blobUrl: null,
    loaded: false,
    promise: Promise.resolve(null),
  };
  const authHeader = appGatewayAuthHeader;
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
      if (identityAvatarCache.get(cacheKey) !== entry) {
        URL.revokeObjectURL(blobUrl);
        return null;
      }
      entry.blobUrl = blobUrl;
      trimIdentityAvatarCache(entry);
      return blobUrl;
    } catch {
      return null;
    } finally {
      if (!entry.blobUrl && identityAvatarCache.get(cacheKey) === entry) {
        // Transient failures and uncached 404s must not hide a later upload.
        identityAvatarCache.delete(cacheKey);
      }
    }
  })();
  identityAvatarCache.set(cacheKey, entry);
  trimIdentityAvatarCache(entry);

  return entry.promise;
}

/** Fetch connected-gateway profile images once and render CSP-safe blobs. */
export function resolveAvatarImageUrl(value: string): string | Promise<string | null> | null {
  const trusted = toTrustedAvatarUrl(value, appGatewayOrigin);
  if (!trusted) {
    return null;
  }
  // Connected same-origin routes need the loader too: it resolves a missing
  // avatar before Lit can reconcile an <img> error back over its initials.
  const pageOrigin = globalThis.location?.origin;
  const crossOrigin = pageOrigin ? new URL(trusted, pageOrigin).origin !== pageOrigin : false;
  return appGatewayOrigin || appGatewayAuthHeader || crossOrigin
    ? loadIdentityAvatar(trusted)
    : trusted;
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

export type ResolvedIdentityAvatar =
  | { kind: "profile"; url: string }
  | { kind: "initials"; initials: string; colorSeed: number };

function initialsFromLabel(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  const initials = words.map((word) => Array.from(word)[0] ?? "").join("");
  return initials.toUpperCase() || "?";
}

export function resolveAvatarInitials(
  input: IdentityAvatarInput,
): Extract<ResolvedIdentityAvatar, { kind: "initials" }> {
  const id = input.id?.trim();
  const label = formatSenderLabel(input) ?? "?";
  return {
    kind: "initials",
    initials: initialsFromLabel(label),
    colorSeed: fnv1aUtf16(id || label),
  };
}

/**
 * Stable identity hue (0-359) shared by avatar initials and per-sender chat
 * bubble tints; both must derive from the same seed or a user's bubble and
 * avatar drift apart. Lightness/alpha stay theme-owned in CSS.
 */
export function resolveIdentityHue(input: IdentityAvatarInput): number {
  return resolveAvatarInitials(input).colorSeed % 360;
}

/**
 * Resolves a trusted gateway avatar route, else deterministic initials.
 * Gravatar is served by the gateway inside the profile avatar route itself, so
 * the client never constructs a Gravatar URL — it only ever renders the
 * canonical /api/users/<id>/avatar endpoint or falls back to initials.
 */
// User-profile ids are crypto UUIDs. Chat sender metadata carries only the id
// (the prompt-visible envelope stays free of URLs), so a UUID-shaped sender id
// is the signal to resolve the canonical avatar route for it client-side.
const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function resolveAvatar(input: IdentityAvatarInput): ResolvedIdentityAvatar {
  // Trusted origin comes only from the app connection, never from `input`.
  const gatewayOrigin = appGatewayOrigin;

  const profileAvatarUrl = input.profileAvatarUrl?.trim();
  if (profileAvatarUrl) {
    const trusted = toTrustedAvatarUrl(profileAvatarUrl, gatewayOrigin);
    if (trusted) {
      return { kind: "profile", url: trusted };
    }
  }

  // Sender metadata without an explicit route: a profile-id sender still has a
  // canonical gateway avatar (upload → Gravatar proxy → 404-to-initials).
  const id = input.id?.trim();
  if (id && PROFILE_ID_RE.test(id)) {
    const trusted = toTrustedAvatarUrl(
      `/api/users/${encodeURIComponent(id)}/avatar`,
      gatewayOrigin,
    );
    if (trusted) {
      return { kind: "profile", url: trusted };
    }
  }

  return resolveAvatarInitials(input);
}
