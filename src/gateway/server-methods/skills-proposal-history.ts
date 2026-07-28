import {
  validateSkillsProposalHistoryScanParams,
  validateSkillsProposalHistoryStatusParams,
} from "../../../packages/gateway-protocol/src/schema/skill-history.js";
import { getSkillHistoryScanStatus } from "../../skills/workshop/history-scan-state.js";
import { runSkillHistoryScan } from "../../skills/workshop/history-scan.js";
import { runSkillsProposalWorkspaceHandler } from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";

export const skillProposalHistoryHandlers: GatewayRequestHandlers = {
  "skills.proposals.historyStatus": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.historyStatus",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalHistoryStatusParams,
      run: (_parsedParams, resolved) =>
        Promise.resolve(
          getSkillHistoryScanStatus({
            agentId: resolved.agentId,
            config: resolved.cfg,
            workspaceDir: resolved.workspaceDir,
          }),
        ),
    });
  },
  "skills.proposals.historyScan": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.historyScan",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalHistoryScanParams,
      run: (parsedParams, resolved) =>
        runSkillHistoryScan({
          agentId: resolved.agentId,
          config: resolved.cfg,
          ...(parsedParams.direction ? { direction: parsedParams.direction } : {}),
          workspaceDir: resolved.workspaceDir,
        }),
    });
  },
};
