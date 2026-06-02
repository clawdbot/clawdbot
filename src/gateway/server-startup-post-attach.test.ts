import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
} from "../plugins/hook-types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { withEnvAsync } from "../test-utils/env.js";

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn<() => Promise<PluginServicesHandle | null>>(async () => null);
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
  const ensureOpenClawModelsJson = vi.fn(async () => {});
  const ensureRuntimePluginsLoaded = vi.fn();
  const clearCurrentProviderAuthState = vi.fn();
  const warmCurrentProviderAuthStateOffMainThread = vi.fn(
    async (_cfg?: unknown, _options?: unknown) => {},
  );
  const setAuthProfileFailureHook = vi.fn();
  const transcriptsAutoStartService = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createTranscriptsAutoStartService = vi.fn(() => transcriptsAutoStartService);
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
    isCliProvider,
    resolveConfiguredModelRef,
    resolveHooksGmailModel,
    loadModelCatalog,
    getModelRefStatus,
    ensureOpenClawModelsJson,
    ensureRuntimePluginsLoaded,
    clearCurrentProviderAuthState,
    warmCurrentProviderAuthStateOffMainThread,
    setAuthProfileFailureHook,
    transcriptsAutoStartService,
    createTranscriptsAutoStartService,
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

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: hoisted.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: hoisted.getModelRefStatus,
  isCliProvider: hoisted.isCliProvider,
  resolveConfiguredModelRef: hoisted.resolveConfiguredModelRef,
  resolveHooksGmailModel: hoisted.resolveHooksGmailModel,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: hoisted.ensureOpenClawModelsJson,
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: hoisted.ensureRuntimePluginsLoaded,
}));

vi.mock("../agents/model-provider-auth.js", () => ({
  clearCurrentProviderAuthState: hoisted.clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread: hoisted.warmCurrentProviderAuthStateOffMainThread,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    setAuthProfileFailureHook: hoisted.setAuthProfileFailureHook,
  };
});

vi.mock("../agents/tools/transcripts-tool.js", () => ({
  createTranscriptsAutoStartService: hoisted.createTranscriptsAutoStartService,
}));

vi.mock("./server-tailscale.js", () => ({
  startGatewayTailscaleExposure: hoisted.startGatewayTailscaleExposure,
}));

const { startGatewayPostAttachRuntime, startGatewaySidecars, testing } =
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
    hoisted.ensureOpenClawModelsJson.mockReset();
    hoisted.ensureOpenClawModelsJson.mockResolvedValue(undefined);
    hoisted.ensureRuntimePluginsLoaded.mockReset();
    hoisted.clearCurrentProviderAuthState.mockClear();
    hoisted.warmCurrentProviderAuthStateOffMainThread.mockReset();
    hoisted.warmCurrentProviderAuthStateOffMainThread.mockResolvedValue(undefined);
    hoisted.setAuthProfileFailureHook.mockClear();
    hoisted.transcriptsAutoStartService.start.mockClear();
    hoisted.transcriptsAutoStartService.stop.mockClear();
    hoisted.transcriptsAutoStartService.stop.mockResolvedValue(undefined);
    hoisted.createTranscriptsAutoStartService.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const startGatewaySidecarsInner = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel,
        startGatewaySidecars: startGatewaySidecarsInner,
      }),
    );

    events.push("returned");
    expect(refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(refreshLatestUpdateRestartSentinel).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["sidecars", "returned", "sentinel"]);
  });

  it("starts sidecars while startup logging is still pending", async () => {
    const events: string[] = [];
    let finishStartupLog: (() => void) | undefined;
    const logGatewayStartup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("startup-log-start");
          finishStartupLog = () => {
            events.push("startup-log-end");
            resolve();
          };
        }),
    );
    const startGatewaySidecarsScoped = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const runtimePromise = startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        logGatewayStartup,
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        startGatewaySidecars: startGatewaySidecarsScoped,
      }),
    );

    await vi.waitFor(() => {
      expect(logGatewayStartup).toHaveBeenCalledTimes(1);
      expect(startGatewaySidecarsScoped).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["startup-log-start", "sidecars"]);

    if (!finishStartupLog) {
      throw new Error("Expected startup log release callback to be initialized");
    }
    finishStartupLog();
    await runtimePromise;

    expect(events).toEqual(["startup-log-start", "sidecars", "startup-log-end"]);
  });

  it("starts the gateway update check after post-attach returns", async () => {
    const events: string[] = [];
    const stopUpdateCheck = vi.fn();
    const scheduleGatewayUpdateCheck = vi.fn(async () => {
      events.push("update-check");
      return stopUpdateCheck;
    });
    const startGatewaySidecarsItem = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        scheduleGatewayUpdateCheck,
        startGatewaySidecars: startGatewaySidecarsItem,
      }),
    );
    events.push("returned");

    expect(scheduleGatewayUpdateCheck).not.toHaveBeenCalled();
    expect(events).toEqual(["sidecars", "returned"]);

    await vi.waitFor(() => {
      expect(scheduleGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["sidecars", "returned", "update-check"]);

    result.stopGatewayUpdateCheck();
    expect(stopUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it("stops the gateway update check if close wins the deferred startup race", async () => {
    let finishUpdateCheckSchedule: (() => void) | undefined;
    const stopUpdateCheck = vi.fn();
    const scheduleGatewayUpdateCheck = vi.fn(
      async () =>
        await new Promise<() => void>((resolve) => {
          finishUpdateCheckSchedule = () => resolve(stopUpdateCheck);
        }),
    );

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        scheduleGatewayUpdateCheck,
      }),
    );

    await vi.waitFor(() => {
      expect(scheduleGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });
    result.stopGatewayUpdateCheck();
    expect(stopUpdateCheck).not.toHaveBeenCalled();

    if (!finishUpdateCheckSchedule) {
      throw new Error("Expected update check schedule release callback to be initialized");
    }
    finishUpdateCheckSchedule();

    await vi.waitFor(() => {
      expect(stopUpdateCheck).toHaveBeenCalledTimes(1);
    });
  });

  it("logs deferred gateway update check startup failures without failing ready", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const scheduleGatewayUpdateCheck = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      startGatewayPostAttachRuntime(
        {
          ...createPostAttachParams(),
          log,
        },
        createPostAttachRuntimeDeps({
          refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
          scheduleGatewayUpdateCheck,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        stopGatewayUpdateCheck: expect.any(Function),
      }),
    );

    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith("gateway update check failed to start: Error: boom");
    });
  });

  it("skips heavy restart sentinel refresh when no sentinel file exists", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-no-sentinel-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const result = await testing.refreshLatestUpdateRestartSentinelIfPresent();

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

    const result = await testing.refreshLatestUpdateRestartSentinelIfPresent();

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
        await testing.hasRestartSentinelFileFast({
          HOME: osHome,
          OPENCLAW_HOME: "~/openclaw-home",
        } as NodeJS.ProcessEnv),
      ).toBe(true);

      const backslashStateDir = path.resolve(`${osHome}\\openclaw-state`);
      fs.mkdirSync(backslashStateDir, { recursive: true });
      fs.writeFileSync(path.join(backslashStateDir, "restart-sentinel.json"), "{}\n");

      expect(
        await testing.hasRestartSentinelFileFast({
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
          testing.hasRestartSentinelFileFast({
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
    const startGatewaySidecarsCandidate = vi.fn(async (params) => {
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
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsCandidate }),
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
    const startGatewaySidecarsEntry = vi.fn(async () => {
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
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsEntry }),
    );

    await vi.waitFor(() => {
      expect(events).toEqual(["startup-loaded-start"]);
    });
    expect(startGatewaySidecarsEntry).not.toHaveBeenCalled();

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
      testing.resolveGatewayMemoryStartupPolicy({ memory: { backend: "qmd" } } as never),
    ).toEqual({ mode: "off" });
    expect(
      testing.resolveGatewayMemoryStartupPolicy({
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

  it("cleans startup session locks with bounded concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const cleanedLock = {
      lockPath: "/tmp/openclaw-state/agents/main/sessions/a.jsonl.lock",
      pid: null,
      pidAlive: false,
      createdAt: null,
      ageMs: null,
      stale: true,
      staleReasons: ["missing-pid"],
      removed: true,
    };
    const releaseQueue: Array<() => void> = [];
    const cleanStaleLockFiles = vi.fn(
      async ({ sessionsDir }: { sessionsDir: string }) =>
        await new Promise<{ locks: []; cleaned: (typeof cleanedLock)[] }>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releaseQueue.push(() => {
            active -= 1;
            resolve({
              locks: [],
              cleaned: sessionsDir.endsWith("/b") ? [cleanedLock] : [],
            });
          });
        }),
    );
    const markRestartAbortedMainSessionsFromLocks = vi.fn(async () => {});
    const cleanupPromise = testing.cleanupStaleSessionLocks({
      sessionDirs: ["/sessions/a", "/sessions/b", "/sessions/c", "/sessions/d"],
      cfg: {} as never,
      log: { warn: vi.fn() },
      isStopped: () => false,
      cleanStaleLockFiles: cleanStaleLockFiles as never,
      markRestartAbortedMainSessionsFromLocks: markRestartAbortedMainSessionsFromLocks as never,
      concurrency: 2,
    });

    await vi.waitFor(() => {
      expect(cleanStaleLockFiles).toHaveBeenCalledTimes(2);
    });
    expect(maxActive).toBe(2);

    releaseQueue.shift()?.();
    releaseQueue.shift()?.();
    await vi.waitFor(() => {
      expect(cleanStaleLockFiles).toHaveBeenCalledTimes(4);
    });
    releaseQueue.shift()?.();
    releaseQueue.shift()?.();
    await cleanupPromise;

    expect(cleanStaleLockFiles).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(2);
    expect(markRestartAbortedMainSessionsFromLocks).toHaveBeenCalledWith({
      sessionsDir: "/sessions/b",
      cleanedLocks: [cleanedLock],
    });
  });

  it("marks cleaned startup session locks even when cleanup is stopped after removal", async () => {
    let stopped = false;
    const cleanedLock = {
      lockPath: "/tmp/openclaw-state/agents/main/sessions/a.jsonl.lock",
      pid: null,
      pidAlive: false,
      createdAt: null,
      ageMs: null,
      stale: true,
      staleReasons: ["missing-pid"],
      removed: true,
    };
    const cleanStaleLockFiles = vi.fn(async () => {
      stopped = true;
      return {
        locks: [],
        cleaned: [cleanedLock],
      };
    });
    const markRestartAbortedMainSessionsFromLocks = vi.fn(async () => {});

    await testing.cleanupStaleSessionLocks({
      sessionDirs: ["/sessions/a"],
      cfg: {} as never,
      log: { warn: vi.fn() },
      isStopped: () => stopped,
      cleanStaleLockFiles: cleanStaleLockFiles as never,
      markRestartAbortedMainSessionsFromLocks: markRestartAbortedMainSessionsFromLocks as never,
    });

    expect(markRestartAbortedMainSessionsFromLocks).toHaveBeenCalledWith({
      sessionsDir: "/sessions/a",
      cleanedLocks: [cleanedLock],
    });
  });

  it("waits for sidecars by default before returning", async () => {
    let resumeSidecars: (() => void) | undefined;
    const sidecarsReady = new Promise<{ pluginServices: null; postReadySidecars: [] }>(
      (resolve) => {
        resumeSidecars = () => resolve({ pluginServices: null, postReadySidecars: [] });
      },
    );
    const startGatewaySidecarsResult = vi.fn(async () => {
      return await sidecarsReady;
    });
    let returned = false;

    const runtimePromise = startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsResult }),
    ).then(() => {
      returned = true;
    });

    await vi.waitFor(() => {
      expect(startGatewaySidecarsResult).toHaveBeenCalledTimes(1);
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

  it("delays provider auth prewarm so post-ready gateway work can run first", async () => {
    vi.useFakeTimers();
    const postReadyRequestTurn = vi.fn();
    const onPostReadySidecars = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      await startGatewayPostAttachRuntime({
        ...createPostAttachParams(),
        log,
        deferSidecars: true,
        providerAuthPrewarm: { enabled: true, delayMs: 1_000 },
        onPostReadySidecars,
        onGatewayLifetimeSidecars,
        onSidecarsReady: () => {
          setImmediate(() => {
            postReadyRequestTurn();
          });
        },
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();
      expect(postReadyRequestTurn).toHaveBeenCalledTimes(1);
      expect(onPostReadySidecars.mock.calls[0]?.[0]).toHaveLength(0);
      expect(onGatewayLifetimeSidecars.mock.calls[0]?.[0]).toHaveLength(2);
      await vi.dynamicImportSettled();
      await vi.waitFor(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses current config when agent runtime plugin prewarm runs", async () => {
    const startupConfig = { marker: "startup" } as never;
    const currentConfig = { marker: "current" } as never;

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams({
        gatewayPluginConfigAtStart: startupConfig,
      }),
      providerAuthPrewarm: { enabled: false },
      agentRuntimePluginPrewarm: {
        enabled: true,
        delayMs: 0,
        getConfig: () => currentConfig,
      },
    });

    await vi.waitFor(() => {
      expect(hoisted.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
        config: currentConfig,
        workspaceDir: "/tmp/openclaw-workspace",
        allowGatewaySubagentBinding: true,
      });
    });
    expect(hoisted.ensureRuntimePluginsLoaded).not.toHaveBeenCalledWith(
      expect.objectContaining({ config: startupConfig }),
    );
  });

  it("keeps provider auth prewarm alive when Gmail post-ready sidecars stop", async () => {
    vi.useFakeTimers();
    const onPostReadySidecars = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      await startGatewayPostAttachRuntime({
        ...createPostAttachParams({
          cfgAtStart: {
            hooks: {
              enabled: true,
              internal: { enabled: false },
              gmail: { account: "me" },
            },
          } as never,
          gatewayPluginConfigAtStart: {
            hooks: {
              enabled: true,
              internal: { enabled: false },
              gmail: { account: "me" },
            },
          } as never,
        }),
        log,
        deferSidecars: true,
        providerAuthPrewarm: { enabled: true, delayMs: 1_000 },
        onPostReadySidecars,
        onGatewayLifetimeSidecars,
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.waitFor(() => {
        expect(onPostReadySidecars).toHaveBeenCalledTimes(1);
        expect(onGatewayLifetimeSidecars).toHaveBeenCalledTimes(1);
      });
      const gmailSidecars = onPostReadySidecars.mock.calls[0]?.[0] as
        | { stop: () => void }[]
        | undefined;
      const lifetimeSidecars = onGatewayLifetimeSidecars.mock.calls[0]?.[0] as
        | { stop: () => void }[]
        | undefined;
      expect(gmailSidecars).toHaveLength(1);
      expect(lifetimeSidecars).toHaveLength(2);

      for (const sidecar of gmailSidecars ?? []) {
        sidecar.stop();
      }
      await vi.dynamicImportSettled();
      await vi.waitFor(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      hook?.();
      expect(hoisted.clearCurrentProviderAuthState).toHaveBeenCalledTimes(1);
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps transcripts auto-start alive when Gmail post-ready sidecars stop", async () => {
    const onPostReadySidecars = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const config = {
      hooks: {
        enabled: true,
        internal: { enabled: false },
        gmail: { account: "me" },
      },
      transcripts: {
        autoStart: [{ providerId: "discord-voice", guildId: "g", channelId: "c" }],
      },
    };

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams({
        cfgAtStart: config as never,
        gatewayPluginConfigAtStart: config as never,
      }),
      providerAuthPrewarm: { enabled: false },
      onPostReadySidecars,
      onGatewayLifetimeSidecars,
    });

    const gmailSidecars = onPostReadySidecars.mock.calls[0]?.[0] as
      | Array<{ stop: () => Promise<void> | void }>
      | undefined;
    const lifetimeSidecars = onGatewayLifetimeSidecars.mock.calls[0]?.[0] as
      | Array<{ stop: () => Promise<void> | void }>
      | undefined;
    expect(gmailSidecars).toHaveLength(1);
    expect(lifetimeSidecars).toHaveLength(2);

    await vi.waitFor(() => {
      expect(hoisted.transcriptsAutoStartService.start).toHaveBeenCalledTimes(1);
    });

    for (const sidecar of gmailSidecars ?? []) {
      await sidecar.stop();
    }
    expect(hoisted.transcriptsAutoStartService.stop).not.toHaveBeenCalled();

    for (const sidecar of lifetimeSidecars ?? []) {
      await sidecar.stop();
    }
    expect(hoisted.transcriptsAutoStartService.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed provider auth prewarm when the sidecar stops before the timer fires", async () => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      const sidecar = testing.scheduleProviderAuthStatePrewarm({
        getConfig: () => ({ marker: "current" }) as never,
        log,
        delayMs: 1_000,
      });
      await vi.dynamicImportSettled();
      await vi.waitFor(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });

      await sidecar.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      hook?.();
      expect(hoisted.clearCurrentProviderAuthState).not.toHaveBeenCalled();
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the current provider auth config when the delayed prewarm fires", async () => {
    vi.useFakeTimers();
    const startupCfg = { marker: "startup" } as never;
    const reloadedCfg = { marker: "reloaded" } as never;
    const afterFailureCfg = { marker: "after-failure" } as never;
    let currentCfg = startupCfg;
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      testing.scheduleProviderAuthStatePrewarm({
        getConfig: () => currentCfg,
        log,
        delayMs: 0,
      });
      currentCfg = reloadedCfg;
      await vi.dynamicImportSettled();
      await vi.waitFor(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      if (!hook) {
        throw new Error("Expected provider auth failure hook to be registered");
      }

      hook();
      currentCfg = afterFailureCfg;
      hook();
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      expect(hoisted.clearCurrentProviderAuthState).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(2);
      });
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread.mock.calls[0]?.[0]).toBe(
        reloadedCfg,
      );
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread.mock.calls[1]?.[0]).toBe(
        afterFailureCfg,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts channels when channel startup is enabled", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
      async () => {
        const startChannels = vi.fn(async () => {});

        await startGatewaySidecars({
          cfg: {
            hooks: { internal: { enabled: false } },
            agents: { defaults: { model: "openai/gpt-5.4" } },
          } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels,
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

        expect(startChannels).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("starts and reports plugin services after channel startup completes", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let releaseChannels: (() => void) | undefined;
        const events: string[] = [];
        const pluginServices: PluginServicesHandle = { stop: vi.fn(async () => {}) };
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              events.push("channels-start");
              releaseChannels = () => {
                events.push("channels-end");
                resolve();
              };
            }),
        );
        hoisted.startPluginServices.mockImplementationOnce(async () => {
          events.push("plugin-services");
          return pluginServices;
        });

        await startGatewayPostAttachRuntime({
          ...createPostAttachParams({
            deferSidecars: true,
            onChannelsStarted: async () => {
              events.push("channels-started");
            },
            onPluginServices,
            onSidecarsReady,
          }),
          startChannels,
        });

        await vi.waitFor(() => {
          expect(startChannels).toHaveBeenCalledTimes(1);
        });
        expect(hoisted.startPluginServices).not.toHaveBeenCalled();
        expect(onPluginServices).not.toHaveBeenCalled();
        expect(onSidecarsReady).not.toHaveBeenCalled();

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();
        await vi.waitFor(() => {
          expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
          expect(onPluginServices).toHaveBeenCalledWith(pluginServices);
          expect(onSidecarsReady).toHaveBeenCalledTimes(1);
        });
        expect(events).toEqual([
          "channels-start",
          "channels-end",
          "channels-started",
          "plugin-services",
        ]);
        expect(onPluginServices).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("does not start plugin services after deferred close starts during channel startup", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let closing = false;
        let releaseChannels: (() => void) | undefined;
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChannels = resolve;
            }),
        );

        await startGatewayPostAttachRuntime({
          ...createPostAttachParams({
            deferSidecars: true,
            onPluginServices,
            onSidecarsReady,
          }),
          startChannels,
          isClosing: () => closing,
        });

        await vi.waitFor(() => {
          expect(startChannels).toHaveBeenCalledTimes(1);
        });
        closing = true;

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();

        await vi.waitFor(() => {
          expect(onSidecarsReady).toHaveBeenCalledTimes(1);
        });
        expect(hoisted.startPluginServices).not.toHaveBeenCalled();
        expect(onPluginServices).toHaveBeenCalledWith(null);
      },
    );
  });

  it("stops plugin services that finish starting after deferred close begins", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let shouldStartPluginServices = true;
        let releasePluginServices: (() => void) | undefined;
        const pluginServices: PluginServicesHandle = { stop: vi.fn(async () => {}) };
        const onPluginServices = vi.fn();
        hoisted.startPluginServices.mockImplementationOnce(
          async () =>
            (await new Promise<typeof pluginServices>((resolve) => {
              releasePluginServices = () => resolve(pluginServices);
            })) as never,
        );

        const sidecarsPromise = startGatewaySidecars({
          cfg: { hooks: { internal: { enabled: false } } } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels: vi.fn(async () => {}),
          shouldStartPluginServices: () => shouldStartPluginServices,
          onPluginServices,
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
          expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
        });
        shouldStartPluginServices = false;

        if (!releasePluginServices) {
          throw new Error("Expected plugin service release callback to be initialized");
        }
        releasePluginServices();
        await expect(sidecarsPromise).resolves.toMatchObject({ pluginServices: null });

        expect(pluginServices.stop).toHaveBeenCalledTimes(1);
        expect(onPluginServices).toHaveBeenCalledWith(null);
      },
    );
  });

  it("returns plugin services already reported by deferred sidecars", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let releaseStartupLog: (() => void) | undefined;
        let releaseChannels: (() => void) | undefined;
        const pluginServices = { stop: vi.fn(async () => {}) } as never;
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const logGatewayStartup = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseStartupLog = resolve;
            }),
        );
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChannels = resolve;
            }),
        );
        hoisted.startPluginServices.mockResolvedValueOnce(pluginServices);

        const runtimePromise = startGatewayPostAttachRuntime(
          {
            ...createPostAttachParams({
              deferSidecars: true,
              onPluginServices,
              onSidecarsReady,
            }),
            startChannels,
          },
          createPostAttachRuntimeDeps({
            logGatewayStartup,
            startGatewaySidecars,
          }),
        );

        await vi.waitFor(() => {
          expect(startChannels).toHaveBeenCalledTimes(1);
        });

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();
        await vi.waitFor(() => {
          expect(onPluginServices).toHaveBeenCalledWith(pluginServices);
        });

        if (!releaseStartupLog) {
          throw new Error("Expected startup log release callback to be initialized");
        }
        releaseStartupLog();
        await expect(runtimePromise).resolves.toMatchObject({ pluginServices });
        await vi.waitFor(() => {
          expect(onSidecarsReady).toHaveBeenCalledTimes(1);
        });
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
        ["postReadySidecarCount", 1],
      ],
    });
  });

  it("stops post-ready sidecars registered after close started", () => {
    const postReadySidecar = { stop: vi.fn() };

    testing.stopPostReadySidecarsAfterCloseStarted({
      postReadySidecars: [postReadySidecar],
      closeStarted: true,
    });

    expect(postReadySidecar.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps post-ready sidecars running when close has not started", () => {
    const postReadySidecar = { stop: vi.fn() };

    testing.stopPostReadySidecarsAfterCloseStarted({
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
    await result.postReadySidecars[0]?.stop();
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
    await result.postReadySidecars[0]?.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

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
      await result.postReadySidecars[0]?.stop();
      releaseImport?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../hooks/gmail-watcher-lifecycle.js");
      vi.resetModules();
    }
  });

  it("stops already-started Gmail watcher cleanup on close", async () => {
    const postReadySidecars = [{ stop: vi.fn() }];
    const stopChannel = vi.fn(async () => {});
    const pluginServices = { stop: vi.fn(async () => {}) };
    const { createGatewayCloseHandler } = await import("./server-close.js");
    const { createChatRunState } = await import("./server-chat-state.js");

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
      chatRunState: createChatRunState(),
      chatAbortControllers: new Map(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      nodeSendToSession: vi.fn(),
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => {}) },
      wss: { close: vi.fn((callback: () => void) => callback()) } as never,
      httpServer: { close: vi.fn((callback: () => void) => callback()) } as never,
    });

    await close();

    expect(postReadySidecars[0]?.stop).toHaveBeenCalledTimes(1);
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
    const startGatewaySidecarsValue = vi.fn(async () => {
      return await sidecarsReady;
    });
    const unavailableGatewayMethods = new Set<string>(STARTUP_UNAVAILABLE_GATEWAY_METHODS);

    await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        unavailableGatewayMethods,
        deferSidecars: true,
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsValue }),
    );

    await vi.waitFor(
      () => {
        expect(startGatewaySidecarsValue).toHaveBeenCalledTimes(1);
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
    expect(startGatewaySidecarsValue).toHaveBeenCalledTimes(1);
  });

  it("loads lazy startup plugins before returning with deferred sidecars", async () => {
    const pluginRegistry = {
      plugins: [{ id: "lazy", status: "loaded" }],
      typedHooks: [],
    } as never;
    const loaded = { pluginRegistry, gatewayMethods: ["core.ping"] };
    const loadStartupPlugins = vi.fn(async () => loaded);
    const onStartupPluginsLoaded = vi.fn();
    const startGatewaySidecarsLocal = vi.fn(async () => ({
      pluginServices: null,
      postReadySidecars: [],
    }));

    await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          deferSidecars: true,
          loadStartupPlugins,
          onStartupPluginsLoaded,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsLocal }),
    );

    expect(loadStartupPlugins).toHaveBeenCalledTimes(1);
    expect(onStartupPluginsLoaded).toHaveBeenCalledWith(loaded);
    expect(startGatewaySidecarsLocal).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(startGatewaySidecarsLocal).toHaveBeenCalledTimes(1);
    });
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
    providerAuthPrewarm: { enabled: false },
    ...overrides,
  };
}
