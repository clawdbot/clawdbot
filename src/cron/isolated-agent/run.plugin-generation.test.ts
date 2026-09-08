// Proves isolated cron/hook runs carry the published Gateway plugin generation
// into embedded execution instead of rebuilding metadata per run (#125596 family).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  getPreparedModelRuntimePluginGeneration,
  getPreparedModelRuntimeBorrowedSnapshot,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
  acquirePreparedModelRuntimeMock,
  loadModelCatalogMock,
  loadPublishedReplyDispatchRuntimeMock,
  loadModelCatalogOwnerMock,
  resolveAgentConfigMock,
  makeCronSession,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
} from "./run.test-harness.js";

const preparedRuntimeMocks = {
  acquireRuntime: acquirePreparedModelRuntimeMock,
  loadDispatchRuntime: loadPublishedReplyDispatchRuntimeMock,
};

const { PreparedModelRuntimeOwnerNotPublishedError } = await vi.importActual<
  typeof import("../../agents/prepared-model-runtime.errors.js")
>("../../agents/prepared-model-runtime.errors.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      modelCatalog: { entries: [], routeVariants: [] },
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

  it("admits a warmed full catalog against the same generation's static dispatch catalog", async () => {
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
    const fullModelCatalog = {
      entries: [
        { provider: "openai", id: "gpt-5.4", reasoning: true },
        { provider: "openai", id: "account-discovered", reasoning: false },
      ],
      routeVariants: [],
    };
    const readFullModelCatalog = vi.fn(() => fullModelCatalog);
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/dispatch-workspace",
      config,
      modelCatalog: {
        entries: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
        routeVariants: [],
      },
      readFullModelCatalog,
      pluginGeneration,
    });
    const release = vi.fn();
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { config, metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      pluginGeneration: { ...pluginGeneration, pluginRegistry: createEmptyPluginRegistry() },
      release,
    });
    mockRunCronFallbackPassthrough();

    await expect(
      runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture({ cfg: config, agentId: "default" })),
    ).resolves.toMatchObject({ status: "ok", provider: "openai", model: "gpt-5.4" });
    expect(readFullModelCatalog).toHaveBeenCalledOnce();
    expect(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[1]).toMatchObject({
      pluginGeneration,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps model selection on the dispatch generation when the owner read would advance", async () => {
    const config = {
      agents: { entries: { default: { thinkingDefault: "high" as const } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const generationA = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const modelCatalogA = {
      entries: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      routeVariants: [],
    };
    const modelCatalogB = {
      entries: [{ provider: "openai", id: "gpt-5.6-sol", reasoning: true }],
      routeVariants: [],
    };
    const { resolveAgentConfig } = await vi.importActual<
      typeof import("../../agents/agent-scope-config.js")
    >("../../agents/agent-scope-config.js");
    resolveAgentConfigMock.mockImplementation(resolveAgentConfig);
    loadModelCatalogMock.mockResolvedValue([]);
    loadModelCatalogOwnerMock.mockResolvedValue({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/workspace",
      config,
      metadataSnapshot,
      modelCatalog: modelCatalogB,
    });
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/workspace",
      config,
      modelCatalog: modelCatalogA,
      pluginGeneration: generationA,
    });
    const release = vi.fn();
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { config, metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      pluginGeneration: generationA,
      release,
    });
    mockRunCronFallbackPassthrough();

    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: config,
          agentId: "default",
          job: {
            payload: { kind: "agentTurn", message: "test", thinking: "high" },
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "ok", provider: "openai", model: "gpt-5.4" });
    expect(loadModelCatalogOwnerMock).not.toHaveBeenCalled();
    expect(loadModelCatalogMock).not.toHaveBeenCalled();
    expect(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[1]).toMatchObject({
      pluginGeneration: generationA,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains the admitted runtime when a generation publishes during auth preparation", async () => {
    const config = {
      auth: {
        profiles: { test: { provider: "openai", mode: "api_key" as const } },
      },
      agents: { entries: { default: { thinkingDefault: "high" as const } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const generationA = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const generationB = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    let publishedGeneration: PreparedModelRuntimePluginGeneration = generationA;
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
    preparedRuntimeMocks.loadDispatchRuntime.mockImplementation(async () => ({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/dispatch-workspace",
      config,
      modelCatalog: { entries: [], routeVariants: [] },
      pluginGeneration: publishedGeneration,
    }));
    resolveSessionAuthSelectionMock.mockImplementation(async () => {
      publishedGeneration = generationB;
      return undefined;
    });
    const release = vi.fn();
    preparedRuntimeMocks.acquireRuntime.mockImplementation(async (input, options) => {
      if (options?.pluginGeneration !== publishedGeneration) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
        );
      }
      const pluginRegistry = createEmptyPluginRegistry();
      return {
        snapshot: { ...input, metadataSnapshot, pluginRegistry },
        pluginGeneration: { ...publishedGeneration, pluginRegistry },
        release,
      };
    });
    mockRunCronFallbackPassthrough();

    await expect(
      runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture({ cfg: config, agentId: "default" })),
    ).resolves.toMatchObject({ status: "ok" });
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledOnce();
    expect(preparedRuntimeMocks.loadDispatchRuntime).toHaveBeenCalledOnce();
    expect(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[1]).toMatchObject({
      pluginGeneration: generationA,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps catalog-derived selection on the admitted generation after publication", async () => {
    const config = {
      auth: {
        profiles: { test: { provider: "openai", mode: "api_key" as const } },
      },
      agents: { entries: { default: { thinkingDefault: "high" as const } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const generationA = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const generationB = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const modelCatalogA = {
      entries: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      routeVariants: [],
    };
    const modelCatalogB = { entries: [], routeVariants: [] };
    let publishedGeneration: PreparedModelRuntimePluginGeneration = generationA;
    let publishedModelCatalog = modelCatalogA;
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
      modelCatalog: modelCatalogA,
    });
    preparedRuntimeMocks.loadDispatchRuntime.mockImplementation(async () => ({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/dispatch-workspace",
      config,
      modelCatalog: publishedModelCatalog,
      pluginGeneration: publishedGeneration,
    }));
    resolveSessionAuthSelectionMock.mockImplementation(async () => {
      publishedGeneration = generationB;
      publishedModelCatalog = modelCatalogB;
      return undefined;
    });
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { config, metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      pluginGeneration: generationA,
      release: vi.fn(),
    });
    mockRunCronFallbackPassthrough();

    await expect(
      runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture({ cfg: config, agentId: "default" })),
    ).resolves.toMatchObject({ status: "ok", provider: "openai", model: "gpt-5.4" });
    expect(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[1]).toMatchObject({
      pluginGeneration: generationA,
    });
  });

  it("keeps provider-scoped thinking on the admitted generation after publication", async () => {
    const config = {
      auth: {
        profiles: { test: { provider: "openai", mode: "api_key" as const } },
      },
      agents: { entries: { default: { thinkingDefault: "high" as const } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const generationA = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const generationB = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } satisfies PreparedModelRuntimePluginGeneration;
    const unresolvedCatalog = { entries: [], routeVariants: [] };
    let publishedGeneration: PreparedModelRuntimePluginGeneration = generationA;
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
      modelCatalog: unresolvedCatalog,
    });
    loadModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", reasoning: true },
    ]);
    preparedRuntimeMocks.loadDispatchRuntime.mockImplementation(async () => ({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/dispatch-workspace",
      config,
      modelCatalog: unresolvedCatalog,
      pluginGeneration: publishedGeneration,
    }));
    resolveSessionAuthSelectionMock.mockImplementation(async () => {
      publishedGeneration = generationB;
      return undefined;
    });
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { config, metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      pluginGeneration: generationA,
      release: vi.fn(),
    });
    mockRunCronFallbackPassthrough();

    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: config,
          agentId: "default",
          job: { payload: { kind: "agentTurn", message: "test", thinking: "high" } },
        }),
      ),
    ).resolves.toMatchObject({ status: "ok" });
    expect(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[1]).toMatchObject({
      pluginGeneration: generationA,
    });
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-5.4", thinkLevel: "high" }),
    );
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

  it("keeps the execution owner's model pricing through finalization", async () => {
    const config = {
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid/v1",
            models: [
              {
                id: "alias",
                name: "Alias",
                cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const snapshot = (model: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            modelIdNormalization: { providers: { fixture: { aliases: { alias: model } } } },
          },
        ],
      });
    const selected = snapshot("selected");
    const ambient = snapshot("other");
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    acquirePreparedModelRuntimeMock.mockImplementation(async (input) => ({
      snapshot: {
        ...input,
        metadataSnapshot: selected,
        pluginRegistry: createEmptyPluginRegistry(),
      },
      pluginGeneration: {
        pluginMetadataSnapshot: selected,
        configuredCatalogEntries: [],
        inlineProviderModels: [],
      },
      release: vi.fn(),
    }));
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          provider: "fixture",
          model: "selected",
          usage: { input: 1_000_000, output: 0 },
        },
      },
    });
    const result = await withPluginRuntimeGenerationScope({ metadataSnapshot: ambient }, () =>
      runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture({ cfg: config })),
    );
    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.estimatedCostUsd).toBe(3);
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

  it("estimates token-only usage from the selected agent's local model prices", async () => {
    const root = tempDirs.make("cron-owner-pricing-");
    const agentDir = path.join(root, "worker");
    const mainDir = path.join(root, "main");
    for (const [dir, input] of [
      [agentDir, 3],
      [mainDir, 1],
    ] as const) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              models: [{ id: "priced", cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 } }],
            },
          },
        }),
      );
    }
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: { agentDir: mainDir }, worker: { agentDir } },
      },
    };
    loadModelCatalogOwnerMock.mockResolvedValue({
      config,
      agentId: "worker",
      agentDir,
      workspaceDir: root,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      modelCatalog: { entries: [], routeVariants: [] },
    });
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: { provider: "fixture", model: "priced", usage: { input: 1_000_000, output: 0 } },
      },
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ cfg: config, agentId: "worker" }),
    );
    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.estimatedCostUsd).toBe(3);
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
