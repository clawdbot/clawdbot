import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  WORKSPACE_WRITABLE_CRITERION_ID,
  type ReadinessCondition,
  type ReadinessRequirement,
} from "./conditions.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";
import {
  buildWorkspaceReadinessCondition,
  createWorkspaceReadinessEvidenceResolver,
} from "./workspace.js";

type SelectedCriterion = {
  id: string;
  requirement: ReadinessRequirement;
};

function resolveSelectedReadinessCriteria(config: OpenClawConfig): SelectedCriterion[] {
  const required = config.gateway?.readiness?.requiredCriteria ?? [];
  const advisory = config.gateway?.readiness?.advisoryCriteria ?? [];
  const selected = new Map<string, ReadinessRequirement>();
  for (const id of advisory) {
    selected.set(id, "advisory");
  }
  for (const id of required) {
    selected.set(id, "required");
  }
  return Array.from(selected, ([id, requirement]) => ({ id, requirement }));
}

function unavailableCondition(id: string, requirement: ReadinessRequirement): ReadinessCondition {
  return {
    type: id,
    status: "Unknown",
    requirement,
    reason: "CriterionNotRegistered",
    message: `Readiness criterion ${id} is selected but is not registered.`,
  };
}

export function createSelectedReadinessResolver() {
  const resolveWorkspace = createWorkspaceReadinessEvidenceResolver();
  const resolvePlugins = createPluginReadinessResolver();

  return async (params: {
    config: OpenClawConfig;
    registry: Pick<PluginRegistry, "readinessCriteria">;
    env?: NodeJS.ProcessEnv;
  }): Promise<ReadinessCondition[]> => {
    const selected = resolveSelectedReadinessCriteria(params.config);
    if (selected.length === 0) {
      return [];
    }

    const selectedIds = new Set(selected.map((entry) => entry.id));
    const pluginIds = new Set(
      selected.filter((entry) => entry.id.startsWith("plugin.")).map((entry) => entry.id),
    );
    const [workspaceEvidence, pluginConditions] = await Promise.all([
      selectedIds.has(WORKSPACE_WRITABLE_CRITERION_ID)
        ? resolveWorkspace({ config: params.config, env: params.env })
        : Promise.resolve(undefined),
      resolvePlugins({ registry: params.registry, config: params.config, criterionIds: pluginIds }),
    ]);

    const conditions = new Map<string, ReadinessCondition>();
    if (workspaceEvidence) {
      conditions.set(
        WORKSPACE_WRITABLE_CRITERION_ID,
        buildWorkspaceReadinessCondition(workspaceEvidence),
      );
    }
    for (const condition of pluginConditions) {
      conditions.set(condition.type, condition);
    }

    return selected.map(({ id, requirement }) => {
      const condition = conditions.get(id);
      return condition
        ? {
            type: condition.type,
            status: condition.status,
            requirement,
            reason: condition.reason,
            message: condition.message,
          }
        : unavailableCondition(id, requirement);
    });
  };
}
