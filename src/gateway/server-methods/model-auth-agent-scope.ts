import type { UnknownAgentIdErrorDetails } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";

type ModelAuthAgentScopeResult =
  | { ok: true; agentId: string; agentDir: string }
  | { ok: false; agentId: string };

/** Resolves model-auth RPC scope without letting explicit garbage reach the default store. */
export function resolveModelAuthAgentScope(
  cfg: OpenClawConfig,
  requestedAgentId: unknown,
): ModelAuthAgentScopeResult {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (requestedAgentId === undefined || requestedAgentId === "") {
    return {
      ok: true,
      agentId: defaultAgentId,
      agentDir: resolveAgentDir(cfg, defaultAgentId),
    };
  }
  if (typeof requestedAgentId !== "string") {
    return {
      ok: false,
      agentId: requestedAgentId === null ? "null" : typeof requestedAgentId,
    };
  }
  const rawAgentId = requestedAgentId.trim();
  // Only the literal empty string keeps the omitted-param default; a
  // whitespace-only value is an explicit target and must not use default auth.
  if (!rawAgentId) {
    return { ok: false, agentId: requestedAgentId };
  }
  const agentId = normalizeAgentId(rawAgentId);
  // normalizeAgentId falls back to "main" when sanitization erases the entire
  // input; explicit garbage must not inherit the default agent's credentials.
  const collapsedToFallback = !/[A-Za-z0-9_]/u.test(rawAgentId);
  if (collapsedToFallback || !listAgentIds(cfg).includes(agentId)) {
    return { ok: false, agentId: rawAgentId };
  }
  return { ok: true, agentId, agentDir: resolveAgentDir(cfg, agentId) };
}

export function unknownModelAuthAgentIdError(agentId: string) {
  const details: UnknownAgentIdErrorDetails = {
    code: GatewayErrorDetailCodes.UNKNOWN_AGENT_ID,
    agentId,
  };
  return errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentId}"`, { details });
}
