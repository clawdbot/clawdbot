import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime-generation-scope.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import { runPreparedReply } from "./get-reply-run.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

const mocks = vi.hoisted(() => ({
  acquireRuntime: vi.fn(),
  execute: vi.fn(),
  prepareAdmission: vi.fn(),
  prepareContext: vi.fn(),
}));

vi.mock("../../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntime,
}));
vi.mock("./get-reply-run-context.js", () => ({
  prepareReplyRunContext: mocks.prepareContext,
}));
vi.mock("./get-reply-run-admission.js", () => ({
  prepareReplyRunAdmission: mocks.prepareAdmission,
}));
vi.mock("./get-reply-run-execute.js", () => ({
  executePreparedReplyRun: mocks.execute,
}));

describe("runPreparedReply prepared metadata", () => {
  beforeEach(() => {
    setCurrentPluginMetadataSnapshot(undefined);
    vi.clearAllMocks();
  });

  it("keeps the admitted Gateway generation active through a different reply workspace", async () => {
    const config = {};
    const workspaceDir = "/tmp/openclaw-reply-workspace";
    const gatewayWorkspaceDir = "/tmp/openclaw-configured-workspace";
    const metadataSnapshot = {
      index: { plugins: [] },
      pluginIds: undefined,
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
      workspaceDir: gatewayWorkspaceDir,
    } as never;
    const pluginRegistry = { registrations: [] } as never;
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
      pluginRegistry,
    };
    const release = vi.fn();
    const selectedGeneration = { ...pluginGeneration, pluginRegistry: { selected: true } };
    mocks.prepareContext.mockResolvedValue({
      kind: "run",
      params: { cfg: config, provider: "selected", model: "model" },
      thinkingRuntime: "selected-harness",
      workspaceDir,
    });
    mocks.acquireRuntime.mockImplementation(async (_input, options) => ({
      snapshot: {
        config,
        metadataSnapshot: options.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: selectedGeneration.pluginRegistry,
        workspaceDir,
      },
      release,
      pluginGeneration: selectedGeneration,
    }));
    let admissionSnapshot: unknown;
    let admissionRegistry: unknown;
    let admissionPluginGeneration: unknown;
    mocks.prepareAdmission.mockImplementation(async () => {
      admissionSnapshot = getCurrentPluginMetadataSnapshot({ config, workspaceDir });
      admissionRegistry = getPluginRuntimeGenerationRegistry();
      admissionPluginGeneration = getPreparedModelRuntimePluginGeneration();
      return { kind: "run" };
    });
    let executionSnapshot: unknown;
    let executionRegistry: unknown;
    let executionPluginGeneration: unknown;
    mocks.execute.mockImplementation(async () => {
      executionSnapshot = getCurrentPluginMetadataSnapshot({ config, workspaceDir });
      executionRegistry = getPluginRuntimeGenerationRegistry();
      executionPluginGeneration = getPreparedModelRuntimePluginGeneration();
      return { text: "ok" };
    });

    const run = bindPreparedReplyDispatchRuntime(
      {
        agentId: "main",
        agentDir: "/tmp/openclaw-reply-agent",
        workspaceDir: gatewayWorkspaceDir,
        config,
        pluginGeneration,
      } as never,
      async () => await runPreparedReply({ provider: "selected", model: "model" } as never),
    );

    await expect(run()).resolves.toEqual({ text: "ok" });
    expect(mocks.acquireRuntime).toHaveBeenCalledWith(
      {
        config,
        agentId: "main",
        agentDir: "/tmp/openclaw-reply-agent",
        allowGatewaySubagentBinding: true,
        workspaceDir,
        runtimePluginSelections: [
          { provider: "selected", modelId: "model", runtime: "selected-harness" },
        ],
      },
      { pluginGeneration },
    );
    expect(admissionSnapshot).toBe(metadataSnapshot);
    expect(executionSnapshot).toBe(metadataSnapshot);
    expect(admissionRegistry === selectedGeneration.pluginRegistry).toBe(true);
    expect(executionRegistry === selectedGeneration.pluginRegistry).toBe(true);
    expect(admissionPluginGeneration === selectedGeneration).toBe(true);
    expect(executionPluginGeneration === selectedGeneration).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir })).toBeUndefined();
    expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
    expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  });
});
