import { boundedCoreReadinessMessage } from "./sanitize.js";
import {
  CORE_READINESS_SUBJECT_REFS,
  createProcessReadinessIdentity,
  normalizeRelatedSubjectRefs,
  reconcileReadinessIdentity,
  type ReadinessIdentity,
  type ReadinessSubject,
} from "./subjects.js";

export const WORKSPACE_WRITABLE_CRITERION_ID = "openclaw.workspace-writable";

type BuiltInReadinessConditionType =
  | "GatewayStartupComplete"
  | "GatewayAcceptingWork"
  | "ChannelRuntimeReady"
  | "ChannelRuntimeSuppressed"
  | "EventLoopHealthy"
  | "ReadinessEvaluationComplete"
  | "ConfigLoaded"
  | "WorkspaceWritable"
  | "ContextEngineReady"
  | "ToolCatalogReady"
  | "McpRuntimeReady"
  | "SandboxReady"
  | "HarnessReady"
  | "GatewayResponding"
  | "PluginsLoaded"
  | "StateReady"
  | "SessionStorageReady"
  | "DeliveryRuntimeReady"
  | "SchedulerReady";

type ReadinessConditionType = BuiltInReadinessConditionType | (string & {});

type ReadinessConditionStatus = "True" | "False" | "Unknown";
export type ReadinessRequirement = "required" | "advisory";

export type ReadinessCondition = {
  type: ReadinessConditionType;
  /** Required on canonical results; omitted only by the compatibility-only legacy path. */
  subjectRef?: string;
  relatedSubjectRefs?: string[];
  observedAtMs?: number;
  status: ReadinessConditionStatus;
  requirement: ReadinessRequirement;
  reason: string;
  message: string;
};

export type CanonicalReadinessResult = {
  contractVersion: 1;
  evaluatedAtMs: number;
  identity: ReadinessIdentity;
  ready: boolean;
  conditions: ReadinessCondition[];
  failures: string[];
  advisories: string[];
};

export type ReadinessContribution = {
  conditions: ReadinessCondition[];
  subjects: ReadinessSubject[];
};

export type PluginReadinessInput = {
  errors: Array<{
    id: string;
    activated?: boolean;
    activationSource?: string;
    error?: string;
  }>;
  unavailable?: Array<{
    id: string;
    diagnostic: {
      reason: string;
    };
  }>;
};

type RuntimeReadinessInput = {
  evaluatedAtMs?: number;
  identity?: ReadinessIdentity;
  configLoaded: boolean;
  gateway: "responding" | "not-checked" | "unavailable";
  plugins?: PluginReadinessInput;
  coreConditions?: ReadinessCondition[];
  additionalConditions?: ReadinessCondition[];
  additionalSubjects?: ReadinessSubject[];
};

export function buildUnobservedGatewayConditions(): ReadinessCondition[] {
  return [
    {
      type: "GatewayStartupComplete",
      subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
      status: "Unknown",
      requirement: "required",
      reason: "GatewayStartupNotChecked",
      message: "This surface did not observe Gateway startup state.",
    },
    {
      type: "GatewayAcceptingWork",
      subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
      status: "Unknown",
      requirement: "required",
      reason: "GatewayAdmissionNotChecked",
      message: "This surface did not observe Gateway drain state.",
    },
    {
      type: "ChannelRuntimeReady",
      subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
      status: "Unknown",
      requirement: "required",
      reason: "ChannelRuntimeNotChecked",
      message: "This surface did not observe Gateway channel runtime state.",
    },
    {
      type: "EventLoopHealthy",
      subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
      status: "Unknown",
      requirement: "advisory",
      reason: "EventLoopStatusUnavailable",
      message: "This surface did not observe Gateway event-loop health.",
    },
  ];
}

function resolvePluginFailures(plugins: PluginReadinessInput): string[] {
  const loadFailures = plugins.errors
    .filter((entry) => entry.activated === true || entry.activationSource !== "disabled")
    .map((entry) =>
      boundedCoreReadinessMessage(
        entry.error ? `${entry.id}: ${entry.error}` : `${entry.id}: plugin load failed`,
      ),
    );
  const unavailable = (plugins.unavailable ?? []).map((entry) =>
    boundedCoreReadinessMessage(`${entry.id}: ${entry.diagnostic.reason}`),
  );
  return [...loadFailures, ...unavailable];
}

function buildPluginCondition(plugins: PluginReadinessInput | undefined): ReadinessCondition {
  if (!plugins) {
    return {
      type: "PluginsLoaded",
      subjectRef: CORE_READINESS_SUBJECT_REFS.plugins,
      status: "Unknown",
      requirement: "advisory",
      reason: "PluginStatusUnavailable",
      message: "Plugin registry status is not available on this surface.",
    };
  }
  const failures = resolvePluginFailures(plugins);
  return {
    type: "PluginsLoaded",
    subjectRef: CORE_READINESS_SUBJECT_REFS.plugins,
    status: failures.length === 0 ? "True" : "False",
    requirement: "advisory",
    reason: failures.length === 0 ? "PluginsLoaded" : "PluginLoadFailures",
    message:
      failures.length === 0
        ? "Selected plugins loaded without activation errors."
        : boundedCoreReadinessMessage(`Plugin activation failures: ${failures.join("; ")}`),
  };
}

function buildGatewayCondition(gateway: RuntimeReadinessInput["gateway"]): ReadinessCondition {
  if (gateway === "responding") {
    return {
      type: "GatewayResponding",
      subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
      status: "True",
      requirement: "required",
      reason: "GatewayResponding",
      message: "Gateway accepted the readiness request.",
    };
  }
  if (gateway === "unavailable") {
    return {
      type: "GatewayResponding",
      subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
      status: "False",
      requirement: "required",
      reason: "GatewayUnavailable",
      message: "Gateway did not respond to the readiness request.",
    };
  }
  return {
    type: "GatewayResponding",
    subjectRef: CORE_READINESS_SUBJECT_REFS.gateway,
    status: "Unknown",
    requirement: "required",
    reason: "GatewayNotChecked",
    message: "This status surface did not probe the running Gateway.",
  };
}

export function buildRuntimeReadiness(input: RuntimeReadinessInput): CanonicalReadinessResult {
  const additionalConditions = input.additionalConditions ?? [];
  const workspaceConditions = additionalConditions.filter(
    (condition) => condition.type === "WorkspaceWritable",
  );
  const remainingConditions = additionalConditions
    .filter((condition) => condition.type !== "WorkspaceWritable")
    .toSorted(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        (left.subjectRef ?? "").localeCompare(right.subjectRef ?? ""),
    );
  const conditions: ReadinessCondition[] = [
    ...(input.coreConditions ?? []),
    {
      type: "ConfigLoaded",
      subjectRef: CORE_READINESS_SUBJECT_REFS.config,
      status: input.configLoaded ? "True" : "False",
      requirement: "required",
      reason: input.configLoaded ? "ConfigLoaded" : "ConfigNotLoaded",
      message: input.configLoaded
        ? "Runtime configuration loaded."
        : "Runtime configuration was not loaded.",
    },
    ...workspaceConditions,
    buildGatewayCondition(input.gateway),
    buildPluginCondition(input.plugins),
    ...remainingConditions,
  ];
  const failures = conditions
    .filter((entry) => entry.requirement === "required" && entry.status !== "True")
    .map((entry) => entry.reason);
  const advisories = conditions
    .filter((entry) => entry.requirement === "advisory" && entry.status !== "True")
    .map((entry) => entry.reason);
  const normalizedConditions: ReadinessCondition[] = [];
  for (const condition of conditions) {
    const relatedSubjectRefs = normalizeRelatedSubjectRefs(condition.relatedSubjectRefs);
    normalizedConditions.push(
      relatedSubjectRefs ? { ...condition, relatedSubjectRefs } : condition,
    );
  }
  if (normalizedConditions.some((condition) => !condition.subjectRef)) {
    throw new Error("canonical readiness condition is missing a subject reference");
  }
  const conditionKeys = new Set<string>();
  for (const condition of normalizedConditions) {
    const key = `${condition.subjectRef}\u0000${condition.type}`;
    if (conditionKeys.has(key)) {
      throw new Error("duplicate canonical readiness condition");
    }
    conditionKeys.add(key);
  }
  const identity = reconcileReadinessIdentity({
    base: input.identity ?? createProcessReadinessIdentity(),
    subjects: input.additionalSubjects,
    references: normalizedConditions as Array<ReadinessCondition & { subjectRef: string }>,
  });
  return {
    contractVersion: 1,
    evaluatedAtMs: input.evaluatedAtMs ?? Date.now(),
    identity,
    ready: failures.length === 0,
    conditions: normalizedConditions,
    failures,
    advisories,
  };
}
