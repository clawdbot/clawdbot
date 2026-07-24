import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createActivationReadinessResolver } from "./activation.js";
import {
  WORKSPACE_WRITABLE_CRITERION_ID,
  type ReadinessCondition,
  type ReadinessContribution,
  type ReadinessRequirement,
} from "./conditions.js";
import {
  createExecutionCapabilityReadinessResolver,
  type ExecutionCapabilityReadinessSnapshot,
} from "./execution-capabilities.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";
import { CORE_READINESS_SUBJECT_REFS } from "./subjects.js";
import {
  buildSessionStorageReadinessCondition,
  createSessionStorageReadinessEvidenceResolver,
  SESSION_STORAGE_READY_CRITERION_ID,
} from "./session-storage.js";
import {
  createStateServiceReadinessResolver,
  type StateServiceReadinessSnapshot,
} from "./state-services.js";
import {
  buildWorkspaceReadinessCondition,
  createWorkspaceReadinessEvidenceResolver,
} from "./workspace.js";

type SelectedCriterion = {
  id: string;
  requirement: ReadinessRequirement;
};

export const EVENT_LOOP_HEALTHY_CRITERION_ID = "openclaw.event-loop-healthy";
export const PLUGINS_LOADED_CRITERION_ID = "openclaw.plugins-loaded";

const CANONICAL_CONDITION_TYPES = new Map<string, ReadinessCondition["type"]>([
  [EVENT_LOOP_HEALTHY_CRITERION_ID, "EventLoopHealthy"],
  [PLUGINS_LOADED_CRITERION_ID, "PluginsLoaded"],
]);

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

export function applySelectedCanonicalRequirements(
  config: OpenClawConfig,
  conditions: readonly ReadinessCondition[],
): ReadinessCondition[] {
  const selected = resolveSelectedReadinessCriteria(config);
  const requirementsByType = new Map<ReadinessCondition["type"], ReadinessRequirement>();
  for (const { id, requirement } of selected) {
    const type = CANONICAL_CONDITION_TYPES.get(id);
    if (type !== undefined) {
      requirementsByType.set(type, requirement);
    }
  }
  const projected = conditions.map((condition) => {
    const requirement = requirementsByType.get(condition.type);
    return requirement === undefined ? condition : { ...condition, requirement };
  });
  const presentTypes = new Set(projected.map((condition) => condition.type));
  for (const [type, requirement] of requirementsByType) {
    if (presentTypes.has(type)) {
      continue;
    }
    projected.push({
      type,
      status: "Unknown",
      requirement,
      reason: "CriterionEvaluationUnavailable",
      message: `Readiness criterion ${type} was selected but could not be evaluated.`,
    });
  }
  return projected;
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

function stateServiceSelectorId(condition: ReadinessCondition): string | undefined {
  switch (condition.type) {
    case "StateReady":
      return "openclaw.state-ready";
    case "DeliveryRuntimeReady":
      return "openclaw.delivery-runtime-ready";
    case "SchedulerReady":
      return "openclaw.scheduler-ready";
    default:
      return undefined;
  }
}

export function createSelectedReadinessResolver() {
  const resolveWorkspace = createWorkspaceReadinessEvidenceResolver();
  const resolveSessionStorage = createSessionStorageReadinessEvidenceResolver();
  const resolvePlugins = createPluginReadinessResolver();
  const resolveActivation = createActivationReadinessResolver();
  const resolveExecutionCapabilities = createExecutionCapabilityReadinessResolver();
  const resolveStateServices = createStateServiceReadinessResolver();

  return async (params: {
    config: OpenClawConfig;
    registry: Pick<PluginRegistry, "readinessCriteria">;
    executionCapabilities?: ExecutionCapabilityReadinessSnapshot;
    env?: NodeJS.ProcessEnv;
    stateServices?: StateServiceReadinessSnapshot;
  }): Promise<ReadinessContribution> => {
    const selected = resolveSelectedReadinessCriteria(params.config).filter(
      ({ id }) => !CANONICAL_CONDITION_TYPES.has(id),
    );
    if (selected.length === 0) {
      return { conditions: [], subjects: [] };
    }

    const selectedIds = new Set(selected.map((entry) => entry.id));
    const pluginIds = new Set(
      selected.filter((entry) => entry.id.startsWith("plugin.")).map((entry) => entry.id),
    );
    const [workspaceEvidence, sessionStorageEvidence, pluginContribution] = await Promise.all([
      selectedIds.has(WORKSPACE_WRITABLE_CRITERION_ID)
        ? resolveWorkspace({ config: params.config, env: params.env })
        : Promise.resolve(undefined),
      selectedIds.has(SESSION_STORAGE_READY_CRITERION_ID)
        ? resolveSessionStorage({ config: params.config, env: params.env })
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
    for (const [id, capabilityCondition] of resolveExecutionCapabilities({
      config: params.config,
      criterionIds: selectedIds,
      snapshot: params.executionCapabilities,
    })) {
      conditions.set(id, capabilityCondition);
    }
    for (const condition of resolveStateServices({
      criterionIds: selectedIds,
      env: params.env,
      snapshot: params.stateServices,
    })) {
      const selectedId = stateServiceSelectorId(condition);
      if (selectedId) {
        conditions.set(selectedId, condition);
      }
    }
    if (workspaceEvidence) {
      conditions.set(
        WORKSPACE_WRITABLE_CRITERION_ID,
        buildWorkspaceReadinessCondition(workspaceEvidence),
      );
    }
    if (sessionStorageEvidence) {
      conditions.set(
        SESSION_STORAGE_READY_CRITERION_ID,
        buildSessionStorageReadinessCondition(sessionStorageEvidence),
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
