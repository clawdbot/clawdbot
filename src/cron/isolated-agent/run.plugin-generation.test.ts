// Proves isolated cron/hook runs carry the published Gateway plugin generation
// into embedded execution instead of rebuilding metadata per run (#125596 family).
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimePluginGeneration,
  getPreparedModelRuntimeBorrowedSnapshot,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
  acquirePreparedModelRuntimeMock,
  loadPublishedReplyDispatchRuntimeMock,
  loadModelCatalogOwnerMock,
  resolveAgentConfigMock,
} from "./run.test-harness.js";

const preparedRuntimeMocks = {
  acquireRuntime: acquirePreparedModelRuntimeMock,
  loadDispatchRuntime: loadPublishedReplyDispatchRuntimeMock,
};

const { PreparedModelRuntimeOwnerNotPublishedError } = await vi.importActual<
  typeof import("../../agents/prepared-model-runtime.errors.js")
>("../../agents/prepared-model-runtime.errors.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn plugin generation carry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("admits the published generation and keeps it active through embedded execution", async () => {
    const config = {
      agents: { entries: { default: { thinkingDefault: "high" as const } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const { resolveAgentConfig } = await vi.importActual<
      typeof import("../../agents/agent-scope-config.js")
    >("../../agents/agent-scope-config.js");
    resolveAgentConfigMock.mockImplementation(resolveAgentConfig);
    loadModelCatalogOwnerMock.mockResolvedValue({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/workspace",
      config,
      metadataSnapshot,
      modelCatalog: { entries: [], routeVariants: [] },
    });
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/dispatch-workspace",
      config,
      pluginGeneration,
    });
    const release = vi.fn();
    const selectedGeneration = {
      ...pluginGeneration,
      pluginRegistry: createEmptyPluginRegistry(),
    };
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { config, metadataSnapshot, pluginRegistry: selectedGeneration.pluginRegistry },
      pluginGeneration: selectedGeneration,
      release,
    });
    mockRunCronFallbackPassthrough();
    const afterRun = createDeferred();
    let borrowedAfterClose: Promise<unknown> | undefined;
    let embeddedRunGeneration: unknown = "not-captured";
    runEmbeddedAgentMock.mockImplementation(async (params) => {
      expect(params.config).toEqual(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[0].config);
      embeddedRunGeneration = getPreparedModelRuntimePluginGeneration();
      borrowedAfterClose = afterRun.promise.then(() =>
        getPreparedModelRuntimeBorrowedSnapshot(selectedGeneration),
      );
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ cfg: config, agentId: "default" }),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ok");
    const dispatchAdmission = preparedRuntimeMocks.loadDispatchRuntime.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
    };
    expect(dispatchAdmission).toMatchObject({ agentId: "default", abortSignal: expect.anything() });
    expect(preparedRuntimeMocks.acquireRuntime).toHaveBeenCalledWith(
      {
        config: {
          agents: {
            entries: config.agents.entries,
            defaults: { thinkingDefault: "high" },
          },
        },
        agentId: "default",
        agentDir: "/tmp/dispatch-agent-dir",
        allowGatewaySubagentBinding: true,
        workspaceDir: "/tmp/workspace",
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", agentId: "default" },
          { provider: "openai", modelId: "gpt-5.6-sol", agentId: "default" },
        ],
      },
      { catalogMode: "static", pluginGeneration, abortSignal: dispatchAdmission.abortSignal },
    );
    expect(embeddedRunGeneration === selectedGeneration).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    afterRun.resolve();
    await expect(borrowedAfterClose).resolves.toBeUndefined();
    expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  });

  it("prepares a standalone generation when no Gateway publication exists", async () => {
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue(undefined);
    mockRunCronFallbackPassthrough();
    let embeddedRunGeneration: unknown = "not-captured";
    runEmbeddedAgentMock.mockImplementation(async () => {
      embeddedRunGeneration = getPreparedModelRuntimePluginGeneration();
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).resolves.toMatchObject(
      { status: "ok" },
    );
    expect(preparedRuntimeMocks.acquireRuntime).toHaveBeenCalledOnce();
    expect(embeddedRunGeneration).toBeDefined();
  });

  it("rejects preparation when the published owner is unavailable", async () => {
    preparedRuntimeMocks.loadDispatchRuntime.mockRejectedValue(
      new PreparedModelRuntimeOwnerNotPublishedError("owner not published"),
    );

    await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).rejects.toThrow(
      "owner not published",
    );
    expect(preparedRuntimeMocks.acquireRuntime).not.toHaveBeenCalled();
  });

  it("releases the prepared lease when continuation initialization fails", async () => {
    const state = await import("./run-session-state.js");
    const initialize = vi.spyOn(state, "createCronRunContinuationSession").mockReturnValue({
      initialize: async () => {
        throw new Error("continuation fixture failed");
      },
      sync: async () => {},
      setCliExecutionProvider: async () => {},
      seal: async () => {},
    });
    const release = vi.fn();
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { pluginRegistry: createEmptyPluginRegistry() },
      release,
    });
    try {
      await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).rejects.toThrow(
        "continuation fixture failed",
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      initialize.mockRestore();
    }
  });
});
