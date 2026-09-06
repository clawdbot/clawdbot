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
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";

export function sessionKeyUuid(sessionKey: string): string | null {
  const uuid = parseAgentSessionKey(sessionKey)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
  return uuid ? uuid.toLowerCase().replaceAll("-", "") : null;
}

export function findLocalSessionReference(
  rows: readonly GatewaySessionRow[],
  target: SessionPathTarget,
  mainKey = "main",
): GatewaySessionRow | undefined {
  const scoped = rows.filter(
    (row) => parseAgentSessionKey(row.key)?.agentId === normalizeAgentId(target.agentId),
  );
  if (target.kind !== "short") {
    const key =
      target.kind === "main"
        ? buildAgentMainSessionKey({ agentId: target.agentId, mainKey })
        : target.sessionKey;
    const exact = scoped.find((row) => areUiSessionKeysEquivalent(row.key, key));
    if (exact || target.kind === "main" || !target.slugCandidate) {
      return exact;
    }
  }
  const matches = scoped.filter((row) => {
    const uuid = sessionKeyUuid(row.key);
    return (
      uuid &&
      (target.kind !== "short" || uuid.startsWith(target.shortId.toLowerCase().replaceAll("-", "")))
    );
  });
  const slug = target.kind === "short" ? target.slugHint : target.slugCandidate;
  const slugMatches = slug
    ? matches.filter((row) => controlUiSessionSlug(row.displayName) === slug)
    : [];
  // A stale name can narrow a short-id tie, but only slug matches resolve a slug-only URL.
  const narrowed = slugMatches.length || target.kind !== "short" ? slugMatches : matches;
  return narrowed.length === 1 ? narrowed[0] : undefined;
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
    if (carried && findLocalSessionReference([carried], target)) {
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
