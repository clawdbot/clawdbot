import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildSkillProposalRevisionChangedErrorDetails,
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { SkillProposalRevisionChangedError } from "../../skills/workshop/service-evaluation.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

export function resolveSkillsAgentWorkspace(params: unknown, context: GatewayRequestContext) {
  const cfg = context.getRuntimeConfig();
  const agentIdRaw =
    params && typeof params === "object" && "agentId" in params
      ? normalizeOptionalString((params as { agentId?: unknown }).agentId)
      : undefined;
  let agentId: string;
  try {
    agentId = agentIdRaw
      ? normalizeAgentId(agentIdRaw)
      : resolveDefaultAgentId(cfg, {
          surface: "skills workspace",
          hint: "Pass agentId to select a configured agent.",
        });
  } catch (error) {
    if (!(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
    };
  }
  if (agentIdRaw && !listAgentIds(cfg).includes(agentId)) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
    };
  }
  return {
    ok: true as const,
    cfg,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

export type ResolvedSkillsWorkspace = Extract<
  ReturnType<typeof resolveSkillsAgentWorkspace>,
  { ok: true }
>;

export const SKILL_PROPOSAL_RESPONSE_HANDLED = Symbol("skill proposal response handled");

export async function runSkillsProposalWorkspaceHandler<TParams, TResult>(params: {
  method: string;
  rawParams: unknown;
  respond: RespondFn;
  context: GatewayRequestContext;
  validate: Validator<TParams>;
  run: (
    parsedParams: TParams,
    resolved: ResolvedSkillsWorkspace,
  ) => Promise<TResult | typeof SKILL_PROPOSAL_RESPONSE_HANDLED>;
}): Promise<void> {
  if (!assertValidParams(params.rawParams, params.validate, params.method, params.respond)) {
    return;
  }
  const resolved = resolveSkillsAgentWorkspace(params.rawParams, params.context);
  if (!resolved.ok) {
    params.respond(false, undefined, resolved.error);
    return;
  }
  try {
    const result = await params.run(params.rawParams, resolved);
    if (result !== SKILL_PROPOSAL_RESPONSE_HANDLED) {
      params.respond(true, result, undefined);
    }
  } catch (error) {
    const details =
      error instanceof SkillProposalRevisionChangedError
        ? buildSkillProposalRevisionChangedErrorDetails({
            expectedRevisionHash: error.expectedRevisionHash,
            currentRevisionHash: error.currentRevisionHash,
          })
        : undefined;
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        formatErrorMessage(error),
        details ? { details } : undefined,
      ),
    );
  }
}
