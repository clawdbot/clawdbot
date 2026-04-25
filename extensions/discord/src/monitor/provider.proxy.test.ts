import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

function resolveGatewayInfoFetch(resolve: ((value: Response) => void) | undefined): void {
  expect(resolve).toBeDefined();
  resolve!({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ url: "wss://gateway.discord.gg" }),
  } as Response);
}

const {
  GatewayIntents,
  baseRegisterClientSpy,
  captureHttpExchangeSpy,
  captureWsEventSpy,
  GatewayPlugin,
  globalFetchMock,
  HttpsProxyAgent,
  getLastAgent,
  resolveDebugProxySettingsMock,
  resetLastAgent,
  webSocketSpy,
  wsProxyAgentSpy,
} = vi.hoisted(() => {
  const wsProxyAgentSpy = vi.fn();
  const globalFetchMock = vi.fn();
  const baseRegisterClientSpy = vi.fn();
  const webSocketSpy = vi.fn();
  const captureHttpExchangeSpy = vi.fn();
  const captureWsEventSpy = vi.fn();
  const resolveDebugProxySettingsMock = vi.fn(() => ({ enabled: false }));

  const GatewayIntents = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 1,
    MessageContent: 1 << 2,
    DirectMessages: 1 << 3,
    GuildMessageReactions: 1 << 4,
    DirectMessageReactions: 1 << 5,
    GuildPresences: 1 << 6,
    GuildMembers: 1 << 7,
  } as const;

  class GatewayPlugin {
    options: unknown;
    gatewayInfo: unknown;
    client: unknown;
    ws: unknown;
    isConnecting: boolean;
    constructor(options?: unknown, gatewayInfo?: unknown) {
      this.options = options;
      this.gatewayInfo = gatewayInfo;
      this.client = undefined;
      this.ws = undefined;
      this.isConnecting = false;
    }
    async registerClient(client: unknown) {
      baseRegisterClientSpy(client);
    }
  }

  class HttpsProxyAgent {
    static lastCreated: HttpsProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      HttpsProxyAgent.lastCreated = this;
      wsProxyAgentSpy(proxyUrl);
    }
  }

  return {
    baseRegisterClientSpy,
    GatewayIntents,
    GatewayPlugin,
    globalFetchMock,
    HttpsProxyAgent,
    getLastAgent: () => HttpsProxyAgent.lastCreated,
    captureHttpExchangeSpy,
    captureWsEventSpy,
    resolveDebugProxySettingsMock,
    resetLastAgent: () => {
      HttpsProxyAgent.lastCreated = undefined;
    },
    webSocketSpy,
    wsProxyAgentSpy,
  };
});

// Unit test: don't import Carbon just to check the prototype chain.
vi.mock("@buape/carbon/gateway", () => ({
  GatewayIntents,
  GatewayPlugin,
}));

vi.mock("@buape/carbon/dist/src/plugins/gateway/index.js", () => ({
  GatewayIntents,
  GatewayPlugin,
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent,
}));

vi.mock("ws", () => ({
  default: function MockWebSocket(url: string, options?: { agent?: unknown }) {
    webSocketSpy(url, options);
  },
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  captureHttpExchange: captureHttpExchangeSpy,
  captureWsEvent: captureWsEventSpy,
  resolveEffectiveDebugProxyUrl: (configuredProxyUrl?: string) =>
    configuredProxyUrl?.trim() || process.env.OPENCLAW_DEBUG_PROXY_URL,
  resolveDebugProxySettings: resolveDebugProxySettingsMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => {
    const source = (await globalFetchMock(params.url, params.init)) as Response;
    const body = await source.text();
    return {
      response: new Response(body, {
        status: source.status,
        statusText: source.statusText,
        headers: source.headers,
      }),
      release: vi.fn(),
    };
  }),
}));

describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;
  let waitForDiscordGatewayPluginRegistration: typeof import("./gateway-plugin.js").waitForDiscordGatewayPluginRegistration;

  beforeAll(async () => {
    ({ createDiscordGatewayPlugin, waitForDiscordGatewayPluginRegistration } =
      await import("./gateway-plugin.js"));
  });

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
  }

  function createProxyTestingOverrides() {
    return {
      HttpsProxyAgentCtor:
        HttpsProxyAgent as unknown as typeof import("https-proxy-agent").HttpsProxyAgent,
      webSocketCtor: function WebSocketCtor(url: string, options?: { agent?: unknown }) {
        webSocketSpy(url, options);
      } as unknown as new (url: string, options?: { agent?: unknown }) => import("ws").WebSocket,
      registerClient: async (_plugin: unknown, client: unknown) => {
        baseRegisterClientSpy(client);
      },
    };
  }

  async function registerGatewayClient(plugin: unknown) {
    await (
      plugin as {
        registerClient: (client: {
          options: { token: string };
          registerListener: typeof baseRegisterClientSpy;
          unregisterListener: ReturnType<typeof vi.fn>;
        }) => Promise<void>;
      }
    ).registerClient({
      options: { token: "token-123" },
      registerListener: baseRegisterClientSpy,
      unregisterListener: vi.fn(),
    });
  }

  function startIgnoredGatewayRegistration(plugin: unknown) {
    void (
      plugin as {
        registerClient: (client: {
          options: { token: string };
          registerListener: typeof baseRegisterClientSpy;
          unregisterListener: ReturnType<typeof vi.fn>;
        }) => Promise<void>;
      }
    ).registerClient({
      options: { token: "token-123" },
      registerListener: baseRegisterClientSpy,
      unregisterListener: vi.fn(),
    });
  }

  async function expectGatewayRegisterFetchFailure(response: Response) {
    const runtime = createRuntime();
    globalFetchMock.mockResolvedValue(response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await expect(registerGatewayClient(plugin)).rejects.toThrow(
      "Failed to get gateway information from Discord",
    );
    expect(baseRegisterClientSpy).not.toHaveBeenCalled();
  }

  async function expectGatewayRegisterFallback(response: Response) {
    const runtime = createRuntime();
    globalFetchMock.mockResolvedValue(response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClient(plugin);

    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
    expect((plugin as unknown as { gatewayInfo?: { url?: string } }).gatewayInfo?.url).toBe(
      "wss://gateway.discord.gg/",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway metadata lookup failed transiently"),
    );
  }

  async function registerGatewayClientWithMetadata(params: {
    plugin: unknown;
    fetchMock: typeof globalFetchMock;
  }) {
    params.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url: "wss://gateway.discord.gg" }),
    } as Response);
    await registerGatewayClient(params.plugin);
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "");
    vi.stubGlobal("fetch", globalFetchMock);
    vi.useRealTimers();
    baseRegisterClientSpy.mockClear();
    globalFetchMock.mockClear();
    wsProxyAgentSpy.mockClear();
    webSocketSpy.mockClear();
    captureHttpExchangeSpy.mockClear();
    captureWsEventSpy.mockClear();
    resolveDebugProxySettingsMock.mockReset().mockReturnValue({ enabled: false });
    resetLastAgent();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses safe gateway metadata lookup without proxy", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClientWithMetadata({ plugin, fetchMock: globalFetchMock });

    expect(globalFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" },
      }),
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });

  it("uses ws for gateway sockets even without proxy", () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");

    expect(webSocketSpy).toHaveBeenCalledWith("wss://gateway.discord.gg", undefined);
    expect(wsProxyAgentSpy).not.toHaveBeenCalled();
  });

  it("allocates a fresh websocket flow id for each gateway socket", () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg/?attempt=1");
    createWebSocket("wss://gateway.discord.gg/?attempt=2");

    const openCalls = captureWsEventSpy.mock.calls.filter(([event]) => event?.kind === "ws-open");
    expect(openCalls).toHaveLength(2);
    expect(openCalls[0]?.[0]?.flowId).not.toBe(openCalls[1]?.[0]?.flowId);
  });

  it("maps plain-text Discord 503 responses to fetch failed", async () => {
    await expectGatewayRegisterFallback({
      ok: false,
      status: 503,
      text: async () =>
        "upstream connect error or disconnect/reset before headers. reset reason: overflow",
    } as Response);
  });

  it("keeps fatal Discord metadata failures fatal", async () => {
    await expectGatewayRegisterFetchFailure({
      ok: false,
      status: 401,
      text: async () => "401: Unauthorized",
    } as Response);
  });

  it("keeps Carbon-ignored fatal metadata failures handled for supervised startup", async () => {
    const runtime = createRuntime();
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    globalFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "401: Unauthorized",
    } as Response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      startIgnoredGatewayRegistration(plugin);
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandledReasons).toHaveLength(0);
      const registration = waitForDiscordGatewayPluginRegistration(plugin);
      if (!registration) {
        throw new Error("expected Discord gateway registration promise");
      }
      await expect(registration).rejects.toThrow("Failed to get gateway information from Discord");
      expect(baseRegisterClientSpy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("exposes Carbon-ignored successful registrations for startup await", async () => {
    const runtime = createRuntime();
    globalFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url: "wss://gateway.discord.gg" }),
    } as Response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    startIgnoredGatewayRegistration(plugin);
    const registration = waitForDiscordGatewayPluginRegistration(plugin);
    if (!registration) {
      throw new Error("expected Discord gateway registration promise");
    }
    await registration;

    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
    expect((plugin as unknown as { gatewayInfo?: { url?: string } }).gatewayInfo?.url).toBe(
      "wss://gateway.discord.gg",
    );
  });

  it("uses proxy agent for gateway WebSocket when configured", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://127.0.0.1:8080" },
      runtime,
      __testing: createProxyTestingOverrides(),
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");

    expect(wsProxyAgentSpy).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ agent: getLastAgent() }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: gateway proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to the default gateway plugin when proxy is invalid", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "bad-proxy" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps gateway metadata lookup on the guarded direct fetch when proxy is configured", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://127.0.0.1:8080" },
      runtime,
      __testing: createProxyTestingOverrides(),
    });

    await registerGatewayClientWithMetadata({ plugin, fetchMock: globalFetchMock });

    expect(globalFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" },
      }),
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });

  it("does not double-capture gateway metadata fetches when global fetch patching is enabled", async () => {
    resolveDebugProxySettingsMock.mockReturnValue({ enabled: true });
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClientWithMetadata({ plugin, fetchMock: globalFetchMock });

    expect(captureHttpExchangeSpy).not.toHaveBeenCalled();
  });

  it("accepts IPv6 loopback proxy URLs for websocket setup", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://[::1]:8080" },
      runtime,
      __testing: createProxyTestingOverrides(),
    });

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");
    await registerGatewayClientWithMetadata({ plugin, fetchMock: globalFetchMock });

    expect(wsProxyAgentSpy).toHaveBeenCalledWith("http://[::1]:8080");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to the default gateway plugin when proxy is remote", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("loopback host"));
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("maps body read failures to fetch failed", async () => {
    await expectGatewayRegisterFallback({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("body stream closed");
      },
    } as unknown as Response);
  });

  it("falls back to the default gateway url when metadata lookup times out", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    globalFetchMock.mockImplementation(() => new Promise(() => {}));
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const registerPromise = registerGatewayClient(plugin);
    await vi.advanceTimersByTimeAsync(10_000);
    await registerPromise;

    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
    expect((plugin as unknown as { gatewayInfo?: { url?: string } }).gatewayInfo?.url).toBe(
      "wss://gateway.discord.gg/",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway metadata lookup failed transiently"),
    );
  });

  it("sets client reference before the async gateway-info fetch resolves (regression for #52372)", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    let fetchResolve: ((v: Response) => void) | undefined;
    globalFetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          fetchResolve = resolve;
        }),
    );
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    const clientArg = {
      options: { token: "token-race" },
      registerListener: baseRegisterClientSpy,
      unregisterListener: vi.fn(),
    };
    const registerPromise = (
      plugin as unknown as {
        registerClient: (c: typeof clientArg) => Promise<void>;
      }
    ).registerClient(clientArg);

    // Before the metadata fetch resolves, this.client should already be set so
    // that a concurrent identify() cannot observe an undefined client.
    expect((plugin as unknown as { client: unknown }).client).toBe(clientArg);

    resolveGatewayInfoFetch(fetchResolve);
    await registerPromise;

    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });

  it("skips super.registerClient when an external connect starts during the metadata fetch (regression for #52372)", async () => {
    const runCase = async (markStarted: (plugin: unknown) => void) => {
      vi.useFakeTimers();
      const runtime = createRuntime();
      let fetchResolve: ((v: Response) => void) | undefined;
      globalFetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            fetchResolve = resolve;
          }),
      );
      const plugin = createDiscordGatewayPlugin({
        discordConfig: {},
        runtime,
      });

      const clientArg = {
        options: { token: "token-race" },
        registerListener: baseRegisterClientSpy,
        unregisterListener: vi.fn(),
      };
      const registerPromise = (
        plugin as unknown as {
          registerClient: (c: typeof clientArg) => Promise<void>;
        }
      ).registerClient(clientArg);

      markStarted(plugin);
      resolveGatewayInfoFetch(fetchResolve);
      await registerPromise;
    };

    await runCase((plugin) => {
      (plugin as { ws: unknown }).ws = { readyState: 1 };
    });
    expect(baseRegisterClientSpy).not.toHaveBeenCalled();

    baseRegisterClientSpy.mockClear();
    globalFetchMock.mockReset();
    vi.useRealTimers();

    await runCase((plugin) => {
      (plugin as { isConnecting: boolean }).isConnecting = true;
    });
    expect(baseRegisterClientSpy).not.toHaveBeenCalled();
  });

  it("refreshes fallback gateway metadata on the next register attempt", async () => {
    const runtime = createRuntime();
    globalFetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () =>
          "upstream connect error or disconnect/reset before headers. reset reason: overflow",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            url: "wss://gateway.discord.gg/?v=10",
            shards: 8,
            session_start_limit: {
              total: 1000,
              remaining: 999,
              reset_after: 120_000,
              max_concurrency: 16,
            },
          }),
      } as Response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    await registerGatewayClient(plugin);
    await registerGatewayClient(plugin);

    expect(globalFetchMock).toHaveBeenCalledTimes(2);
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(2);
    expect(
      (plugin as unknown as { gatewayInfo?: { url?: string; shards?: number } }).gatewayInfo,
    ).toMatchObject({
      url: "wss://gateway.discord.gg/?v=10",
      shards: 8,
    });
  });
});
