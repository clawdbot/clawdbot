// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { loadPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelFullCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

async function prepareCatalogOwner(
  config: OpenClawConfig,
  catalogs: readonly ModelCatalogSnapshot[],
) {
  mocks.configuredAgentIds = ["pro"];
  for (const catalog of catalogs) {
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(catalog);
  }
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
  });
  return getPreparedModelRuntimeSnapshot({
    config,
    agentId: "pro",
    agentDir: state.agentDir("pro"),
  })!;
}

describe("prepared model runtime scoped refresh", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it.each([undefined, "provider-a:default"])(
    "retains failed-provider inventory and variants until authoritative recovery (%s)",
    async (profileId) => {
      mocks.preparedAuthStore = {
        version: 1,
        profiles: {
          "provider-a:default": { type: "api_key", provider: "provider-a", key: "fixture-key" },
        },
      };
      const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
      const learned = { provider: "provider-a", id: "learned", name: "Learned" };
      const caseDistinct = { provider: "provider-a", id: "Learned", name: "Case distinct" };
      const variant = { ...learned, baseUrl: "https://catalog.example.test/v1" };
      const fallback = { provider: "provider-a", id: "advisory", name: "Advisory" };
      const sibling = { provider: "provider-b", id: "new", name: "New" };
      const native = {
        provider: "provider-a",
        id: "learned",
        name: "Native",
        nativeRuntime: "fixture-runtime",
      };
      const snapshots: ModelCatalogSnapshot[] = [
        {
          entries: [],
          routeVariants: [],
          staticEntries: [fallback],
          providerOutcomes: [{ provider: "provider-a", profileId, status: "unavailable" }],
        },
        {
          entries: [caseDistinct, native],
          routeVariants: [variant, caseDistinct, native],
          providerOutcomes: [
            { provider: "provider-a", profileId: "provider-a:default", status: "ready" },
          ],
        },
        {
          entries: [fallback, sibling],
          routeVariants: [fallback, sibling],
          staticEntries: [fallback],
          providerOutcomes: [
            { provider: "provider-a", profileId, status: "unavailable" },
            { provider: "provider-b", status: "ready" },
          ],
        },
        {
          entries: [sibling],
          routeVariants: [sibling],
          providerOutcomes: [
            { provider: "provider-a", profileId: "provider-a:default", status: "unavailable" },
            { provider: "provider-b", status: "ready" },
          ],
        },
        {
          entries: [sibling],
          routeVariants: [sibling],
          providerOutcomes: [
            { provider: "provider-a", profileId: "provider-a:default", status: "ready" },
            { provider: "provider-b", status: "ready" },
          ],
        },
      ];
      const owner = await prepareCatalogOwner(config, snapshots);
      expect(await owner.loadFullModelCatalog!()).toMatchObject({
        entries: [fallback],
        routeVariants: [fallback],
        authoritative: false,
        providerOutcomes: snapshots[0]!.providerOutcomes,
      });
      await owner.loadFullModelCatalog!({ refresh: true });
      const failed = await owner.loadFullModelCatalog!({ refresh: true });
      expect(failed.entries).toMatchObject([learned, caseDistinct, sibling]);
      expect(failed.routeVariants).toMatchObject([variant, caseDistinct, sibling]);
      expect(failed.authoritative).toBe(false);
      expect(failed.providerOutcomes).toEqual([
        { provider: "provider-a", profileId, status: "unavailable" },
        { provider: "provider-b", status: "ready" },
      ]);
      const failedAgain = await owner.loadFullModelCatalog!({ refresh: true });
      expect(failedAgain.entries).toMatchObject([learned, caseDistinct, sibling]);
      const recovered = await owner.loadFullModelCatalog!({ refresh: true });
      expect(recovered.entries).toMatchObject([sibling]);
      expect(recovered.routeVariants).toMatchObject([sibling]);
      expect(recovered.authoritative).not.toBe(false);
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(snapshots[2]!);
      expect(await owner.loadFullModelCatalog!({ refresh: true })).toMatchObject({
        entries: [sibling],
        routeVariants: [sibling],
        authoritative: false,
      });
    },
  );

  it.each(["credential", "selected-profile", "synthetic-credential"] as const)(
    "does not retain an account inventory after its %s changes",
    async (change) => {
      const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
      const learned = { provider: "demo", id: "learned", name: "Learned" };
      const starter = { provider: "demo", id: "starter", name: "Starter" };
      const profiles = {
        "demo:first": { type: "api_key" as const, provider: "demo", key: "first-key" },
        "demo:second": { type: "api_key" as const, provider: "demo", key: "second-key" },
      };
      const previous: ModelCatalogSnapshot = {
        entries: [learned],
        routeVariants: [learned],
        providerOutcomes: [
          {
            provider: "demo",
            profileId: change === "synthetic-credential" ? undefined : "demo:first",
            status: "ready",
          },
        ],
      };
      const failed: ModelCatalogSnapshot = {
        entries: [],
        routeVariants: [],
        staticEntries: [starter],
        providerOutcomes: [
          {
            provider: "demo",
            profileId:
              change === "synthetic-credential"
                ? undefined
                : change === "credential"
                  ? "demo:first"
                  : "demo:second",
            status: "unavailable",
          },
        ],
      };
      setPreparedModelFullCatalogAuth(previous, {
        authStore: { version: 1, profiles: change === "synthetic-credential" ? {} : profiles },
        authModes: { demo: "api_key" },
        credentials:
          change === "synthetic-credential"
            ? { demo: { type: "api_key", key: "first-synthetic-key" } }
            : {},
      });
      setPreparedModelFullCatalogAuth(failed, {
        authStore: {
          version: 1,
          profiles:
            change === "synthetic-credential"
              ? {}
              : change === "credential"
                ? {
                    ...profiles,
                    "demo:first": { ...profiles["demo:first"], key: "replacement-key" },
                  }
                : profiles,
        },
        authModes: { demo: "api_key" },
        credentials:
          change === "synthetic-credential"
            ? { demo: { type: "api_key", key: "second-synthetic-key" } }
            : {},
      });
      const owner = await prepareCatalogOwner(config, [previous, failed]);
      await owner.loadFullModelCatalog!();
      expect(await owner.loadFullModelCatalog!({ refresh: true })).toMatchObject({
        entries: [starter],
        routeVariants: [starter],
        authoritative: false,
      });
    },
  );

  it.each(["alias", "mixed-success"] as const)(
    "publishes %s inventory without losing ownership",
    async (scenario) => {
      const originalManifest = mocks.pluginMetadataSnapshot.manifestRegistry;
      const originalPlugins = mocks.pluginMetadataSnapshot.plugins;
      if (scenario === "alias") {
        mocks.pluginMetadataSnapshot.manifestRegistry = { ...originalManifest };
        Object.assign(mocks.pluginMetadataSnapshot.manifestRegistry, {
          plugins: [
            createPluginManifestRecordFixture({
              id: "demo",
              providers: ["demo"],
              origin: "bundled",
              modelCatalog: { aliases: { "old-demo": { provider: "demo" } } },
            }),
          ],
        });
        Object.assign(mocks.pluginMetadataSnapshot, {
          plugins: mocks.pluginMetadataSnapshot.manifestRegistry.plugins,
        });
      }
      const provider = scenario === "alias" ? "old-demo" : "demo";
      mocks.preparedAuthStore = {
        version: 1,
        profiles: {
          "demo:first": { type: "api_key", provider, key: "first-fixture-key" },
          "demo:second": { type: "api_key", provider, key: "second-fixture-key" },
        },
      };
      const previous: ModelCatalogSnapshot = {
        entries: [{ provider: "demo", id: "old", name: "Old" }],
        routeVariants: [
          { provider: "demo", id: "old", name: "Old", baseUrl: "https://demo.example.test/v1" },
        ],
        providerOutcomes: [{ provider, profileId: "demo:first", status: "ready" }],
      };
      const fresh = { provider: "demo", id: "fresh", name: "Fresh" };
      const current: ModelCatalogSnapshot = {
        entries: scenario === "alias" ? [] : [fresh],
        routeVariants: scenario === "alias" ? [] : [fresh],
        providerOutcomes: [
          { provider, profileId: "demo:first", status: "unavailable" },
          ...(scenario === "mixed-success"
            ? [{ provider, profileId: "demo:second", status: "ready" as const }]
            : []),
        ],
      };
      const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
      try {
        const owner = await prepareCatalogOwner(config, [previous, current]);
        await owner.loadFullModelCatalog!();
        const published = await owner.loadFullModelCatalog!({ refresh: true });
        expect(published.entries).toMatchObject(scenario === "alias" ? previous.entries : [fresh]);
        expect(published.routeVariants).toMatchObject(
          scenario === "alias" ? previous.routeVariants : [fresh],
        );
        expect(published.authoritative).toBe(false);
      } finally {
        mocks.pluginMetadataSnapshot.manifestRegistry = originalManifest;
        mocks.pluginMetadataSnapshot.plugins = originalPlugins;
      }
    },
  );

  it.each([undefined, new Set(["pro"])])(
    "carries completed discovery across hot reload without rediscovery (scope: %j)",
    async (agentIds) => {
      mocks.configuredAgentIds = ["pro"];
      const config: OpenClawConfig = {
        agents: { entries: { pro: {} } },
        plugins: { entries: { fixture: { enabled: true } } },
      };
      const discovered = {
        provider: "discovered-provider",
        id: "discovered-model",
        name: "Discovered",
      };
      const catalog = markPreparedModelCatalogFull({
        entries: [discovered],
        routeVariants: [discovered],
      });
      const auth = {
        authModes: { "discovered-provider": "api_key" as const },
        authStore: { version: 1 as const, profiles: {} },
        credentials: mocks.authStorage.getAll(),
      };
      setPreparedModelFullCatalogAuth(catalog, auth);
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(catalog);
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      });
      const input = { agentId: "pro", agentDir: state.agentDir("pro"), config };
      const original = getPreparedModelRuntimeSnapshot(input)!;
      await original.loadFullModelCatalog!();
      expect(
        await loadPreparedGatewayModelCatalogSnapshot({ agentId: "pro", getConfig: () => config }),
      ).toMatchObject({ entries: [discovered], authModes: auth.authModes });

      let currentConfig = config;
      for (const alias of ["First alias", "Second alias"]) {
        mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: false });
        const nextConfig: OpenClawConfig = {
          meta: { lastTouchedVersion: alias },
          plugins: { entries: { fixture: { enabled: true, config: {} } } },
          agents: {
            ...config.agents,
            defaults: {
              model: alias === "First alias" ? undefined : "discovered-provider/discovered-model",
              models: { "custom/configured": { alias } },
              modelPolicy: {
                allow: [alias === "First alias" ? "discovered-provider/*" : "custom/*"],
              },
            },
          },
        };
        await refreshModelRuntimeAfterHotReload({
          config: nextConfig,
          agentIds,
          pluginMetadataSnapshot: undefined,
        });
        currentConfig = nextConfig;
        expect(
          await loadPreparedGatewayModelCatalogSnapshot({
            agentId: "pro",
            getConfig: () => nextConfig,
          }),
        ).toMatchObject({ config: nextConfig, entries: [discovered], authModes: auth.authModes });
        expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
      }
      expect(() => original.readFullModelCatalog!()).toThrow("superseded");
      await expect(original.loadFullModelCatalog!()).rejects.toThrow("superseded");
      const replacement = getPreparedModelRuntimeSnapshot(input)!;
      const refreshed = markPreparedModelCatalogFull({ entries: [], routeVariants: [] });
      setPreparedModelFullCatalogAuth(refreshed, auth);
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(refreshed);
      const refreshedCatalog = await replacement.loadFullModelCatalog!({ refresh: true });
      expect(refreshedCatalog).toMatchObject(refreshed);
      expect(replacement.readFullModelCatalog!()).toBe(refreshedCatalog);
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
      mocks.credentialsRevision += 1;
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      const afterAuth = await loadPreparedGatewayModelCatalogSnapshot({
        agentId: "pro",
        getConfig: () => currentConfig,
      });
      expect(afterAuth.entries).not.toContainEqual(discovered);
      expect(afterAuth.authModes).not.toHaveProperty("discovered-provider");
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "endpoint",
    "plugin",
    "plugin-disabled",
    "plugin-allowlist",
    "configured-models",
    "prepared-credential",
  ] as const)("invalidates retained discovery after the %s identity changes", async (change) => {
    mocks.configuredAgentIds = ["pro"];
    const originalIndex = mocks.pluginMetadataSnapshot.index;
    mocks.pluginMetadataSnapshot.index = { ...originalIndex };
    const configuredProvider: ModelProviderConfig = {
      baseUrl: "https://original.example.test/v1",
      models: [
        {
          id: "configured",
          name: "Configured",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4096,
        },
      ],
    };
    const config: OpenClawConfig = {
      agents: { entries: { pro: {} } },
      plugins: { allow: ["demo"], entries: { demo: { enabled: true } } },
      models: {
        providers: {
          demo: configuredProvider,
        },
      },
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce({
      entries: buildConfiguredModelCatalog({ cfg: config }),
      routeVariants: [],
    });
    const options = { gatewayLifecycle: true, catalogMode: "static" as const };
    const input = { agentId: "pro", agentDir: state.agentDir("pro") };
    try {
      await refreshPreparedModelRuntimeSnapshots(config, options);
      await getPreparedModelRuntimeSnapshot({ ...input, config })!.loadFullModelCatalog!();
      let nextConfig: OpenClawConfig =
        change === "endpoint" || change === "configured-models"
          ? {
              ...config,
              models: {
                providers: {
                  demo: {
                    baseUrl:
                      change === "endpoint"
                        ? "https://replacement.example.test/v1"
                        : "https://original.example.test/v1",
                    models: change === "configured-models" ? [] : configuredProvider.models,
                  },
                },
              },
            }
          : config;
      if (change === "plugin") {
        Object.assign(mocks.pluginMetadataSnapshot.index, { hostContractVersion: "replacement" });
      }
      if (change === "plugin-disabled") {
        nextConfig = {
          ...config,
          plugins: { ...config.plugins, entries: { demo: { enabled: false } } },
        };
      }
      if (change === "plugin-allowlist") {
        nextConfig = { ...config, plugins: { ...config.plugins, allow: ["other"] } };
      }
      if (change === "prepared-credential") {
        mocks.authStorage.getAll.mockReturnValue({
          demo: { type: "api_key", key: "replacement-synthetic-credential" },
        });
      }
      await refreshPreparedModelRuntimeSnapshots(nextConfig, options);
      expect(
        getPreparedModelRuntimeSnapshot({ ...input, config: nextConfig })!.readFullModelCatalog!(),
      ).toBeUndefined();
    } finally {
      mocks.pluginMetadataSnapshot.index = originalIndex;
    }
  });

  it("does not reuse a post-startup account catalog under the startup credentials", async () => {
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const learned = { provider: "demo", id: "private-model", name: "Private model" };
    const catalog: ModelCatalogSnapshot = {
      entries: [learned],
      routeVariants: [learned],
      providerOutcomes: [{ provider: "demo", status: "ready" }],
    };
    setPreparedModelFullCatalogAuth(catalog, {
      authStore: { version: 1, profiles: {} },
      authModes: { demo: "api_key" },
      credentials: { demo: { type: "api_key", key: "post-startup-key" } },
    });
    const owner = await prepareCatalogOwner(config, [catalog]);
    expect((await owner.loadFullModelCatalog!()).entries).toContainEqual(
      expect.objectContaining(learned),
    );
    await refreshModelRuntimeAfterHotReload({
      config,
      agentIds: undefined,
      pluginMetadataSnapshot: undefined,
    });
    const reloaded = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!;
    expect(reloaded.readFullModelCatalog!()).toBeUndefined();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "retains catalog callbacks across scoped exec reloads (warmed: %s)",
    async (warmed) => {
      mocks.configuredAgentIds = ["pro", "free"];
      const initialConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.6-luna" },
          entries: {
            pro: { tools: { exec: { security: "full", ask: "off" } } },
            free: {},
          },
        },
      } satisfies OpenClawConfig;
      const buildCounts: number[] = [];
      const options = {
        gatewayLifecycle: true,
        catalogMode: "static" as const,
        onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
      };
      const freeInput = {
        config: initialConfig,
        agentId: "free",
        agentDir: state.agentDir("free"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-free",
      };
      const proInput = {
        ...freeInput,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
        workspaceDir: "/tmp/workspace-pro",
      };
      // The harness stubs discovery, not the snapshot's catalog guards. Real worker retirement
      // and auth liveness are covered by prepared-model-catalog-worker.integration.test.ts.
      mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
        entries: [],
        routeVariants: [],
      }));
      await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
      const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
      const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);
      let catalog = warmed ? await retainedReader.loadFullModelCatalog!() : undefined;

      for (const ask of ["always", "off"] as const) {
        const previousPro = getPreparedModelRuntimeSnapshot(proInput)!;
        const nextConfig = {
          agents: {
            ...initialConfig.agents,
            entries: {
              ...initialConfig.agents.entries,
              pro: { tools: { exec: { security: "full", ask } } },
            },
          },
        } satisfies OpenClawConfig;
        await refreshPreparedModelRuntimeSnapshots(nextConfig, {
          ...options,
          agentIds: new Set(["pro"]),
        });

        const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig })!;
        expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
        expect(retained).not.toBe(retainedReader);
        expect(retainedReader.config).toBe(initialConfig);
        expect(retained.metadataSnapshot).toBe(retainedReader.metadataSnapshot);
        expect(retained.modelCatalog).toBe(retainedReader.modelCatalog);
        expect(getPreparedModelRuntimeAuthStore(retained)).toBe(retainedAuthStore);
        expect(retained.readFullModelCatalog!()).toBe(catalog);
        expect(retainedReader.readFullModelCatalog!()).toBe(catalog);
        const refreshed = await retained.loadFullModelCatalog!({ refresh: true });
        expect(refreshed).not.toBe(catalog);
        expect(retainedReader.readFullModelCatalog!()).toBe(refreshed);
        catalog = refreshed;
        expect(() => previousPro.readFullModelCatalog!()).toThrow("superseded");
        await expect(previousPro.loadFullModelCatalog!()).rejects.toThrow("superseded");
      }
      expect(buildCounts).toEqual([2, 1, 1]);
    },
  );

  it("reprojects retained discovery when a runtime override is added and removed", async () => {
    mocks.configuredAgentIds = ["pro"];
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      provider,
      id: modelId,
      name: modelId,
      api: "openai-responses",
      baseUrl: "https://synthetic.invalid/v1",
      reasoning: provider === "fixture-runtime",
      input: ["text"],
      contextWindow: 32000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsTools: provider === "fixture-runtime" },
    }));
    const discovered = {
      provider: "custom",
      id: "discovered-model",
      name: "Discovered",
      reasoning: false,
    };
    const catalog = markPreparedModelCatalogFull({
      entries: [discovered],
      routeVariants: [discovered],
    });
    setPreparedModelFullCatalogAuth(catalog, {
      authModes: { custom: "api_key" },
      authStore: { version: 1, profiles: {} },
      credentials: mocks.authStorage.getAll(),
    });
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(catalog);
    const input = { agentId: "pro", agentDir: state.agentDir("pro"), config: {} };
    for (const [index, runtime] of ["openclaw", "fixture-runtime", "openclaw"].entries()) {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "custom/discovered-model",
            models: { "custom/discovered-model": { agentRuntime: { id: runtime } } },
          },
          entries: { pro: {} },
        },
      };
      await refreshModelRuntimeAfterHotReload({
        config,
        agentIds: undefined,
        pluginMetadataSnapshot: undefined,
      });
      const snapshot = getPreparedModelRuntimeSnapshot(input)!;
      if (!snapshot.readFullModelCatalog!()) {
        await snapshot.loadFullModelCatalog!();
      }
      if (runtime === "fixture-runtime") {
        const failed: ModelCatalogSnapshot = {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "custom", status: "unavailable" }],
        };
        setPreparedModelFullCatalogAuth(failed, {
          authModes: { custom: "api_key" },
          authStore: { version: 1, profiles: {} },
          credentials: mocks.authStorage.getAll(),
        });
        mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(failed);
        await snapshot.loadFullModelCatalog!({ refresh: true });
      }
      const projected = await loadPreparedGatewayModelCatalogSnapshot({
        agentId: "pro",
        getConfig: () => config,
      });
      expect(projected.entries).toMatchObject([
        {
          provider: "custom",
          id: "discovered-model",
          reasoning: runtime === "fixture-runtime",
        },
      ]);
      expect(projected.entries[0]?.compat?.supportsTools).toBe(
        runtime === "fixture-runtime" ? true : undefined,
      );
      expect(projected.authModes).toEqual({ custom: "api_key" });
      expect(projected.catalogComplete).toBe(true);
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(index === 0 ? 1 : 2);
    }
  });

  it("recomposes configured models and retires native rows on a compatible reload", async () => {
    const { resolveAgentEffectiveModelPrimary } =
      await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    mocks.resolveAgentEffectiveModelPrimary.mockImplementation(resolveAgentEffectiveModelPrimary);
    const nativeStarted = createDeferredCore();
    const releaseNative = createDeferredCore();
    let holdNative = false;
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      provider,
      id: modelId,
      name: modelId,
      api: "openai-responses",
      baseUrl: "https://configured.example.test/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "fixture-native",
      source: "fixture",
      harness: {
        id: "fixture-native",
        label: "Fixture native",
        supports: () => ({ supported: true }),
        async runAttempt() {
          throw new Error("catalog-only fixture");
        },
        async loadModelCatalog({ config: currentConfig }) {
          if (holdNative) {
            nativeStarted.resolve();
            await releaseNative.promise;
          }
          return [
            {
              provider: "demo",
              id:
                currentConfig.agents?.defaults?.model === "demo/old-configured"
                  ? "native-old"
                  : "native-new",
              name: "Native",
              nativeRuntime: "fixture-native",
            },
          ];
        },
      },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    const config: OpenClawConfig = {
      models: {
        providers: {
          demo: {
            baseUrl: "https://configured.example.test/v1",
            models: [],
            agentRuntime: { id: "fixture-native" },
          },
        },
      },
      agents: {
        entries: { pro: {} },
        defaults: {
          model: "demo/old-configured",
        },
      },
    };
    const learned = { provider: "demo", id: "learned", name: "Learned" };
    const native = {
      provider: "demo",
      id: "native-old",
      name: "Native",
      nativeRuntime: "fixture-native",
    };
    const owner = await prepareCatalogOwner(config, [
      {
        entries: [learned],
        routeVariants: [learned],
        staticEntries: [{ provider: "demo", id: "old-configured", name: "Old" }],
      },
    ]);
    const initial = await owner.loadFullModelCatalog!();
    expect(initial.entries).toContainEqual(expect.objectContaining(native));
    const nextConfig: OpenClawConfig = {
      ...config,
      agents: {
        entries: { pro: {} },
        defaults: {
          model: "demo/new-configured",
        },
      },
    };
    await refreshModelRuntimeAfterHotReload({
      config: nextConfig,
      agentIds: undefined,
      pluginMetadataSnapshot: undefined,
    });
    const nextOwner = getPreparedModelRuntimeSnapshot({
      config: nextConfig,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!;
    const next = nextOwner.readFullModelCatalog!()!;
    expect(next.authoritative).toBe(false);
    expect(next.entries.some((entry) => entry.nativeRuntime)).toBe(false);
    expect(next.entries).toContainEqual(expect.objectContaining(learned));
    expect(next.entries).toContainEqual(
      expect.objectContaining({ provider: "demo", id: "new-configured" }),
    );
    expect(next.staticEntries?.some((entry) => entry.id === "new-configured")).toBe(true);
    expect(next.entries.some((entry) => entry.id === "old-configured")).toBe(false);
    holdNative = true;
    const ordinaryRead = nextOwner.loadFullModelCatalog!();
    await nativeStarted.promise;
    const newlyDiscovered = { provider: "demo", id: "new-discovery", name: "New discovery" };
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce({
      entries: [learned, newlyDiscovered],
      routeVariants: [learned, newlyDiscovered],
    });
    const refreshParams = {
      config: nextConfig,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
      readOnly: false,
      refreshFullCatalog: true,
    };
    const explicitRefresh = loadPreparedModelCatalogSnapshot(refreshParams);
    const concurrentRefresh = loadPreparedModelCatalogSnapshot(refreshParams);
    releaseNative.resolve();
    await ordinaryRead;
    const refreshed = await explicitRefresh;
    expect((await concurrentRefresh).entries).toContainEqual(
      expect.objectContaining(newlyDiscovered),
    );
    expect(refreshed.entries).toContainEqual(expect.objectContaining(newlyDiscovered));
    expect(refreshed.authoritative).not.toBe(false);
    expect(refreshed.entries).toContainEqual(
      expect.objectContaining({ id: "native-new", nativeRuntime: "fixture-native" }),
    );
    expect(refreshed.entries.some((entry) => entry.id === "native-old")).toBe(false);
    const retiredConfig: OpenClawConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          models: { "demo/*": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());
    await refreshModelRuntimeAfterHotReload({
      config: retiredConfig,
      agentIds: undefined,
      pluginMetadataSnapshot: undefined,
    });
    const retired = getPreparedModelRuntimeSnapshot({
      config: retiredConfig,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!.readFullModelCatalog!()!;
    expect(retired.entries).toContainEqual(expect.objectContaining(learned));
    expect(retired.entries.some((entry) => entry.nativeRuntime === "fixture-native")).toBe(false);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
  });

  it("falls back to full refresh when an out-of-scope owner dependency changes", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([2, 2]);
  });

  it("builds only a newly added non-default agent", async () => {
    mocks.configuredAgentIds = ["free"];
    const initialConfig = {
      agents: { entries: { free: { model: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          free: { model: "openai/gpt-5.5" },
          pro: { model: "openai/gpt-5.6" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    mocks.configuredAgentIds = ["free", "pro"];
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([1, 1]);
    expect(
      getPreparedModelRuntimeSnapshot({
        config: nextConfig,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
