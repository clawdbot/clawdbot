import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
} from "../plugins/hook-types.js";
import { withEnvAsync } from "../test-utils/env.js";

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn(async () => null);
  const startGmailWatcherWithLogs = vi.fn(async () => undefined);
  const loadInternalHooks = vi.fn(async () => 0);
  const setInternalHooksEnabled = vi.fn();
  const hasInternalHookListeners = vi.fn(() => false);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const createInternalHookEvent = vi.fn(() => startupHookEvent);
  const triggerInternalHook = vi.fn(async () => undefined);
  const startGatewayMemoryBackend = vi.fn(async () => undefined);
  const scheduleGatewayUpdateCheck = vi.fn(() => () => {});
  const startGatewayTailscaleExposure = vi.fn(async () => null);
  const logGatewayStartup = vi.fn();
  const scheduleSubagentOrphanRecovery = vi.fn();
  const shouldWakeFromRestartSentinel = vi.fn(() => false);
  const scheduleRestartSentinelWake = vi.fn();
  const refreshLatestUpdateRestartSentinel = vi.fn(async () => null);
  const getAcpRuntimeBackend = vi.fn<(id?: string) => unknown>(() => null);
  const reconcilePendingSessionIdentities = vi.fn(async () => ({
    checked: 0,
    resolved: 0,
    failed: 0,
  }));
  const resolveAgentModelPrimaryValue = vi.fn(() => "");
  const normalizeProviderId = vi.fn((provider: string) => provider.toLowerCase());
  const resolveOpenClawAgentDir = vi.fn(() => "/tmp/openclaw-state/agents/default/agent");
  const isCliProvider = vi.fn(() => false);
  const resolveConfiguredModelRef = vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  }));
  const resolveEmbeddedAgentRuntime = vi.fn(() => "pi");
  const ensureOpenClawModelsJson = vi.fn(async () => undefined);
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
    resolveOpenClawAgentDir,
    isCliProvider,
    resolveConfiguredModelRef,
    resolveEmbeddedAgentRuntime,
    ensureOpenClawModelsJson,
  };
});

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("../agents/session-write-lock.js", () => ({
  cleanStaleLockFiles: vi.fn(async () => undefined),
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

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: hoisted.resolveOpenClawAgentDir,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_MODEL: "gpt-5.4",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-selection.js", () => ({
  isCliProvider: hoisted.isCliProvider,
  resolveConfiguredModelRef: hoisted.resolveConfiguredModelRef,
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
const { STARTUP_UNAVAILABLE_GATEWAY_METHODS } =
  await import("./server-startup-unavailable-methods.js");

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];
type PostAttachRuntimeDeps = NonNullable<Parameters<typeof startGatewayPostAttachRuntime>[1]>;

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
    hoisted.resolveOpenClawAgentDir.mockClear();
    hoisted.isCliProvider.mockReset();
    hoisted.isCliProvider.mockReturnValue(false);
    hoisted.resolveConfiguredModelRef.mockClear();
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
    expect([...unavailableGatewayMethods]).toEqual([]);
    expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
    expect(hoisted.loadInternalHooks).not.toHaveBeenCalled();
    expect(hoisted.setInternalHooksEnabled).not.toHaveBeenCalled();
    expect(hoisted.logGatewayStartup).toHaveBeenCalledWith(
      expect.objectContaining({ loadedPluginIds: ["beta", "alpha"] }),
    );
    expect(log.info).toHaveBeenCalledWith("gateway ready");
    expect(hoisted.startGatewayMemoryBackend).not.toHaveBeenCalled();
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
        startChannels: vi.fn(async () => undefined),
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
    let resumeSidecars!: () => void;
    const sidecarsReady = new Promise<{ pluginServices: null }>((resolve) => {
      resumeSidecars = () => resolve({ pluginServices: null });
    });
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

  it("starts channels without waiting for primary model prewarm completion", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let resolvePrewarm!: () => void;
        const prewarmPrimaryModel = vi.fn(
          async () =>
            await new Promise<undefined>((resolve) => {
              resolvePrewarm = () => resolve(undefined);
            }),
        );
        const startChannels = vi.fn(async () => undefined);

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
            expect(prewarmPrimaryModel).toHaveBeenCalledWith(
              expect.objectContaining({
                workspaceDir: "/tmp/openclaw-workspace",
              }),
            );
            expect(startChannels).toHaveBeenCalledTimes(1);
          },
          { timeout: 2_000 },
        );
        await sidecarsPromise;

        resolvePrewarm();
        await Promise.resolve();
      },
    );
  });

  it("keeps startup-gated methods unavailable while sidecars are still resuming", async () => {
    let resumeSidecars!: () => void;
    const sidecarsReady = new Promise<{ pluginServices: null }>((resolve) => {
      resumeSidecars = () => resolve({ pluginServices: null });
    });
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

    resumeSidecars();
    await vi.waitFor(() => {
      expect([...unavailableGatewayMethods]).toEqual([]);
    });
    expect([...unavailableGatewayMethods]).toEqual([]);
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
        startChannels: vi.fn(async () => undefined),
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
      startChannels: vi.fn(async () => undefined),
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
      expect(hoisted.getAcpRuntimeBackend).toHaveBeenCalledWith("acpx");
    });
    expect(hoisted.reconcilePendingSessionIdentities).not.toHaveBeenCalled();

    healthy = true;
    await vi.waitFor(() => {
      expect(hoisted.reconcilePendingSessionIdentities).toHaveBeenCalledTimes(1);
    });
  });

  it("passes typed gateway_start context with config, workspace dir, and a live cron getter", async () => {
    const runGatewayStart = vi.fn<
      (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>
    >(async () => undefined);
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

    const firstCall = runGatewayStart.mock.calls[0];
    if (!firstCall) {
      throw new Error("gateway_start was not invoked");
    }
    const [event, ctx] = firstCall;
    expect(event).toEqual({ port: 18789 });
    expect(ctx).toMatchObject({
      port: 18789,
      config: params.gatewayPluginConfigAtStart,
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(typeof ctx.getCron).toBe("function");
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
    >(async () => undefined);
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

    const ctx = runGatewayStart.mock.calls[0]?.[1];
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
    startGatewaySidecars: vi.fn(async () => ({ pluginServices: null })),
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
    startChannels: vi.fn(async () => undefined),
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
