// Shared agent-id resolution for gateway handlers that accept optional agent ids
// and must reject unknown explicit ids consistently.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespondFn } from "./types.js";

/**
 * Shared agent-id resolver for request handlers that accept optional agent ids.
 */
export function resolveAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  respond: RespondFn;
  cfg: OpenClawConfig;
  normalize: (rawAgentId: unknown) => string | undefined;
}) {
  const knownAgents = listAgentIds(params.cfg);
  const requestedAgentId = params.normalize(params.rawAgentId) ?? "";
  let agentId: string;
  try {
    agentId =
      requestedAgentId ||
      tryResolveLegacyCompatibilityAgentId(params.cfg) ||
      resolveDefaultAgentId(params.cfg, {
        surface: "this Gateway request",
        hint: "Set agentId to one of the configured agents.",
      });
  } catch (error) {
    if (!(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return null;
  }
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg: params.cfg, agentId };
}
