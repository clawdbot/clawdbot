// Cron preparation, fallback, and nested admission retain one published owner through cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentConfig, resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveLegacyInheritedAuthDir } from "../../agents/legacy-inherited-auth-dir.js";
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import { isCliProvider as classifyCliProvider } from "../../agents/model-selection-cli.js";
import {
  preparePublishedModelCatalogOwnerIdentity,
  resolvePublishedModelCatalogOwner,
} from "../../agents/prepared-model-catalog-owner.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "../../agents/prepared-model-runtime-lease.js";
import {
  prepareModelRuntimeOwner,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  PreparedModelRuntimeOwnerRetention,
} from "../../agents/prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeSnapshot,
  PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../agents/runtime-plugins.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { installPluginMetadataOwner } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../../plugins/plugin-cache.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
} from "../../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadataSnapshotRuntime from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeProviderModelIdWithPlugin } from "../../plugins/provider-model-normalization.runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  cleanupBrowserSessionsForLifecycleEndMock,
  dispatchCronDeliveryMock,
  ensureAgentWorkspaceMock,
  isCliProviderMock,
  acquirePreparedModelRuntimeMock,
  loadPublishedReplyDispatchRuntimeMock,
  loadModelCatalogOwnerMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  preflightCronModelProviderMock,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const preparedRuntimeMocks = {
  acquireRuntime: acquirePreparedModelRuntimeMock,
  loadDispatchRuntime: loadPublishedReplyDispatchRuntimeMock,
};

const { PreparedModelRuntimeOwnerNotPublishedError } = await vi.importActual<
  typeof import("../../agents/prepared-model-runtime.errors.js")
>("../../agents/prepared-model-runtime.errors.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makePublishedFixture(
  config: OpenClawConfig,
  workspaceDir: string,
  metadataSnapshot = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: { plugins: [], diagnostics: [] },
  }),
  pluginRegistry: PluginRegistry = createEmptyPluginRegistry(),
) {
  const input = {
    config,
    agentId: "default",
    agentDir: resolveAgentDir(config, "default"),
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config),
    workspaceDir,
  };
  const snapshot: PreparedModelRuntimeSnapshot = {
    ...input,
    catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
    authModes: {},
    activeProjectKeys: [],
    allowGatewaySubagentBinding: true,
    metadataSnapshot,
    pluginRegistry,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("test must not materialize provider stores");
    },
  };
  setPreparedModelRuntimeAuthStore(snapshot, { version: 1, profiles: {} });
  const dispatch: PreparedReplyDispatchRuntime = {
    config,
    agentId: "default",
    agentDir: snapshot.agentDir,
    workspaceDir,
    modelCatalog: snapshot.modelCatalog,
    inboundPluginRegistry: pluginRegistry,
    pluginGeneration: {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
      pluginRegistry,
    },
  };
  return { snapshot, dispatch, release: vi.fn() };
}

function snapshotWithConfig(
  snapshot: PreparedModelRuntimeSnapshot,
  config: OpenClawConfig,
  pluginRegistry = snapshot.pluginRegistry,
): PreparedModelRuntimeSnapshot {
  const projected = { ...snapshot, config, pluginRegistry };
  setPreparedModelRuntimeAuthStore(projected, { version: 1, profiles: {} });
  return projected;
}

function installPublishedFixture(fixture: ReturnType<typeof makePublishedFixture>) {
  const preparationGeneration = { ...fixture.dispatch.pluginGeneration };
  const selectedGeneration = {
    ...preparationGeneration,
    pluginRegistry: createEmptyPluginRegistry(),
  };
  const selectedRelease = vi.fn();
  preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue(fixture.dispatch);
  preparedRuntimeMocks.acquireRuntime.mockImplementation(async (input) => {
    const selected = input.runtimePluginSelections !== undefined;
    const pluginGeneration = selected ? selectedGeneration : preparationGeneration;
    return {
      snapshot: snapshotWithConfig(fixture.snapshot, input.config, pluginGeneration.pluginRegistry),
      pluginGeneration,
      release: selected ? selectedRelease : fixture.release,
    };
  });
  loadModelCatalogOwnerMock.mockResolvedValue(resolvePublishedModelCatalogOwner(fixture.snapshot));
  ensureAgentWorkspaceMock.mockResolvedValue({ dir: fixture.snapshot.workspaceDir });
  return { preparationGeneration, selectedGeneration, selectedRelease };
}

function fixtureConfig(workspace: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "default" }, workspace, thinkingDefault: "off" },
      entries: { default: { workspace, verboseDefault: "on" } },
    },
  };
}

describe("runCronIsolatedAgentTurn plugin generation carry", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    cleanupBrowserSessionsForLifecycleEndMock.mockReset();
    cleanupBrowserSessionsForLifecycleEndMock.mockResolvedValue(undefined);
  });

  it("retains the selected generation through delivery and browser cleanup, then closes borrowing", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspaceDir = state.path("workspace");
      const fixture = makePublishedFixture(fixtureConfig(workspaceDir), workspaceDir);
      const { preparationGeneration, selectedGeneration, selectedRelease } =
        installPublishedFixture(fixture);
      resolveAgentConfigMock.mockImplementation(resolveAgentConfig);
      mockRunCronFallbackPassthrough();
      const afterRun = createDeferred();
      let borrowedAfterClose: Promise<unknown> | undefined;
      runEmbeddedAgentMock.mockImplementation(async (params) => {
        expect(params.config).toEqual(
          preparedRuntimeMocks.acquireRuntime.mock.calls[1]?.[0].config,
        );
        expect(getPreparedModelRuntimePluginGeneration()).toBe(selectedGeneration);
        expect(getPreparedModelRuntimeBorrowedSnapshot(selectedGeneration)?.config).toBe(
          params.config,
        );
        borrowedAfterClose = afterRun.promise.then(() =>
          getPreparedModelRuntimeBorrowedSnapshot(selectedGeneration),
        );
        return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
      });
      const deliver = dispatchCronDeliveryMock.getMockImplementation()!;
      dispatchCronDeliveryMock.mockImplementation((...args) => {
        expect(fixture.release).not.toHaveBeenCalled();
        expect(selectedRelease).not.toHaveBeenCalled();
        expect(getPreparedModelRuntimePluginGeneration()).toBe(selectedGeneration);
        return deliver(...args);
      });
      cleanupBrowserSessionsForLifecycleEndMock.mockImplementation(async () => {
        expect(fixture.release).not.toHaveBeenCalled();
        expect(selectedRelease).not.toHaveBeenCalled();
        expect(getPreparedModelRuntimePluginGeneration()).toBe(selectedGeneration);
      });

      await expect(
        runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({ cfg: fixture.snapshot.config, agentId: "default" }),
        ),
      ).resolves.toMatchObject({ status: "ok" });
      const dispatchAdmission = preparedRuntimeMocks.loadDispatchRuntime.mock.calls[0]?.[0];
      expect(dispatchAdmission).toMatchObject({
        agentId: fixture.dispatch.agentId,
        abortSignal: expect.any(AbortSignal),
      });
      expect(preparedRuntimeMocks.acquireRuntime).toHaveBeenCalledTimes(2);
      expect(
        preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[0].config.agents.defaults,
      ).toMatchObject({ thinkingDefault: "off", verboseDefault: "on" });
      expect(preparedRuntimeMocks.acquireRuntime.mock.calls[0]?.[1].pluginGeneration).toBe(
        fixture.dispatch.pluginGeneration,
      );
      expect(preparedRuntimeMocks.acquireRuntime.mock.calls[1]?.[0]).toMatchObject({
        agentId: "default",
        agentDir: fixture.snapshot.agentDir,
        workspaceDir,
        allowGatewaySubagentBinding: true,
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", agentId: "default" },
          { provider: "openai", modelId: "gpt-5.6-sol", agentId: "default" },
        ],
      });
      expect(preparedRuntimeMocks.acquireRuntime.mock.calls[1]?.[1]).toEqual({
        catalogMode: "static",
        pluginGeneration: preparationGeneration,
        abortSignal: dispatchAdmission.abortSignal,
      });
      expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledOnce();
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(selectedRelease).toHaveBeenCalledOnce();
      afterRun.resolve();
      await expect(borrowedAfterClose).resolves.toBeUndefined();
      expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
    });
  });

  it("keeps cold aliases, fallback, and actual nested lease admission on A when B publishes during preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const buildConfig = async (generation: string) => {
        const workspaceDir = state.path(generation);
        const pluginId = `cron-normalizer-${generation}`;
        const rootDir = path.join(workspaceDir, ".openclaw", "extensions", pluginId);
        await fs.mkdir(rootDir, { recursive: true });
        const fixture = createColdPluginFixture({
          rootDir,
          pluginId,
          manifest: {
            providers: ["custom"],
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            modelIdNormalization: {
              providers: {
                custom: {
                  aliases: { primary: `${generation}-primary`, fallback: `${generation}-fallback` },
                },
              },
            },
          },
        });
        // Manifest aliases belong to this same provider owner. Metadata stays cold;
        // the explicit startup load below imports its executable registration once.
        await fs.writeFile(
          fixture.runtimeSource,
          `require("node:fs").appendFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded\\n", "utf8");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerProvider({ id: "custom", label: "Cron fixture provider", auth: [] });
  },
};\n`,
        );
        const config: OpenClawConfig = {
          ...fixtureConfig(workspaceDir),
          plugins: {
            allow: [pluginId],
            slots: { memory: "none" },
            entries: { [pluginId]: { enabled: true } },
          },
          models: {
            providers: {
              custom: {
                baseUrl: "http://127.0.0.1:1/v1",
                api: "openai-completions",
                models: ["primary", "fallback"].map<ModelDefinitionConfig>((id) => ({
                  id: `${generation}-${id}`,
                  name: id,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 256,
                })),
              },
            },
          },
        };
        config.agents!.defaults!.model = {
          primary: "custom/primary",
          fallbacks: ["custom/fallback"],
        };
        return { config, workspaceDir, fixture };
      };
      const captured = await buildConfig("captured");
      const ambient = await buildConfig("ambient");
      const pluginCache = createPluginCache();
      const metadataOwner = createPluginMetadataOwner(pluginCache);
      const dispose = installPluginMetadataOwner(metadataOwner, pluginCache);
      const loadSnapshot = vi.spyOn(pluginMetadataSnapshotRuntime, "loadPluginMetadataSnapshot");
      try {
        const capturedMetadata = metadataOwner.prepare({ config: captured.config });
        metadataOwner.publish(capturedMetadata, { config: captured.config });
        const makeRuntime = (
          value: typeof captured,
          metadataSnapshot: PluginMetadataSnapshot,
          pluginRegistry?: PluginRegistry,
        ) =>
          makePublishedFixture(value.config, value.workspaceDir, metadataSnapshot, pluginRegistry);
        const capturedSnapshot = getPluginMetadataWorkspaceSnapshot(capturedMetadata, {
          workspaceDir: captured.workspaceDir,
        });
        expect([captured.fixture, ambient.fixture].some(isColdPluginRuntimeLoaded)).toBe(false);
        const configuredRegistry = loadAgentRuntimePluginRegistryHandle({
          config: captured.config,
          workspaceDir: captured.workspaceDir,
          metadataSnapshot: capturedSnapshot,
          basePluginIds: [],
          allowGatewaySubagentBinding: true,
          selections: [
            { provider: "custom", modelId: "captured-primary", agentId: "default" },
            { provider: "custom", modelId: "captured-fallback", agentId: "default" },
          ],
        });
        expect(configuredRegistry.providers).toEqual([
          expect.objectContaining({
            pluginId: captured.fixture.pluginId,
            provider: expect.objectContaining({ id: "custom" }),
          }),
        ]);
        expect(await fs.readFile(captured.fixture.runtimeMarker, "utf8")).toBe("loaded\n");
        const first = makeRuntime(captured, capturedSnapshot, configuredRegistry);
        const replacementMetadata = metadataOwner.prepare({ config: ambient.config });
        const next = makeRuntime(
          ambient,
          getPluginMetadataWorkspaceSnapshot(replacementMetadata, {
            workspaceDir: ambient.workspaceDir,
          }),
        );
        installPublishedFixture(first);
        resolveAgentConfigMock.mockImplementation(resolveAgentConfig);
        // Finalization classifies the provider again, after the execution callback returns.
        isCliProviderMock.mockImplementation(classifyCliProvider);
        resolveConfiguredModelRefMock.mockReturnValue({ provider: "custom", model: "primary" });
        const owners = new Map<string, PreparedModelRuntimeOwner>();
        const nextInput = normalizePreparedModelRuntimeInput({
          config: next.snapshot.config,
          agentId: next.snapshot.agentId,
          agentDir: next.snapshot.agentDir,
          workspaceDir: next.snapshot.workspaceDir,
          allowGatewaySubagentBinding: true,
        });
        const nextOwner = prepareModelRuntimeOwner(nextInput, "configured", "static");
        Object.assign(nextOwner, {
          snapshot: next.snapshot,
          pluginGeneration: next.dispatch.pluginGeneration,
          needsRefresh: false,
        });
        owners.set(ownerKey(nextInput), nextOwner);
        const prepareSnapshot = vi.fn(async () => {
          throw new Error("nested admission must borrow the captured lease without discovery");
        });
        const leaseContext = {
          owners,
          agentBuildCompletions: new Map<string, Promise<void>>(),
          retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(1),
          retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(1),
          getBuildTimeoutMs: () => 1_000,
          getGatewayLifecycleActive: () => true,
          getPendingReplacement: () => undefined,
          prepareSnapshot,
        };
        let retainedSnapshot: PreparedModelRuntimeSnapshot | undefined;
        let selectedSnapshot: PreparedModelRuntimeSnapshot | undefined;
        preparedRuntimeMocks.acquireRuntime.mockImplementation(async (input, options) => {
          if (input.runtimePluginSelections === undefined) {
            retainedSnapshot = snapshotWithConfig(first.snapshot, input.config);
            return {
              snapshot: retainedSnapshot,
              pluginGeneration: first.dispatch.pluginGeneration,
              release: first.release,
            };
          }
          // A real selected admission after B publishes must borrow the exact projected A owner.
          const lease = await acquirePreparedModelRuntimeLeaseFromOwners(
            input,
            "run",
            leaseContext,
            options,
          );
          selectedSnapshot = lease.snapshot;
          return lease;
        });
        const preparedLoads = loadSnapshot.mock.calls.length;
        ensureAgentWorkspaceMock.mockImplementation(async () => {
          metadataOwner.publish(replacementMetadata, { config: ambient.config });
          setRuntimeConfigSnapshot(ambient.config, captured.config);
          preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue(next.dispatch);
          return { dir: captured.workspaceDir };
        });
        preflightCronModelProviderMock.mockImplementation(async ({ model }) =>
          model.endsWith("primary")
            ? { status: "unavailable", reason: "fixture primary unavailable" }
            : { status: "available" },
        );
        // Exercise the real fallback normalization consumer; provider I/O remains the existing harness seam.
        runWithModelFallbackMock.mockImplementation(async (params) => {
          const candidate = resolveModelCandidateChain(params)[0]!;
          const result = await params.run(candidate.provider, candidate.model);
          return { result, provider: candidate.provider, model: candidate.model, attempts: [] };
        });
        let nestedSnapshot: PreparedModelRuntimeSnapshot | undefined;
        runEmbeddedAgentMock.mockImplementation(async (params) => {
          const lease = await acquirePreparedModelRuntimeLeaseFromOwners(
            {
              config: params.config,
              agentId: params.agentId,
              agentDir: params.agentDir,
              workspaceDir: params.workspaceDir,
              allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            },
            "run",
            leaseContext,
            {
              catalogMode: "static",
              pluginGeneration: getPreparedModelRuntimePluginGeneration(),
              abortSignal: params.abortSignal,
            },
          );
          try {
            nestedSnapshot = lease.snapshot;
            return { payloads: [{ text: "captured fallback completed" }], meta: { agentMeta: {} } };
          } finally {
            lease.release();
          }
        });

        const result = await runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({
            cfg: captured.config,
            agentId: "default",
          }),
        );
        expect(result, result.error).toMatchObject({
          status: "ok",
          provider: "custom",
          model: "captured-fallback",
        });
        expect(preflightCronModelProviderMock.mock.calls.map(([params]) => params.model)).toEqual([
          "captured-primary",
          "captured-fallback",
        ]);
        expect(retainedSnapshot?.config.agents?.defaults?.verboseDefault).toBe("on");
        expect(captured.config.agents?.defaults?.verboseDefault).toBeUndefined();
        expect(selectedSnapshot).toBe(retainedSnapshot);
        expect(nestedSnapshot).toBe(retainedSnapshot);
        expect(owners.get(ownerKey(nextInput))?.snapshot).toBe(next.snapshot);
        expect(first.release).toHaveBeenCalledOnce();
        expect(next.release).not.toHaveBeenCalled();
        expect(prepareSnapshot).not.toHaveBeenCalled();
        expect(loadSnapshot.mock.calls.length).toBe(preparedLoads);
        expect(await fs.readFile(captured.fixture.runtimeMarker, "utf8")).toBe("loaded\n");
        expect(isColdPluginRuntimeLoaded(ambient.fixture)).toBe(false);
      } finally {
        clearRuntimeConfigSnapshot();
        loadSnapshot.mockRestore();
        dispose();
        clearPluginMetadataLifecycleCaches();
      }
    });
  });

  it.each([
    "preparation error",
    "model rejection",
    "preflight skip",
    "continuation error",
    "execution error",
    "cleanup error",
  ])("releases the admitted owner after %s", async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspaceDir = state.path("workspace");
      const fixture = makePublishedFixture(fixtureConfig(workspaceDir), workspaceDir);
      const { selectedRelease } = installPublishedFixture(fixture);
      mockRunCronFallbackPassthrough();
      const error = new Error(`fixture ${failure}`);
      if (failure === "preparation error") {
        ensureAgentWorkspaceMock.mockRejectedValue(error);
      } else if (failure === "model rejection") {
        resolveAllowedModelRefMock.mockReturnValue({ error: "model not allowed: custom/blocked" });
      } else if (failure === "preflight skip") {
        preflightCronModelProviderMock.mockResolvedValue({
          status: "unavailable",
          reason: error.message,
        });
      } else if (failure === "continuation error") {
        const sessionState = await import("./run-session-state.js");
        const initialize = vi
          .spyOn(sessionState, "createCronRunContinuationSession")
          .mockReturnValue({
            initialize: async () => {
              throw error;
            },
            sync: async () => {},
            setCliExecutionProvider: async () => {},
            seal: async () => {},
          });
        onTestFinished(() => initialize.mockRestore());
      } else if (failure === "execution error") {
        runEmbeddedAgentMock.mockRejectedValue(error);
      } else {
        cleanupBrowserSessionsForLifecycleEndMock.mockRejectedValue(error);
      }
      const run = runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: fixture.snapshot.config,
          ...(failure === "model rejection"
            ? {
                job: makeIsolatedAgentJobFixture({
                  payload: { kind: "agentTurn", message: "test", model: "custom/blocked" },
                }),
              }
            : {}),
        }),
      );
      if (
        failure === "preparation error" ||
        failure === "continuation error" ||
        failure === "cleanup error"
      ) {
        await expect(run).rejects.toBe(error);
      } else {
        await expect(run).resolves.toMatchObject({
          status: failure === "preflight skip" ? "skipped" : "error",
        });
      }
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(selectedRelease).toHaveBeenCalledTimes(
        ["continuation error", "execution error", "cleanup error"].includes(failure) ? 1 : 0,
      );
      expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
    });
  });

  it("prepares a standalone generation without replacing the preparation-time ambient registry", async () => {
    const provider = "standalone-normalizer";
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: provider,
      source: "test",
      provider: {
        id: provider,
        label: "Standalone normalizer",
        auth: [],
        normalizeModelId: ({ modelId }) => `${modelId}-normalized`,
      },
    });
    ensureAgentWorkspaceMock.mockImplementation(async ({ dir }) => {
      expect(
        normalizeProviderModelIdWithPlugin({
          provider,
          plugins: [],
          context: { provider, modelId: "fixture" },
        }),
      ).toBe("fixture-normalized");
      return { dir };
    });
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue(undefined);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockImplementation(async () => {
      expect(getPreparedModelRuntimePluginGeneration()).toBeDefined();
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    await expect(
      withPluginRuntimeRegistryScope(registry, () =>
        runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture()),
      ),
    ).resolves.toMatchObject({ status: "ok" });
    expect(preparedRuntimeMocks.acquireRuntime).toHaveBeenCalledOnce();
  });

  it.each(["load", "acquire"])(
    "does not turn a Gateway %s failure into standalone execution",
    async (boundary) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const workspaceDir = state.path("workspace");
        const fixture = makePublishedFixture(fixtureConfig(workspaceDir), workspaceDir);
        installPublishedFixture(fixture);
        const error = new PreparedModelRuntimeOwnerNotPublishedError(
          "fixture generation superseded",
        );
        (boundary === "load"
          ? preparedRuntimeMocks.loadDispatchRuntime
          : preparedRuntimeMocks.acquireRuntime
        ).mockRejectedValue(error);
        await expect(
          runCronIsolatedAgentTurn(
            makeIsolatedAgentParamsFixture({ cfg: fixture.snapshot.config }),
          ),
        ).rejects.toBe(error);
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(fixture.release).not.toHaveBeenCalled();
      });
    },
  );
});
