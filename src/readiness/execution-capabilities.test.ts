import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureExecutionCapabilityReadinessSnapshot,
  CONTEXT_ENGINE_READY_CRITERION_ID,
  createExecutionCapabilityReadinessResolver,
  HARNESS_READY_CRITERION_ID,
  MCP_RUNTIME_READY_CRITERION_ID,
  SANDBOX_READY_CRITERION_ID,
  TOOL_CATALOG_READY_CRITERION_ID,
} from "./execution-capabilities.js";

function createDeps() {
  return {
    contextEngineRegistration: vi.fn(
      (): { lifecycle: "runtime" | "readOnlyDiscovery" } | undefined => ({
        lifecycle: "runtime",
      }),
    ),
    contextEngineQuarantines: vi.fn(() => [] as Array<{ engineId: string }>),
    toolSchemaQuarantines: vi.fn(() => [] as Array<{ toolName: string }>),
    configuredHarnessRuntimes: vi.fn(() => [] as string[]),
    harnessRegistered: vi.fn((_id: string) => true),
    agentIds: vi.fn(() => ["main"]),
    sandboxConfig: vi.fn(() => ({ mode: "off", backend: "docker" })),
    sandboxBackendRegistered: vi.fn(() => true),
  };
}

describe("createExecutionCapabilityReadinessResolver", () => {
  it("captures MCP discovery only when its criterion is selected", () => {
    expect(captureExecutionCapabilityReadinessSnapshot({})).toEqual({});

    const workspace = mkdtempSync(path.join(os.tmpdir(), "openclaw-mcp-readiness-"));
    try {
      expect(
        captureExecutionCapabilityReadinessSnapshot({
          agents: { defaults: { workspace } },
          gateway: {
            readiness: { advisoryCriteria: [MCP_RUNTIME_READY_CRITERION_ID] },
          },
        }).mcp,
      ).toEqual({ status: "captured", serverCount: 0, diagnosticCount: 0 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("aggregates MCP discovery across every configured agent", () => {
    const mcpConfig = vi
      .fn()
      .mockReturnValueOnce({ serverCount: 1, diagnosticCount: 0 })
      .mockReturnValueOnce({ serverCount: 2, diagnosticCount: 1 });
    const config = {
      gateway: { readiness: { requiredCriteria: [MCP_RUNTIME_READY_CRITERION_ID] } },
    };

    expect(
      captureExecutionCapabilityReadinessSnapshot(config, {
        agentIds: () => ["main", "support"],
        workspaceDir: (_config, agentId) => `/workspaces/${agentId}`,
        mcpConfig,
      }).mcp,
    ).toEqual({ status: "captured", serverCount: 3, diagnosticCount: 1 });
    expect(mcpConfig).toHaveBeenNthCalledWith(1, config, "/workspaces/main");
    expect(mcpConfig).toHaveBeenNthCalledWith(2, config, "/workspaces/support");
  });

  it("does no owner work when no capability criteria are selected", () => {
    const deps = createDeps();
    const resolve = createExecutionCapabilityReadinessResolver(deps);

    expect(resolve({ config: {}, criterionIds: new Set() })).toEqual(new Map());
    for (const owner of Object.values(deps)) {
      expect(owner).not.toHaveBeenCalled();
    }
  });

  it("reports the selected context engine registration and quarantine state", () => {
    const deps = createDeps();
    const resolve = createExecutionCapabilityReadinessResolver(deps);
    const selected = new Set([CONTEXT_ENGINE_READY_CRITERION_ID]);

    expect(
      resolve({ config: {}, criterionIds: selected }).get(CONTEXT_ENGINE_READY_CRITERION_ID),
    ).toMatchObject({ status: "True", reason: "LegacyContextEngineReady" });
    expect(deps.contextEngineRegistration).not.toHaveBeenCalled();

    expect(
      resolve({
        config: { plugins: { slots: { contextEngine: "custom" } } },
        criterionIds: selected,
      }).get(CONTEXT_ENGINE_READY_CRITERION_ID),
    ).toMatchObject({ status: "True", reason: "ContextEngineReady" });

    deps.contextEngineQuarantines.mockReturnValueOnce([{ engineId: "custom" }]);
    expect(
      resolve({
        config: { plugins: { slots: { contextEngine: "custom" } } },
        criterionIds: selected,
      }).get(CONTEXT_ENGINE_READY_CRITERION_ID),
    ).toMatchObject({ status: "False", reason: "ContextEngineQuarantined" });

    deps.contextEngineRegistration.mockReturnValueOnce({ lifecycle: "readOnlyDiscovery" });
    expect(
      resolve({
        config: { plugins: { slots: { contextEngine: "custom" } } },
        criterionIds: selected,
      }).get(CONTEXT_ENGINE_READY_CRITERION_ID),
    ).toMatchObject({ status: "False", reason: "ContextEngineUnavailable" });
  });

  it("reports active runtime tool-schema quarantines without exposing tool details", () => {
    const deps = createDeps();
    deps.toolSchemaQuarantines.mockReturnValue([{ toolName: "private_tool" }]);
    const condition = createExecutionCapabilityReadinessResolver(deps)({
      config: {},
      criterionIds: new Set([TOOL_CATALOG_READY_CRITERION_ID]),
    }).get(TOOL_CATALOG_READY_CRITERION_ID);

    expect(condition).toMatchObject({ status: "False", reason: "ToolSchemasQuarantined" });
    expect(condition?.message).toBe("1 runtime tool schema(s) are quarantined.");
  });

  it("distinguishes unconfigured, configured, and invalid MCP definitions", () => {
    const deps = createDeps();
    const resolve = createExecutionCapabilityReadinessResolver(deps);
    const selected = new Set([MCP_RUNTIME_READY_CRITERION_ID]);

    expect(
      resolve({
        config: {},
        criterionIds: selected,
        snapshot: { mcp: { status: "captured", serverCount: 0, diagnosticCount: 0 } },
      }).get(MCP_RUNTIME_READY_CRITERION_ID),
    ).toMatchObject({ status: "True", reason: "McpRuntimeNotConfigured" });

    expect(
      resolve({
        config: {},
        criterionIds: selected,
        snapshot: { mcp: { status: "captured", serverCount: 2, diagnosticCount: 0 } },
      }).get(MCP_RUNTIME_READY_CRITERION_ID),
    ).toMatchObject({ status: "True", reason: "McpRuntimeReady" });

    expect(
      resolve({
        config: {},
        criterionIds: selected,
        snapshot: { mcp: { status: "captured", serverCount: 1, diagnosticCount: 2 } },
      }).get(MCP_RUNTIME_READY_CRITERION_ID),
    ).toMatchObject({ status: "False", reason: "McpConfigurationUnavailable" });

    expect(
      resolve({ config: {}, criterionIds: selected }).get(MCP_RUNTIME_READY_CRITERION_ID),
    ).toMatchObject({ status: "Unknown", reason: "McpSnapshotUnavailable" });
  });

  it("requires registered backends only for sandbox-enabled agents", () => {
    const deps = createDeps();
    const resolve = createExecutionCapabilityReadinessResolver(deps);
    const selected = new Set([SANDBOX_READY_CRITERION_ID]);

    expect(
      resolve({ config: {}, criterionIds: selected }).get(SANDBOX_READY_CRITERION_ID),
    ).toMatchObject({ status: "True", reason: "SandboxNotRequired" });

    deps.sandboxConfig.mockReturnValue({ mode: "all", backend: "remote" });
    deps.sandboxBackendRegistered.mockReturnValue(false);
    expect(
      resolve({ config: {}, criterionIds: selected }).get(SANDBOX_READY_CRITERION_ID),
    ).toMatchObject({ status: "False", reason: "SandboxBackendUnavailable" });
  });

  it("requires every configured native harness runtime to be registered", () => {
    const deps = createDeps();
    deps.configuredHarnessRuntimes.mockReturnValue(["codex", "custom"]);
    deps.harnessRegistered.mockImplementation((id) => id === "codex");
    const condition = createExecutionCapabilityReadinessResolver(deps)({
      config: {},
      criterionIds: new Set([HARNESS_READY_CRITERION_ID]),
    }).get(HARNESS_READY_CRITERION_ID);

    expect(condition).toMatchObject({ status: "False", reason: "HarnessUnavailable" });
    expect(condition?.message).toBe("1 configured native harness runtime(s) are not registered.");
  });

  it("fails closed as unknown when an owner snapshot throws", () => {
    const deps = createDeps();
    deps.toolSchemaQuarantines.mockImplementation(() => {
      throw new Error("store unavailable");
    });

    expect(
      createExecutionCapabilityReadinessResolver(deps)({
        config: {},
        criterionIds: new Set([TOOL_CATALOG_READY_CRITERION_ID]),
      }).get(TOOL_CATALOG_READY_CRITERION_ID),
    ).toMatchObject({ status: "Unknown", reason: "CriterionEvaluationFailed" });
  });
});
