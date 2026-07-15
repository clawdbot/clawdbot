import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginHostRuntimeState } from "./host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "./host-hook-runtime.test-fixtures.js";
import { clearActivatedPluginRuntimeState } from "./loader-shared.js";
import {
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
} from "./memory-state.test-fixtures.js";
import {
  createPluginRegistrationTransaction,
  type PluginProcessGlobalState,
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  getSessionDiscussionProvider,
  registerSessionDiscussionProvider,
  type SessionDiscussionProvider,
} from "./session-discussion-registry.js";
import { createPluginRecord } from "./status.test-helpers.js";

function discussionProvider(id: string): SessionDiscussionProvider {
  return {
    id,
    info: vi.fn().mockResolvedValue({ state: "available" }),
    open: vi.fn().mockResolvedValue({ state: "open" }),
  };
}

function createSchedulerPlugin(pluginId: string) {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
  });
  const api = pluginRegistry.createApi(createPluginRecord({ id: pluginId }), {
    config: {} as OpenClawConfig,
  });
  return { api, pluginRegistry };
}

describe("plugin registration transaction", () => {
  let initialProcessGlobalState: PluginProcessGlobalState;

  beforeEach(() => {
    initialProcessGlobalState = snapshotPluginProcessGlobalState();
  });

  afterEach(() => {
    clearPluginHostRuntimeState();
    restorePluginProcessGlobalState(initialProcessGlobalState);
  });

  it("rolls back registry writes and restores prior process-global capability state", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const failedResolver = () => "failed";
    const rollbackGlobalSideEffects = vi.fn();
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({
      registry,
      rollbackGlobalSideEffects,
    });
    registry.hostedMediaResolvers.push({
      pluginId: "failed-plugin",
      resolver: failedResolver,
      source: "failed-plugin",
    });
    registry.gatewayHandlers.failed = async () => {};
    registerMemoryCapability("failed-memory", { promptBuilder: () => ["failed"] });

    transaction.rollback();

    expect(rollbackGlobalSideEffects).toHaveBeenCalledOnce();
    expect(registry.hostedMediaResolvers).toStrictEqual([]);
    expect(registry.gatewayHandlers).toStrictEqual({});
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("isolates PluginRecord metadata mutations in arrays through shallow record cloning (#106647)", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "test-plugin",
      name: "Test Plugin",
      source: "test-source",
      origin: "global" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      cliBackendIds: [],
      providerIds: [],
      embeddingProviderIds: [],
      speechProviderIds: [],
      realtimeTranscriptionProviderIds: [],
      realtimeVoiceProviderIds: [],
      mediaUnderstandingProviderIds: [],
      transcriptSourceProviderIds: [],
      imageGenerationProviderIds: [],
      videoGenerationProviderIds: [],
      musicGenerationProviderIds: [],
      webFetchProviderIds: [],
      webSearchProviderIds: [],
      migrationProviderIds: [],
      memoryEmbeddingProviderIds: [],
      agentHarnessIds: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServiceIds: [],
      commands: [],
      httpRoutes: 0,
      hookCount: 0,
      configSchema: false,
    });

    const transaction = createPluginRegistrationTransaction({ registry });

    // Mutate a nested property on the PluginRecord that was captured in the snapshot
    registry.plugins[0]!.status = "error";
    registry.plugins[0]!.enabled = false;

    transaction.rollback();

    // After rollback, the original values should be restored
    expect(registry.plugins[0]!.status).toBe("loaded");
    expect(registry.plugins[0]!.enabled).toBe(true);
  });

  it("isolates Map entry metadata mutations through shallow record cloning (#106647)", () => {
    const registry = createEmptyPluginRegistry();
    registry.workerProviders.set("test-worker", {
      pluginId: "test-plugin",
      pluginName: "Test",
      provider: { id: "worker-1" } as import("./types.js").WorkerProvider,
      source: "test-source",
    });

    const transaction = createPluginRegistrationTransaction({ registry });

    // Mutate a property on the Map value
    const entry = registry.workerProviders.get("test-worker")!;
    entry.pluginName = "Mutated";

    transaction.rollback();

    // After rollback, the original value should be restored
    expect(registry.workerProviders.get("test-worker")!.pluginName).toBe("Test");
  });

  it("preserves functions by reference in cloned objects (#106647)", () => {
    const registry = createEmptyPluginRegistry();
    const myResolver = () => "resolved";
    registry.hostedMediaResolvers.push({
      pluginId: "test-plugin",
      resolver: myResolver,
      source: "test-source",
    });

    const transaction = createPluginRegistrationTransaction({ registry });

    // Push a new entry during the transaction
    registry.hostedMediaResolvers.push({
      pluginId: "another-plugin",
      resolver: () => "another",
      source: "another-source",
    });

    transaction.rollback();

    // After rollback, the array should be restored to the snapshot
    expect(registry.hostedMediaResolvers).toHaveLength(1);
    // The original resolver function reference should be preserved
    expect(registry.hostedMediaResolvers[0]!.resolver).toBe(myResolver);
  });

  it("preserves class instances and their prototypes by reference in cloned records (#106647)", () => {
    const registry = createEmptyPluginRegistry();

    class TestProvider {
      id = "provider-1";
      label = "Test Provider";
      chat(model: string) {
        return `chat-${model}`;
      }
      listModels() {
        return ["model-a"];
      }
      start() {}
      stop() {}
    }
    const providerInstance = new TestProvider();

    registry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test",
      provider: providerInstance as import("./types.js").ProviderPlugin,
      source: "test-source",
    });

    const transaction = createPluginRegistrationTransaction({ registry });

    // Mutate metadata during transaction
    registry.providers[0]!.pluginName = "Mutated";

    transaction.rollback();

    // After rollback, metadata is restored
    expect(registry.providers[0]!.pluginName).toBe("Test");
    // The provider instance is the same object reference (not a plain-object copy)
    expect(registry.providers[0]!.provider).toBe(providerInstance);
    // Class prototype is intact — methods are callable
    expect(registry.providers[0]!.provider.chat("gpt-5")).toBe("chat-gpt-5");
    expect(Object.getPrototypeOf(registry.providers[0]!.provider)).toBe(TestProvider.prototype);
  });

  it("keeps snapshot registry writes while restoring globals for non-activating commits", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const snapshotResolver = () => "snapshot";
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({ registry });
    registry.hostedMediaResolvers.push({
      pluginId: "snapshot-plugin",
      resolver: snapshotResolver,
      source: "snapshot-plugin",
    });
    registerMemoryCapability("snapshot-memory", { promptBuilder: () => ["snapshot"] });

    transaction.commit({ activate: false });

    expect(registry.hostedMediaResolvers).toEqual([
      {
        pluginId: "snapshot-plugin",
        resolver: snapshotResolver,
        source: "snapshot-plugin",
      },
    ]);
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("clears the discussion provider before repeated active plugin activation", () => {
    registerSessionDiscussionProvider(discussionProvider("clickclack"));

    clearActivatedPluginRuntimeState();

    expect(getSessionDiscussionProvider()).toBeUndefined();
  });

  it("restores the prior discussion provider when plugin activation rolls back", () => {
    const activeProvider = discussionProvider("clickclack");
    registerSessionDiscussionProvider(activeProvider);
    const transaction = createPluginRegistrationTransaction({});
    registerSessionDiscussionProvider(discussionProvider("replacement"));

    transaction.rollback();

    expect(getSessionDiscussionProvider()).toBe(activeProvider);
  });

  it("rolls back only scheduler jobs owned by the failed registry", async () => {
    const pluginId = "scheduler-plugin";
    const failedCleanup = vi.fn();
    const activeCleanup = vi.fn();
    const active = createSchedulerPlugin(pluginId);
    const failed = createSchedulerPlugin(pluginId);

    active.api.registerSessionSchedulerJob({
      id: "active-job",
      sessionKey: "agent:main:main",
      kind: "monitor",
      cleanup: activeCleanup,
    });
    const transaction = createPluginRegistrationTransaction({
      registry: failed.pluginRegistry.registry,
      rollbackGlobalSideEffects: () =>
        failed.pluginRegistry.rollbackPluginGlobalSideEffects(pluginId),
    });
    failed.api.registerSessionSchedulerJob({
      id: "failed-job",
      sessionKey: "agent:main:main",
      kind: "monitor",
      cleanup: failedCleanup,
    });

    transaction.rollback();
    await vi.waitFor(() => {
      expect(failedCleanup).toHaveBeenCalledOnce();
    });

    expect(failedCleanup).toHaveBeenCalledWith({
      reason: "disable",
      sessionKey: "agent:main:main",
      jobId: "failed-job",
    });
    expect(activeCleanup).not.toHaveBeenCalled();
    expect(listPluginSessionSchedulerJobs(pluginId)).toStrictEqual([
      {
        id: "active-job",
        pluginId,
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
    expect(failed.pluginRegistry.registry.sessionSchedulerJobs).toStrictEqual([]);
    expect(active.pluginRegistry.registry.sessionSchedulerJobs).toHaveLength(1);
  });
});
