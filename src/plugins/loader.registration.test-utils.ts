// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getContextEngineRegistration } from "../context-engine/registry.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import {
  clearDetachedTaskLifecycleRuntimeRegistration,
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime-state.js";
import { clearPluginCommands } from "./command-registry-state.js";
import { getPluginCommandSpecs } from "./command-specs.js";
import { registerEmbeddingProvider } from "./embedding-providers.js";
import {
  getGlobalHookRunner,
  getGlobalPluginRegistry,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import {
  clearPluginInteractiveHandlers,
  resolvePluginInteractiveNamespaceMatch,
} from "./interactive-registry.js";
import { clearPluginInteractiveHandlerRegistrations } from "./interactive-registry.test-fixtures.js";
import {
  claimPluginInteractiveCallbackDedupe,
  commitPluginInteractiveCallbackDedupe,
} from "./interactive-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  makeTempDir,
  mkdirSafe,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  getEmbeddingProvider,
  listEmbeddingProviders,
  expectGlobalHookRunner,
  createDetachedTaskRuntimeStub,
  updatePluginManifest,
  expectDiagnosticContaining,
  expectCachePartitionByPluginSource,
  globalAfterEach0,
  globalAfterAll1,
} from "./loader.test-harness.js";
import {
  listMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryRuntime,
  listActiveMemoryPublicArtifacts,
  listMemoryCorpusSupplements,
  listMemoryPromptPreparations,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryPromptPreparation,
  registerMemoryPromptSupplement,
  resolveMemoryFlushPlan,
} from "./memory-state.test-fixtures.js";
import {
  getActivePluginRegistry,
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
} from "./runtime.js";
import { ensurePluginRegistryLoaded } from "./runtime/runtime-registry-loader.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

describe("loadOpenClawPlugins", () => {
  it("runs consecutive plugin hook handlers with shared mutable context but isolated plugin config", async () => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: "hook-context-first",
      filename: "hook-context-first.cjs",
      body: `module.exports = {
          id: "hook-context-first",
          register(api) {
            api.registerHook(
              "gateway:startup",
              (event) => {
                event.messages.push("first-config=" + event.context.pluginConfig?.marker);
                event.context.note = "mutation-from-first";
              },
              { name: "hook-context-first" },
            );
          },
        };`,
    });
    const second = writePlugin({
      id: "hook-context-second",
      filename: "hook-context-second.cjs",
      body: `module.exports = {
          id: "hook-context-second",
          register(api) {
            api.registerHook(
              "gateway:startup",
              (event) => {
                event.messages.push(
                  "second-config=" + String(event.context.pluginConfig?.marker ?? "none"),
                );
                event.messages.push("note=" + String(event.context.note ?? "missing-note"));
              },
              { name: "hook-context-second" },
            );
          },
        };`,
    });
    for (const plugin of [first, second]) {
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify(
          {
            id: plugin.id,
            configSchema: { type: "object" },
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    clearInternalHooks();

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: first.dir,
      onlyPluginIds: ["hook-context-first", "hook-context-second"],
      config: {
        plugins: {
          load: { paths: [first.file, second.file] },
          allow: ["hook-context-first", "hook-context-second"],
          entries: {
            "hook-context-first": {
              config: {
                marker: "visible-to-first",
              },
            },
            "hook-context-second": {
              config: {
                marker: "visible-to-second",
              },
            },
          },
        },
      },
    });

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);

    expect(event.messages).toEqual([
      "first-config=visible-to-first",
      "second-config=visible-to-second",
      "note=mutation-from-first",
    ]);
    expect(event.context).toEqual({
      note: "mutation-from-first",
    });

    clearInternalHooks();
  });

  it("rolls back global side effects when registration fails", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-side-effects",
      filename: "failing-side-effects.cjs",
      body: `module.exports = {
          id: "failing-side-effects",
          register(api) {
            api.registerHook(
              "gateway:startup",
              (event) => {
                event.messages.push("should-not-run");
              },
              { name: "failing-side-effects-hook" },
            );
            api.registerCommand({
              name: "failme",
              description: "Fail me",
              handler: async () => ({ text: "nope" }),
            });
            api.registerReload({
              onConfigReload: async () => {},
            });
            api.registerNodeHostCommand({
              command: "failme",
              description: "failme",
              run: async () => ({ ok: true }),
            });
            api.registerNodeInvokePolicy({
              commands: ["failme.node"],
              handle: async () => ({ ok: true }),
            });
            api.registerSecurityAuditCollector({
              id: "failme",
              collect: async () => [],
            });
            api.registerInteractiveHandler({
              channel: "slack",
              namespace: "failme",
              handle: async () => ({ handled: true }),
            });
            api.registerContextEngine("failme-context", () => ({
              info: { id: "failme-context", name: "Failme Context" },
              ingest: async () => {},
              assemble: async () => ({ messages: [] }),
            }));
            throw new Error("boom");
          },
        };`,
    });

    clearInternalHooks();
    clearPluginCommands();
    clearPluginInteractiveHandlers();

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-side-effects"],
        },
      },
      onlyPluginIds: ["failing-side-effects"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-side-effects")?.status).toBe(
      "error",
    );
    expect(getRegisteredEventKeys()).toStrictEqual([]);
    expect(getPluginCommandSpecs()).toStrictEqual([]);
    expect(registry.reloads).toStrictEqual([]);
    expect(registry.nodeHostCommands).toStrictEqual([]);
    expect(registry.nodeInvokePolicies).toStrictEqual([]);
    expect(registry.securityAuditCollectors).toStrictEqual([]);
    expect(registry.interactiveHandlers).toStrictEqual([]);
    expect(resolvePluginInteractiveNamespaceMatch("slack", "failme:payload")).toBeNull();
    expect(getContextEngineRegistration("failme-context")).toBeUndefined();

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);
    expect(event.messages).toStrictEqual([]);

    clearInternalHooks();
    clearPluginCommands();
    clearPluginInteractiveHandlers();
  });

  it("fails plugin registration when a hook is missing its required name", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "nameless-hook",
      filename: "nameless-hook.cjs",
      body: `module.exports = {
          id: "nameless-hook",
          register(api) {
            api.registerHook("gateway:startup", () => {});
          },
        };`,
    });

    clearInternalHooks();

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["nameless-hook"],
        },
      },
      onlyPluginIds: ["nameless-hook"],
    });

    const record = registry.plugins.find((entry) => entry.id === "nameless-hook");
    expect(record?.status).toBe("error");
    expect(record?.failurePhase).toBe("register");
    expect(record?.error).toContain("hook registration missing name");
    expect(registry.hooks).toStrictEqual([]);
    expect(getRegisteredEventKeys()).toStrictEqual([]);
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "nameless-hook",
      message: "hook registration missing name",
    });

    clearInternalHooks();
  });

  it("fails plugin registration when a non-memory plugin registers a memory capability", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "invalid-memory-capability",
      filename: "invalid-memory-capability.cjs",
      body: `module.exports = {
          id: "invalid-memory-capability",
          register(api) {
            api.registerMemoryCapability({
              promptBuilder: () => ["should not register"],
            });
          },
        };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["invalid-memory-capability"],
        },
      },
      onlyPluginIds: ["invalid-memory-capability"],
    });

    const record = registry.plugins.find((entry) => entry.id === "invalid-memory-capability");
    expect(record?.status).toBe("error");
    expect(record?.failurePhase).toBe("register");
    expect(record?.error).toContain("only memory plugins can register a memory capability");
    expect(getMemoryCapabilityRegistration()).toBeUndefined();
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "invalid-memory-capability",
      message: "only memory plugins can register a memory capability",
    });
  });

  it("can scope bundled provider loads without hanging", () => {
    const bundledDir = makeTempDir();
    const scopedDir = path.join(bundledDir, "scoped-provider");
    mkdirSafe(scopedDir);
    fs.writeFileSync(
      path.join(scopedDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/scoped-provider",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf-8",
    );
    const plugin = writePlugin({
      id: "scoped-provider",
      dir: scopedDir,
      filename: "index.cjs",
      body: `module.exports = {
          id: "scoped-provider",
          register(api) {
            api.registerProvider({
              id: "scoped-provider",
              label: "Scoped Provider",
              auth: [],
            });
          },
        };`,
    });
    updatePluginManifest(plugin, { enabledByDefault: true, providers: ["scoped-provider"] });

    const unscopedDir = path.join(bundledDir, "unscoped-provider");
    mkdirSafe(unscopedDir);
    fs.writeFileSync(
      path.join(unscopedDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/unscoped-provider",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf-8",
    );
    const unscoped = writePlugin({
      id: "unscoped-provider",
      dir: unscopedDir,
      filename: "index.cjs",
      body: `module.exports = {
          id: "unscoped-provider",
          register() {
            throw new Error("unscoped provider should not load");
          },
        };`,
    });
    updatePluginManifest(unscoped, {
      enabledByDefault: true,
      providers: ["unscoped-provider"],
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      config: {
        plugins: {
          enabled: true,
          allow: ["scoped-provider", "unscoped-provider"],
        },
      },
      onlyPluginIds: ["scoped-provider"],
    });

    expect(scoped.plugins.map((entry) => entry.id)).toEqual(["scoped-provider"]);
    expect(scoped.plugins[0]?.status).toBe("loaded");
    expect(scoped.providers.map((entry) => entry.provider.id)).toEqual(["scoped-provider"]);
  });

  it("allows bundled plugins to supply system.notify without opening the command to external plugins", () => {
    const bundledDir = makeTempDir();
    const bundledPluginDir = path.join(bundledDir, "notify-host");
    mkdirSafe(bundledPluginDir);
    fs.writeFileSync(
      path.join(bundledPluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/notify-host",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf-8",
    );
    const bundled = writePlugin({
      id: "notify-host",
      dir: bundledPluginDir,
      filename: "index.cjs",
      body: `module.exports = {
          id: "notify-host",
          register(api) {
            api.registerNodeHostCommand({
              command: "system.notify",
              handle: async () => "{}",
            });
          },
        };`,
    });
    updatePluginManifest(bundled, { enabledByDefault: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledRegistry = loadOpenClawPlugins({
      cache: false,
      config: { plugins: { allow: ["notify-host"] } },
      onlyPluginIds: ["notify-host"],
    });
    expect(bundledRegistry.nodeHostCommands.map((entry) => entry.command.command)).toEqual([
      "system.notify",
    ]);

    useNoBundledPlugins();
    const external = writePlugin({
      id: "external-notify-host",
      filename: "external-notify-host.cjs",
      body: `module.exports = {
          id: "external-notify-host",
          register(api) {
            api.registerNodeHostCommand({
              command: "system.notify",
              handle: async () => "{}",
            });
          },
        };`,
    });
    const externalRegistry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: external.dir,
      config: {
        plugins: {
          allow: ["external-notify-host"],
          load: { paths: [external.file] },
        },
      },
      onlyPluginIds: ["external-notify-host"],
    });
    expect(externalRegistry.nodeHostCommands).toEqual([]);
    expect(
      externalRegistry.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("node host command reserved by core: system.notify"),
      ),
    ).toBe(true);
  });

  it("does not replace active memory plugin registries during non-activating loads", () => {
    useNoBundledPlugins();
    registerMemoryEmbeddingProvider({
      id: "active",
      create: async () => ({ provider: null }),
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => null,
    });
    registerMemoryPromptSupplement("memory-wiki", () => ["active wiki supplement"]);
    registerMemoryPromptPreparation("memory-wiki", async () => ["active prepared wiki"]);
    const activeRuntime = {
      async getMemorySearchManager() {
        return { manager: null, error: "active" };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    };
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["active memory section"],
      flushPlanResolver: () => ({
        softThresholdTokens: 1,
        forceFlushTranscriptBytes: 2,
        reserveTokensFloor: 3,
        prompt: "active",
        systemPrompt: "active",
        relativePath: "memory/active.md",
      }),
      runtime: activeRuntime,
    });
    const plugin = writePlugin({
      id: "snapshot-memory",
      filename: "snapshot-memory.cjs",
      body: `module.exports = {
          id: "snapshot-memory",
          kind: "memory",
          register(api) {
            api.registerMemoryEmbeddingProvider({
              id: "snapshot",
              create: async () => ({ provider: null }),
            });
            api.registerMemoryPromptSection(() => ["snapshot memory section"]);
            api.registerMemoryFlushPlan(() => ({
              softThresholdTokens: 10,
              forceFlushTranscriptBytes: 20,
              reserveTokensFloor: 30,
              prompt: "snapshot",
              systemPrompt: "snapshot",
              relativePath: "memory/snapshot.md",
            }));
            api.registerMemoryRuntime({
              async getMemorySearchManager() {
                return { manager: null, error: "snapshot" };
              },
              resolveMemoryBackendConfig() {
                return { backend: "qmd", qmd: {} };
              },
            });
          },
        };`,
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-memory"],
          slots: { memory: "snapshot-memory" },
        },
      },
      onlyPluginIds: ["snapshot-memory"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-memory")?.status).toBe("loaded");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "active memory section",
      "active wiki supplement",
    ]);
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/active.md");
    expect(getMemoryRuntime()).toBe(activeRuntime);
    expect(listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["active"]);
    expect(listMemoryPromptPreparations()).toHaveLength(1);
  });

  it("does not replace active embedding providers during non-activating loads", () => {
    useNoBundledPlugins();
    registerEmbeddingProvider({
      id: "active",
      create: async () => ({ provider: null }),
    });
    const plugin = writePlugin({
      id: "snapshot-embedding",
      filename: "snapshot-embedding.cjs",
      body: `module.exports = {
          id: "snapshot-embedding",
          register(api) {
            api.registerEmbeddingProvider({
              id: "snapshot",
              create: async () => ({ provider: null }),
            });
          },
        };`,
    });
    updatePluginManifest(plugin, {
      contracts: { embeddingProviders: ["snapshot"] },
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-embedding"],
        },
      },
      onlyPluginIds: ["snapshot-embedding"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-embedding")?.status).toBe(
      "loaded",
    );
    expect(scoped.embeddingProviders.map((entry) => entry.provider.id)).toEqual(["snapshot"]);
    expect(listEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "active",
    ]);
    expect(getEmbeddingProvider("snapshot")).toBeUndefined();
  });

  it("allows non-activating embedding provider snapshots to reuse active ids", () => {
    useNoBundledPlugins();
    registerEmbeddingProvider({
      id: "shared",
      create: async () => ({ provider: null }),
    });
    const plugin = writePlugin({
      id: "snapshot-shared-embedding",
      filename: "snapshot-shared-embedding.cjs",
      body: `module.exports = {
          id: "snapshot-shared-embedding",
          register(api) {
            api.registerEmbeddingProvider({
              id: "shared",
              create: async () => ({ provider: null }),
            });
          },
        };`,
    });
    updatePluginManifest(plugin, {
      contracts: { embeddingProviders: ["shared"] },
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-shared-embedding"],
        },
      },
      onlyPluginIds: ["snapshot-shared-embedding"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-shared-embedding")?.status).toBe(
      "loaded",
    );
    expect(scoped.embeddingProviders.map((entry) => entry.provider.id)).toEqual(["shared"]);
    expect(listEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "shared",
    ]);
    expect(getEmbeddingProvider("shared")?.id).toBe("shared");
  });

  it("clears newly-registered embedding providers when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-embedding",
      filename: "failing-embedding.cjs",
      body: `module.exports = {
          id: "failing-embedding",
          register(api) {
            api.registerEmbeddingProvider({
              id: "failed",
              create: async () => ({ provider: null }),
            });
            throw new Error("embedding register failed");
          },
        };`,
    });
    updatePluginManifest(plugin, {
      contracts: { embeddingProviders: ["failed"] },
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-embedding"],
        },
      },
      onlyPluginIds: ["failing-embedding"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-embedding")?.status).toBe(
      "error",
    );
    expect(listEmbeddingProviders().map((adapter) => adapter.id)).toStrictEqual([
      "openai-compatible",
    ]);
  });

  it("clears newly-registered memory plugin registries when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-memory",
      filename: "failing-memory.cjs",
      body: `module.exports = {
          id: "failing-memory",
          kind: "memory",
          register(api) {
            api.registerMemoryEmbeddingProvider({
              id: "failed",
              create: async () => ({ provider: null }),
            });
            api.registerMemoryPromptSection(() => ["stale failure section"]);
            api.registerMemoryPromptSupplement(() => ["stale failure supplement"]);
            api.registerMemoryPromptPreparation(async () => ["stale prepared supplement"]);
            api.registerMemoryCorpusSupplement({
              search: async () => [],
              get: async () => null,
            });
            api.registerMemoryFlushPlan(() => ({
              softThresholdTokens: 10,
              forceFlushTranscriptBytes: 20,
              reserveTokensFloor: 30,
              prompt: "failed",
              systemPrompt: "failed",
              relativePath: "memory/failed.md",
            }));
            api.registerMemoryRuntime({
              async getMemorySearchManager() {
                return { manager: null, error: "failed" };
              },
              resolveMemoryBackendConfig() {
                return { backend: "builtin" };
              },
            });
            throw new Error("memory register failed");
          },
        };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-memory"],
          slots: { memory: "failing-memory" },
        },
      },
      onlyPluginIds: ["failing-memory"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-memory")?.status).toBe("error");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toStrictEqual([]);
    expect(listMemoryCorpusSupplements()).toStrictEqual([]);
    expect(listMemoryPromptPreparations()).toStrictEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(listMemoryEmbeddingProviders()).toStrictEqual([]);
  });

  it("does not replace the active detached task runtime during non-activating loads", () => {
    useNoBundledPlugins();
    const activeRuntime = createDetachedTaskRuntimeStub("active");
    registerDetachedTaskLifecycleRuntime("active-runtime", activeRuntime);

    const plugin = writePlugin({
      id: "snapshot-detached-runtime",
      filename: "snapshot-detached-runtime.cjs",
      body: `module.exports = {
          id: "snapshot-detached-runtime",
          register(api) {
            api.registerDetachedTaskRuntime({
              createQueuedTaskRun() { throw new Error("snapshot createQueuedTaskRun should not run"); },
              createRunningTaskRun() { throw new Error("snapshot createRunningTaskRun should not run"); },
              startTaskRunByRunId() { throw new Error("snapshot startTaskRunByRunId should not run"); },
              recordTaskRunProgressByRunId() { throw new Error("snapshot recordTaskRunProgressByRunId should not run"); },
              finalizeTaskRunByRunId() { throw new Error("snapshot finalizeTaskRunByRunId should not run"); },
              completeTaskRunByRunId() { throw new Error("snapshot completeTaskRunByRunId should not run"); },
              failTaskRunByRunId() { throw new Error("snapshot failTaskRunByRunId should not run"); },
              setDetachedTaskDeliveryStatusByRunId() { throw new Error("snapshot setDetachedTaskDeliveryStatusByRunId should not run"); },
              async cancelDetachedTaskRunById() { return { found: true, cancelled: true }; },
            });
          },
        };`,
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-detached-runtime"],
        },
      },
      onlyPluginIds: ["snapshot-detached-runtime"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-detached-runtime")?.status).toBe(
      "loaded",
    );
    const runtimeRegistration = getDetachedTaskLifecycleRuntimeRegistration();
    expect(runtimeRegistration?.pluginId).toBe("active-runtime");
    expect(runtimeRegistration?.runtime).toBe(activeRuntime);
  });

  it("clears newly-registered detached task runtimes when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-detached-runtime",
      filename: "failing-detached-runtime.cjs",
      body: `module.exports = {
          id: "failing-detached-runtime",
          register(api) {
            api.registerDetachedTaskRuntime({
              createQueuedTaskRun() { throw new Error("failing createQueuedTaskRun should not run"); },
              createRunningTaskRun() { throw new Error("failing createRunningTaskRun should not run"); },
              startTaskRunByRunId() { throw new Error("failing startTaskRunByRunId should not run"); },
              recordTaskRunProgressByRunId() { throw new Error("failing recordTaskRunProgressByRunId should not run"); },
              finalizeTaskRunByRunId() { throw new Error("failing finalizeTaskRunByRunId should not run"); },
              completeTaskRunByRunId() { throw new Error("failing completeTaskRunByRunId should not run"); },
              failTaskRunByRunId() { throw new Error("failing failTaskRunByRunId should not run"); },
              setDetachedTaskDeliveryStatusByRunId() { throw new Error("failing setDetachedTaskDeliveryStatusByRunId should not run"); },
              async cancelDetachedTaskRunById() { return { found: true, cancelled: true }; },
            });
            throw new Error("detached runtime register failed");
          },
        };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-detached-runtime"],
        },
      },
      onlyPluginIds: ["failing-detached-runtime"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-detached-runtime")?.status).toBe(
      "error",
    );
    expect(getDetachedTaskLifecycleRuntimeRegistration()).toBeUndefined();
  });

  it("restores cached detached task runtime registrations on cache hits", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-detached-runtime",
      filename: "cached-detached-runtime.cjs",
      body: `module.exports = {
          id: "cached-detached-runtime",
          register(api) {
            api.registerDetachedTaskRuntime({
              createQueuedTaskRun() { throw new Error("cached createQueuedTaskRun should not run"); },
              createRunningTaskRun() { throw new Error("cached createRunningTaskRun should not run"); },
              startTaskRunByRunId() { throw new Error("cached startTaskRunByRunId should not run"); },
              recordTaskRunProgressByRunId() { throw new Error("cached recordTaskRunProgressByRunId should not run"); },
              finalizeTaskRunByRunId() { throw new Error("cached finalizeTaskRunByRunId should not run"); },
              completeTaskRunByRunId() { throw new Error("cached completeTaskRunByRunId should not run"); },
              failTaskRunByRunId() { throw new Error("cached failTaskRunByRunId should not run"); },
              setDetachedTaskDeliveryStatusByRunId() { throw new Error("cached setDetachedTaskDeliveryStatusByRunId should not run"); },
              async cancelDetachedTaskRunById() { return { found: true, cancelled: true }; },
            });
          },
        };`,
    });

    const loadOptions = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cached-detached-runtime"],
        },
      },
      onlyPluginIds: ["cached-detached-runtime"],
    } satisfies Parameters<typeof loadOpenClawPlugins>[0];

    loadOpenClawPlugins(loadOptions);
    expect(getDetachedTaskLifecycleRuntimeRegistration()?.pluginId).toBe("cached-detached-runtime");

    clearDetachedTaskLifecycleRuntimeRegistration();
    expect(getDetachedTaskLifecycleRuntimeRegistration()).toBeUndefined();

    loadOpenClawPlugins(loadOptions);

    expect(getDetachedTaskLifecycleRuntimeRegistration()?.pluginId).toBe("cached-detached-runtime");
  });

  it("restores cached command and interactive handler registrations on cache hits", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-command-interactive",
      filename: "cached-command-interactive.cjs",
      body: `module.exports = {
          id: "cached-command-interactive",
          register(api) {
            api.registerCommand({
              name: "hue",
              description: "Control Hue lights",
              handler: async () => ({ text: "ok" }),
            });
            api.registerInteractiveHandler({
              channel: "telegram",
              namespace: "hue",
              handle: async () => ({ handled: true }),
            });
          },
        };`,
    });

    const loadOptions = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cached-command-interactive"],
        },
      },
      onlyPluginIds: ["cached-command-interactive"],
    } satisfies Parameters<typeof loadOpenClawPlugins>[0];

    const registry = loadOpenClawPlugins(loadOptions);
    expect(getPluginCommandSpecs()).toEqual([
      { name: "hue", description: "Control Hue lights", acceptsArgs: false },
    ]);
    expect(registry.interactiveHandlers).toEqual([
      expect.objectContaining({
        channel: "telegram",
        namespace: "hue",
        pluginId: "cached-command-interactive",
      }),
    ]);
    const match = resolvePluginInteractiveNamespaceMatch("telegram", "hue:on");
    expect(match?.namespace).toBe("hue");
    expect(match?.payload).toBe("on");

    const dedupeKey = "telegram:hue:callback-1";
    expect(claimPluginInteractiveCallbackDedupe(dedupeKey, 1_000)).toBe(true);
    commitPluginInteractiveCallbackDedupe(dedupeKey, 1_000);
    expect(claimPluginInteractiveCallbackDedupe(dedupeKey, 1_001)).toBe(false);

    loadOpenClawPlugins(loadOptions);
    expect(claimPluginInteractiveCallbackDedupe(dedupeKey, 1_002)).toBe(false);

    clearPluginCommands();
    clearPluginInteractiveHandlerRegistrations();
    expect(getPluginCommandSpecs()).toStrictEqual([]);
    expect(resolvePluginInteractiveNamespaceMatch("telegram", "hue:on")).toBeNull();

    loadOpenClawPlugins(loadOptions);

    expect(getPluginCommandSpecs()).toEqual([
      { name: "hue", description: "Control Hue lights", acceptsArgs: false },
    ]);
    const registration = resolvePluginInteractiveNamespaceMatch("telegram", "hue:on")?.registration;
    expect(registration?.pluginId).toBe("cached-command-interactive");
    expect(registration?.namespace).toBe("hue");
    expect(registration?.channel).toBe("telegram");
    expect(claimPluginInteractiveCallbackDedupe(dedupeKey, 1_003)).toBe(false);
  });

  it("clears stale detached task runtime registrations on active reloads when no plugin re-registers one", () => {
    useNoBundledPlugins();
    registerDetachedTaskLifecycleRuntime("stale-runtime", createDetachedTaskRuntimeStub("stale"));

    loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [] },
          allow: [],
        },
      },
    });

    expect(getDetachedTaskLifecycleRuntimeRegistration()).toBeUndefined();
  });

  it("restores cached memory capability public artifacts on cache hits", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(absolutePath, "# Memory\n");
    const plugin = writePlugin({
      id: "cached-memory-capability",
      filename: "cached-memory-capability.cjs",
      body: `module.exports = {
          id: "cached-memory-capability",
          kind: "memory",
          register(api) {
            api.registerMemoryCapability({
              publicArtifacts: {
                async listArtifacts() {
                  return [{
                    kind: "memory-root",
                    workspaceDir: ${JSON.stringify(workspaceDir)},
                    relativePath: "MEMORY.md",
                    absolutePath: ${JSON.stringify(absolutePath)},
                    agentIds: ["main"],
                    contentType: "markdown",
                  }];
                },
              },
            });
          },
        };`,
    });

    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cached-memory-capability"],
          slots: { memory: "cached-memory-capability" },
        },
      },
      onlyPluginIds: ["cached-memory-capability"],
    };

    const expectedArtifacts = [
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath,
        agentIds: ["main"],
        contentType: "markdown" as const,
      },
    ];

    const first = loadOpenClawPlugins(options);
    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );

    clearMemoryPluginState();

    const second = loadOpenClawPlugins(options);
    expect(second).toBe(first);
    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );
  });

  it("preserves previously registered memory capability across activate:false snapshot loads", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(absolutePath, "# Memory\n");
    const memoryPlugin = writePlugin({
      id: "capability-survives-memory",
      filename: "capability-survives-memory.cjs",
      body: `module.exports = {
          id: "capability-survives-memory",
          kind: "memory",
          register(api) {
            api.registerMemoryCapability({
              publicArtifacts: {
                async listArtifacts() {
                  return [{
                    kind: "memory-root",
                    workspaceDir: ${JSON.stringify(workspaceDir)},
                    relativePath: "MEMORY.md",
                    absolutePath: ${JSON.stringify(absolutePath)},
                    agentIds: ["main"],
                    contentType: "markdown",
                  }];
                },
              },
            });
          },
        };`,
    });
    const sidecarPlugin = writePlugin({
      id: "capability-survives-sidecar",
      filename: "capability-survives-sidecar.cjs",
      body: `module.exports = {
          id: "capability-survives-sidecar",
          register() {},
        };`,
    });

    const activateConfig = {
      plugins: {
        load: { paths: [memoryPlugin.file, sidecarPlugin.file] },
        allow: ["capability-survives-memory", "capability-survives-sidecar"],
        slots: { memory: "capability-survives-memory" },
      },
    };
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: memoryPlugin.dir,
      config: activateConfig,
    });

    const expectedArtifacts = [
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath,
        agentIds: ["main"],
        contentType: "markdown" as const,
      },
    ];

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );

    // Simulate what resolvePluginWebSearchProviders and similar read-only paths do:
    // load plugins again with activate:false. Each per-plugin snapshot/rollback must
    // preserve the previously registered memory capability.
    loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: memoryPlugin.dir,
      config: activateConfig,
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );
  });

  it("uses discovery registration mode for non-activating loads", () => {
    useNoBundledPlugins();
    const marker = "__openclawDiscoveryModeTest";
    const plugin = writePlugin({
      id: "discovery-mode-test",
      filename: "discovery-mode-test.cjs",
      body: `module.exports = {
          id: "discovery-mode-test",
          register(api) {
            globalThis.${marker} = globalThis.${marker} || [];
            globalThis.${marker}.push(api.registrationMode);
            api.registerProvider({ id: "discovery-provider", label: "Discovery Provider", auth: [] });
            api.registerTool({
              name: "discovery_tool",
              description: "Discovery tool",
              parameters: {},
              execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            });
          },
        };`,
    });
    updatePluginManifest(plugin, { contracts: { tools: ["discovery_tool"] } });
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: ["discovery-mode-test"],
      },
    };

    const snapshot = loadOpenClawPlugins({
      activate: false,
      cache: false,
      workspaceDir: plugin.dir,
      config,
    });
    expect((globalThis as Record<string, unknown>)[marker]).toEqual(["discovery"]);
    expect(snapshot.providers.map((entry) => entry.provider.id)).toEqual(["discovery-provider"]);
    expect(snapshot.tools.flatMap((entry) => entry.names)).toContain("discovery_tool");

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config,
    });
    expect((globalThis as Record<string, unknown>)[marker]).toEqual(["discovery", "full"]);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("ignores plugin-supplied conversation-read authority claims", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "conversation-read-provenance-test",
      filename: "conversation-read-provenance-test.cjs",
      body: `module.exports = {
          id: "conversation-read-provenance-test",
          register(api) {
            const createTool = (name) => () => ({
              name,
              description: name,
              parameters: {},
              execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            });
            api.registerTool(createTool("attested_tool"), {
              name: "attested_tool",
              conversationReadPolicy: "current-or-configured-v1",
              supportsConversationReadPolicyV1: true,
            });
            api.registerTool(createTool("unknown_policy_tool"), {
              name: "unknown_policy_tool",
              conversationReadPolicy: "future-policy",
            });
          },
        };`,
    });
    updatePluginManifest(plugin, {
      contracts: { tools: ["attested_tool", "unknown_policy_tool"] },
    });

    const registry = loadOpenClawPlugins({
      activate: false,
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["conversation-read-provenance-test"],
        },
      },
    });

    expect(registry.tools).toHaveLength(2);
    expect(registry.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ names: ["attested_tool"], origin: "config" }),
        expect.objectContaining({ names: ["unknown_policy_tool"], origin: "config" }),
      ]),
    );
    for (const entry of registry.tools) {
      expect(entry).not.toHaveProperty("conversationReadPolicy");
      expect(entry).not.toHaveProperty("supportsConversationReadPolicyV1");
    }
  });

  it("rejects plugin tool registration without manifest tool ownership", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "undeclared-tool-owner",
      filename: "undeclared-tool-owner.cjs",
      body: `module.exports = {
          id: "undeclared-tool-owner",
          register(api) {
            api.registerTool({
              name: "undeclared_tool",
              description: "Undeclared tool",
              parameters: {},
              execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            });
          },
        };`,
    });

    const registry = loadOpenClawPlugins({
      activate: false,
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["undeclared-tool-owner"],
        },
      },
    });

    expect(registry.tools).toStrictEqual([]);
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.pluginId === "undeclared-tool-owner" &&
          entry.message === "plugin must declare contracts.tools before registering agent tools",
      ),
    ).toBe(true);
  });

  it("rejects plugin tool names outside the manifest tool contract", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "wrong-tool-owner",
      filename: "wrong-tool-owner.cjs",
      body: `module.exports = {
          id: "wrong-tool-owner",
          register(api) {
            api.registerTool({
              name: "runtime_tool",
              description: "Runtime tool",
              parameters: {},
              execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            });
          },
        };`,
    });
    updatePluginManifest(plugin, { contracts: { tools: ["manifest_tool"] } });

    const registry = loadOpenClawPlugins({
      activate: false,
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["wrong-tool-owner"],
        },
      },
    });

    expect(registry.tools).toStrictEqual([]);
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.pluginId === "wrong-tool-owner" &&
          entry.message === "plugin must declare contracts.tools for: runtime_tool",
      ),
    ).toBe(true);
  });

  it("caches non-activating snapshots without restoring global side effects", () => {
    useNoBundledPlugins();
    clearPluginCommands();
    const marker = "__openclawSnapshotCacheRegisterCount";
    const plugin = writePlugin({
      id: "snapshot-cache",
      filename: "snapshot-cache.cjs",
      body: `module.exports = {
          id: "snapshot-cache",
          register(api) {
            globalThis.${marker} = (globalThis.${marker} || 0) + 1;
            api.registerCommand({
              name: "snapshot-command",
              description: "Snapshot command",
              handler: async () => ({ text: "ok" }),
            });
          },
        };`,
    });
    const options = {
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-cache"],
        },
      },
      onlyPluginIds: ["snapshot-cache"],
    };

    const first = loadOpenClawPlugins(options);
    const second = loadOpenClawPlugins(options);

    expect(second).toBe(first);
    expect((globalThis as Record<string, unknown>)[marker]).toBe(1);
    expect(first.commands.map((entry) => entry.command.name)).toEqual(["snapshot-command"]);
    expect(getPluginCommandSpecs()).toStrictEqual([]);

    const active = loadOpenClawPlugins({
      workspaceDir: plugin.dir,
      config: options.config,
      onlyPluginIds: ["snapshot-cache"],
    });
    expect(active).not.toBe(first);
    expect((globalThis as Record<string, unknown>)[marker]).toBe(2);
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "snapshot-command",
        description: "Snapshot command",
        acceptsArgs: false,
      },
    ]);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("does not re-register non-bundled plugins after gateway-bindable boot loads", () => {
    useNoBundledPlugins();
    const marker = "__openclawGatewayBootRegisterCount";
    const plugin = writePlugin({
      id: "costclaw-boot-cache",
      filename: "costclaw-boot-cache.cjs",
      body: `module.exports = {
          id: "costclaw-boot-cache",
          register() {
            globalThis.${marker} = (globalThis.${marker} || 0) + 1;
          },
        };`,
    });
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: ["costclaw-boot-cache"],
        entries: {
          "costclaw-boot-cache": { enabled: true },
        },
      },
    };

    loadOpenClawPlugins({
      workspaceDir: plugin.dir,
      config,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    ensurePluginRegistryLoaded({
      scope: "all",
      workspaceDir: plugin.dir,
      config,
    });

    expect((globalThis as Record<string, unknown>)[marker]).toBe(1);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("reuses a gateway-bindable cache entry for later default-mode loads", () => {
    useNoBundledPlugins();
    const marker = "__openclawGatewayBindableCacheRegisterCount";
    const plugin = writePlugin({
      id: "gateway-bindable-cache",
      filename: "gateway-bindable-cache.cjs",
      body: `module.exports = {
          id: "gateway-bindable-cache",
          register() {
            globalThis.${marker} = (globalThis.${marker} || 0) + 1;
          },
        };`,
    });
    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["gateway-bindable-cache"],
          entries: {
            "gateway-bindable-cache": { enabled: true },
          },
        },
      },
    };

    const gatewayBindable = loadOpenClawPlugins({
      ...options,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    const defaultMode = loadOpenClawPlugins(options);

    expect(defaultMode).toBe(gatewayBindable);
    expect((globalThis as Record<string, unknown>)[marker]).toBe(1);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("re-initializes global hook runner when serving registry from cache", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cache-hook-runner",
      filename: "cache-hook-runner.cjs",
      body: `module.exports = { id: "cache-hook-runner", register() {} };`,
    });

    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cache-hook-runner"],
        },
      },
    };

    const first = loadOpenClawPlugins(options);
    expectGlobalHookRunner(getGlobalHookRunner());

    resetGlobalHookRunner();
    expect(getGlobalHookRunner()).toBeNull();

    const second = loadOpenClawPlugins(options);
    expect(second).toBe(first);
    expectGlobalHookRunner(getGlobalHookRunner());

    resetGlobalHookRunner();
  });

  it("keeps pinned gateway hooks and later default-mode hooks dispatchable together", () => {
    useNoBundledPlugins();
    const gatewayPlugin = writePlugin({
      id: "gateway-hook-surface",
      filename: "gateway-hook-surface.cjs",
      body: `module.exports = { id: "gateway-hook-surface", register(api) {
          api.on("subagent_ended", () => undefined);
        } };`,
    });
    const defaultPlugin = writePlugin({
      id: "default-hook-surface",
      filename: "default-hook-surface.cjs",
      body: `module.exports = { id: "default-hook-surface", register(api) {
          api.on("message_sent", () => undefined);
        } };`,
    });

    const gatewayRegistry = loadOpenClawPlugins({
      workspaceDir: gatewayPlugin.dir,
      config: {
        plugins: {
          load: { paths: [gatewayPlugin.file] },
          allow: ["gateway-hook-surface"],
          entries: {
            "gateway-hook-surface": {
              enabled: true,
              hooks: { allowConversationAccess: true },
            },
          },
        },
      },
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    // The gateway pins its boot registry to the channel/http surfaces; the
    // pin is what keeps gateway lifecycle hooks live across later swaps.
    pinActivePluginChannelRegistry(gatewayRegistry);
    try {
      expect(getGlobalPluginRegistry()).toBe(gatewayRegistry);
      expect(expectGlobalHookRunner(getGlobalHookRunner()).hasHooks("subagent_ended")).toBe(true);

      const defaultRegistry = loadOpenClawPlugins({
        workspaceDir: defaultPlugin.dir,
        config: {
          plugins: {
            load: { paths: [defaultPlugin.file] },
            allow: ["default-hook-surface"],
            entries: {
              "default-hook-surface": {
                enabled: true,
                hooks: { allowConversationAccess: true },
              },
            },
          },
        },
      });

      expect(getActivePluginRegistry()).toBe(defaultRegistry);
      expect(getGlobalPluginRegistry()).toBe(defaultRegistry);
      // Regression guard for #91918: the runner must see the union of live
      // registries, not just whichever registry initialized it last.
      const globalHookRunner = expectGlobalHookRunner(getGlobalHookRunner());
      expect(globalHookRunner.hasHooks("subagent_ended")).toBe(true);
      expect(globalHookRunner.hasHooks("message_sent")).toBe(true);
    } finally {
      releasePinnedPluginChannelRegistry(gatewayRegistry);
    }
  });

  it("drops hooks of replaced unpinned registries from the global runner", () => {
    useNoBundledPlugins();
    const firstPlugin = writePlugin({
      id: "retired-hook-surface",
      filename: "retired-hook-surface.cjs",
      body: `module.exports = { id: "retired-hook-surface", register(api) {
          api.on("subagent_ended", () => undefined);
        } };`,
    });
    const secondPlugin = writePlugin({
      id: "replacing-hook-surface",
      filename: "replacing-hook-surface.cjs",
      body: `module.exports = { id: "replacing-hook-surface", register(api) {
          api.on("message_sent", () => undefined);
        } };`,
    });

    loadOpenClawPlugins({
      workspaceDir: firstPlugin.dir,
      config: {
        plugins: {
          load: { paths: [firstPlugin.file] },
          allow: ["retired-hook-surface"],
          entries: { "retired-hook-surface": { enabled: true } },
        },
      },
    });
    expect(expectGlobalHookRunner(getGlobalHookRunner()).hasHooks("subagent_ended")).toBe(true);

    // A second activation retires the unpinned first registry entirely; its
    // hooks must drop instead of dispatching stale config closures.
    loadOpenClawPlugins({
      workspaceDir: secondPlugin.dir,
      config: {
        plugins: {
          load: { paths: [secondPlugin.file] },
          allow: ["replacing-hook-surface"],
          entries: { "replacing-hook-surface": { enabled: true } },
        },
      },
    });
    const globalHookRunner = expectGlobalHookRunner(getGlobalHookRunner());
    expect(globalHookRunner.hasHooks("message_sent")).toBe(true);
    expect(globalHookRunner.hasHooks("subagent_ended")).toBe(false);
  });

  it.each([
    {
      name: "does not reuse cached bundled plugin registries across env changes",
      pluginId: "cache-root",
      setup: () => {
        const bundledA = makeTempDir();
        const bundledB = makeTempDir();
        const pluginA = writePlugin({
          id: "cache-root",
          dir: path.join(bundledA, "cache-root"),
          filename: "index.cjs",
          body: `module.exports = { id: "cache-root", register() {} };`,
        });
        const pluginB = writePlugin({
          id: "cache-root",
          dir: path.join(bundledB, "cache-root"),
          filename: "index.cjs",
          body: `module.exports = { id: "cache-root", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              allow: ["cache-root"],
              entries: {
                "cache-root": { enabled: true },
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached load-path plugin registries across env home changes",
      pluginId: "demo",
      setup: () => {
        const homeA = makeTempDir();
        const homeB = makeTempDir();
        const stateDir = makeTempDir();
        const bundledDir = makeTempDir();
        const pluginA = writePlugin({
          id: "demo",
          dir: path.join(homeA, "plugins", "demo"),
          filename: "index.cjs",
          body: `module.exports = { id: "demo", register() {} };`,
        });
        const pluginB = writePlugin({
          id: "demo",
          dir: path.join(homeB, "plugins", "demo"),
          filename: "index.cjs",
          body: `module.exports = { id: "demo", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              allow: ["demo"],
              entries: {
                demo: { enabled: true },
              },
              load: {
                paths: ["~/plugins/demo"],
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeA,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeB,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
              },
            }),
        };
      },
    },
  ])("$name", ({ pluginId, setup }) => {
    const { expectedFirstSource, expectedSecondSource, loadFirst, loadSecond } = setup();
    expectCachePartitionByPluginSource({
      pluginId,
      loadFirst,
      loadSecond,
      expectedFirstSource,
      expectedSecondSource,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
