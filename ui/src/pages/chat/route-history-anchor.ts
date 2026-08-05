import type { RouteLocation } from "@openclaw/uirouter";
import {
  SESSION_HISTORY_MESSAGE_ID_PARAM,
  SESSION_HISTORY_SESSION_ID_PARAM,
  type SessionHistoryAnchor,
} from "../../lib/sessions/route-navigation.ts";
import { draftRouteDataFromLocation, draftSearchFromLocation } from "./route-draft.ts";

export function locationWithoutHistoryAnchor(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  params.delete(SESSION_HISTORY_SESSION_ID_PARAM);
  params.delete(SESSION_HISTORY_MESSAGE_ID_PARAM);
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

function historyAnchorFromLocation(location: RouteLocation): SessionHistoryAnchor | undefined {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get(SESSION_HISTORY_SESSION_ID_PARAM)?.trim();
  const messageId = params.get(SESSION_HISTORY_MESSAGE_ID_PARAM)?.trim();
  return sessionId && messageId ? { sessionId, messageId } : undefined;
}

export function sessionRouteDataFromLocation(location: RouteLocation) {
  const historyAnchor = historyAnchorFromLocation(location);
  return {
    ...draftRouteDataFromLocation(location),
    ...(historyAnchor ? { historyAnchor } : {}),
  };
}

export function sessionRouteSearchFromLocation(location: RouteLocation): string {
  const params = new URLSearchParams(draftSearchFromLocation(location));
  const historyAnchor = historyAnchorFromLocation(location);
  if (historyAnchor) {
    params.set(SESSION_HISTORY_SESSION_ID_PARAM, historyAnchor.sessionId);
    params.set(SESSION_HISTORY_MESSAGE_ID_PARAM, historyAnchor.messageId);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}
