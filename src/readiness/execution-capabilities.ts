import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { getSandboxBackendFactory } from "../agents/sandbox/backend.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { listPersistedRuntimeToolSchemaQuarantines } from "../agents/tool-schema-quarantine-health.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getContextEngineRegistration,
  listContextEngineQuarantines,
} from "../context-engine/registry.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import type { ReadinessCondition } from "./conditions.js";
import { CORE_READINESS_SUBJECT_REFS, type ReadinessSubject } from "./subjects.js";

const CONTEXT_ENGINE_READY_CRITERION_ID = "openclaw.context-engine-ready";
const TOOL_CATALOG_READY_CRITERION_ID = "openclaw.tool-catalog-ready";
const MCP_RUNTIME_READY_CRITERION_ID = "openclaw.mcp-runtime-ready";
const SANDBOX_READY_CRITERION_ID = "openclaw.sandbox-ready";
const HARNESS_READY_CRITERION_ID = "openclaw.harness-ready";

type ExecutionCapabilityReadinessCriterionId =
  | typeof CONTEXT_ENGINE_READY_CRITERION_ID
  | typeof TOOL_CATALOG_READY_CRITERION_ID
  | typeof MCP_RUNTIME_READY_CRITERION_ID
  | typeof SANDBOX_READY_CRITERION_ID
  | typeof HARNESS_READY_CRITERION_ID;

type ExecutionCapabilityReadinessDeps = {
  contextEngineRegistration(id: string): { lifecycle: "runtime" | "readOnlyDiscovery" } | undefined;
  contextEngineQuarantines(): Array<{ engineId: string }>;
  toolSchemaQuarantines(): Array<{ toolName: string }>;
  configuredHarnessRuntimes(config: OpenClawConfig): string[];
  harnessRegistered(id: string): boolean;
  agentIds(config: OpenClawConfig): string[];
  sandboxConfig(config: OpenClawConfig, agentId: string): { mode: string; backend: string };
  sandboxBackendRegistered(id: string): boolean;
};

export type ExecutionCapabilityReadinessSnapshot = {
  mcp?:
    | { status: "captured"; serverCount: number; diagnosticCount: number }
    | { status: "unavailable" };
};

type ExecutionCapabilitySnapshotDeps = {
  agentIds(config: OpenClawConfig): string[];
  workspaceDir(config: OpenClawConfig, agentId: string): string;
  mcpConfig(
    config: OpenClawConfig,
    workspaceDir: string,
  ): {
    serverCount: number;
    diagnosticCount: number;
  };
};

function condition(
  type: string,
  status: ReadinessCondition["status"],
  reason: string,
  message: string,
): ReadinessCondition {
  return {
    type,
    subjectRef: executionSubjectRef(type),
    status,
    requirement: "advisory",
    reason,
    message,
  };
}

function executionSubjectRef(type: string): string {
  const refs: Record<string, string> = {
    ContextEngineReady: CORE_READINESS_SUBJECT_REFS.contextEngine,
    ToolCatalogReady: CORE_READINESS_SUBJECT_REFS.toolCatalog,
    McpRuntimeReady: CORE_READINESS_SUBJECT_REFS.mcpRuntime,
    SandboxReady: CORE_READINESS_SUBJECT_REFS.sandbox,
    HarnessReady: CORE_READINESS_SUBJECT_REFS.harness,
  };
  const ref = refs[type];
  if (!ref) {
    throw new Error(`unknown execution readiness condition: ${type}`);
  }
  return ref;
}

export function listExecutionCapabilityReadinessSubjects(): ReadinessSubject[] {
  return [
    { ref: CORE_READINESS_SUBJECT_REFS.contextEngine, kind: "openclaw.context-engine" },
    { ref: CORE_READINESS_SUBJECT_REFS.toolCatalog, kind: "openclaw.tool-catalog" },
    { ref: CORE_READINESS_SUBJECT_REFS.mcpRuntime, kind: "openclaw.mcp-runtime" },
    { ref: CORE_READINESS_SUBJECT_REFS.sandbox, kind: "openclaw.sandbox" },
    { ref: CORE_READINESS_SUBJECT_REFS.harness, kind: "openclaw.harness" },
  ];
}

function createDefaultDeps(): ExecutionCapabilityReadinessDeps {
  return {
    contextEngineRegistration: getContextEngineRegistration,
    contextEngineQuarantines: listContextEngineQuarantines,
    toolSchemaQuarantines: listPersistedRuntimeToolSchemaQuarantines,
    configuredHarnessRuntimes: collectConfiguredAgentHarnessRuntimes,
    harnessRegistered: (id) => getRegisteredAgentHarness(id) !== undefined,
    agentIds: listAgentIds,
    sandboxConfig: (config, agentId) => resolveSandboxConfigForAgent(config, agentId),
    sandboxBackendRegistered: (id) => getSandboxBackendFactory(id) !== null,
  };
}

function isCriterionSelected(config: OpenClawConfig, id: string): boolean {
  const readiness = config.gateway?.readiness;
  return (
    readiness?.requiredCriteria?.includes(id) === true ||
    readiness?.advisoryCriteria?.includes(id) === true
  );
}

export function captureExecutionCapabilityReadinessSnapshot(
  config: OpenClawConfig,
  deps: ExecutionCapabilitySnapshotDeps = {
    agentIds: listAgentIds,
    workspaceDir: resolveAgentWorkspaceDir,
    mcpConfig: (runtimeConfig, workspaceDir) => {
      const { loaded } = loadSessionMcpConfig({
        workspaceDir,
        cfg: runtimeConfig,
        logDiagnostics: false,
      });
      return {
        serverCount: Object.keys(loaded.mcpServers).length,
        diagnosticCount: loaded.diagnostics.length,
      };
    },
  },
  additionalCriterionIds: readonly string[] = [],
): ExecutionCapabilityReadinessSnapshot {
  if (
    !isCriterionSelected(config, MCP_RUNTIME_READY_CRITERION_ID) &&
    !additionalCriterionIds.includes(MCP_RUNTIME_READY_CRITERION_ID)
  ) {
    return {};
  }
  try {
    let serverCount = 0;
    let diagnosticCount = 0;
    for (const agentId of deps.agentIds(config)) {
      const discovered = deps.mcpConfig(config, deps.workspaceDir(config, agentId));
      serverCount += discovered.serverCount;
      diagnosticCount += discovered.diagnosticCount;
    }
    return {
      mcp: {
        status: "captured",
        serverCount,
        diagnosticCount,
      },
    };
  } catch {
    return { mcp: { status: "unavailable" } };
  }
}

function buildContextEngineReadyCondition(
  config: OpenClawConfig,
  deps: ExecutionCapabilityReadinessDeps,
): ReadinessCondition {
  const configured = config.plugins?.slots?.contextEngine?.trim();
  const engineId = configured || defaultSlotIdForKey("contextEngine");
  if (deps.contextEngineQuarantines().some((entry) => entry.engineId === engineId)) {
    return condition(
      "ContextEngineReady",
      "False",
      "ContextEngineQuarantined",
      "The selected context engine is quarantined and runtime execution uses its fallback.",
    );
  }
  if (engineId === "legacy") {
    return condition(
      "ContextEngineReady",
      "True",
      "LegacyContextEngineReady",
      "The built-in legacy context engine is available without a plugin runtime registration.",
    );
  }
  if (deps.contextEngineRegistration(engineId)?.lifecycle !== "runtime") {
    return condition(
      "ContextEngineReady",
      "False",
      "ContextEngineUnavailable",
      "The selected context engine does not have an active runtime registration.",
    );
  }
  return condition(
    "ContextEngineReady",
    "True",
    "ContextEngineReady",
    "The selected context engine has an active runtime registration.",
  );
}

function buildToolCatalogReadyCondition(
  deps: ExecutionCapabilityReadinessDeps,
): ReadinessCondition {
  const quarantined = deps.toolSchemaQuarantines();
  return quarantined.length === 0
    ? condition(
        "ToolCatalogReady",
        "True",
        "ToolCatalogReady",
        "No runtime tool schemas are quarantined.",
      )
    : condition(
        "ToolCatalogReady",
        "False",
        "ToolSchemasQuarantined",
        `${quarantined.length} runtime tool schema(s) are quarantined.`,
      );
}

function buildMcpRuntimeReadyCondition(
  snapshot: ExecutionCapabilityReadinessSnapshot | undefined,
): ReadinessCondition {
  const mcp = snapshot?.mcp;
  if (!mcp || mcp.status === "unavailable") {
    return condition(
      "McpRuntimeReady",
      "Unknown",
      "McpSnapshotUnavailable",
      "The accepted runtime configuration does not have an MCP readiness snapshot.",
    );
  }
  if (mcp.diagnosticCount > 0) {
    return condition(
      "McpRuntimeReady",
      "False",
      "McpConfigurationUnavailable",
      `${mcp.diagnosticCount} MCP configuration owner(s) reported diagnostics.`,
    );
  }
  if (mcp.serverCount === 0) {
    return condition(
      "McpRuntimeReady",
      "True",
      "McpRuntimeNotConfigured",
      "No MCP servers are configured for any configured agent.",
    );
  }
  return condition(
    "McpRuntimeReady",
    "True",
    "McpRuntimeReady",
    `${mcp.serverCount} MCP server definition(s) across configured agents are ready for session-scoped materialization.`,
  );
}

function buildSandboxReadyCondition(
  config: OpenClawConfig,
  deps: ExecutionCapabilityReadinessDeps,
): ReadinessCondition {
  const enabled = deps
    .agentIds(config)
    .map((agentId) => deps.sandboxConfig(config, agentId))
    .filter((sandbox) => sandbox.mode !== "off");
  if (enabled.length === 0) {
    return condition(
      "SandboxReady",
      "True",
      "SandboxNotRequired",
      "No configured agent requires a sandbox backend.",
    );
  }
  const unavailable = enabled.filter((sandbox) => !deps.sandboxBackendRegistered(sandbox.backend));
  return unavailable.length === 0
    ? condition(
        "SandboxReady",
        "True",
        "SandboxReady",
        "Every sandbox-enabled agent references a registered backend.",
      )
    : condition(
        "SandboxReady",
        "False",
        "SandboxBackendUnavailable",
        `${unavailable.length} sandbox-enabled agent configuration(s) reference an unavailable backend.`,
      );
}

function buildHarnessReadyCondition(
  config: OpenClawConfig,
  deps: ExecutionCapabilityReadinessDeps,
): ReadinessCondition {
  const runtimes = deps.configuredHarnessRuntimes(config);
  const unavailable = runtimes.filter((id) => !deps.harnessRegistered(id));
  return unavailable.length === 0
    ? condition(
        "HarnessReady",
        "True",
        "HarnessReady",
        runtimes.length === 0
          ? "Configured model routes use the built-in OpenClaw harness."
          : "Every configured native harness runtime is registered.",
      )
    : condition(
        "HarnessReady",
        "False",
        "HarnessUnavailable",
        `${unavailable.length} configured native harness runtime(s) are not registered.`,
      );
}

export function createExecutionCapabilityReadinessResolver(
  deps: ExecutionCapabilityReadinessDeps = createDefaultDeps(),
) {
  return (params: {
    config: OpenClawConfig;
    criterionIds: ReadonlySet<string>;
    snapshot?: ExecutionCapabilityReadinessSnapshot;
  }): Map<ExecutionCapabilityReadinessCriterionId, ReadinessCondition> => {
    const conditions = new Map<ExecutionCapabilityReadinessCriterionId, ReadinessCondition>();
    const evaluate = (
      id: ExecutionCapabilityReadinessCriterionId,
      type: string,
      check: () => ReadinessCondition,
    ) => {
      if (!params.criterionIds.has(id)) {
        return;
      }
      try {
        conditions.set(id, check());
      } catch {
        conditions.set(
          id,
          condition(
            type,
            "Unknown",
            "CriterionEvaluationFailed",
            "The readiness criterion could not inspect its runtime snapshot.",
          ),
        );
      }
    };

    evaluate(CONTEXT_ENGINE_READY_CRITERION_ID, "ContextEngineReady", () =>
      buildContextEngineReadyCondition(params.config, deps),
    );
    evaluate(TOOL_CATALOG_READY_CRITERION_ID, "ToolCatalogReady", () =>
      buildToolCatalogReadyCondition(deps),
    );
    evaluate(MCP_RUNTIME_READY_CRITERION_ID, "McpRuntimeReady", () =>
      buildMcpRuntimeReadyCondition(params.snapshot),
    );
    evaluate(SANDBOX_READY_CRITERION_ID, "SandboxReady", () =>
      buildSandboxReadyCondition(params.config, deps),
    );
    evaluate(HARNESS_READY_CRITERION_ID, "HarnessReady", () =>
      buildHarnessReadyCondition(params.config, deps),
    );
    return conditions;
  };
}
