import "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayInboundPluginRegistry,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime inbound registry", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("atomically replaces the prepared inbound registry across a Gateway refresh", async () => {
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
    await expect(loadPublishedGatewayInboundPluginRegistry({ agentId: "default" })).resolves.toBe(
      firstRegistry,
    );

    let finishReplacement!: () => void;
    mocks.prepareStaticCatalog.mockImplementationOnce(
      async () =>
        await new Promise<{ entries: [] }>((resolve) => {
          finishReplacement = () => resolve({ entries: [] });
        }),
    );
    const refresh = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    await vi.waitFor(() =>
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(4),
    );
    expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
    let resolvedRegistry: unknown;
    const read = loadPublishedGatewayInboundPluginRegistry({ agentId: "default" }).then(
      (registry) => {
        resolvedRegistry = registry;
        return registry;
      },
    );
    await Promise.resolve();
    expect(resolvedRegistry).toBeUndefined();

    finishReplacement();
    await expect(refresh).resolves.toBeUndefined();
    await expect(read).resolves.toBe(replacementRegistry);
    expect(replacementRegistry).not.toBe(firstRegistry);
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
    })?.inboundPluginRegistry;
    const publicationLoadCount = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;

    await expect(
      Promise.all([
        loadPublishedGatewayInboundPluginRegistry({ agentId: "default" }),
        loadPublishedGatewayInboundPluginRegistry({ agentId: "default" }),
        loadPublishedGatewayInboundPluginRegistry({ agentId: "default" }),
      ]),
    ).resolves.toEqual([published, published, published]);
    expect(published).toBeDefined();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(publicationLoadCount);
  });

  it("keeps inbound registry ownership off retained run owners during auth refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const dynamicInput = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      config,
      workspaceDir: "/tmp/dynamic-auth-workspace",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    };
    const dynamicLease = await acquireAgentRunPreparedModelRuntime(dynamicInput);
    expect(dynamicLease.snapshot.inboundPluginRegistry).toBeUndefined();
    dynamicLease.release();
    const callsBeforeAuthRefresh = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
    let unregister = () => {};
    const published = new Promise<void>((resolve) => {
      unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "published") {
          resolve();
        }
      });
    });

    mocks.mutationListener?.({ affectsInheritedStores: true });
    await published;
    unregister();

    const authRefreshCalls =
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.slice(callsBeforeAuthRefresh);
    const genericCalls = authRefreshCalls.filter(
      ([params]) => !Object.hasOwn(params as object, "selections"),
    );
    expect(genericCalls).toHaveLength(1);
    expect(genericCalls[0]?.[0]).toMatchObject({ workspaceDir: "/tmp/unused-workspace" });
    expect(
      genericCalls.some(
        ([params]) =>
          (params as { workspaceDir?: string }).workspaceDir === "/tmp/dynamic-auth-workspace",
      ),
    ).toBe(false);
    expect(getPreparedModelRuntimeSnapshot(dynamicInput)?.inboundPluginRegistry).toBeUndefined();
    expect(
      getPreparedModelRuntimeSnapshot({
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        config,
        workspaceDir: "/tmp/unused-workspace",
      })?.inboundPluginRegistry,
    ).toBeDefined();
  });
});
