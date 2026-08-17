import type { AgentConfig } from "../config/types.agents.js";
import { digestClawAddPlanIntegrity } from "./add-plan-integrity.js";
import { canonicalizeClawAgent } from "./agent-adoption-apply.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function preserveAdoptedAgentDefault(params: {
  plan: ClawAddPlan;
  install: PersistedClawInstall;
  liveAgent: AgentConfig | undefined;
}): ClawAddPlan | undefined {
  if (params.install.agentOrigin !== "adopted") {
    return params.plan;
  }
  const liveAgent = params.liveAgent
    ? canonicalizeClawAgent(params.liveAgent, params.install.agentId)
    : undefined;
  if (!liveAgent || digestClawAgentConfig(liveAgent) !== params.install.agentConfigDigest) {
    return undefined;
  }
  const config: ClawAddPlan["agent"]["config"] = { ...params.plan.agent.config };
  if (Object.hasOwn(liveAgent, "default")) {
    config.default = liveAgent.default;
  } else {
    delete config.default;
  }
  const actions = params.plan.actions.map((action) =>
    action.kind === "agent" && action.id === params.install.agentId
      ? { ...action, details: { ...action.details, ...config } }
      : action,
  );
  const plan = {
    ...params.plan,
    agent: { ...params.plan.agent, config },
    actions,
  };
  return { ...plan, planIntegrity: digestClawAddPlanIntegrity(plan) };
}
