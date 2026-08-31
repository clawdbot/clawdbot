import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { RouteId } from "../app-routes.ts";
import { selectRenderedRouteMatch } from "./router-outlet.ts";

export type ShellRouteState = {
  routeId?: RouteId;
  location?: RouteLocation;
  committedRouteId?: RouteId;
  committedLocation?: RouteLocation;
  committedSessionKey?: string;
};

function sessionKeyFromRouteData(routeId: RouteId, data: unknown): string | undefined {
  if (!isSessionRouteId(routeId) || !data || typeof data !== "object") {
    return undefined;
  }
  const record = data as { kind?: unknown; sessionKey?: unknown };
  return record.kind === "session" && typeof record.sessionKey === "string"
    ? record.sessionKey.trim() || undefined
    : undefined;
}

export function selectShellRouteState(routerState: RouterState<RouteId>): ShellRouteState {
  const match = selectRenderedRouteMatch(routerState.matches[0], routerState.pendingMatches[0]);
  const committedMatch = routerState.matches[0];
  const committedSessionKey = committedMatch
    ? sessionKeyFromRouteData(committedMatch.routeId, committedMatch.data)
    : undefined;
  return {
    ...(match ? { routeId: match.routeId, location: match.location } : {}),
    ...(committedMatch
      ? { committedRouteId: committedMatch.routeId, committedLocation: committedMatch.location }
      : {}),
    ...(committedSessionKey ? { committedSessionKey } : {}),
  };
}
