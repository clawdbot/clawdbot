import {
  buildControlUiUserAvatarPath,
  canonicalizeControlUiUserAvatarPath,
} from "../../../src/gateway/control-ui-user-avatar-route.js";
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
let appGatewayResourceBasePath = "";
let appGatewayAuthHeader: string | null = null;
// More than one cache is keyed by the Gateway HTTP context (avatars,
// geolocation), so every subscriber must be notified on a switch. A single slot
// would silently drop whichever registered first.
const gatewayContextResets = new Set<() => void>();

export function registerAvatarGatewayReset(reset: () => void): void {
  gatewayContextResets.add(reset);
}

export function readAvatarGatewayContext() {
  return {
    origin: appGatewayOrigin,
    resourceBasePath: appGatewayResourceBasePath,
    authHeader: appGatewayAuthHeader,
  };
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
  resourceBasePath = "",
): void {
  const nextOrigin = toHttpOrigin(gatewayUrl);
  const documentOrigin = globalThis.location?.origin;
  const nextResourceBasePath =
    nextOrigin && documentOrigin === nextOrigin ? normalizeBasePath(resourceBasePath) : "";
  const nextAuthHeader = authHeader?.trim() || null;
  if (
    appGatewayOrigin !== nextOrigin ||
    appGatewayResourceBasePath !== nextResourceBasePath ||
    appGatewayAuthHeader !== nextAuthHeader
  ) {
    for (const reset of gatewayContextResets) {
      reset();
    }
  }
  appGatewayOrigin = nextOrigin;
  appGatewayResourceBasePath = nextResourceBasePath;
  appGatewayAuthHeader = nextAuthHeader;
}

/**
 * Returns a browser-safe avatar URL, or null. Only the canonical
 * /api/users/<id>/avatar route is trusted (pathname pinned, fragment dropped).
 * The query is preserved: the gateway stamps a ?v=<updatedAt> revision there so
 * replacing an image invalidates its bounded authenticated blob-cache entry.
 * Relative paths resolve against the trusted gateway origin; absolute URLs
 * must match that origin.
 */
export function resolveTrustedAvatarUrl(
  value: string,
  gatewayOrigin: string | null,
  resourceBasePath = appGatewayResourceBasePath,
): string | null {
  try {
    const parsed = new URL(value, ORIGIN_PROBE);
    const relativeRoute = parsed.origin === ORIGIN_PROBE;
    const canonicalPathname = canonicalizeControlUiUserAvatarPath(
      parsed.pathname,
      relativeRoute ? "" : resourceBasePath,
    );
    if (!canonicalPathname) {
      return null;
    }
    const suffix = `${resourceBasePath}${canonicalPathname}${parsed.search}`;
    if (relativeRoute) {
      return gatewayOrigin ? new URL(suffix, gatewayOrigin).toString() : suffix;
    }
    return gatewayOrigin && parsed.origin === gatewayOrigin ? gatewayOrigin + suffix : null;
  } catch {
    return null;
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
    const trusted = resolveTrustedAvatarUrl(profileAvatarUrl, gatewayOrigin);
    if (trusted) {
      return { kind: "profile", url: trusted };
    }
  }

  // Sender metadata without an explicit route: a profile-id sender still has a
  // canonical gateway avatar (upload → Gravatar proxy → 404-to-initials).
  const id = input.id?.trim();
  if (id && PROFILE_ID_RE.test(id)) {
    const trusted = resolveTrustedAvatarUrl(buildControlUiUserAvatarPath(id), gatewayOrigin);
    if (trusted) {
      return { kind: "profile", url: trusted };
    }
  }

  return resolveAvatarInitials(input);
}
