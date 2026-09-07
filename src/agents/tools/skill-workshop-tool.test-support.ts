import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { discardRunWorkspaceSkillUsage } from "../../skills/runtime/run-usage.js";
import { readSkillProposalRecord as readSkillProposalRecordImpl } from "../../skills/workshop/store.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "../admitted-run-context.js";
import type { AnyAgentTool } from "./common.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";

const workshopConfig: OpenClawConfig = {};

export function readSkillWorkshopTestProposalRecord(
  proposalId: string,
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return readSkillProposalRecordImpl(
    proposalId,
    { config: workshopConfig, ...options },
    {},
    { config: workshopConfig },
  );
}

export function createTrackedSkillWorkshopRunAuthorities(): {
  admit: (runId: string) => OperationalRunInstanceRef;
  bind: (tool: AnyAgentTool, operationalRunInstance: OperationalRunInstanceRef) => AnyAgentTool;
  cleanup: () => void;
} {
  const entries: Array<{
    operationalRunInstance: OperationalRunInstanceRef;
    authority: AgentRunDelegatedAuthority;
  }> = [];
  return {
    admit: (runId) => {
      const operationalRunInstance = createOperationalRunInstanceRef(runId);
      entries.push({
        operationalRunInstance,
        authority: claimAgentRunDelegatedAuthority(operationalRunInstance),
      });
      return operationalRunInstance;
    },
    bind: (tool, operationalRunInstance) =>
      wrapToolWithGatewayCallerIdentity(tool, {
        agentId: "main",
        sessionKey: "skill-workshop-test",
        operationalRunInstance,
      }),
    cleanup: () => {
      for (const entry of entries.splice(0)) {
        discardRunWorkspaceSkillUsage(entry.operationalRunInstance);
        releaseAgentRunDelegatedAuthority(entry.authority);
      }
    },
  };
}
