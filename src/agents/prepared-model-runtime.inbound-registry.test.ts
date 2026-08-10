import "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared reply dispatch runtime", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("returns undefined while the Gateway lifecycle is inactive", async () => {
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toBeUndefined();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("atomically replaces one complete prepared dispatch runtime across a Gateway refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const firstConfig = {};
    const replacementConfig = { plugins: {} };
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
    });
    const input = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      config: firstConfig,
      workspaceDir: "/tmp/unused-workspace",
      allowGatewaySubagentBinding: true,
    };
    const firstSnapshot = getPreparedModelRuntimeSnapshot(input);
    const firstRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    expect(firstRuntime).toEqual({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
      config: firstConfig,
      modelCatalog: firstSnapshot?.modelCatalog,
      inboundPluginRegistry: firstRegistry,
    });
    expect(Object.isFrozen(firstRuntime)).toBe(true);

    const replacementCatalog = createDeferred<{ entries: [] }>();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => await replacementCatalog.promise);
    const refresh = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    await vi.waitFor(() =>
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(4),
    );
    expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
    let resolvedRuntime: unknown;
    const read = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }).then(
      (runtime) => {
        resolvedRuntime = runtime;
        return runtime;
      },
    );
    await Promise.resolve();
    expect(resolvedRuntime).toBeUndefined();

    replacementCatalog.resolve({ entries: [] });
    await expect(refresh).resolves.toBeUndefined();
    const replacementRuntime = await read;
    expect(replacementRuntime).toMatchObject({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
      config: replacementConfig,
      inboundPluginRegistry: replacementRegistry,
    });
    expect(replacementRuntime).not.toBe(firstRuntime);
    expect(replacementRuntime?.modelCatalog).not.toBe(firstRuntime?.modelCatalog);
  });

  it("resolves the configured inbound registry across a launch-workspace override", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const published = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
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
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() =>
      createEmptyPluginRegistry(),
    );
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    const configuredRuntimeBefore = await loadPublishedGatewayReplyDispatchRuntime({
      agentId: "default",
    });
    const configuredInput = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      config,
      workspaceDir: "/tmp/unused-workspace",
    };
    const configuredSelectedBefore =
      getPreparedModelRuntimeSnapshot(configuredInput)?.pluginRegistry;
    const dynamicInput = {
      ...configuredInput,
      workspaceDir: "/tmp/dynamic-auth-workspace",
      runtimePluginSelections: [
        { provider: "openai", modelId: "gpt-5.5", runtime: "codex" as const },
      ],
    };
    const dynamicLease = await acquireAgentRunPreparedModelRuntime(dynamicInput);
    const dynamicSelectedBefore = dynamicLease.snapshot.pluginRegistry;
    dynamicLease.release();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(3);
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[2]?.[0]).toMatchObject({
      workspaceDir: "/tmp/dynamic-auth-workspace",
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });
    const registryCallsBeforeAuth = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
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

    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(
      registryCallsBeforeAuth,
    );
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

  it("removes only the affected configured projection during an auth refresh", async () => {
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
      agentDir: "/tmp/configured-worker",
      affectsInheritedStores: false,
    });

    const defaultRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const workerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    await expect(defaultRead).resolves.toBe(defaultRuntime);
    await expect(workerRead).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for worker",
    );

    await published.promise;
    unregister();

    const refreshedWorker = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    expect(refreshedWorker).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/configured-worker",
      workspaceDir: "/tmp/workspace-worker",
    });
    expect(refreshedWorker).not.toBe(workerRuntime);
  });
});
