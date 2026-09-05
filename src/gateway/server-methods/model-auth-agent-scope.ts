import type { UnknownAgentIdErrorDetails } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";

type ModelAuthAgentScopeResult =
  | { ok: true; agentId: string; agentDir: string }
  | { ok: false; agentId: string; error?: ReturnType<typeof errorShape> };

/** Resolves model-auth RPC scope without letting explicit garbage reach the default store. */
export function resolveModelAuthAgentScope(
  cfg: OpenClawConfig,
  requestedAgentId: unknown,
): ModelAuthAgentScopeResult {
  if (requestedAgentId === undefined || requestedAgentId === "") {
    let defaultAgentId: string;
    try {
      defaultAgentId = resolveDefaultAgentId(cfg, {
        surface: "model auth",
        hint: "Pass agentId to select a configured agent.",
      });
    } catch (error) {
      if (!(error instanceof AgentSelectionRequiredError)) {
        throw error;
      }
      return {
        ok: false,
        agentId: "",
        error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
      };
    }
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
  const normalized = normalizeAgentIdStrict(rawAgentId);
  if (!normalized.ok || !listAgentIds(cfg).includes(normalized.value)) {
    return { ok: false, agentId: rawAgentId };
  }
  const agentId = normalized.value;
  return { ok: true, agentId, agentDir: resolveAgentDir(cfg, agentId) };
}

export function modelAuthAgentScopeError(scope: Extract<ModelAuthAgentScopeResult, { ok: false }>) {
  return scope.error ?? unknownModelAuthAgentIdError(scope.agentId);
}

function unknownModelAuthAgentIdError(agentId: string) {
  const details: UnknownAgentIdErrorDetails = {
    code: GatewayErrorDetailCodes.UNKNOWN_AGENT_ID,
    agentId,
  };
  return errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentId}"`, { details });
}
