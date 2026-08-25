import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext } from "./route-loader-context.ts";

export function resolveLocalMainSessionKey(
  context: SessionRouteContext,
  target: Extract<SessionPathTarget, { kind: "main" }>,
): string | null {
  if (context.gateway.snapshot.phase === "connected") {
    return null;
  }
  const sessionKey = context.gateway.snapshot.sessionKey;
  const persisted = parseAgentSessionKey(sessionKey);
  return persisted?.rest ===
    resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }) && normalizeAgentId(persisted.agentId) === normalizeAgentId(target.agentId)
    ? sessionKey
    : null;
}
