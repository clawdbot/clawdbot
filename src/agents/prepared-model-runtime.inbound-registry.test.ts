// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPreparedPluginMetadataFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { DiscoverAuthStorageOptions } from "./agent-auth-discovery.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared reply dispatch runtime", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it("returns undefined while the Gateway lifecycle is inactive", async () => {
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toBeUndefined();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("carries newly selected provider auth into a derived generation and its refresh", async () => {
    const { resolveAmbientAgentCredentialsForDiscovery } = await vi.importActual<
      typeof import("./agent-auth-discovery.js")
    >("./agent-auth-discovery.js");
    mocks.resolveAmbientCredentials.mockImplementation((options) =>
      resolveAmbientAgentCredentialsForDiscovery(
        options as Parameters<typeof resolveAmbientAgentCredentialsForDiscovery>[0],
      ),
    );
    mocks.discoverAuthStorage.mockImplementation((_dir, options) => ({
      getAll: () => (options as DiscoverAuthStorageOptions).ambientCredentials,
      getOAuthProviders: () => [],
    }));
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "initial/model" } } };
    const selectedRegistry = createEmptyPluginRegistry();
    selectedRegistry.providers.push({
      pluginId: "selected-provider",
      source: "test",
      provider: {
        id: "selected",
        label: "Selected provider",
        auth: [],
        resolveSyntheticAuth: () => ({
          apiKey: "synthetic-provider-fixture",
          source: "fixture",
          mode: "api-key",
        }),
      },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
      params.selections?.some(
        (selection: { provider: string }) => selection.provider === "selected",
      )
        ? selectedRegistry
        : (params.reusableRegistry ?? createEmptyPluginRegistry()),
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const input = {
      config,
      agentId: "default",
      agentDir: published.agentDir,
      workspaceDir: published.workspaceDir,
      runtimePluginSelections: [{ provider: "selected", modelId: "model", runtime: "openclaw" }],
    };
    const lease = await acquireAgentRunPreparedModelRuntime(input, {
      catalogMode: "static",
      pluginGeneration: published.pluginGeneration,
    });
    expect(lease.snapshot.pluginRegistry === selectedRegistry).toBe(true);
    expect(lease.snapshot.authModes.selected).toBe("api_key");
    expect(published.pluginGeneration.preparedStaticProviderCatalog?.providers).toBeUndefined();
    lease.release();
    const publishedRefresh = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        publishedRefresh.resolve();
      }
    });
    mocks.mutationListener?.({ affectsInheritedStores: true });
    await publishedRefresh.promise;
    unregister();
    expect(getPreparedModelRuntimeSnapshot(input)?.authModes.selected).toBe("api_key");
  });

  it("isolates selected run owners while retaining the published generation and lease lifetime", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "custom/model" } } };
    const registries = new Map(
      ["first-harness", "second-harness"].map((runtime) => {
        const registry = createEmptyPluginRegistry();
        registry.agentHarnesses.push({
          pluginId: runtime,
          source: "test",
          harness: {
            id: runtime,
            label: runtime,
            supports: () => ({ supported: true }),
            runAttempt: async () => {
              throw new Error("unused");
            },
          },
        });
        return [runtime, registry] as const;
      }),
    );
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
      const runtime = params.selections?.[0]?.runtime;
      const registry = runtime ? registries.get(runtime) : undefined;
      return registry ?? createEmptyPluginRegistry();
    });
    const manifests: PluginManifestRecord[] = [...registries.keys()].map((id) => ({
      id,
      name: id,
      origin: "bundled",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      rootDir: `/plugins/${id}`,
      source: `/plugins/${id}/index.js`,
      manifestPath: `/plugins/${id}/openclaw.plugin.json`,
      activation: { onStartup: false, onAgentHarnesses: [id] },
    }));
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      pluginMetadata: createPreparedPluginMetadataFixture({
        unionSnapshot: createPluginMetadataSnapshot({
          config,
          workspaceDir: "/tmp/unused-workspace",
          manifestRegistry: { plugins: manifests, diagnostics: [] },
        }),
        agentWorkspaceDirs: new Map([["default", "/tmp/unused-workspace"]]),
      }),
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const input = (runtime: string) => ({
      config,
      agentId: "default",
      agentDir: published.agentDir,
      workspaceDir: published.workspaceDir,
      allowGatewaySubagentBinding: true,
      runtimePluginSelections: [{ provider: "custom", modelId: "model", runtime }],
    });
    const options = {
      catalogMode: "static" as const,
      pluginGeneration: published.pluginGeneration,
    };
    const leases = await Promise.all(
      [...registries.keys()].map((runtime) =>
        acquireAgentRunPreparedModelRuntime(input(runtime), options),
      ),
    );
    for (const [index, runtime] of [...registries.keys()].entries()) {
      const lease = leases[index]!;
      expect(lease.snapshot.pluginRegistry === registries.get(runtime)).toBe(true);
      expect(lease.snapshot.metadataSnapshot).toBe(
        published.pluginGeneration.pluginMetadataSnapshot,
      );
      expect(lease.pluginGeneration.inboundPluginRegistry).toBe(published.inboundPluginRegistry);
      expect(Object.isFrozen(lease.pluginGeneration)).toBe(true);
      const repeated = await acquireAgentRunPreparedModelRuntime(input(runtime), options);
      expect(repeated.snapshot === lease.snapshot).toBe(true);
      expect(repeated.pluginGeneration === lease.pluginGeneration).toBe(true);
      repeated.release();
      let active = true;
      await withPreparedModelRuntimePluginGenerationScope(
        lease.pluginGeneration,
        async () => {
          const nested = await acquireAgentRunPreparedModelRuntime(input(runtime), {
            pluginGeneration: lease.pluginGeneration,
          });
          expect(nested.snapshot === lease.snapshot).toBe(true);
          nested.release();
          const otherRuntime = [...registries.keys()].find((candidate) => candidate !== runtime)!;
          await expect(
            acquireAgentRunPreparedModelRuntime(input(otherRuntime), {
              pluginGeneration: lease.pluginGeneration,
            }),
          ).rejects.toThrow("plugin generation was superseded");
          active = false;
          lease.release();
          await expect(
            acquireAgentRunPreparedModelRuntime(input(runtime), {
              pluginGeneration: lease.pluginGeneration,
            }),
          ).rejects.toThrow("plugin generation was superseded");
        },
        () => (active ? lease.snapshot : undefined),
      );
    }
    expect(
      (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })) === published,
    ).toBe(true);
    expect(published.pluginGeneration.pluginRegistry?.agentHarnesses).toEqual([]);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(4);
  });

  it("atomically replaces one complete prepared dispatch runtime across a Gateway refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const firstConfig = {};
    const replacementConfig = { plugins: {} };
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: firstConfig,
      workspaceDir: "/tmp/unused-workspace",
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const pluginMetadata = createPreparedPluginMetadataFixture({
      unionSnapshot: metadataSnapshot,
      agentWorkspaceDirs: new Map([["default", "/tmp/unused-workspace"]]),
    });
    const firstRegistry = createEmptyPluginRegistry();
    const replacementRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
      const request = params as { config: unknown; selections?: unknown };
      if (request.selections) {
        return createEmptyPluginRegistry();
      }
      return request.config === firstConfig ? firstRegistry : replacementRegistry;
    });
    await refreshPreparedModelRuntimeSnapshots(firstConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      pluginMetadata,
    });
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: firstConfig,
      workspaceDir: "/tmp/unused-workspace",
      allowGatewaySubagentBinding: true,
    };
    const firstSnapshot = getPreparedModelRuntimeSnapshot(input);
    const firstRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    expect(firstRuntime).toMatchObject({
      agentId: "default",
      agentDir: state.agentDir("default"),
      workspaceDir: "/tmp/unused-workspace",
      config: firstConfig,
      modelCatalog: firstSnapshot?.modelCatalog,
      inboundPluginRegistry: firstRegistry,
    });
    expect(firstRuntime?.pluginGeneration?.pluginMetadataSnapshot).toBe(metadataSnapshot);
    expect(firstSnapshot?.metadataSnapshot).toBe(metadataSnapshot);
    expect(Object.isFrozen(firstRuntime)).toBe(true);

    const replacementCatalog = createDeferred<{ entries: [] }>();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => await replacementCatalog.promise);
    let refresh: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let read: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    try {
      refresh = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadata,
      });
      await vi.waitFor(() =>
        expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(4),
      );
      expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
      let resolvedRuntime: unknown;
      read = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }).then((runtime) => {
        resolvedRuntime = runtime;
        return runtime;
      });
      await Promise.resolve();
      expect(resolvedRuntime).toBeUndefined();

      replacementCatalog.resolve({ entries: [] });
      await expect(refresh).resolves.toBeUndefined();
      const replacementRuntime = await read;
      expect(replacementRuntime).toMatchObject({
        agentId: "default",
        agentDir: state.agentDir("default"),
        workspaceDir: "/tmp/unused-workspace",
        config: replacementConfig,
        inboundPluginRegistry: replacementRegistry,
      });
      expect(replacementRuntime).not.toBe(firstRuntime);
      expect(replacementRuntime?.modelCatalog).not.toBe(firstRuntime?.modelCatalog);
    } finally {
      replacementCatalog.resolve({ entries: [] });
      await Promise.allSettled([refresh, read]);
    }
  });

  it("resolves the configured inbound registry across a launch-workspace override", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = retainLegacyDefaultAgentId({ agents: { entries: { default: {} } } }, "default");
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const published = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config,
      workspaceDir: "/tmp/gateway-launch-workspace",
      allowGatewaySubagentBinding: true,
    });
    const publicationLoadCount = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;

    const runtimes = await Promise.all([
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ]);
    expect(runtimes).toEqual([runtimes[0], runtimes[0], runtimes[0]]);
    expect(runtimes[0]).toMatchObject({
      workspaceDir: "/tmp/gateway-launch-workspace",
      config,
      modelCatalog: published?.modelCatalog,
    });
    expect(runtimes[0]?.inboundPluginRegistry).toBeDefined();
    expect(published).toBeDefined();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(publicationLoadCount);
  });

  it("reuses configured and retained dynamic plugin generations during auth refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const workspaceDir = "/tmp/dynamic-auth-workspace";
    const catalogGenerationRegistries: unknown[] = [];
    const dynamicPreparationRegistries: unknown[] = [];
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      (params) => params.reusableRegistry ?? createEmptyPluginRegistry(),
    );
    mocks.buildPreparedModelCatalogSnapshot.mockImplementation(async () => {
      catalogGenerationRegistries.push(getPluginRuntimeGenerationRegistry());
      return { entries: [], routeVariants: [] };
    });
    mocks.resolveAmbientCredentials.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { workspaceDir?: string };
      if (params.workspaceDir === workspaceDir) {
        dynamicPreparationRegistries.push(getPluginRuntimeGenerationRegistry());
      }
      return {};
    });
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    const configuredRuntimeBefore = await loadPublishedGatewayReplyDispatchRuntime({
      agentId: "default",
    });
    if (!configuredRuntimeBefore) {
      throw new Error("expected configured reply runtime");
    }
    const configuredInput = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config,
      workspaceDir: "/tmp/unused-workspace",
    };
    const configuredSelectedBefore =
      getPreparedModelRuntimeSnapshot(configuredInput)?.pluginRegistry;
    const dynamicInput = {
      ...configuredInput,
      workspaceDir,
      runtimePluginSelections: [
        { provider: "openai", modelId: "gpt-5.5", runtime: "codex" as const },
      ],
    };
    const dynamicLease = await acquireAgentRunPreparedModelRuntime(dynamicInput, {
      pluginGeneration: configuredRuntimeBefore.pluginGeneration,
    });
    const dynamicSelectedBefore = dynamicLease.snapshot.pluginRegistry;
    expect(getPluginRuntimeLoadContext(dynamicSelectedBefore)).toMatchObject({
      preferBuiltPluginArtifacts: true,
    });
    dynamicLease.release();
    expect(dynamicPreparationRegistries.every(Boolean)).toBe(true);
    expect(catalogGenerationRegistries.every(Boolean)).toBe(true);
    expect(dynamicSelectedBefore).toBe(configuredSelectedBefore);
    const authStorageCallsBeforeAuth = mocks.discoverAuthStorage.mock.calls.length;
    const modelCallsBeforeAuth = mocks.discoverModels.mock.calls.length;
    const staticCatalogCallsBeforeAuth = mocks.prepareStaticCatalog.mock.calls.length;
    const published = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        published.resolve();
      }
    });

    mocks.mutationListener?.({ affectsInheritedStores: true });
    await published.promise;
    unregister();

    expect(mocks.discoverAuthStorage.mock.calls.length - authStorageCallsBeforeAuth).toBe(2);
    expect(mocks.discoverModels.mock.calls.length - modelCallsBeforeAuth).toBe(2);
    expect(mocks.prepareStaticCatalog.mock.calls.length - staticCatalogCallsBeforeAuth).toBe(0);
    const configuredRuntimeAfter = await loadPublishedGatewayReplyDispatchRuntime({
      agentId: "default",
    });
    expect(configuredRuntimeAfter?.inboundPluginRegistry).toBe(
      configuredRuntimeBefore?.inboundPluginRegistry,
    );
    expect(getPreparedModelRuntimeSnapshot(configuredInput)?.pluginRegistry).toBe(
      configuredSelectedBefore,
    );
    expect(getPreparedModelRuntimeSnapshot(dynamicInput)?.pluginRegistry).toBe(
      dynamicSelectedBefore,
    );
    expect(configuredSelectedBefore).not.toBe(configuredRuntimeBefore?.inboundPluginRegistry);
  });

  it("waits only the affected configured projection during an auth refresh", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const defaultRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const workerRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    const published = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        published.resolve();
      }
    });

    mocks.mutationListener?.({
      agentDir: state.agentDir("worker"),
      affectsInheritedStores: false,
    });

    const defaultRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const workerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    await expect(defaultRead).resolves.toBe(defaultRuntime);
    await expect(workerRead).resolves.not.toBe(workerRuntime);

    await published.promise;
    unregister();

    const refreshedWorker = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    expect(refreshedWorker).toMatchObject({
      agentId: "worker",
      agentDir: state.agentDir("worker"),
      workspaceDir: "/tmp/workspace-worker",
    });
    expect(refreshedWorker).not.toBe(workerRuntime);
  });

  it("keeps a rejected auth refresh projection unavailable without affecting siblings", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    await refreshPreparedModelRuntimeSnapshots(
      {},
      {
        gatewayLifecycle: true,
        catalogMode: "static",
      },
    );
    const defaultRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const refreshFailed = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "failed") {
        refreshFailed.resolve();
      }
    });
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new Error("auth refresh rejected");
    });

    mocks.mutationListener?.({
      agentDir: state.agentDir("worker"),
      affectsInheritedStores: false,
    });
    await refreshFailed.promise;
    unregister();

    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for worker",
    );
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).resolves.toBe(
      defaultRuntime,
    );
  });

  it.each([false, true])(
    "preserves cancelled admission reasons without retaining owners (already aborted: %s)",
    async (alreadyAborted) => {
      mocks.configuredAgentIds = ["default"];
      const config = {};
      const input = {
        agentId: "default",
        agentDir: state.agentDir("default"),
        config,
        workspaceDir: "/tmp/dynamic-workspace",
      };
      await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
      const testApi = getPreparedModelRuntimeTestApi();
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      const finishAuthRefreshGate = createDeferred();
      let finishAuthRefresh: (() => void) | undefined;
      mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
        finishAuthRefresh = () => finishAuthRefreshGate.resolve();
        await finishAuthRefreshGate.promise;
        return { agentDir: String(agentDir), wrote: false };
      });

      let settled: Promise<unknown> | undefined;
      try {
        mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
        await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
        const abort = new AbortController();
        const reason = new DOMException("caller deadline expired", "TimeoutError");
        if (alreadyAborted) {
          abort.abort(reason);
        }
        const admission = acquireAgentRunPreparedModelRuntime(input, { abortSignal: abort.signal });
        const dispatch = loadPublishedGatewayReplyDispatchRuntime({
          agentId: input.agentId,
          abortSignal: abort.signal,
        });
        settled = Promise.allSettled([admission.then((lease) => lease.release()), dispatch]);
        if (!alreadyAborted) {
          for (const pending of [admission, dispatch]) {
            await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe(
              "pending",
            );
          }
          abort.abort(reason);
        }
        await expect(admission).rejects.toBe(reason);
        await expect(dispatch).rejects.toBe(reason);
        expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

        finishAuthRefreshGate.resolve();
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
        expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
        const lease = await acquireAgentRunPreparedModelRuntime(input);
        expect(lease.snapshot).toMatchObject({ agentId: "default", agentDir: input.agentDir });
        expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(2);
        lease.release();
      } finally {
        finishAuthRefreshGate.resolve();
        await Promise.allSettled([
          settled,
          loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
        ]);
      }
    },
  );
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
