import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigWriteNotification } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import {
  createGatewayReloadHandlers,
  startManagedGatewayConfigReloader,
} from "./server-reload-handlers.js";

type GmailWatcherRestartParams = {
  cfg: OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  onSkipped?: () => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
};

type StartGmailWatcherWithLogs = (params: GmailWatcherRestartParams) => Promise<void>;
type StopGmailWatcher = () => Promise<void>;

const hoisted = vi.hoisted(() => ({
  startGmailWatcherWithLogs: vi.fn<StartGmailWatcherWithLogs>(async () => {}),
  stopGmailWatcher: vi.fn<StopGmailWatcher>(async () => {}),
  activeTaskCount: { value: 0 },
  activeTaskBlockers: [] as Array<{
    taskId: string;
    status: "queued" | "running";
    runtime: "subagent" | "acp" | "cli" | "cron";
    runId?: string;
    label?: string;
    title?: string;
  }>,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../tasks/task-registry.maintenance.js", async () => {
  const actual = await vi.importActual<typeof import("../tasks/task-registry.maintenance.js")>(
    "../tasks/task-registry.maintenance.js",
  );
  return {
    ...actual,
    getInspectableActiveTaskRestartBlockers: () => hoisted.activeTaskBlockers,
    getInspectableTaskRegistrySummary: () => ({
      total: hoisted.activeTaskCount.value,
      active: hoisted.activeTaskCount.value,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: hoisted.activeTaskCount.value,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: hoisted.activeTaskCount.value,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    }),
  };
});

function createReloadHandlersForTest(logReload = { info: vi.fn(), warn: vi.fn() }) {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  return createGatewayReloadHandlers({
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => ({
      hooksConfig: {} as never,
      hookClientIpConfig: {} as never,
      heartbeatRunner: heartbeatRunner as never,
      cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
      channelHealthMonitor: null,
    }),
    setState: vi.fn(),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    stopPostReadySidecars: vi.fn(),
    reloadPlugins: vi.fn(
      async (): Promise<GatewayPluginReloadResult> => ({
        restartChannels: new Set(),
        activeChannels: new Set(),
      }),
    ),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload,
    createHealthMonitor: () => null,
  });
}

afterEach(() => {
  hoisted.startGmailWatcherWithLogs.mockClear();
  hoisted.stopGmailWatcher.mockClear();
  hoisted.activeTaskCount.value = 0;
  hoisted.activeTaskBlockers.length = 0;
});

describe("gateway restart deferral preflight", () => {
  it("logs active task run ids before waiting and when forcing after timeout", async () => {
    const restartTesting = (await import("../infra/restart.js")).__testing;
    restartTesting.resetSigusr1State();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    hoisted.activeTaskCount.value = 1;
    hoisted.activeTaskBlockers.push({
      taskId: "task-nightly",
      runId: "run-nightly",
      status: "running",
      runtime: "cron",
      label: "nightly sync",
      title: "refresh all accounts",
    });
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          gateway: { reload: { deferralTimeoutMs: 1_000 } },
        },
      );

      expect(logReload.warn.mock.calls).toEqual([
        [
          "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
        ],
        [
          "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
        ],
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(logReload.warn.mock.calls).toEqual([
        [
          "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
        ],
        [
          "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
        ],
        [
          "restart timeout after 1000ms with 1 background task run(s) still active (taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts); forcing restart",
        ],
      ]);
    } finally {
      hoisted.activeTaskCount.value = 0;
      vi.useRealTimers();
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
    }
  });
});

describe("gateway Gmail hot reload handlers", () => {
  function createGmailReloadPlan(): GatewayReloadPlan {
    return {
      changedPaths: ["hooks.gmail.account"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["hooks.gmail.account"],
      reloadHooks: false,
      restartGmailWatcher: true,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };
  }

  function createGmailConfig(account: string): OpenClawConfig {
    return {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, gmail: { account } },
    };
  }

  it("stops queued post-ready sidecars before restarting Gmail watcher", async () => {
    const stopPostReadySidecars = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      stopPostReadySidecars,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });
    const nextConfig = {
      hooks: { enabled: true, gmail: { account: "next@example.com" } },
    } as never;

    await applyHotReload(
      {
        changedPaths: ["hooks.gmail.account"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["hooks.gmail.account"],
        reloadHooks: false,
        restartGmailWatcher: true,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      nextConfig,
    );

    expect(stopPostReadySidecars).toHaveBeenCalledBefore(hoisted.stopGmailWatcher);
    expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: nextConfig }),
    );
  });

  it("passes a cancellable signal to Gmail watcher restarts", async () => {
    const abortController = new AbortController();
    const clearGmailRestartAbortController = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
      createGmailRestartAbortController: () => abortController,
      clearGmailRestartAbortController,
    });
    const nextConfig = createGmailConfig("next@example.com");

    await applyHotReload(createGmailReloadPlan(), nextConfig);

    const [restartParams] = hoisted.startGmailWatcherWithLogs.mock.calls[0] ?? [];
    expect(restartParams).toMatchObject({ cfg: nextConfig });
    expect(restartParams?.signal).toBe(abortController.signal);
    expect(restartParams?.isCancelled?.()).toBe(false);
    abortController.abort();
    expect(restartParams?.isCancelled?.()).toBe(true);
    expect(clearGmailRestartAbortController).toHaveBeenCalledWith(abortController);
  });

  it("aborts an in-flight managed Gmail restart when the reloader stops", async () => {
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    let restartSignal: AbortSignal | undefined;
    let restartEntered: (() => void) | undefined;
    const restartStarted = new Promise<void>((resolve) => {
      restartEntered = resolve;
    });
    hoisted.startGmailWatcherWithLogs.mockImplementationOnce(
      async (params: GmailWatcherRestartParams) => {
        restartSignal = params.signal;
        restartEntered?.();
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig = createGmailConfig("next@example.com");
    const readSnapshot = vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: nextConfig,
      resolved: nextConfig,
      valid: true,
      runtimeConfig: nextConfig,
      config: nextConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
      hash: "hash-next",
    }));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: readSnapshot as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        warnings: [],
        webTools: {},
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await restartStarted;
    expect(restartSignal?.aborted).toBe(false);

    await reloader.stop();

    expect(restartSignal?.aborted).toBe(true);
  });

  it("does not start a Gmail restart after the managed reloader stops before hot reload applies", async () => {
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    let releaseSecrets: (() => void) | undefined;
    let secretsEntered: (() => void) | undefined;
    const secretsStarted = new Promise<void>((resolve) => {
      secretsEntered = resolve;
    });
    const releaseSecretsPromise = new Promise<void>((resolve) => {
      releaseSecrets = resolve;
    });
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig = createGmailConfig("next@example.com");
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => {
        secretsEntered?.();
        await releaseSecretsPromise;
        return {
          sourceConfig: config,
          config,
          authStores: [],
          warnings: [],
          webTools: {},
        };
      }) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await secretsStarted;

    const stopPromise = reloader.stop();
    releaseSecrets?.();
    await stopPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.stopGmailWatcher).not.toHaveBeenCalled();
    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
  });
});

describe("gateway plugin hot reload handlers", () => {
  it("stops removed channel plugins from broad activation before swapping plugin runtime", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const startChannel = vi.fn(async () => {});
    const events: string[] = [];
    const stopChannel = vi.fn(async () => {
      events.push("stop");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        events.push("registry:replace");
        return {
          restartChannels: new Set(),
          activeChannels: new Set(),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          plugins: {
            enabled: false,
          },
        },
      );
    } finally {
      if (previousSkipChannels === undefined) {
        delete process.env.OPENCLAW_SKIP_CHANNELS;
      } else {
        process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
      }
      if (previousSkipProviders === undefined) {
        delete process.env.OPENCLAW_SKIP_PROVIDERS;
      } else {
        process.env.OPENCLAW_SKIP_PROVIDERS = previousSkipProviders;
      }
    }

    const [reloadParams] = reloadPlugins.mock.calls.at(-1) ?? [];
    const reloadParamsRecord = reloadParams as
      | { nextConfig?: unknown; changedPaths?: unknown }
      | undefined;
    expect(reloadParamsRecord?.nextConfig).toEqual({
      plugins: {
        enabled: false,
      },
    });
    expect(reloadParamsRecord?.changedPaths).toEqual(["plugins.enabled"]);
    expect(stopChannel).toHaveBeenCalledWith("discord");
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reload:start", "stop", "registry:replace"]);
    expect(setState).toHaveBeenCalledTimes(1);
  });
});
