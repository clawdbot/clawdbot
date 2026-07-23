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
  | "GatewayResponding"
  | "PluginsLoaded";

type ReadinessConditionType = BuiltInReadinessConditionType | (string & {});

type ReadinessConditionStatus = "True" | "False" | "Unknown";
export type ReadinessRequirement = "required" | "advisory";

export type ReadinessCondition = {
  type: ReadinessConditionType;
  status: ReadinessConditionStatus;
  requirement: ReadinessRequirement;
  reason: string;
  message: string;
};

export type CanonicalReadinessResult = {
  ready: boolean;
  conditions: ReadinessCondition[];
  failures: string[];
  advisories: string[];
};

export type PluginReadinessInput = {
  errors: Array<{
    id: string;
    activated?: boolean;
    activationSource?: string;
    error?: string;
  }>;
};

type RuntimeReadinessInput = {
  configLoaded: boolean;
  gateway: "responding" | "not-checked" | "unavailable";
  plugins?: PluginReadinessInput;
  coreConditions?: ReadinessCondition[];
  additionalConditions?: ReadinessCondition[];
};

export function buildUnobservedGatewayConditions(): ReadinessCondition[] {
  return [
    {
      type: "GatewayStartupComplete",
      status: "Unknown",
      requirement: "required",
      reason: "GatewayStartupNotChecked",
      message: "This surface did not observe Gateway startup state.",
    },
    {
      type: "GatewayAcceptingWork",
      status: "Unknown",
      requirement: "required",
      reason: "GatewayAdmissionNotChecked",
      message: "This surface did not observe Gateway drain state.",
    },
    {
      type: "ChannelRuntimeReady",
      status: "Unknown",
      requirement: "required",
      reason: "ChannelRuntimeNotChecked",
      message: "This surface did not observe Gateway channel runtime state.",
    },
    {
      type: "EventLoopHealthy",
      status: "Unknown",
      requirement: "advisory",
      reason: "EventLoopStatusUnavailable",
      message: "This surface did not observe Gateway event-loop health.",
    },
  ];
}

function resolvePluginFailures(plugins: PluginReadinessInput): string[] {
  return plugins.errors
    .filter((entry) => entry.activated === true || entry.activationSource !== "disabled")
    .map((entry) =>
      entry.error ? `${entry.id}: ${entry.error}` : `${entry.id}: plugin load failed`,
    );
}

function buildPluginCondition(plugins: PluginReadinessInput | undefined): ReadinessCondition {
  if (!plugins) {
    return {
      type: "PluginsLoaded",
      status: "Unknown",
      requirement: "advisory",
      reason: "PluginStatusUnavailable",
      message: "Plugin registry status is not available on this surface.",
    };
  }
  const failures = resolvePluginFailures(plugins);
  return {
    type: "PluginsLoaded",
    status: failures.length === 0 ? "True" : "False",
    requirement: "advisory",
    reason: failures.length === 0 ? "PluginsLoaded" : "PluginLoadFailures",
    message:
      failures.length === 0
        ? "Selected plugins loaded without activation errors."
        : `Plugin load failures: ${failures.join("; ")}`,
  };
}

function buildGatewayCondition(gateway: RuntimeReadinessInput["gateway"]): ReadinessCondition {
  if (gateway === "responding") {
    return {
      type: "GatewayResponding",
      status: "True",
      requirement: "required",
      reason: "GatewayResponding",
      message: "Gateway accepted the readiness request.",
    };
  }
  if (gateway === "unavailable") {
    return {
      type: "GatewayResponding",
      status: "False",
      requirement: "required",
      reason: "GatewayUnavailable",
      message: "Gateway did not respond to the readiness request.",
    };
  }
  return {
    type: "GatewayResponding",
    status: "Unknown",
    requirement: "required",
    reason: "GatewayNotChecked",
    message: "This status surface did not probe the running Gateway.",
  };
}

export function buildRuntimeReadiness(input: RuntimeReadinessInput): CanonicalReadinessResult {
  const conditions: ReadinessCondition[] = [
    ...(input.coreConditions ?? []),
    {
      type: "ConfigLoaded",
      status: input.configLoaded ? "True" : "False",
      requirement: "required",
      reason: input.configLoaded ? "ConfigLoaded" : "ConfigNotLoaded",
      message: input.configLoaded
        ? "Runtime configuration loaded."
        : "Runtime configuration was not loaded.",
    },
    ...(input.additionalConditions ?? []),
    buildGatewayCondition(input.gateway),
    buildPluginCondition(input.plugins),
  ];
  const failures = conditions
    .filter((entry) => entry.requirement === "required" && entry.status !== "True")
    .map((entry) => entry.reason);
  const advisories = conditions
    .filter((entry) => entry.requirement === "advisory" && entry.status !== "True")
    .map((entry) => entry.reason);
  return {
    ready: failures.length === 0,
    conditions,
    failures,
    advisories,
  };
}
