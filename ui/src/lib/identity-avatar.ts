import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import {
  buildControlUiResourcePath,
  parseControlUiResourcePath,
} from "../../../src/gateway/control-ui-resource-routes.js";
import {
  buildControlUiUserAvatarPath,
  canonicalizeControlUiUserAvatarPath,
} from "../../../src/gateway/control-ui-user-avatar-route.js";
import { formatSenderLabel, type SenderIdentity } from "./chat/sender-label.ts";
import { fnv1aUtf16 } from "./fnv1a.ts";
import { takeGraphemes } from "./graphemes.ts";
import { readAvatarGatewayContext } from "./identity-avatar-context.ts";

// NOTE: this is sender-controlled metadata. It must never carry the trusted
// gateway origin — that comes only from the app connection via
// setAvatarGatewayOrigin().
export type IdentityAvatarInput = SenderIdentity & {
  profileAvatarUrl?: string;
  identity?: SessionParticipantIdentity;
};

const ORIGIN_PROBE = "https://origin-probe.invalid";

/**
 * Trust only canonical user and agent image routes on the connected Gateway.
 * Keep revision queries for cache invalidation, drop fragments, and apply the
 * mount once: agent URLs arrive already prefixed, unlike user-profile URLs.
 */
export function resolveTrustedAvatarUrl(
  value: string,
  gatewayOrigin: string | null,
  resourceBasePath = readAvatarGatewayContext().resourceBasePath,
): string | null {
  try {
    const parsed = new URL(value, ORIGIN_PROBE);
    const relativeRoute = parsed.origin === ORIGIN_PROBE;
    const userPath = canonicalizeControlUiUserAvatarPath(parsed.pathname, resourceBasePath);
    const agentPath = parseControlUiResourcePath("agentAvatar", parsed.pathname, resourceBasePath);
    const pathname = userPath
      ? `${resourceBasePath}${userPath}`
      : agentPath.matched && agentPath.value
        ? buildControlUiResourcePath("agentAvatar", resourceBasePath, agentPath.value)
        : null;
    if (!pathname) {
      return null;
    }
    const suffix = `${pathname}${parsed.search}`;
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
  const initials = words.map((word) => takeGraphemes(word, 1)).join("");
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
 * Resolve a Gateway user/agent avatar, else deterministic initials. Remote
 * sources (including Gravatar) remain Gateway-owned, never browser fetches.
 */
// Unqualified per-message senders keep their existing display contract pending
// the separate transcript-provenance repair; typed participants never infer it.
const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function resolveAvatar(input: IdentityAvatarInput): ResolvedIdentityAvatar {
  const identity = input.identity;
  if (identity && identity.type !== "profile" && identity.type !== "agent") {
    return resolveAvatarInitials(input);
  }
  // Trusted origin comes only from the app connection, never from `input`.
  const { origin: gatewayOrigin, resourceBasePath } = readAvatarGatewayContext();

  const profileAvatarUrl = input.profileAvatarUrl?.trim();
  if (profileAvatarUrl) {
    const trusted = resolveTrustedAvatarUrl(profileAvatarUrl, gatewayOrigin);
    // A trusted image route does not change a typed participant's namespace.
    if (
      trusted &&
      (!identity ||
        parseControlUiResourcePath(
          identity.type === "agent" ? "agentAvatar" : "userAvatar",
          new URL(trusted, ORIGIN_PROBE).pathname,
          resourceBasePath,
        ).matched)
    ) {
      return { kind: "profile", url: trusted };
    }
  }

  const id = identity?.id ?? input.id?.trim();
  if (id && (identity?.type === "profile" || (!identity && PROFILE_ID_RE.test(id)))) {
    const trusted = resolveTrustedAvatarUrl(buildControlUiUserAvatarPath(id), gatewayOrigin);
    if (trusted) {
      return { kind: "profile", url: trusted };
    }
  }

  return resolveAvatarInitials(input);
}
