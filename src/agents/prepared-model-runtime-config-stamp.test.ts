// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { PreparedPluginMetadata } from "../plugins/plugin-metadata-collection.js";
import { createPreparedPluginMetadataFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import {
  getPreparedModelRuntimeAuthMaterializations,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthMaterializations,
} from "./prepared-model-runtime-auth.js";
import {
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime config stamps", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentIds = ["default"];
  });

  it("advances without rebuilding or mutating existing readers", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: initialConfig,
    };
    const existingReader = await prepareModelRuntimeSnapshot(input);
    const materializations = [
      {
        provider: "test",
        modelId: "model",
        modelApi: "responses",
        modelBaseUrl: "https://example.test",
        requestTransportOverrides: "none" as const,
        authMode: "api_key",
        runtimeOwnerId: "test-owner",
      },
    ];
    setPreparedModelRuntimeAuthMaterializations(existingReader, materializations);
    const authStore = getPreparedModelRuntimeAuthStore(existingReader);
    const loadedAuth = await loadPreparedModelRuntimeAuth(existingReader, { providerIds: [] });
    mocks.configuredAgentDirs.set("default", state.agentDir("later"));

    advancePreparedModelRuntimeConfig(nextConfig);

    const advanced = await prepareModelRuntimeSnapshot({ ...input, config: nextConfig });
    expect(advanced).not.toBe(existingReader);
    expect(advanced.config).toBe(nextConfig);
    expect(existingReader.config).toBe(initialConfig);
    expect(resolvePublishedModelCatalogOwner(advanced)).toMatchObject({
      agentId: "default",
      workspaceDir: "/tmp/unused-workspace",
      config: nextConfig,
    });
    expect(getPreparedModelRuntimeAuthStore(advanced)).toBe(authStore);
    expect(getPreparedModelRuntimeAuthMaterializations(advanced)).toBe(materializations);
    await expect(loadPreparedModelRuntimeAuth(advanced, { providerIds: [] })).resolves.toEqual(
      loadedAuth,
    );
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: nextConfig });
  });

  it("resolves startup config and workspace metadata inside the serialized publication", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    const metadata = [initialConfig, nextConfig].map((config, index): PreparedPluginMetadata => {
      const snapshot = createPluginMetadataSnapshot({
        config,
        workspaceDir: `/tmp/queued-metadata-workspace-${index}`,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      return createPreparedPluginMetadataFixture({
        unionSnapshot: snapshot,
        agentWorkspaceDirs: new Map([["default", `/tmp/queued-metadata-workspace-${index}`]]),
      });
    });
    let current = { config: initialConfig, pluginMetadata: metadata[0]! };
    const next = { config: nextConfig, pluginMetadata: metadata[1]! };
    const supplierStarted = createDeferred();
    const supplierReady = createDeferred();

    const publication = refreshPreparedModelRuntimeSnapshots(
      async () => {
        supplierStarted.resolve();
        await supplierReady.promise;
        return current;
      },
      { gatewayLifecycle: true },
    );
    try {
      await supplierStarted.promise;
      current = next;
      mocks.configuredWorkspaces.set("default", next.pluginMetadata.selectedSnapshot.workspaceDir!);
      advancePreparedModelRuntimeConfig(nextConfig);
      supplierReady.resolve();
      await publication;

      await expect(
        prepareModelRuntimeSnapshot({
          agentId: "default",
          agentDir: state.agentDir("default"),
          inheritedAuthDir: state.agentDir("default"),
          config: nextConfig,
        }),
      ).resolves.toMatchObject({
        config: nextConfig,
        metadataSnapshot: next.pluginMetadata.selectedSnapshot,
      });
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ config: nextConfig });
    } finally {
      supplierReady.resolve();
      await Promise.allSettled([publication]);
    }
  });

  it("drops an async startup config supplier superseded before it resolves", async () => {
    const staleConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    const supplierReady = createDeferred();
    let stalePublication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let nextPublication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      stalePublication = refreshPreparedModelRuntimeSnapshots(async () => {
        await supplierReady.promise;
        return { config: staleConfig };
      });
      nextPublication = refreshPreparedModelRuntimeSnapshots(nextConfig, {
        gatewayLifecycle: true,
      });

      supplierReady.resolve();
      await Promise.all([stalePublication, nextPublication]);

      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      await expect(
        prepareModelRuntimeSnapshot({
          agentId: "default",
          agentDir: state.agentDir("default"),
          inheritedAuthDir: state.agentDir("default"),
          config: nextConfig,
        }),
      ).resolves.toMatchObject({ config: nextConfig });
    } finally {
      supplierReady.resolve();
      await Promise.allSettled([stalePublication, nextPublication]);
    }
  });

  it("drops a publication whose lifecycle claim is lost during async config resolution", async () => {
    const initialConfig = {};
    const staleConfig = { gateway: { reload: { mode: "off" as const } } };
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const supplierStarted = createDeferred();
    const releaseSupplier = createDeferred();
    let claimCurrent = true;
    let stalePublication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      stalePublication = refreshPreparedModelRuntimeSnapshots(
        async () => {
          supplierStarted.resolve();
          await releaseSupplier.promise;
          return { config: staleConfig };
        },
        {
          gatewayLifecycle: true,
          isPublicationCurrent: () => claimCurrent,
        },
      );

      await supplierStarted.promise;
      const readerSettled = vi.fn();
      const reader = prepareModelRuntimeSnapshot({
        agentId: "default",
        agentDir: state.agentDir("default"),
        config: staleConfig,
      }).then(readerSettled, readerSettled);
      claimCurrent = false;
      releaseSupplier.resolve();
      await stalePublication;
      // Losing the external claim must settle readers even if no replacement is scheduled.
      await vi.waitFor(() => expect(readerSettled).toHaveBeenCalledWith(expect.any(Error)));
      await reader;
      await refreshPreparedModelRuntimeSnapshots(nextConfig, { gatewayLifecycle: true });

      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      await expect(
        prepareModelRuntimeSnapshot({
          agentId: "default",
          agentDir: state.agentDir("default"),
          inheritedAuthDir: state.agentDir("default"),
          config: nextConfig,
        }),
      ).resolves.toMatchObject({ config: nextConfig });
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ config: nextConfig });
    } finally {
      claimCurrent = false;
      releaseSupplier.resolve();
      await Promise.allSettled([stalePublication]);
    }
  });

  it("keeps an in-flight auth publication on the advanced stamp", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const finishAuthRefreshGate = createDeferred();
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
      finishAuthRefresh = () => finishAuthRefreshGate.resolve();
      await finishAuthRefreshGate.promise;
      return { agentDir: String(agentDir), wrote: false };
    });

    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
      mocks.configuredAgentDirs.set("default", state.agentDir("later"));
      advancePreparedModelRuntimeConfig(nextConfig);
      finishAuthRefreshGate.resolve();

      const snapshot = await prepareModelRuntimeSnapshot({
        agentId: "default",
        agentDir: state.agentDir("default"),
        inheritedAuthDir: state.agentDir("default"),
        config: nextConfig,
      });
      expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
        agentId: "default",
        workspaceDir: "/tmp/unused-workspace",
        config: nextConfig,
      });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      finishAuthRefreshGate.resolve();
      await Promise.allSettled([loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })]);
    }
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
