import { formatSenderLabel, type SenderIdentity } from "./chat/sender-label.ts";

// NOTE: this is sender-controlled metadata. It must never carry the trusted
// gateway origin — that comes only from the app connection via
// setAvatarGatewayOrigin().
export type IdentityAvatarInput = SenderIdentity & {
  profileAvatarUrl?: string;
};

const ORIGIN_PROBE = "https://origin-probe.invalid";

let appGatewayOrigin: string | null = null;

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

/** Records the connected gateway URL so avatar routes resolve to its origin. */
export function setAvatarGatewayOrigin(gatewayUrl: string | null | undefined): void {
  appGatewayOrigin = toHttpOrigin(gatewayUrl);
}

// Mirrors the server's user-profiles-http-path matcher. Sender metadata may
// point only at this image route, never another gateway endpoint.
const USER_AVATAR_PATHNAME = /^\/api\/users\/[^/]+\/avatar$/u;

/**
 * Returns a browser-safe avatar URL, or null. Only the canonical
 * /api/users/<id>/avatar route is trusted (pathname pinned, fragment dropped).
 * The query is preserved: the gateway stamps a ?v=<updatedAt> revision there so
 * the browser cache-busts a replaced avatar. Since avatars now render as plain
 * <img> with no attached credentials, a varied query cannot amplify any
 * client cache — the browser bounds it. Relative paths resolve against the
 * trusted gateway origin; absolute URLs must match that origin.
 */
function toTrustedAvatarUrl(value: string, gatewayOrigin: string | null): string | null {
  try {
    const parsed = new URL(value, ORIGIN_PROBE);
    if (!USER_AVATAR_PATHNAME.test(parsed.pathname)) {
      return null;
    }
    const suffix = parsed.pathname + parsed.search;
    if (parsed.origin === ORIGIN_PROBE) {
      return gatewayOrigin ? new URL(suffix, gatewayOrigin).toString() : suffix;
    }
    return gatewayOrigin && parsed.origin === gatewayOrigin ? gatewayOrigin + suffix : null;
  } catch {
    return null;
  }
}

export type ResolvedIdentityAvatar =
  | { kind: "profile"; url: string }
  | { kind: "gravatar"; url: string }
  | { kind: "initials"; initials: string; colorSeed: number };

function initialsFromLabel(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  const initials = words.map((word) => Array.from(word)[0] ?? "").join("");
  return initials.toUpperCase() || "?";
}

function stableColorSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function resolveAvatarInitials(
  input: IdentityAvatarInput,
): Extract<ResolvedIdentityAvatar, { kind: "initials" }> {
  const id = input.id?.trim();
  const label = formatSenderLabel(input) ?? "?";
  return {
    kind: "initials",
    initials: initialsFromLabel(label),
    colorSeed: stableColorSeed(id || label),
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
