import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
} from "../plugins/hook-types.js";
import { withEnvAsync } from "../test-utils/env.js";

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn(async () => null);
  const startGmailWatcherWithLogs = vi.fn(async () => {});
  const loadInternalHooks = vi.fn(async () => 0);
  const setInternalHooksEnabled = vi.fn();
  const hasInternalHookListeners = vi.fn(() => false);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const createInternalHookEvent = vi.fn(() => startupHookEvent);
  const triggerInternalHook = vi.fn(async () => {});
  const startGatewayMemoryBackend = vi.fn(async () => {});
  const scheduleGatewayUpdateCheck = vi.fn(() => () => {});
  const startGatewayTailscaleExposure = vi.fn(async () => null);
  const logGatewayStartup = vi.fn();
  const scheduleSubagentOrphanRecovery = vi.fn();
  const shouldWakeFromRestartSentinel = vi.fn(() => false);
  const scheduleRestartSentinelWake = vi.fn();
  const refreshLatestUpdateRestartSentinel = vi.fn<
    typeof import("./server-restart-sentinel.js").refreshLatestUpdateRestartSentinel
  >(async () => null);
  const getAcpRuntimeBackend = vi.fn<(id?: string) => unknown>(() => null);
  const reconcilePendingSessionIdentities = vi.fn(async () => ({
    checked: 0,
    resolved: 0,
    failed: 0,
  }));
  const resolveAgentModelPrimaryValue = vi.fn(() => "");
  const normalizeProviderId = vi.fn((provider: string) => provider.toLowerCase());
  const resolveDefaultAgentDir = vi.fn(() => "/tmp/openclaw-state/agents/default/agent");
  const isCliProvider = vi.fn(() => false);
  const resolveConfiguredModelRef = vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  }));
  const resolveHooksGmailModel = vi.fn<() => string | null>(() => null);
  const loadModelCatalog = vi.fn(async () => ({}));
  const getModelRefStatus = vi.fn(() => ({
    key: "openai/gpt-5.4",
    allowed: true,
    inCatalog: true,
  }));
  const resolveEmbeddedAgentRuntime = vi.fn(() => "pi");
  const ensureOpenClawModelsJson = vi.fn(async () => {});
  return {
    startPluginServices,
    startGmailWatcherWithLogs,
    loadInternalHooks,
    setInternalHooksEnabled,
    hasInternalHookListeners,
    startupHookEvent,
    createInternalHookEvent,
    triggerInternalHook,
    startGatewayMemoryBackend,
    scheduleGatewayUpdateCheck,
    startGatewayTailscaleExposure,
    logGatewayStartup,
    scheduleSubagentOrphanRecovery,
    shouldWakeFromRestartSentinel,
    scheduleRestartSentinelWake,
    refreshLatestUpdateRestartSentinel,
    getAcpRuntimeBackend,
    reconcilePendingSessionIdentities,
    resolveAgentModelPrimaryValue,
    normalizeProviderId,
    resolveDefaultAgentDir,
    isCliProvider,
    resolveConfiguredModelRef,
    resolveHooksGmailModel,
    loadModelCatalog,
    getModelRefStatus,
    resolveEmbeddedAgentRuntime,
    ensureOpenClawModelsJson,
  };
});

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("../agents/session-write-lock.js", () => ({
  cleanStaleLockFiles: vi.fn(async () => {}),
}));

vi.mock("../agents/subagent-registry.js", () => ({
  scheduleSubagentOrphanRecovery: hoisted.scheduleSubagentOrphanRecovery,
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return {
    ...actual,
    STATE_DIR: "/tmp/openclaw-state",
    resolveConfigPath: vi.fn(() => "/tmp/openclaw-state/openclaw.json"),
    resolveGatewayPort: vi.fn(() => 18789),
    resolveStateDir: vi.fn(() => "/tmp/openclaw-state"),
  };
});

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: hoisted.createInternalHookEvent,
  hasInternalHookListeners: hoisted.hasInternalHookListeners,
  setInternalHooksEnabled: hoisted.setInternalHooksEnabled,
  triggerInternalHook: hoisted.triggerInternalHook,
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: hoisted.loadInternalHooks,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: hoisted.startPluginServices,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn(() => ({
    reconcilePendingSessionIdentities: hoisted.reconcilePendingSessionIdentities,
  })),
}));

vi.mock("../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: hoisted.getAcpRuntimeBackend,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  refreshLatestUpdateRestartSentinel: hoisted.refreshLatestUpdateRestartSentinel,
  scheduleRestartSentinelWake: hoisted.scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel: hoisted.shouldWakeFromRestartSentinel,
}));

vi.mock("./server-startup-memory.js", () => ({
  startGatewayMemoryBackend: hoisted.startGatewayMemoryBackend,
}));

vi.mock("./server-startup-log.js", () => ({
  logGatewayStartup: hoisted.logGatewayStartup,
}));

vi.mock("../infra/update-startup.js", () => ({
  scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
}));

vi.mock("../config/model-input.js", () => ({
  resolveAgentModelPrimaryValue: hoisted.resolveAgentModelPrimaryValue,
}));

vi.mock("../agents/provider-id.js", () => ({
  normalizeProviderId: hoisted.normalizeProviderId,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: hoisted.resolveDefaultAgentDir,
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_MODEL: "gpt-5.4",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: hoisted.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: hoisted.getModelRefStatus,
  isCliProvider: hoisted.isCliProvider,
  resolveConfiguredModelRef: hoisted.resolveConfiguredModelRef,
  resolveHooksGmailModel: hoisted.resolveHooksGmailModel,
}));

vi.mock("../agents/pi-embedded-runner/runtime.js", () => ({
  resolveEmbeddedAgentRuntime: hoisted.resolveEmbeddedAgentRuntime,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: hoisted.ensureOpenClawModelsJson,
}));

vi.mock("./server-tailscale.js", () => ({
  startGatewayTailscaleExposure: hoisted.startGatewayTailscaleExposure,
}));

const { startGatewayPostAttachRuntime, startGatewaySidecars, __testing } =
  await import("./server-startup-post-attach.js");
const { STARTUP_UNAVAILABLE_GATEWAY_METHODS } = await import("./methods/core-descriptors.js");

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];
type PostAttachRuntimeDeps = NonNullable<Parameters<typeof startGatewayPostAttachRuntime>[1]>;

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[argIndex];
}

function firstStartupLog(): { loadedPluginIds?: string[] } {
  return mockCallArg(hoisted.logGatewayStartup) as { loadedPluginIds?: string[] };
}

function firstEnsureModelsJsonCall(): [
  unknown,
  string,
  {
    workspaceDir?: string;
    providerDiscoveryProviderIds?: string[];
  },
] {
  const call = hoisted.ensureOpenClawModelsJson.mock.calls[0];
  if (!call || call.length < 3) {
    throw new Error("expected ensureOpenClawModelsJson call");
  }
  return call as unknown as [
    unknown,
    string,
    {
      workspaceDir?: string;
      providerDiscoveryProviderIds?: string[];
    },
  ];
}

function firstPrewarmCall(
  prewarmPrimaryModel: ReturnType<typeof vi.fn>,
): [{ workspaceDir?: string }] {
  return prewarmPrimaryModel.mock.calls[0] as [{ workspaceDir?: string }];
}

function createStartupTraceRecorder() {
  const details: Array<{
    name: string;
    metrics: ReadonlyArray<readonly [string, number | string]>;
  }> = [];
  const marks: string[] = [];
  const measures: string[] = [];
  return {
    details,
    marks,
    measures,
    startupTrace: {
      detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => {
        details.push({ name, metrics });
      },
      mark: (name: string) => {
        marks.push(name);
      },
      measure: async <T>(name: string, run: () => T | Promise<T>) => {
        measures.push(name);
        return await run();
      },
    },
  };
}

function firstGatewayStartCall(
  runGatewayStart: ReturnType<typeof vi.fn>,
): [PluginHookGatewayStartEvent, PluginHookGatewayContext] {
  const call = runGatewayStart.mock.calls[0];
  if (!call) {
    throw new Error("gateway_start was not invoked");
  }
  return call as [PluginHookGatewayStartEvent, PluginHookGatewayContext];
}

describe("startGatewayPostAttachRuntime", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "0");
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "0");
    hoisted.startPluginServices.mockClear();
    hoisted.startGmailWatcherWithLogs.mockClear();
    hoisted.loadInternalHooks.mockClear();
    hoisted.setInternalHooksEnabled.mockClear();
    hoisted.hasInternalHookListeners.mockReset();
    hoisted.hasInternalHookListeners.mockReturnValue(false);
    hoisted.createInternalHookEvent.mockClear();
    hoisted.triggerInternalHook.mockClear();
    hoisted.startGatewayMemoryBackend.mockClear();
    hoisted.scheduleGatewayUpdateCheck.mockClear();
    hoisted.startGatewayTailscaleExposure.mockClear();
    hoisted.logGatewayStartup.mockClear();
    hoisted.scheduleSubagentOrphanRecovery.mockClear();
    hoisted.shouldWakeFromRestartSentinel.mockReturnValue(false);
    hoisted.scheduleRestartSentinelWake.mockClear();
    hoisted.getAcpRuntimeBackend.mockReset();
    hoisted.getAcpRuntimeBackend.mockReturnValue(null);
    hoisted.reconcilePendingSessionIdentities.mockClear();
    hoisted.resolveAgentModelPrimaryValue.mockReset();
    hoisted.resolveAgentModelPrimaryValue.mockReturnValue("");
    hoisted.normalizeProviderId.mockClear();
    hoisted.resolveDefaultAgentDir.mockClear();
    hoisted.isCliProvider.mockReset();
    hoisted.isCliProvider.mockReturnValue(false);
    hoisted.resolveConfiguredModelRef.mockClear();
    hoisted.resolveHooksGmailModel.mockReset();
    hoisted.resolveHooksGmailModel.mockReturnValue(null);
    hoisted.loadModelCatalog.mockReset();
    hoisted.loadModelCatalog.mockResolvedValue({});
    hoisted.getModelRefStatus.mockReset();
    hoisted.getModelRefStatus.mockReturnValue({
      key: "openai/gpt-5.4",
      allowed: true,
      inCatalog: true,
    });
    hoisted.resolveEmbeddedAgentRuntime.mockReset();
    hoisted.resolveEmbeddedAgentRuntime.mockReturnValue("pi");
    hoisted.ensureOpenClawModelsJson.mockReset();
    hoisted.ensureOpenClawModelsJson.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("re-enables startup-gated methods after post-attach sidecars start", async () => {
    const unavailableGatewayMethods = new Set<string>(["chat.history", "models.list"]);
    const onSidecarsReady = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      log,
      unavailableGatewayMethods,
      onSidecarsReady,
    });

    await vi.waitFor(() => {
      expect(onSidecarsReady).toHaveBeenCalledTimes(1);
    });
    expect([...unavailableGatewayMethods]).toStrictEqual([]);
    expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
    expect(hoisted.loadInternalHooks).not.toHaveBeenCalled();
    expect(hoisted.setInternalHooksEnabled).not.toHaveBeenCalled();
    expect(hoisted.logGatewayStartup).toHaveBeenCalledTimes(1);
    expect(firstStartupLog().loadedPluginIds).toEqual(["beta", "alpha"]);
    expect(log.info).toHaveBeenCalledWith("gateway ready");
    expect(hoisted.startGatewayMemoryBackend).not.toHaveBeenCalled();
  });

  it("refreshes the restart sentinel after sidecars without blocking post-attach", async () => {
    const events: string[] = [];
    const refreshLatestUpdateRestartSentinel = vi.fn(async () => {
      events.push("sentinel");
      return null;
    });
    const startGatewaySidecars = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel,
        startGatewaySidecars,
      }),
    );

    events.push("returned");
    expect(refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(refreshLatestUpdateRestartSentinel).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["sidecars", "returned", "sentinel"]);
  });

  it("skips heavy restart sentinel refresh when no sentinel file exists", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-no-sentinel-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const result = await __testing.refreshLatestUpdateRestartSentinelIfPresent();

    expect(result).toBeNull();
    expect(hoisted.refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("refreshes the restart sentinel when the sentinel file exists", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-"));
    fs.writeFileSync(path.join(stateDir, "restart-sentinel.json"), "{}\n");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sentinel = { kind: "update", status: "ok", ts: 1 } as const;
    hoisted.refreshLatestUpdateRestartSentinel.mockResolvedValue(sentinel);

    const result = await __testing.refreshLatestUpdateRestartSentinelIfPresent();

    expect(result).toBe(sentinel);
    expect(hoisted.refreshLatestUpdateRestartSentinel).toHaveBeenCalledOnce();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("expands tilde-based restart sentinel state paths", async () => {
    const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-home-"));
    try {
      const openclawHome = path.join(osHome, "openclaw-home");
      const stateDirFromHome = path.join(openclawHome, ".openclaw");
      fs.mkdirSync(stateDirFromHome, { recursive: true });
      fs.writeFileSync(path.join(stateDirFromHome, "restart-sentinel.json"), "{}\n");

      expect(
        await __testing.hasRestartSentinelFileFast({
          HOME: osHome,
          OPENCLAW_HOME: "~/openclaw-home",
        } as NodeJS.ProcessEnv),
      ).toBe(true);

      const backslashStateDir = path.resolve(`${osHome}\\openclaw-state`);
      fs.mkdirSync(backslashStateDir, { recursive: true });
      fs.writeFileSync(path.join(backslashStateDir, "restart-sentinel.json"), "{}\n");

      expect(
        await __testing.hasRestartSentinelFileFast({
          HOME: osHome,
          OPENCLAW_STATE_DIR: "~\\openclaw-state",
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    } finally {
      fs.rmSync(osHome, { recursive: true, force: true });
    }
  });

  it("avoids sync filesystem probes while checking restart sentinel presence", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-async-sentinel-"));
    try {
      fs.writeFileSync(path.join(stateDir, "restart-sentinel.json"), "{}\n");
      const actualExistsSync = fs.existsSync;
      const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
        if (String(candidate).startsWith(stateDir)) {
          throw new Error("sync restart sentinel probe");
        }
        return actualExistsSync(candidate);
      });
      try {
        await expect(
          __testing.hasRestartSentinelFileFast({
            OPENCLAW_STATE_DIR: stateDir,
          } as NodeJS.ProcessEnv),
        ).resolves.toBe(true);
        expect(
          existsSync.mock.calls.filter((call) => String(call[0]).startsWith(stateDir)),
        ).toHaveLength(0);
      } finally {
        existsSync.mockRestore();
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("loads deferred startup plugins before channel sidecars", async () => {
    const events: string[] = [];
    const trace = createStartupTraceRecorder();
    const loadedPluginRegistry = {
      plugins: [{ id: "acpx", status: "loaded" }],
      typedHooks: [],
    } as never;
    const loadStartupPlugins = vi.fn(async () => {
      events.push("load-startup-plugins");
      return {
        pluginRegistry: loadedPluginRegistry,
        gatewayMethods: ["ping", "acp.spawn"],
      };
    });
    const onStartupPluginsLoading = vi.fn(() => {
      events.push("startup-loading");
    });
    const onStartupPluginsLoaded = vi.fn(() => {
      events.push("startup-loaded");
    });
    const startGatewaySidecars = vi.fn(async (params) => {
      events.push("sidecars");
      expect(params.pluginRegistry).toBe(loadedPluginRegistry);
      return { pluginServices: null, postReadySidecars: [] };
    });

    await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          pluginRegistry: {
            plugins: [],
            typedHooks: [],
          } as never,
          loadStartupPlugins,
          onStartupPluginsLoading,
          onStartupPluginsLoaded,
          startupTrace: trace.startupTrace,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars }),
    );

    expect(events).toEqual([
      "startup-loading",
      "load-startup-plugins",
      "startup-loaded",
      "sidecars",
    ]);
    expect(loadStartupPlugins).toHaveBeenCalledTimes(1);
    expect(onStartupPluginsLoaded).toHaveBeenCalledWith({
      pluginRegistry: loadedPluginRegistry,
      gatewayMethods: ["ping", "acp.spawn"],
    });
    expect(hoisted.logGatewayStartup).toHaveBeenCalledTimes(1);
    expect(firstStartupLog().loadedPluginIds).toEqual(["acpx"]);
    expect(trace.measures).toContain("plugins.runtime-post-bind");
    expect(trace.details).toContainEqual({
      name: "plugins.runtime-post-bind",
      metrics: [
        ["loadedPluginCount", 1],
        ["gatewayMethodCount", 2],
      ],
    });
  });

  it("waits for deferred startup plugin attachment before channel sidecars", async () => {
    const events: string[] = [];
    let finishAttachment: (() => void) | undefined;
    const attachmentFinished = new Promise<void>((resolve) => {
      finishAttachment = () => {
        events.push("startup-loaded-end");
        resolve();
      };
    });
    const loadedPluginRegistry = {
      plugins: [{ id: "acpx", status: "loaded" }],
      typedHooks: [],
    } as never;
    const loadStartupPlugins = vi.fn(async () => ({
      pluginRegistry: loadedPluginRegistry,
      gatewayMethods: ["ping", "acp.spawn"],
    }));
    const onStartupPluginsLoaded = vi.fn(() => {
      events.push("startup-loaded-start");
      return attachmentFinished;
    });
    const startGatewaySidecars = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const runtimePromise = startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          pluginRegistry: {
            plugins: [],
            typedHooks: [],
          } as never,
          loadStartupPlugins,
          onStartupPluginsLoaded,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars }),
    );

    await vi.waitFor(() => {
      expect(events).toEqual(["startup-loaded-start"]);
    });
    expect(startGatewaySidecars).not.toHaveBeenCalled();

    if (!finishAttachment) {
      throw new Error("Expected startup plugin attachment release callback to be initialized");
    }
    finishAttachment();
    await runtimePromise;

    expect(events).toEqual(["startup-loaded-start", "startup-loaded-end", "sidecars"]);
  });

  it("keeps the qmd memory backend lazy by default", async () => {
    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      gatewayPluginConfigAtStart: {
        hooks: { internal: { enabled: false } },
        memory: { backend: "qmd" },
      } as never,
    });

    expect(hoisted.startGatewayMemoryBackend).not.toHaveBeenCalled();
    expect(
      __testing.resolveGatewayMemoryStartupPolicy({ memory: { backend: "qmd" } } as never),
    ).toEqual({ mode: "off" });
    expect(
      __testing.resolveGatewayMemoryStartupPolicy({
        memory: { backend: "qmd", qmd: { update: { startup: "immediate", onBoot: false } } },
      } as never),
    ).toEqual({ mode: "off" });
  });

  it("starts the qmd memory backend when startup refresh is immediate", async () => {
    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      gatewayPluginConfigAtStart: {
        hooks: { internal: { enabled: false } },
        memory: { backend: "qmd", qmd: { update: { startup: "immediate" } } },
      } as never,
    });

    await vi.waitFor(() => {
      expect(hoisted.startGatewayMemoryBackend).toHaveBeenCalledTimes(1);
    });
  });

  it("defers qmd memory backend startup refresh until the idle delay elapses", async () => {
    vi.useFakeTimers();
    try {
      await startGatewaySidecars({
        cfg: {
          hooks: { internal: { enabled: false } },
          memory: { backend: "qmd", qmd: { update: { startup: "idle", startupDelayMs: 25 } } },
        } as never,
        pluginRegistry: createPostAttachParams().pluginRegistry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps: {} as never,
        startChannels: vi.fn(async () => {}),
        log: { warn: vi.fn() },
        logHooks: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        logChannels: {
          info: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(hoisted.startGatewayMemoryBackend).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24);
      expect(hoisted.startGatewayMemoryBackend).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await vi.waitFor(() => {
        expect(hoisted.startGatewayMemoryBackend).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for sidecars by default before returning", async () => {
    let resumeSidecars: (() => void) | undefined;
    const sidecarsReady = new Promise<{ pluginServices: null; postReadySidecars: [] }>(
      (resolve) => {
        resumeSidecars = () => resolve({ pluginServices: null, postReadySidecars: [] });
      },
    );
    const startGatewaySidecars = vi.fn(async () => {
      return await sidecarsReady;
    });
    let returned = false;

    const runtimePromise = startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({ startGatewaySidecars }),
    ).then(() => {
      returned = true;
    });

    await vi.waitFor(() => {
      expect(startGatewaySidecars).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    if (!resumeSidecars) {
      throw new Error("Expected gateway sidecar resume callback to be initialized");
    }
    resumeSidecars();
    await runtimePromise;
    expect(returned).toBe(true);
  });

  it("continues channel startup when primary model prewarm hangs", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };
    const prewarm = vi.fn(async () => {
      await new Promise(() => undefined);
    });

    try {
      const promise = __testing.prewarmConfiguredPrimaryModelWithTimeout(
        {
          cfg: {} as never,
          log,
          timeoutMs: 25,
        },
        prewarm as never,
      );

      await vi.advanceTimersByTimeAsync(25);
      await promise;

      expect(prewarm).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        "startup model warmup timed out after 25ms; continuing without waiting",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("prewarms models.json in the configured default agent dir", async () => {
    const cfg = {
      agents: {
        defaults: { model: "openai/gpt-5.4" },
        list: [{ id: "main" }, { id: "ops", default: true }],
      },
    } as never;
    hoisted.resolveAgentModelPrimaryValue.mockReturnValue("openai/gpt-5.4");
    hoisted.resolveDefaultAgentDir.mockReturnValue("/tmp/openclaw-state/agents/ops/agent");

    await __testing.prewarmConfiguredPrimaryModel({
      cfg,
      workspaceDir: "/tmp/openclaw-workspace",
      log: { warn: vi.fn() },
    });

    expect(hoisted.resolveDefaultAgentDir).toHaveBeenCalledWith(cfg);
    expect(hoisted.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
    const ensureCall = firstEnsureModelsJsonCall();
    expect(ensureCall[0]).toBe(cfg);
    expect(ensureCall[1]).toBe("/tmp/openclaw-state/agents/ops/agent");
    const options = ensureCall[2];
    expect(options?.workspaceDir).toBe("/tmp/openclaw-workspace");
    expect(options?.providerDiscoveryProviderIds).toEqual(["openai"]);
  });

  it("starts channels without waiting for primary model prewarm completion", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let resolvePrewarm: (() => void) | undefined;
        const prewarmPrimaryModel = vi.fn(
          async () =>
            await new Promise<undefined>((resolve) => {
              resolvePrewarm = () => resolve(undefined);
            }),
        );
        const startChannels = vi.fn(async () => {});

        const sidecarsPromise = startGatewaySidecars({
          cfg: {
            hooks: { internal: { enabled: false } },
            agents: { defaults: { model: "openai/gpt-5.4" } },
          } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels,
          prewarmPrimaryModel: prewarmPrimaryModel as never,
          log: { warn: vi.fn() },
          logHooks: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
          logChannels: {
            info: vi.fn(),
            error: vi.fn(),
          },
        });

        await vi.waitFor(
          () => {
            expect(prewarmPrimaryModel).toHaveBeenCalledTimes(1);
            expect(firstPrewarmCall(prewarmPrimaryModel)[0].workspaceDir).toBe(
              "/tmp/openclaw-workspace",
            );
            expect(startChannels).toHaveBeenCalledTimes(1);
          },
          { timeout: 2_000 },
        );
        await sidecarsPromise;

        if (!resolvePrewarm) {
          throw new Error("Expected primary model prewarm resolver to be initialized");
        }
        resolvePrewarm();
        await Promise.resolve();
      },
    );
  });

  it("emits a startup trace span when channel startup is skipped", async () => {
    const trace = createStartupTraceRecorder();
    const logChannels = { info: vi.fn(), error: vi.fn() };

    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        await startGatewaySidecars({
          cfg: { hooks: { internal: { enabled: false } } } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels: vi.fn(async () => {}),
          log: { warn: vi.fn() },
          logHooks: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
          logChannels,
          startupTrace: trace.startupTrace,
        });
      },
    );

    expect(trace.measures).toContain("sidecars.channels");
    expect(trace.measures).toContain("sidecars.channel-skip");
    expect(logChannels.info).toHaveBeenCalledWith(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  });

  it("emits a sidecar readiness summary in startup trace details", async () => {
    const trace = createStartupTraceRecorder();

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams({
        startupTrace: trace.startupTrace,
      }),
    });

    expect(trace.marks).toContain("sidecars.ready");
    expect(trace.details).toContainEqual({
      name: "sidecars.ready",
      metrics: [
        ["loadedPluginCount", 2],
        ["postReadySidecarCount", 0],
      ],
    });
  });

  it("stops post-ready sidecars registered after close started", () => {
    const postReadySidecar = { stop: vi.fn() };

    __testing.stopPostReadySidecarsAfterCloseStarted({
      postReadySidecars: [postReadySidecar],
      closeStarted: true,
    });

    expect(postReadySidecar.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps post-ready sidecars running when close has not started", () => {
    const postReadySidecar = { stop: vi.fn() };

    __testing.stopPostReadySidecarsAfterCloseStarted({
      postReadySidecars: [postReadySidecar],
      closeStarted: false,
    });

    expect(postReadySidecar.stop).not.toHaveBeenCalled();
  });

  it("runs Gmail watcher after sidecars are ready", async () => {
    let resolveWatcher: (() => void) | undefined;
    let watcherSignal: AbortSignal | undefined;
    hoisted.startGmailWatcherWithLogs.mockImplementationOnce(
      async (...args: unknown[]) =>
        await new Promise<void>((resolve) => {
          const [params] = args as [{ signal?: AbortSignal }];
          watcherSignal = params.signal;
          resolveWatcher = resolve;
        }),
    );
    const onPostReadySidecars = vi.fn();
    const log = { warn: vi.fn() };

    const result = await startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log,
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(1);
    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
    onPostReadySidecars(result.postReadySidecars);
    expect(onPostReadySidecars).toHaveBeenCalledWith(result.postReadySidecars);

    await vi.waitFor(() => {
      expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledTimes(1);
    });
    expect(watcherSignal?.aborted).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();

    if (!resolveWatcher) {
      throw new Error("Expected gmail watcher resolver to be initialized");
    }
    result.postReadySidecars[0]?.stop();
    expect(watcherSignal?.aborted).toBe(true);
    resolveWatcher();
  });

  it("logs post-ready Gmail watcher failures without delaying sidecar readiness", async () => {
    const log = { warn: vi.fn() };
    hoisted.startGmailWatcherWithLogs.mockRejectedValueOnce(new Error("boom"));

    const result = await startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log,
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(1);
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        "sidecars.gmail-watch failed after gateway ready: Error: boom",
      );
    });
  });

  it("cancels a post-ready Gmail watcher before the immediate starts", async () => {
    const result = await startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(1);
    result.postReadySidecars[0]?.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
  });

  it("cancels a post-ready Gmail watcher after the immediate enters", async () => {
    let releaseImport: (() => void) | undefined;
    vi.doMock("../hooks/gmail-watcher-lifecycle.js", async () => {
      await new Promise<void>((resolve) => {
        releaseImport = resolve;
      });
      return {
        startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
      };
    });
    vi.resetModules();
    try {
      const { startGatewaySidecars: startGatewaySidecarsWithDelayedImport } =
        await import("./server-startup-post-attach.js");

      const result = await startGatewaySidecarsWithDelayedImport({
        cfg: {
          hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
        } as never,
        pluginRegistry: createPostAttachParams().pluginRegistry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps: {} as never,
        startChannels: vi.fn(async () => {}),
        log: { warn: vi.fn() },
        logHooks: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        logChannels: {
          info: vi.fn(),
          error: vi.fn(),
        },
      });

      await vi.waitFor(() => {
        expect(releaseImport).toBeDefined();
      });
      result.postReadySidecars[0]?.stop();
      releaseImport?.();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../hooks/gmail-watcher-lifecycle.js");
      vi.resetModules();
    }
  });

  it("keeps already-started Gmail watcher cleanup on close", async () => {
    const postReadySidecars = [{ stop: vi.fn() }];
    const stopChannel = vi.fn(async () => {});
    const pluginServices = { stop: vi.fn(async () => {}) };
    const { createGatewayCloseHandler } = await import("./server-close.js");

    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      channelIds: [],
      stopChannel,
      pluginServices,
      postReadySidecars,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() },
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => {}, 1 << 30),
      healthInterval: setInterval(() => {}, 1 << 30),
      dedupeCleanup: setInterval(() => {}, 1 << 30),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => {}) },
      wss: { close: vi.fn((callback: () => void) => callback()) } as never,
      httpServer: { close: vi.fn((callback: () => void) => callback()) } as never,
    });

    await close();

    expect(postReadySidecars[0]?.stop).not.toHaveBeenCalled();
    expect(pluginServices.stop).toHaveBeenCalledTimes(1);
  });

  it("runs Gmail model validation after sidecars are ready", async () => {
    hoisted.resolveHooksGmailModel.mockReturnValueOnce("openai/gpt-5.4");

    const result = await startGatewaySidecars({
      cfg: {
        hooks: { internal: { enabled: false }, gmail: { model: "openai/gpt-5.4" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(1);
    expect(hoisted.loadModelCatalog).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(hoisted.loadModelCatalog).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.getModelRefStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "openai/gpt-5.4" }),
    );
  });

  it("keeps startup-gated methods unavailable while sidecars are still resuming", async () => {
    let resumeSidecars: (() => void) | undefined;
    const sidecarsReady = new Promise<{ pluginServices: null; postReadySidecars: [] }>(
      (resolve) => {
        resumeSidecars = () => resolve({ pluginServices: null, postReadySidecars: [] });
      },
    );
    const startGatewaySidecars = vi.fn(async () => {
      return await sidecarsReady;
    });
    const unavailableGatewayMethods = new Set<string>(STARTUP_UNAVAILABLE_GATEWAY_METHODS);

    await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        unavailableGatewayMethods,
        deferSidecars: true,
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars }),
    );

    await vi.waitFor(
      () => {
        expect(startGatewaySidecars).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );

    expect([...unavailableGatewayMethods]).toEqual([...STARTUP_UNAVAILABLE_GATEWAY_METHODS]);
    expect(hoisted.startPluginServices).not.toHaveBeenCalled();

    if (!resumeSidecars) {
      throw new Error("Expected gateway sidecar resume callback to be initialized");
    }
    resumeSidecars();
    await vi.waitFor(() => {
      expect([...unavailableGatewayMethods]).toStrictEqual([]);
    });
    expect([...unavailableGatewayMethods]).toStrictEqual([]);
    expect(startGatewaySidecars).toHaveBeenCalledTimes(1);
  });

  it("dispatches registered gateway startup internal hooks without configured hook packs", async () => {
    vi.useFakeTimers();
    hoisted.hasInternalHookListeners.mockReturnValue(true);
    const cfg = {} as never;
    const deps = {} as never;

    try {
      await startGatewaySidecars({
        cfg,
        pluginRegistry: createPostAttachParams().pluginRegistry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps,
        startChannels: vi.fn(async () => {}),
        log: { warn: vi.fn() },
        logHooks: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        logChannels: {
          info: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(hoisted.loadInternalHooks).not.toHaveBeenCalled();
      expect(hoisted.hasInternalHookListeners).toHaveBeenCalledWith("gateway", "startup");

      await vi.advanceTimersByTimeAsync(250);

      expect(hoisted.createInternalHookEvent).toHaveBeenCalledWith(
        "gateway",
        "startup",
        "gateway:startup",
        {
          cfg,
          deps,
          workspaceDir: "/tmp/openclaw-workspace",
        },
      );
      expect(hoisted.triggerInternalHook).toHaveBeenCalledWith(hoisted.startupHookEvent);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a healthy ACP runtime backend before startup identity reconcile", async () => {
    const trace = createStartupTraceRecorder();
    let healthy = false;
    hoisted.getAcpRuntimeBackend.mockImplementation((id?: string) => ({
      id: id ?? "acpx",
      runtime: {},
      healthy: () => healthy,
    }));

    await startGatewaySidecars({
      cfg: {
        hooks: { internal: { enabled: false } },
        acp: { enabled: true, backend: "acpx" },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
      startupTrace: trace.startupTrace,
    });

    await vi.waitFor(() => {
      expect(hoisted.getAcpRuntimeBackend).toHaveBeenCalledWith("acpx");
    });
    expect(hoisted.reconcilePendingSessionIdentities).not.toHaveBeenCalled();

    healthy = true;
    await vi.waitFor(() => {
      expect(hoisted.reconcilePendingSessionIdentities).toHaveBeenCalledTimes(1);
    });
    expect(trace.measures).toContain("sidecars.acp.runtime-ready");
    expect(trace.measures).toContain("sidecars.acp.identity-reconcile");
    expect(trace.details).toContainEqual({
      name: "sidecars.acp.runtime-ready",
      metrics: [
        ["readyCount", 1],
        ["backend", "acpx"],
      ],
    });
  });

  it("passes typed gateway_start context with config, workspace dir, and a live cron getter", async () => {
    const runGatewayStart = vi.fn<
      (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>
    >(async () => {});
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "gateway_start"),
      runGatewayStart,
    };
    const initialCron = { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const params = createPostAttachParams({
      gatewayPluginConfigAtStart: {
        hooks: { internal: { enabled: false } },
        plugins: { entries: { demo: { enabled: true } } },
      } as never,
      pluginRegistry: {
        ...createPostAttachParams().pluginRegistry,
        typedHooks: [{ hookName: "gateway_start" }],
      } as never,
      deps: { cron: initialCron } as never,
    });

    await startGatewayPostAttachRuntime(
      params,
      createPostAttachRuntimeDeps({
        getGlobalHookRunner: vi.fn(async () => hookRunner as never),
      }),
    );

    await vi.waitFor(() => {
      expect(runGatewayStart).toHaveBeenCalledTimes(1);
    });

    const [event, ctx] = firstGatewayStartCall(runGatewayStart);
    expect(event).toEqual({ port: 18789 });
    expect(ctx.port).toBe(18789);
    expect(ctx.config).toBe(params.gatewayPluginConfigAtStart);
    expect(ctx.workspaceDir).toBe("/tmp/openclaw-workspace");
    const getCron = ctx.getCron;
    if (!getCron) {
      throw new Error("gateway_start context did not expose getCron");
    }
    expect(getCron()).toBe(initialCron);

    const reloadedCron = { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() };
    params.deps.cron = reloadedCron as never;
    expect(getCron()).toBe(reloadedCron);
  });

  it("does not resolve the global hook runner when no gateway_start hooks are registered", async () => {
    const getGlobalHookRunner = vi.fn(async () => {
      throw new Error("should not load hook runner");
    });

    await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({ getGlobalHookRunner }),
    );

    expect(getGlobalHookRunner).not.toHaveBeenCalled();
  });

  it("resolves gateway_start cron from the live runtime getter before deps fallback", async () => {
    const runGatewayStart = vi.fn<
      (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>
    >(async () => {});
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "gateway_start"),
      runGatewayStart,
    };
    const depsCron = { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const liveCron = { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const reloadedCron = { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() };
    let currentLiveCron = liveCron;
    const params = createPostAttachParams({
      deps: { cron: depsCron } as never,
      getCronService: () => currentLiveCron,
      pluginRegistry: {
        ...createPostAttachParams().pluginRegistry,
        typedHooks: [{ hookName: "gateway_start" }],
      } as never,
    });

    await startGatewayPostAttachRuntime(
      params,
      createPostAttachRuntimeDeps({
        getGlobalHookRunner: vi.fn(async () => hookRunner as never),
      }),
    );

    await vi.waitFor(() => {
      expect(runGatewayStart).toHaveBeenCalledTimes(1);
    });

    const [, ctx] = firstGatewayStartCall(runGatewayStart);
    if (!ctx?.getCron) {
      throw new Error("gateway_start context did not expose getCron");
    }
    expect(ctx.getCron()).toBe(liveCron);

    params.deps.cron = depsCron as never;
    currentLiveCron = reloadedCron;
    expect(ctx.getCron()).toBe(reloadedCron);
  });
});

function createPostAttachRuntimeDeps(
  overrides: Partial<PostAttachRuntimeDeps> = {},
): PostAttachRuntimeDeps {
  return {
    getGlobalHookRunner: vi.fn(() => null),
    logGatewayStartup: hoisted.logGatewayStartup,
    refreshLatestUpdateRestartSentinel: hoisted.refreshLatestUpdateRestartSentinel,
    scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
    startGatewaySidecars: vi.fn(async () => ({ pluginServices: null, postReadySidecars: [] })),
    startGatewayTailscaleExposure: hoisted.startGatewayTailscaleExposure,
    ...overrides,
  };
}

function createPostAttachParams(overrides: Partial<PostAttachParams> = {}): PostAttachParams {
  return {
    minimalTestGateway: false,
    cfgAtStart: { hooks: { internal: { enabled: false } } } as never,
    bindHost: "127.0.0.1",
    bindHosts: ["127.0.0.1"],
    port: 18789,
    tlsEnabled: false,
    log: { info: vi.fn(), warn: vi.fn() },
    isNixMode: false,
    broadcast: vi.fn(),
    tailscaleMode: "off",
    resetOnExit: false,
    preserveFunnel: false,
    controlUiBasePath: "/",
    logTailscale: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    gatewayPluginConfigAtStart: { hooks: { internal: { enabled: false } } } as never,
    pluginRegistry: {
      plugins: [
        { id: "beta", status: "loaded" },
        { id: "alpha", status: "loaded" },
        { id: "cold", status: "disabled" },
        { id: "broken", status: "error" },
      ],
      typedHooks: [],
    } as never,
    defaultWorkspaceDir: "/tmp/openclaw-workspace",
    deps: {} as never,
    startChannels: vi.fn(async () => {}),
    logHooks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    logChannels: {
      info: vi.fn(),
      error: vi.fn(),
    },
    unavailableGatewayMethods: new Set<string>(),
    ...overrides,
  };
}
