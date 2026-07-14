import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillProposalOrigin, SkillWorkshopRunOptions } from "../../skills/workshop/types.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

export function createConfiguredSkillWorkshopTool(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string | number;
  run?: SkillWorkshopRunOptions;
}) {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const runId = normalizeOptionalString(params.runId);
  const messageId = normalizeOptionalString(
    params.messageId === undefined ? undefined : String(params.messageId),
  );
  return createSkillWorkshopTool({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    origin:
      params.run?.origin ??
      ({
        agentId: params.agentId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(messageId ? { messageId } : {}),
      } satisfies SkillProposalOrigin),
    proposalOnly: params.run?.proposalOnly,
    proposalMutationBudget:
      params.run?.proposalMutationBudget ??
      (params.run?.proposalOnly ? { remaining: 1 } : undefined),
  });
}
