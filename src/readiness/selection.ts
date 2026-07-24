import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createActivationReadinessResolver } from "./activation.js";
import {
  WORKSPACE_WRITABLE_CRITERION_ID,
  type ReadinessCondition,
  type ReadinessContribution,
  type ReadinessRequirement,
} from "./conditions.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";
import { CORE_READINESS_SUBJECT_REFS } from "./subjects.js";
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
    subjectRef: CORE_READINESS_SUBJECT_REFS.plugins,
    status: "Unknown",
    requirement,
    reason: "CriterionNotRegistered",
    message: `Readiness criterion ${id} is selected but is not registered.`,
  };
}

function withRequirement(
  condition: ReadinessCondition,
  requirement: ReadinessRequirement,
): ReadinessCondition {
  return {
    type: condition.type,
    subjectRef: condition.subjectRef,
    ...(condition.relatedSubjectRefs ? { relatedSubjectRefs: condition.relatedSubjectRefs } : {}),
    ...(condition.observedAtMs !== undefined ? { observedAtMs: condition.observedAtMs } : {}),
    status: condition.status,
    requirement,
    reason: condition.reason,
    message: condition.message,
  };
}

export function createSelectedReadinessResolver() {
  const resolveWorkspace = createWorkspaceReadinessEvidenceResolver();
  const resolvePlugins = createPluginReadinessResolver();
  const resolveActivation = createActivationReadinessResolver();

  return async (params: {
    config: OpenClawConfig;
    registry: Pick<PluginRegistry, "readinessCriteria">;
    env?: NodeJS.ProcessEnv;
  }): Promise<ReadinessContribution> => {
    const selected = resolveSelectedReadinessCriteria(params.config);
    if (selected.length === 0) {
      return { conditions: [], subjects: [] };
    }

    const selectedIds = new Set(selected.map((entry) => entry.id));
    const pluginIds = new Set(
      selected.filter((entry) => entry.id.startsWith("plugin.")).map((entry) => entry.id),
    );
    const [workspaceEvidence, pluginContribution] = await Promise.all([
      selectedIds.has(WORKSPACE_WRITABLE_CRITERION_ID)
        ? resolveWorkspace({ config: params.config, env: params.env })
        : Promise.resolve(undefined),
      resolvePlugins({ registry: params.registry, config: params.config, criterionIds: pluginIds }),
    ]);
    // Owner snapshots are synchronous and sampled last so no asynchronous provider work can
    // publish a replacement generation between activation observation and result assembly.
    const activationConditions = resolveActivation({
      config: params.config,
      criterionIds: selectedIds,
      env: params.env,
    });

    const conditions = new Map<string, ReadinessCondition>();
    for (const [id, condition] of activationConditions) {
      conditions.set(id, condition);
    }
    if (workspaceEvidence) {
      conditions.set(
        WORKSPACE_WRITABLE_CRITERION_ID,
        buildWorkspaceReadinessCondition(workspaceEvidence),
      );
    }
    for (const condition of pluginContribution.conditions) {
      conditions.set(condition.type, condition);
    }

    return {
      conditions: selected.map(({ id, requirement }) => {
        const condition = conditions.get(id);
        return condition
          ? withRequirement(condition, requirement)
          : unavailableCondition(id, requirement);
      }),
      subjects: pluginContribution.subjects,
    };
  };
}
