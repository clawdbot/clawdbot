// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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

describe("prepared model runtime config stamps", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
    mocks.configuredAgentIds = ["default"];
  });

  it("advances without rebuilding or mutating existing readers", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const input = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
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
    mocks.configuredAgentDirs.set("default", "/tmp/later-agent");

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

  it("resolves startup config inside the serialized publication", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    let currentConfig = initialConfig;

    const publication = refreshPreparedModelRuntimeSnapshots(() => currentConfig, {
      gatewayLifecycle: true,
    });
    currentConfig = nextConfig;
    advancePreparedModelRuntimeConfig(nextConfig);
    await publication;

    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        config: nextConfig,
      }),
    ).resolves.toMatchObject({ config: nextConfig });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: nextConfig });
  });

  it("drops an async startup config supplier superseded before it resolves", async () => {
    const staleConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    const supplierReady = createDeferred();
    const stalePublication = refreshPreparedModelRuntimeSnapshots(async () => {
      await supplierReady.promise;
      return staleConfig;
    });
    const nextPublication = refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
    });

    supplierReady.resolve();
    await Promise.all([stalePublication, nextPublication]);

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await expect(
      prepareModelRuntimeSnapshot({
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        config: nextConfig,
      }),
    ).resolves.toMatchObject({ config: nextConfig });
  });

  it("drops a publication whose lifecycle claim is lost during async config resolution", async () => {
    const initialConfig = {};
    const staleConfig = { gateway: { reload: { mode: "off" as const } } };
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const supplierStarted = createDeferred();
    const releaseSupplier = createDeferred();
    let claimCurrent = true;
    const stalePublication = refreshPreparedModelRuntimeSnapshots(
      async () => {
        supplierStarted.resolve();
        await releaseSupplier.promise;
        return staleConfig;
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
      agentDir: "/tmp/unused-agent",
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
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        config: nextConfig,
      }),
    ).resolves.toMatchObject({ config: nextConfig });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: nextConfig });
  });

  it("keeps an in-flight auth publication on the advanced stamp", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishAuthRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );

    mocks.mutationListener?.({ affectsInheritedStores: true });
    await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
    mocks.configuredAgentDirs.set("default", "/tmp/later-agent");
    advancePreparedModelRuntimeConfig(nextConfig);
    finishAuthRefresh?.();

    const snapshot = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      config: nextConfig,
    });
    expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
      agentId: "default",
      workspaceDir: "/tmp/unused-workspace",
      config: nextConfig,
    });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });
});
