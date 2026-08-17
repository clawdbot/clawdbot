// Commits the agent slice of a consented Claw add plan.
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import { exactExistingAgentIsAuthorized } from "./agent-adoption-apply.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";

export type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export class ClawAddConfigCommitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddConfigCommitError";
  }
}

export type ClawAddConfigCommitResult = {
  committed: boolean;
  reservedConfig: boolean;
};

function preserveAgentEntries(config: OpenClawConfig): {
  agents: AgentConfig[];
  config: OpenClawConfig;
} {
  const existingAgents = listAgentEntries(config);
  const agents =
    existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID, default: true }];
  return {
    agents,
    config: {
      ...config,
      agents: {
        ...config.agents,
        entries: Object.fromEntries(agents.map(({ id, ...entry }) => [id, entry])),
      },
    },
  };
}

function addPlannedAgent(
  config: OpenClawConfig,
  agents: AgentConfig[],
  plan: ClawAddPlan,
): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: Object.fromEntries(
        [...agents, plan.agent.config].map(({ id, ...entry }) => [id, entry]),
      ),
    },
  };
}

export async function commitClawAgentConfig(params: {
  plan: ClawAddPlan;
  workspace: string;
  commitConfig?: ConfigCommit;
  resumePlan?: ClawAddPlan;
  resumeRecord?: PersistedClawInstall;
  agentAdoption?: boolean;
  persistedStatus: PersistedClawInstall["status"];
}): Promise<ClawAddConfigCommitResult> {
  let committed = false;
  let reservedConfig = false;
  const commit =
    params.commitConfig ??
    (async (transform) => {
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        transform: (config) => ({ nextConfig: transform(config) }),
      });
    });

  await commit((config) => {
    const preserved = preserveAgentEntries(config);
    const normalizedAgentId = normalizeAgentId(params.plan.agent.finalId);
    const existingAgent = preserved.agents.find(
      (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
    );
    if (existingAgent) {
      if (
        sameCommittedAgent(existingAgent, params.plan) &&
        exactExistingAgentIsAuthorized({
          adoption: params.agentAdoption ?? false,
          resume: params.resumeRecord !== undefined,
          persistedStatus: params.persistedStatus,
        })
      ) {
        if (
          findOverlappingWorkspaceAgentIds(
            preserved.config,
            params.plan.agent.finalId,
            params.workspace,
          ).length > 0
        ) {
          throw new ClawAddConfigCommitError(
            "agent_workspace_conflict",
            "Workspace " + JSON.stringify(params.workspace) + " is assigned to another agent.",
          );
        }
        committed = true;
        return config;
      }
      const nextConfig = replaceLegacyCommittedAgent({
        config: preserved.config,
        agents: preserved.agents,
        normalizedAgentId,
        plan: params.plan,
        resumePlan: params.resumePlan,
        resumeRecord: params.resumeRecord,
        matchesPlan: sameCommittedAgent,
      });
      if (nextConfig) {
        committed = true;
        reservedConfig = true;
        return nextConfig;
      }
      throw new ClawAddConfigCommitError(
        params.agentAdoption ? "agent_config_conflict" : "agent_id_collision",
        params.agentAdoption
          ? `Agent ${JSON.stringify(params.plan.agent.finalId)} changed after adoption planning.`
          : "Agent " + JSON.stringify(params.plan.agent.finalId) + " was created after planning.",
      );
    }
    if (params.agentAdoption) {
      throw new ClawAddConfigCommitError(
        "agent_config_conflict",
        `Agent ${JSON.stringify(params.plan.agent.finalId)} disappeared after adoption planning.`,
      );
    }
    if (
      findOverlappingWorkspaceAgentIds(
        preserved.config,
        params.plan.agent.finalId,
        params.workspace,
      ).length > 0
    ) {
      throw new ClawAddConfigCommitError(
        "workspace_collision",
        "Workspace " + JSON.stringify(params.workspace) + " is already assigned to an agent.",
      );
    }
    committed = true;
    reservedConfig = true;
    return addPlannedAgent(preserved.config, preserved.agents, params.plan);
  });

  return { committed, reservedConfig };
}

export async function rollbackClawAgentConfigReservation(params: {
  plan: ClawAddPlan;
  commitConfig?: ConfigCommit;
}): Promise<boolean> {
  let rolledBack = false;
  const commit =
    params.commitConfig ??
    (async (transform) => {
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        transform: (config) => ({ nextConfig: transform(config) }),
      });
    });

  await commit((config) => {
    const preserved = preserveAgentEntries(config);
    const normalizedAgentId = normalizeAgentId(params.plan.agent.finalId);
    const existingAgent = preserved.agents.find(
      (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
    );
    if (!existingAgent || !sameCommittedAgent(existingAgent, params.plan)) {
      return config;
    }
    const remainingAgents = preserved.agents.filter(
      (agent) => normalizeAgentId(agent.id) !== normalizedAgentId,
    );
    rolledBack = true;
    return {
      ...preserved.config,
      agents: {
        ...preserved.config.agents,
        entries: Object.fromEntries(remainingAgents.map(({ id, ...entry }) => [id, entry])),
      },
    };
  });

  return rolledBack;
}
