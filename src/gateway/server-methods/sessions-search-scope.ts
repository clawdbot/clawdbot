import {
  ErrorCodes,
  errorShape,
  type SessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";

export function resolveSessionSearchScope(cfg: OpenClawConfig, params: SessionsSearchParams) {
  const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const resolvedSessionKeys:
    | Array<{ sessionKey: string; agentId: string | undefined }>
    | undefined = params.sessionKeys ? [] : undefined;
  for (const sessionKey of params.sessionKeys ?? []) {
    const requestedAgent =
      requestedAgentId &&
      !isConfiguredSessionStoreAgentId(cfg, requestedAgentId) &&
      resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey).kind === "none"
        ? ({ ok: true, agentId: requestedAgentId } as const)
        : resolveRequestedSessionAgentId(cfg, sessionKey, requestedAgentId);
    if (!requestedAgent.ok) {
      return { ok: false as const, error: requestedAgent.error };
    }
    resolvedSessionKeys?.push({
      sessionKey: requestedAgent.agentId
        ? resolveStoredSessionKeyForAgentStore({
            cfg,
            agentId: requestedAgent.agentId,
            sessionKey,
          })
        : resolveSessionStoreKey({ cfg, sessionKey }),
      agentId: requestedAgent.agentId,
    });
  }
  const sessionKeys = resolvedSessionKeys?.map((resolved) => resolved.sessionKey);
  const agentIds = new Set(
    resolvedSessionKeys?.map((resolved) =>
      resolved.agentId ? resolved.agentId : resolveSessionStoreAgentId(cfg, resolved.sessionKey),
    ),
  );
  if (
    agentIds.size > 1 ||
    (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
  ) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "sessions.search supports one agent per call"),
    };
  }
  let agentId = requestedAgentId ?? agentIds.values().next().value;
  if (!agentId) {
    const fallbackAgent = resolveRequestedSessionAgentId(cfg, "main");
    if (!fallbackAgent.ok) {
      return { ok: false as const, error: fallbackAgent.error };
    }
    agentId = fallbackAgent.agentId;
  }
  return {
    ok: true as const,
    agentId,
    configured: isConfiguredSessionStoreAgentId(cfg, agentId),
    requestedAgentId,
    sessionKeys,
  };
}
