import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
  getOrCreateSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
  applyFinalEffectiveToolPolicy: vi.fn(),
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: mocks.createBundleLspToolRuntime,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  getOrCreateSessionMcpRuntime: mocks.getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun: mocks.materializeBundleMcpToolsForRun,
}));

vi.mock("../../runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));

vi.mock("../../local-model-lean.js", () => ({
  filterLocalModelLeanTools: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));

vi.mock("../../tool-schema-projection.js", () => ({
  filterRuntimeCompatibleTools: vi.fn((tools: unknown[]) => ({ tools, diagnostics: [] })),
}));

vi.mock("../effective-tool-policy.js", () => ({
  applyFinalEffectiveToolPolicy: mocks.applyFinalEffectiveToolPolicy,
}));

vi.mock("./attempt-tool-construction-plan.js", () => ({
  applyEmbeddedAttemptToolsAllow: vi.fn((tools: unknown[]) => tools),
  shouldCreateBundleLspRuntimeForAttempt: vi.fn(() => true),
  shouldCreateBundleMcpRuntimeForAttempt: vi.fn(() => true),
}));

import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";

describe("prepareEmbeddedAttemptBundleTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBundleLspToolRuntime.mockReset().mockResolvedValue(undefined);
    mocks.getOrCreateSessionMcpRuntime.mockReset().mockResolvedValue(undefined);
    mocks.materializeBundleMcpToolsForRun.mockReset().mockResolvedValue(undefined);
    mocks.applyFinalEffectiveToolPolicy
      .mockReset()
      .mockImplementation(({ bundledTools }: { bundledTools: unknown[] }) => bundledTools);
  });

  function createInput(inheritedToolAllowlist: string[], toolsRaw: unknown[]) {
    return {
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        model: {},
        modelId: "model",
        provider: "provider",
        runId: "run",
        runtimePlan: {},
        sessionId: "session",
      },
      effectiveWorkspace: "/tmp/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      getProviderRuntimeHandle: () => undefined,
      isRawModelRun: false,
      preparedToolBase: {
        cronCreatorToolAllowlist: [],
        effectiveToolsAllow: undefined,
        inheritedToolAllowlist,
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: undefined,
        toolsEnabled: true,
        toolsRaw,
      },
      sessionAgentId: "main",
    } as unknown as Parameters<typeof prepareEmbeddedAttemptBundleTools>[0];
  }

  it("refreshes spawned-child inheritance after authorized MCP tools materialize", async () => {
    const inheritedToolAllowlist = ["sessions_spawn"];
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [{ name: "server__read" }],
    });

    await prepareEmbeddedAttemptBundleTools(
      createInput(inheritedToolAllowlist, [{ name: "sessions_spawn" }]),
    );

    expect(inheritedToolAllowlist).toEqual(["sessions_spawn", "server__read"]);
  });

  it("never adds policy-denied bundled tools to spawned-child inheritance", async () => {
    const inheritedToolAllowlist = ["sessions_spawn"];
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [{ name: "server__read" }, { name: "server__delete" }],
    });
    mocks.applyFinalEffectiveToolPolicy.mockImplementation(
      ({ bundledTools }: { bundledTools: Array<{ name: string }> }) =>
        bundledTools.filter((tool) => tool.name !== "server__delete"),
    );

    await prepareEmbeddedAttemptBundleTools(
      createInput(inheritedToolAllowlist, [{ name: "sessions_spawn" }]),
    );

    expect(inheritedToolAllowlist).toEqual(["sessions_spawn", "server__read"]);
    expect(inheritedToolAllowlist).not.toContain("server__delete");
  });

  it("disposes prepared bundle runtimes when later policy setup fails", async () => {
    const disposeMcp = vi.fn(async () => {});
    const disposeLsp = vi.fn(async () => {});
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [],
      dispose: disposeMcp,
    });
    mocks.createBundleLspToolRuntime.mockResolvedValue({
      tools: [],
      dispose: disposeLsp,
    });
    mocks.applyFinalEffectiveToolPolicy.mockImplementation(() => {
      throw new Error("bundle policy failed");
    });

    const input = {
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        model: {},
        modelId: "model",
        provider: "provider",
        runId: "run",
        runtimePlan: {},
        sessionId: "session",
      },
      effectiveWorkspace: "/tmp/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      getProviderRuntimeHandle: () => undefined,
      isRawModelRun: false,
      preparedToolBase: {
        cronCreatorToolAllowlist: [],
        effectiveToolsAllow: undefined,
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: undefined,
        toolsEnabled: true,
        toolsRaw: [],
      },
      sessionAgentId: "main",
    } as unknown as Parameters<typeof prepareEmbeddedAttemptBundleTools>[0];

    await expect(prepareEmbeddedAttemptBundleTools(input)).rejects.toThrow("bundle policy failed");
    expect(mocks.applyFinalEffectiveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
    );
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });
});
