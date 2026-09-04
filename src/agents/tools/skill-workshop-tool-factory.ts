import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillProposalOrigin, SkillWorkshopRunOptions } from "../../skills/workshop/types.js";
import { getCanonicalSkillWorkspace } from "../skill-workshop-workspace-context.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

export function createConfiguredSkillWorkshopTool(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string | number;
  run?: SkillWorkshopRunOptions;
  modelContextWindowTokens?: number;
}) {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const runId = normalizeOptionalString(params.runId);
  const messageId = normalizeOptionalString(
    params.messageId === undefined ? undefined : String(params.messageId),
  );
  const revision = params.run?.proposalRevision;
  const agentId = revision?.agentId ?? params.agentId;
  return createSkillWorkshopTool({
    workspaceDir: revision?.workspaceDir ?? getCanonicalSkillWorkspace() ?? params.workspaceDir,
    config: params.config,
    env: params.run?.env,
    agentId,
    origin:
      params.run?.origin ??
      ({
        agentId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(messageId ? { messageId } : {}),
      } satisfies SkillProposalOrigin),
    proposalOnly: params.run?.proposalOnly,
    ...(params.run?.updateProposals ? { updateProposals: true } : {}),
    ...(params.run?.autonomousCapture ? { autonomousCapture: true } : {}),
    proposalMutationBudget:
      params.run?.proposalMutationBudget ??
      (params.run?.proposalOnly ? { remaining: 1 } : undefined),
    proposalReviewCompletion: params.run?.proposalReviewCompletion,
    collectionReconcile: params.run?.collectionReconcile,
    modelContextWindowTokens: params.modelContextWindowTokens,
    proposalRevision: params.run?.proposalRevision,
    libraryAuthoring: params.run?.libraryAuthoring,
  });
}
