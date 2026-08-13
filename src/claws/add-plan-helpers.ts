import { stableStringify } from "@openclaw/normalization-core";
import type { AgentConfig } from "../config/types.agents.js";
import type { ClawInstallStatus } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function hasUnsupportedMutationActions(plan: ClawAddPlan): boolean {
  return plan.actions.some(
    (action) =>
      ![
        "agent",
        "workspace",
        "bootstrap",
        "workspaceFile",
        "package",
        "mcpServer",
        "cronJob",
      ].includes(action.kind),
  );
}

export function planWithPackageActions(
  plan: ClawAddPlan,
  predicate: (action: ClawAddPlan["actions"][number]) => boolean,
): ClawAddPlan {
  return {
    ...plan,
    actions: plan.actions.filter((action) => action.kind !== "package" || predicate(action)),
  };
}

export function statusAtLeast(status: ClawInstallStatus, phase: ClawInstallStatus): boolean {
  const order: Record<ClawInstallStatus, number> = {
    pending: 0,
    partial: 0,
    workspace_ready: 1,
    config_committed: 2,
    complete: 3,
  };
  return order[status] >= order[phase];
}

export function sameCommittedAgent(existingAgent: AgentConfig, plan: ClawAddPlan): boolean {
  return stableStringify(existingAgent) === stableStringify(plan.agent.config);
}
