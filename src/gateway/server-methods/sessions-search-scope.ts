import {
  ErrorCodes,
  errorShape,
  type SessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope-config.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";

export function resolveSessionSearchScope(cfg: OpenClawConfig, params: SessionsSearchParams) {
  const normalizedRequest =
    params.agentId === undefined ? null : normalizeAgentIdStrict(params.agentId);
  if (normalizedRequest && !normalizedRequest.ok) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${params.agentId}"`),
    };
  }
  const requestedAgentId = normalizedRequest?.value;
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
  // Unfiltered search with no explicit agentId: fall back to the configured
  // ambient owner (agents.defaults.systemAgent.agentId), matching skills.list /
  // models.list. The prior fallback passed the literal "main" to
  // resolveRequestedSessionAgentId as a session key, so explicit multi-agent
  // rosters without a legacy `default: true` marker rejected it with a
  // misleading 'session key "main" has no explicit owner' error (same
  // owner-loss class as the Talk path in #126730).
  const agentId =
    requestedAgentId ?? agentIds.values().next().value ?? tryResolveAmbientOwnerAgentId(cfg);
  if (!agentId) {
    const selection = new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "sessions.search",
      hint: "Pass an explicit agentId or configure agents.defaults.systemAgent.agentId.",
    });
    return { ok: false as const, error: errorShape(ErrorCodes.INVALID_REQUEST, selection.message) };
  }
  return {
    ok: true as const,
    agentId,
    configured: isConfiguredSessionStoreAgentId(cfg, agentId),
    requestedAgentId,
    sessionKeys,
  };
}
