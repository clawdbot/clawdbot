import { EventEmitter } from "node:events";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "../internal/discord.js";
import {
  baseConfig,
  baseRuntime,
  getFirstDiscordMessageHandlerParams,
  getProviderMonitorTestMocks,
  resetDiscordProviderMonitorMocks,
} from "../test-support/provider.test-support.js";

const {
  clientConstructorOptionsMock,
  clientDeployCommandsMock,
  clientFetchUserMock,
  clientGetPluginMock,
  createDiscordExecApprovalButtonContextMock,
  createDiscordMessageHandlerMock,
  createDiscordNativeCommandMock,
  createdBindingManagers,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  getAcpSessionStatusMock,
  getPluginCommandSpecsMock,
  isVerboseMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  reconcileAcpThreadBindingsOnStartupMock,
  resolveDiscordAccountMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = getProviderMonitorTestMocks();

let monitorDiscordProvider: typeof import("./provider.js").monitorDiscordProvider;
let providerTesting: typeof import("./provider.js").__testing;
let runtimeEnvModule: typeof import("openclaw/plugin-sdk/runtime-env");

function createAcpRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function createTestChannelRuntime(): ChannelRuntimeSurface {
  const contexts = new Map<string, unknown>();
  const keyFor = (params: { channelId: string; accountId?: string | null; capability: string }) =>
    `${params.channelId}:${params.accountId ?? ""}:${params.capability}`;
  const runtimeContexts: ChannelRuntimeSurface["runtimeContexts"] = {
    register(params) {
      contexts.set(keyFor(params), params.context);
      return {
        dispose: () => {
          contexts.delete(keyFor(params));
        },
      };
    },
    get: ((params: { channelId: string; accountId?: string | null; capability: string }) =>
      contexts.get(keyFor(params))) as ChannelRuntimeSurface["runtimeContexts"]["get"],
    watch() {
      return () => {};
    },
  };
  return {
    runtimeContexts,
  };
}

function createRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  request?: Request,
): RateLimitError {
  const fallbackRequest =
    request ??
    new Request("https://discord.com/api/v10/applications/commands", {
      method: "PUT",
    });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
    request?: Request,
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body, fallbackRequest);
}

function createConfigWithDiscordAccount(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      discord: {
        accounts: {
          default: {
            token: "MTIz.abc.def",
            ...overrides,
          },
        },
      },
    },
  } as OpenClawConfig;
}

vi.mock("../voice/manager.runtime.js", () => {
  voiceRuntimeModuleLoadedMock();
  return {
    DiscordVoiceManager: function DiscordVoiceManager() {},
    DiscordVoiceReadyListener: function DiscordVoiceReadyListener() {},
  };
});
describe("monitorDiscordProvider", () => {
  type ReconcileHealthProbeParams = {
    cfg: OpenClawConfig;
    accountId: string;
    sessionKey: string;
    binding: unknown;
    session: unknown;
  };

  type ReconcileStartupParams = {
    cfg: OpenClawConfig;
    healthProbe?: (
      params: ReconcileHealthProbeParams,
    ) => Promise<{ status: string; reason?: string }>;
  };

  const getConstructedEventQueue = ():
    | { listenerTimeout?: number; slowListenerThreshold?: number }
    | undefined => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    const opts = clientConstructorOptionsMock.mock.calls[0]?.[0] as {
      eventQueue?: { listenerTimeout?: number; slowListenerThreshold?: number };
    };
    return opts.eventQueue;
  };

  const getConstructedClientOptions = (): {
    clientId?: string;
    eventQueue?: { listenerTimeout?: number; slowListenerThreshold?: number };
    requestOptions?: { timeout?: number; runtimeProfile?: string; maxQueueSize?: number };
  } => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    return (
      (clientConstructorOptionsMock.mock.calls[0]?.[0] as {
        clientId?: string;
        eventQueue?: { listenerTimeout?: number; slowListenerThreshold?: number };
        requestOptions?: { timeout?: number; runtimeProfile?: string; maxQueueSize?: number };
      }) ?? {}
    );
  };

  const getHealthProbe = () => {
    expect(reconcileAcpThreadBindingsOnStartupMock).toHaveBeenCalledTimes(1);
    const firstCall = reconcileAcpThreadBindingsOnStartupMock.mock.calls.at(0) as
      | [ReconcileStartupParams]
      | undefined;
    const reconcileParams = firstCall?.[0];
    if (!reconcileParams?.healthProbe) {
      throw new Error("healthProbe was not wired into ACP startup reconciliation");
    }
    return reconcileParams.healthProbe;
  };

  beforeAll(async () => {
    vi.doMock("openclaw/plugin-sdk/plugin-runtime", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-runtime")>(
        "openclaw/plugin-sdk/plugin-runtime",
      );
      return {
        ...actual,
        getPluginCommandSpecs: getPluginCommandSpecsMock,
      };
    });
    vi.doMock("../accounts.js", () => ({
      resolveDiscordAccount: (...args: Parameters<typeof resolveDiscordAccountMock>) =>
        resolveDiscordAccountMock(...args),
      resolveDiscordAccountAllowFrom: () => undefined,
      resolveDiscordAccountDmPolicy: () => undefined,
    }));
    vi.doMock("../probe.js", () => ({
      fetchDiscordApplicationId: async () => "app-1",
      parseApplicationIdFromToken: (token: string) => {
        const segment = token.trim().split(".")[0];
        if (!segment) {
          return undefined;
        }
        try {
          const decoded = Buffer.from(segment, "base64url").toString("utf8").trim();
          return /^\d+$/.test(decoded) ? decoded : undefined;
        } catch {
          return undefined;
        }
      },
    }));
    vi.doMock("../token.js", () => ({
      normalizeDiscordToken: (value?: string) => value,
    }));
    runtimeEnvModule = await import("openclaw/plugin-sdk/runtime-env");
    vi.spyOn(runtimeEnvModule, "logVerbose").mockImplementation(() => undefined);
    ({ monitorDiscordProvider, __testing: providerTesting } = await import("./provider.js"));
  });

  beforeEach(() => {
    resetDiscordProviderMonitorMocks();
    vi.mocked(runtimeEnvModule.logVerbose).mockClear();
    providerTesting.setFetchDiscordApplicationId(async () => "app-1");
    providerTesting.setCreateDiscordNativeCommand(((
      ...args: Parameters<typeof providerTesting.setCreateDiscordNativeCommand>[0] extends
        | ((...inner: infer P) => unknown)
        | undefined
        ? P
        : never
    ) =>
      createDiscordNativeCommandMock(
        ...(args as Parameters<typeof createDiscordNativeCommandMock>),
      )) as NonNullable<Parameters<typeof providerTesting.setCreateDiscordNativeCommand>[0]>);
    providerTesting.setRunDiscordGatewayLifecycle((...args) =>
      monitorLifecycleMock(...(args as Parameters<typeof monitorLifecycleMock>)),
    );
    providerTesting.setLoadDiscordVoiceRuntime(async () => {
      voiceRuntimeModuleLoadedMock();
      return {
        DiscordVoiceManager: function DiscordVoiceManager() {},
        DiscordVoiceReadyListener: function DiscordVoiceReadyListener() {},
      } as never;
    });
    providerTesting.setLoadDiscordProviderSessionRuntime(
      (async () =>
        ({
          getAcpSessionManager: () => ({
            getSessionStatus: getAcpSessionStatusMock,
          }),
          isAcpRuntimeError: (error: unknown): error is { code: string } =>
            error instanceof Error && "code" in error,
          resolveThreadBindingIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
          resolveThreadBindingMaxAgeMs: () => 7 * 24 * 60 * 60 * 1000,
          resolveThreadBindingsEnabled: () => true,
          createDiscordMessageHandler: createDiscordMessageHandlerMock,
          createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
          createThreadBindingManager: createThreadBindingManagerMock,
          reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
        }) as never) as NonNullable<
        Parameters<typeof providerTesting.setLoadDiscordProviderSessionRuntime>[0]
      >,
    );
    providerTesting.setCreateClient((options, handlers, plugins = []) => {
      clientConstructorOptionsMock(options);
      const pluginRegistry = plugins.map((plugin) => ({ id: plugin.id, plugin }));
      return {
        options,
        listeners: handlers.listeners ?? [],
        plugins: pluginRegistry,
        rest: {
          get: vi.fn(async () => undefined),
          post: vi.fn(async () => undefined),
          put: vi.fn(async () => undefined),
          patch: vi.fn(async () => undefined),
          delete: vi.fn(async () => undefined),
        },
        deployCommands: async (deployOptions?: { mode?: string }) =>
          await clientDeployCommandsMock(deployOptions),
        fetchUser: async (target: string) => await clientFetchUserMock(target),
        getPlugin: (name: string) =>
          clientGetPluginMock(name) ?? pluginRegistry.find((entry) => entry.id === name)?.plugin,
      } as never;
    });
    providerTesting.setGetPluginCommandSpecs((provider?: string) =>
      getPluginCommandSpecsMock(provider),
    );
    providerTesting.setResolveDiscordAccount(
      (...args) => resolveDiscordAccountMock(...args) as never,
    );
    providerTesting.setResolveNativeCommandsEnabled((...args) =>
      resolveNativeCommandsEnabledMock(...args),
    );
    providerTesting.setResolveNativeSkillsEnabled((...args) =>
      resolveNativeSkillsEnabledMock(...args),
    );
    providerTesting.setListNativeCommandSpecsForConfig((...args) =>
      listNativeCommandSpecsForConfigMock(...args),
    );
    providerTesting.setListSkillCommandsForAgents(
      (...args) => listSkillCommandsForAgentsMock(...args) as never,
    );
    providerTesting.setIsVerbose(() => isVerboseMock());
    providerTesting.setShouldLogVerbose(() => shouldLogVerboseMock());
  });

  it("stops thread bindings when startup fails before lifecycle begins", async () => {
    createDiscordNativeCommandMock.mockImplementation(() => {
      throw new Error("native command boom");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      }),
    ).rejects.toThrow("native command boom");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("disconnects the shared gateway and suppresses late gateway errors when startup fails before lifecycle begins", async () => {
    const disconnect = vi.fn();
    const emitter = new EventEmitter();
    const gateway = { emitter, disconnect, isConnected: false };
    const runtime = baseRuntime();
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    createDiscordMessageHandlerMock.mockImplementationOnce(() => {
      throw new Error("handler init failed");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime,
      }),
    ).rejects.toThrow("handler init failed");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(() =>
      emitter.emit("error", new Error("Max reconnect attempts (0) reached after code 1005")),
    ).not.toThrow();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("suppressed late gateway reconnect-exhausted error after dispose"),
    );
  });

  it("fails closed before lifecycle when Discord bot identity fetch rejects", async () => {
    const runtime = baseRuntime();
    clientFetchUserMock.mockRejectedValueOnce(new Error("identity offline"));

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime,
      }),
    ).rejects.toThrow("Failed to resolve Discord bot identity");

    expect(createDiscordMessageHandlerMock).not.toHaveBeenCalled();
    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("identity offline"));
  });

  it("fails closed before lifecycle when Discord bot identity has no usable id", async () => {
    const runtime = baseRuntime();
    clientFetchUserMock.mockResolvedValueOnce({ username: "Molty" } as never);

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime,
      }),
    ).rejects.toThrow("Failed to resolve Discord bot identity");

    expect(createDiscordMessageHandlerMock).not.toHaveBeenCalled();
    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("no usable id"));
  });

  it("does not double-stop thread bindings when lifecycle performs cleanup", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(reconcileAcpThreadBindingsOnStartupMock).toHaveBeenCalledTimes(1);
  });

  it("does not load the Discord voice runtime when voice is disabled", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(voiceRuntimeModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("loads the Discord voice runtime only when voice is enabled", async () => {
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: true },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(voiceRuntimeModuleLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("wires exec approval button context from the resolved Discord account config", async () => {
    const cfg = createConfigWithDiscordAccount();
    const execApprovalsConfig = { enabled: true, approvers: ["123"] };
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "cfg-token",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: execApprovalsConfig,
      },
    });

    await monitorDiscordProvider({
      config: cfg,
      runtime: baseRuntime(),
    });

    expect(createDiscordExecApprovalButtonContextMock).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      config: execApprovalsConfig,
    });
  });

  it("registers the native approval runtime context when exec approvals are enabled", async () => {
    const channelRuntime = createTestChannelRuntime();
    const execApprovalsConfig = { enabled: true, approvers: ["123"] };
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "cfg-token",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: execApprovalsConfig,
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
      channelRuntime,
    });

    expect(
      channelRuntime.runtimeContexts.get({
        channelId: "discord",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({
      token: "cfg-token",
      config: execApprovalsConfig,
    });
  });

  it("treats ACP error status as uncertain during startup thread-binding probes", async () => {
    getAcpSessionStatusMock.mockResolvedValue({ state: "error" });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:error",
      binding: {} as never,
      session: {
        acp: {
          state: "error",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "uncertain",
      reason: "status-error-state",
    });
  });

  it("classifies typed ACP session init failures as stale", async () => {
    getAcpSessionStatusMock.mockRejectedValue(
      createAcpRuntimeError("ACP_SESSION_INIT_FAILED", "missing ACP metadata"),
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:stale",
      binding: {} as never,
      session: {
        acp: {
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "stale",
      reason: "session-init-failed",
    });
  });

  it("classifies typed non-init ACP errors as uncertain when not stale-running", async () => {
    getAcpSessionStatusMock.mockRejectedValue(
      createAcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime unavailable"),
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:uncertain",
      binding: {} as never,
      session: {
        acp: {
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "uncertain",
      reason: "status-error",
    });
  });

  it("aborts timed-out ACP status probes during startup thread-binding health checks", async () => {
    vi.useFakeTimers();
    try {
      getAcpSessionStatusMock.mockImplementation(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );

      await monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      });

      const probePromise = getHealthProbe()({
        cfg: baseConfig(),
        accountId: "default",
        sessionKey: "agent:codex:acp:timeout",
        binding: {} as never,
        session: {
          acp: {
            state: "idle",
            lastActivityAt: Date.now(),
          },
        } as never,
      });

      await vi.advanceTimersByTimeAsync(8_100);
      await expect(probePromise).resolves.toEqual({
        status: "uncertain",
        reason: "status-timeout",
      });

      const firstCall = getAcpSessionStatusMock.mock.calls[0]?.[0] as
        | { signal?: AbortSignal }
        | undefined;
      if (!firstCall?.signal) {
        throw new Error("ACP status check did not receive an abort signal");
      }
      expect(firstCall.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to legacy missing-session message classification", async () => {
    getAcpSessionStatusMock.mockRejectedValue(new Error("ACP session metadata missing"));

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:legacy",
      binding: {} as never,
      session: {
        acp: {
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "stale",
      reason: "session-missing",
    });
  });

  it("captures gateway errors emitted before lifecycle wait starts", async () => {
    const emitter = new EventEmitter();
    const drained: Array<{ message: string; type: string }> = [];
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { emitter, disconnect: vi.fn() } : undefined,
    );
    monitorLifecycleMock.mockImplementationOnce(async (params) => {
      (
        params as {
          gatewaySupervisor?: {
            drainPending: (
              handler: (event: { message: string; type: string }) => "continue" | "stop",
            ) => "continue" | "stop";
          };
          threadBindings: { stop: () => void };
        }
      ).gatewaySupervisor?.drainPending((event) => {
        drained.push(event);
        return "continue";
      });
      params.threadBindings.stop();
    });
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("error", new Error("Fatal gateway close code: 4014"));
      return { id: "bot-1" };
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(drained).toHaveLength(1);
    expect(drained[0]?.type).toBe("disallowed-intents");
    expect(drained[0]?.message).toContain("4014");
  });

  it("passes OpenClaw event queue defaults to the Discord client", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue).toEqual({
      listenerTimeout: 120_000,
      slowListenerThreshold: 30_000,
    });
  });

  it("forwards custom eventQueue config from discord config to the Discord client", async () => {
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        eventQueue: { listenerTimeout: 300_000 },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue?.listenerTimeout).toBe(300_000);
  });

  it("does not pass eventQueue.listenerTimeout into the message run queue", async () => {
    await monitorDiscordProvider({
      config: createConfigWithDiscordAccount({
        eventQueue: { listenerTimeout: 50_000 },
      }),
      runtime: baseRuntime(),
    });

    const params = getFirstDiscordMessageHandlerParams<{
      workerRunTimeoutMs?: number;
      listenerTimeoutMs?: number;
    }>();
    expect(params?.workerRunTimeoutMs).toBeUndefined();
    expect("listenerTimeoutMs" in (params ?? {})).toBe(false);
  });

  it("ignores legacy inbound worker timeout config", async () => {
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        inboundWorker: { runTimeoutMs: 300_000 },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const params = getFirstDiscordMessageHandlerParams<{
      workerRunTimeoutMs?: number;
    }>();
    expect(params?.workerRunTimeoutMs).toBeUndefined();
  });

  it("continues startup when Discord daily slash-command create quota is exhausted", async () => {
    const runtime = baseRuntime();
    const request = new Request("https://discord.com/api/v10/applications/commands", {
      method: "PUT",
    });
    const rateLimitError = createRateLimitError(
      new Response(null, {
        status: 429,
        headers: {
          "X-RateLimit-Scope": "shared",
          "X-RateLimit-Bucket": "bucket-1",
        },
      }),
      {
        message: "Max number of daily application command creates has been reached (200)",
        retry_after: 193.632,
        global: false,
      },
      request,
    );
    rateLimitError.discordCode = 30034;
    clientDeployCommandsMock.mockRejectedValueOnce(rateLimitError);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    await vi.waitFor(() => expect(clientDeployCommandsMock).toHaveBeenCalledTimes(1));
    expect(clientDeployCommandsMock).toHaveBeenCalledWith({ mode: "reconcile" });
    expect(clientFetchUserMock).toHaveBeenCalledWith("@me");
    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
  });

  it("logs native command deploy failures as non-fatal warnings", async () => {
    const runtime = baseRuntime();
    clientDeployCommandsMock.mockRejectedValueOnce(new Error("This operation was aborted"));

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    await vi.waitFor(() => expect(clientDeployCommandsMock).toHaveBeenCalledTimes(1));
    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("failed to deploy native commands"),
    );
    expect(
      vi
        .mocked(runtime.log)
        .mock.calls.some(
          (call) =>
            String(call[0]).includes("native slash command deploy warning (not message send):") &&
            String(call[0]).includes("This operation was aborted"),
        ),
    ).toBe(true);
  });

  it("formats rejected Discord deploy entries with command details", () => {
    const details = providerTesting.formatDiscordDeployErrorDetails({
      status: 400,
      discordCode: 50035,
      rawBody: {
        code: 50035,
        message: "Invalid Form Body",
        errors: {
          63: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
          65: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
          66: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
          67: {
            description: {
              _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer." }],
            },
          },
        },
      },
      deployRequestBody: Array.from({ length: 68 }, (_entry, index) => ({
        name: `command-${index}`,
        description: `description-${index}`,
      })),
    });

    expect(details).toContain("status=400");
    expect(details).toContain("code=50035");
    expect(details).toContain("rejected=");
    expect(details).toContain(
      '#63 fields=description name=command-63 description="description-63"',
    );
    expect(details).toContain(
      '#65 fields=description name=command-65 description="description-65"',
    );
    expect(details).toContain(
      '#66 fields=description name=command-66 description="description-66"',
    );
    expect(details).not.toContain("command-67");
  });

  it("configures internal native deploy by default", async () => {
    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    await vi.waitFor(() => expect(clientDeployCommandsMock).toHaveBeenCalledTimes(1));
    expect(clientDeployCommandsMock).toHaveBeenCalledWith({ mode: "reconcile" });
    expect(getConstructedClientOptions().requestOptions).toMatchObject({
      timeout: 15_000,
      runtimeProfile: "persistent",
      maxQueueSize: 1000,
    });
    expect(getConstructedClientOptions().eventQueue?.listenerTimeout).toBe(120_000);
  });

  it("derives application id from token before probing Discord over REST", async () => {
    const fetchApplicationId = vi.fn(async () => "network-app");
    providerTesting.setFetchDiscordApplicationId(fetchApplicationId);
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(fetchApplicationId).not.toHaveBeenCalled();
    expect(getConstructedClientOptions().clientId).toBe("123");
  });

  it("uses configured application id before token parsing or REST lookup", async () => {
    const fetchApplicationId = vi.fn(async () => "network-app");
    providerTesting.setFetchDiscordApplicationId(fetchApplicationId);
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        applicationId: "987654321098765432",
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
      },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(fetchApplicationId).not.toHaveBeenCalled();
    expect(getConstructedClientOptions().clientId).toBe("987654321098765432");
  });

  it("reports connected status on startup and shutdown", async () => {
    const setStatus = vi.fn();
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { isConnected: true } : undefined,
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
      setStatus,
    });

    expect(setStatus.mock.calls).toContainEqual([expect.objectContaining({ connected: true })]);
    expect(setStatus.mock.calls).toContainEqual([expect.objectContaining({ connected: false })]);
  });

  it("logs Discord startup phases and early gateway debug events", async () => {
    const runtime = baseRuntime();
    const emitter = new EventEmitter();
    const gateway = { emitter, isConnected: true, reconnectAttempts: 0 };
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway websocket opened");
      return { id: "bot-1", username: "Molty" };
    });
    isVerboseMock.mockReturnValue(true);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    await vi.waitFor(() =>
      expect(
        vi
          .mocked(runtime.log)
          .mock.calls.some((call) => String(call[0]).includes("deploy-commands:done")),
      ).toBe(true),
    );

    const messages = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("fetch-application-id:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-application-id:done"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:schedule"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:scheduled"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:done"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-bot-identity:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-bot-identity:done"))).toBe(true);
    expect(
      messages.some(
        (msg) => msg.includes("gateway-debug") && msg.includes("Gateway websocket opened"),
      ),
    ).toBe(true);
  });

  it("keeps Discord startup chatter quiet by default", async () => {
    const runtime = baseRuntime();

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    const messages = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("discord startup ["))).toBe(false);
  });
});
