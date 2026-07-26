import type { RouteLocation } from "@openclaw/uirouter";
import { routeIdFromPath } from "../app-routes.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import {
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import { isDefaultChatLanding } from "../pages/model-setup/first-run.ts";
import type { ApplicationGateway } from "./context.ts";
import { waitForGatewayClient } from "./gateway-readiness.ts";

export function normalizeInitialApplicationLocation(
  location: RouteLocation,
  basePath: string,
  sessionKey: string,
  fallbackAgentId: string,
) {
  if (!isDefaultChatLanding(location, basePath, routeIdFromPath) || !sessionKey.trim()) {
    return location;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId.trim();
  if (!agentId) {
    return location;
  }
  const pathname = pathForSession("chat", agentId, sessionKey, basePath);
  return pathname ? { ...location, pathname } : location;
}

export async function resolveInitialApplicationLocation(params: {
  location: RouteLocation;
  basePath: string;
  sessionKey: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => UiSessionDefaultsHost["agentsList"];
  signal: AbortSignal;
}): Promise<RouteLocation> {
  if (!isDefaultChatLanding(params.location, params.basePath, routeIdFromPath)) {
    return params.location;
  }
  // Explicit routes must start immediately; only the implicit persisted-session
  // landing needs gateway defaults before its agent can be made authoritative.
  if (params.sessionKey.trim() && !parseAgentSessionKey(params.sessionKey)) {
    await waitForGatewayClient(params.gateway, params.signal);
  }
  return normalizeInitialApplicationLocation(
    params.location,
    params.basePath,
    params.sessionKey,
    resolveUiDefaultAgentId({
      agentsList: params.agentsList(),
      hello: params.gateway.snapshot.hello,
    }),
  );
}
