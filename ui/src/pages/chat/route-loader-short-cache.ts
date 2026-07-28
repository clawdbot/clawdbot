import { controlUiSessionSlug } from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  consumeSessionNavigationHandoff,
  prepareSessionNavigationHandoff,
} from "../../lib/sessions/navigation-handoff.ts";
import {
  findUiSessionRow,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

const SESSION_UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

export function sessionKeyUuid(sessionKey: string): string | null {
  const uuid = parseAgentSessionKey(sessionKey)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
  return uuid ? uuid.toLowerCase().replaceAll("-", "") : null;
}

function rowMatchesShortTarget(
  row: GatewaySessionRow,
  target: Extract<SessionPathTarget, { kind: "short" }>,
): boolean {
  const uuid = sessionKeyUuid(row.key);
  if (!uuid || !uuid.startsWith(target.shortId.toLowerCase().replaceAll("-", ""))) {
    return false;
  }
  return !target.slugHint || controlUiSessionSlug(row.displayName) === target.slugHint;
}

type CachedShortSession = {
  sessionKey: string;
  row?: GatewaySessionRow;
};

export type ShortSessionResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: GatewaySessionRow }
  | { kind: "ambiguous"; sessions: GatewaySessionRow[]; truncated: boolean };

export function narrowShortResolutionBySlugHint(
  resolution: ShortSessionResolution,
  slugHint: string | undefined,
): ShortSessionResolution {
  if (resolution.kind !== "ambiguous" || resolution.truncated || !slugHint) {
    return resolution;
  }
  const matched = resolution.sessions.filter(
    (row) => controlUiSessionSlug(row.displayName) === slugHint,
  );
  return matched.length === 1 && matched[0] ? { kind: "unique", session: matched[0] } : resolution;
}

export function incompleteShortSessionResolution(
  kind: "exact" | "short" | "slug",
  sessions: GatewaySessionRow[],
): ShortSessionResolution {
  if (kind === "slug" && sessions.length === 0) {
    // Slugs are best-effort: an incomplete exact-key search must retain the
    // authoritative literal route, while a bounded zero-match slug is a 404.
    return { kind: "not-found" };
  }
  return { kind: "ambiguous", sessions, truncated: true };
}

export function requireShortSessionResolution(
  resolution: ShortSessionResolution | null,
): ShortSessionResolution {
  if (!resolution) {
    throw new Error("Session list unavailable while resolving URL.");
  }
  return resolution;
}

export function findCachedShortSession(
  context: ApplicationContext,
  location: RouteLocation,
  target: Extract<SessionPathTarget, { kind: "short" }>,
): CachedShortSession | undefined {
  const locationKey = new URLSearchParams(location.search)
    .get(SESSION_NAVIGATION_KEY_PARAM)
    ?.trim();
  const handoffKey = consumeSessionNavigationHandoff(context.gateway, location.pathname);
  const carriedKey = locationKey ?? handoffKey;
  const carriedByCurrentNavigation = Boolean(handoffKey && handoffKey === carriedKey);
  if (carriedKey) {
    const preserveLocationKeyForCanonicalReload = () => {
      if (locationKey) {
        prepareSessionNavigationHandoff(context.gateway, location.pathname, locationKey);
      }
    };
    const carried = findUiSessionRow(context, carriedKey, target.agentId);
    if (carried && rowMatchesShortTarget(carried, target)) {
      preserveLocationKeyForCanonicalReload();
      return { sessionKey: carried.key, row: carried };
    }
    const carriedUuid = sessionKeyUuid(carriedKey);
    const carriedAgentId = parseAgentSessionKey(carriedKey)?.agentId;
    if (
      carriedByCurrentNavigation &&
      carriedUuid?.startsWith(target.shortId.toLowerCase().replaceAll("-", "")) &&
      carriedAgentId &&
      normalizeAgentId(carriedAgentId) === normalizeAgentId(target.agentId)
    ) {
      preserveLocationKeyForCanonicalReload();
      return { sessionKey: carriedKey };
    }
  }
  return undefined;
}
