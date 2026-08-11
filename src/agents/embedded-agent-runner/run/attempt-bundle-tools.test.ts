import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tools.js";
import { attachToolAllowlistIntersection } from "../../tool-policy.js";

const mocks = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
  getOrCreateSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
  applyFinalEffectiveToolPolicy: vi.fn(),
  filterRuntimeCompatibleTools: vi.fn(),
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
  filterRuntimeCompatibleTools: mocks.filterRuntimeCompatibleTools,
}));

vi.mock("../effective-tool-policy.js", () => ({
  applyFinalEffectiveToolPolicy: mocks.applyFinalEffectiveToolPolicy,
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
    mocks.filterRuntimeCompatibleTools
      .mockReset()
      .mockImplementation((tools: unknown[]) => ({ tools, diagnostics: [] }));
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

  it.each([
    {
      name: "ordinary uncapped runs",
      allow: undefined,
      clients: ["client_read", "client_delete"],
      expected: ["client_read", "client_delete"],
    },
    {
      name: "message-only completion turns",
      allow: ["message"],
      clients: ["client_read", "client_delete"],
      expected: [],
    },
    {
      name: "explicitly empty capabilities",
      allow: [],
      clients: ["client_read"],
      expected: [],
    },
    {
      name: "wildcard capabilities",
      allow: ["*"],
      clients: ["client_read", "client_delete"],
      expected: ["client_read", "client_delete"],
    },
    {
      name: "canonical tool groups",
      allow: ["group:fs"],
      clients: ["read", "write", "exec"],
      expected: ["read", "write"],
    },
    {
      name: "canonical tool aliases",
      allow: ["bash"],
      clients: ["exec", "client_read"],
      expected: ["exec"],
    },
    {
      name: "independent glob intersections",
      allow: attachToolAllowlistIntersection(
        ["client_read", "client_write", "other_read"],
        [["client_*"], ["*_read"]],
      ),
      clients: ["client_read", "client_write", "other_read"],
      expected: ["client_read"],
    },
  ])("applies the effective client-function capability to $name", async (testCase) => {
    const input = createInput([], []);
    const providedClientTools = testCase.clients.map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" as const } },
    }));
    input.attempt.clientTools = providedClientTools;
    input.attempt.toolsAllow = testCase.allow;
    input.preparedToolBase.effectiveToolsAllow = testCase.allow;

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(testCase.expected);
    if (testCase.allow === undefined) {
      expect(result.clientTools).toBe(providedClientTools);
    }
  });

  it("removes unauthorized client names before MCP and LSP tool reservation", async () => {
    const input = createInput([], [{ name: "message" }]);
    input.attempt.toolsAllow = ["client_allowed", "bundle-mcp", "lsp_probe"];
    input.preparedToolBase.effectiveToolsAllow = input.attempt.toolsAllow;
    input.attempt.clientTools = ["client_allowed", "client_forbidden"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" as const } },
    }));
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({ tools: [] });

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(["client_allowed"]);
    expect(mocks.materializeBundleMcpToolsForRun).toHaveBeenCalledWith(
      expect.objectContaining({ reservedToolNames: ["message", "client_allowed"] }),
    );
    expect(mocks.createBundleLspToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ reservedToolNames: ["message", "client_allowed"] }),
    );
  });

  it("never exposes client functions when the attempt disables every tool", async () => {
    const input = createInput([], []);
    input.attempt.disableTools = true;
    input.attempt.clientTools = [
      {
        type: "function",
        function: { name: "client_forbidden", parameters: { type: "object" } },
      },
    ];

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.clientTools).toBeUndefined();
    expect(mocks.getOrCreateSessionMcpRuntime).not.toHaveBeenCalled();
    expect(mocks.materializeBundleMcpToolsForRun).not.toHaveBeenCalled();
    expect(mocks.createBundleLspToolRuntime).not.toHaveBeenCalled();
  });

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

  it("captures the post-quarantine creator cap with plugin ownership", async () => {
    const coreTool = { name: "automations" };
    const allowedMcpTool = { name: "mail__read" };
    const quarantinedMcpTool = { name: "mail__broken" };
    setPluginToolMeta(allowedMcpTool as never, { pluginId: "bundle-mcp", optional: false });
    setPluginToolMeta(quarantinedMcpTool as never, {
      pluginId: "bundle-mcp",
      optional: false,
    });
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [allowedMcpTool, quarantinedMcpTool],
    });
    mocks.filterRuntimeCompatibleTools.mockImplementation((tools: Array<{ name: string }>) => ({
      tools: tools.filter((tool) => tool.name !== "mail__broken"),
      diagnostics: [{ toolName: "mail__broken", violations: ["unsupported"] }],
    }));
    const input = createInput([], [coreTool]);
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};
    input.preparedToolBase.cronCreatorToolAllowlistCaptureRef = captureRef;

    await prepareEmbeddedAttemptBundleTools(input);

    expect(input.preparedToolBase.cronCreatorToolAllowlist).toEqual([
      { name: "automations" },
      { name: "mail__read", pluginId: "bundle-mcp" },
    ]);
    expect(captureRef.value).toEqual({
      version: 1,
      source: "final-executable-surface",
    });
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
