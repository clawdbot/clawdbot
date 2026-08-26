import { controlUiSessionSlug, SESSION_UUID_SUFFIX_RE } from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import {
  consumeSessionNavigationHandoff,
  prepareSessionNavigationHandoff,
} from "../../lib/sessions/navigation-handoff.ts";
import {
  findUiSessionRow,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";

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
