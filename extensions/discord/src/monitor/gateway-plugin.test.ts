// Discord tests cover gateway plugin plugin behavior.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDiscordProviderEndpointForTest } from "../provider-endpoint.test-support.js";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";
import {
  fetchDiscordGatewayInfoWithTimeout,
  resolveDiscordGatewayInfoTimeoutMs,
} from "./gateway-metadata.js";

const { resolvePinnedHostnameWithPolicyMock } = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicyMock: vi.fn(),
}));

const { GatewayIntents, GatewayPlugin } = vi.hoisted(() => {
  const GatewayIntentsLocal = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 1,
    MessageContent: 1 << 2,
    DirectMessages: 1 << 3,
    GuildMessageReactions: 1 << 4,
    DirectMessageReactions: 1 << 5,
    GuildPresences: 1 << 6,
    GuildMembers: 1 << 7,
    GuildVoiceStates: 1 << 8,
    GuildExpressions: 1 << 9,
  } as const;

  class TestEmitter {
    private readonly listenersByEvent = new Map<string, Array<(value: unknown) => void>>();

    on(event: string, listener: (value: unknown) => void) {
      const listeners = this.listenersByEvent.get(event) ?? [];
      listeners.push(listener);
      this.listenersByEvent.set(event, listeners);
    }

    emit(event: string, value: unknown) {
      for (const listener of this.listenersByEvent.get(event) ?? []) {
        listener(value);
      }
    }
  }

  class GatewayPluginLocal {
    options: unknown;
    gatewayInfo: unknown;
    emitter = new TestEmitter();
    isConnecting = false;
    heartbeatInterval?: NodeJS.Timeout;
    firstHeartbeatTimeout?: NodeJS.Timeout;
    ws?: unknown;

    constructor(options?: unknown) {
      this.options = options;
    }

    async registerClient(_clientForTest: unknown): Promise<void> {}

    connect(_resume = false): void {}
  }

  return { GatewayIntents: GatewayIntentsLocal, GatewayPlugin: GatewayPluginLocal };
});

vi.mock("../internal/gateway.js", () => ({
  DISCORD_GATEWAY_WS_CLIENT_OPTIONS: { maxPayload: 16 * 1024 * 1024 },
  GatewayIntents,
  GatewayPlugin,
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  captureHttpExchange: vi.fn(),
  captureWsEvent: vi.fn(),
  resolveEffectiveDebugProxyUrl: () => undefined,
  resolveDebugProxySettings: () => ({ enabled: false }),
}));

// Suite runs isolate=false: a partial factory here poisons the shared module
// cache for later files in the worker (#123025), so spread the real module.
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    danger: (value: string) => value,
    warn: (value: string) => value,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;
  let resolveDiscordGatewayIntents: typeof import("./gateway-plugin.js").resolveDiscordGatewayIntents;

  beforeEach(async () => {
    vi.resetModules();
    resolvePinnedHostnameWithPolicyMock.mockReset();
    ({ createDiscordGatewayPlugin, resolveDiscordGatewayIntents } =
      await import("./gateway-plugin.js"));
  });

  function createPlugin(
    testing?: NonNullable<Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]>,
    discordConfig: Parameters<typeof createDiscordGatewayPlugin>[0]["discordConfig"] = {},
    runtime: Parameters<typeof createDiscordGatewayPlugin>[0]["runtime"] = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
  ) {
    return createDiscordGatewayPlugin({
      discordConfig,
      runtime,
      ...(testing ? { testing } : {}),
    });
  }

  it("subscribes to guild emoji changes without enabling voice by default", () => {
    const intents = resolveDiscordGatewayIntents();

    expect(intents & GatewayIntents.GuildExpressions).toBe(GatewayIntents.GuildExpressions);
    expect(intents & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("includes GuildVoiceStates when voice is enabled", () => {
    const intents = resolveDiscordGatewayIntents({ voiceEnabled: true });

    expect(intents & GatewayIntents.GuildVoiceStates).toBe(GatewayIntents.GuildVoiceStates);
  });

  it("omits GuildVoiceStates when voice is disabled", () => {
    const intents = resolveDiscordGatewayIntents({ voiceEnabled: false });

    expect(intents & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("omits MessageContent only when explicitly disabled", () => {
    const defaultIntents = resolveDiscordGatewayIntents();
    const mentionOnlyIntents = resolveDiscordGatewayIntents({
      intentsConfig: { messageContent: false },
    });

    expect(defaultIntents & GatewayIntents.MessageContent).toBe(GatewayIntents.MessageContent);
    expect(mentionOnlyIntents & GatewayIntents.MessageContent).toBe(0);
  });

  it("lets intents.voiceStates override voice enablement", () => {
    const enabled = resolveDiscordGatewayIntents({
      intentsConfig: { voiceStates: true },
      voiceEnabled: false,
    });
    const disabled = resolveDiscordGatewayIntents({
      intentsConfig: { voiceStates: false },
      voiceEnabled: true,
    });

    expect(enabled & GatewayIntents.GuildVoiceStates).toBe(GatewayIntents.GuildVoiceStates);
    expect(disabled & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("includes optional configured privileged intents", () => {
    const intents = resolveDiscordGatewayIntents({
      intentsConfig: { presence: true, guildMembers: true },
    });

    expect(intents & GatewayIntents.GuildPresences).toBe(GatewayIntents.GuildPresences);
    expect(intents & GatewayIntents.GuildMembers).toBe(GatewayIntents.GuildMembers);
  });

  it("resolves gateway metadata timeout from env, then default", () => {
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "25000" },
      }),
    ).toBe(25_000);
    expect(resolveDiscordGatewayInfoTimeoutMs({ env: {} })).toBe(30_000);
  });

  it("parses valid Discord gateway metadata", async () => {
    await expect(
      fetchDiscordGatewayInfoWithTimeout({
        token: "test",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              url: "wss://gateway.discord.gg",
              shards: 1,
              session_start_limit: {
                total: 1000,
                remaining: 999,
                reset_after: 0,
                max_concurrency: 1,
              },
            }),
          ),
      }),
    ).resolves.toEqual({
      url: "wss://gateway.discord.gg",
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 0,
        max_concurrency: 1,
      },
    });
  });

  it("rejects malformed Discord gateway metadata", async () => {
    await expect(
      fetchDiscordGatewayInfoWithTimeout({
        token: "test",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              url: "wss://gateway.discord.gg",
              shards: 0,
              session_start_limit: {
                total: 1000,
                remaining: 999,
                reset_after: 0,
                max_concurrency: 1,
              },
            }),
          ),
      }),
    ).rejects.toThrow(/url|shards/);
  });

  it("omits voice states when Discord voice is disabled in account config", () => {
    const plugin = createPlugin(undefined, { voice: { enabled: false } });
    const options = (plugin as unknown as { options?: { intents?: number } }).options;

    expect((options?.intents ?? 0) & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("omits voice states when Discord voice config is absent", () => {
    const plugin = createPlugin(undefined, {});
    const options = (plugin as unknown as { options?: { intents?: number } }).options;

    expect((options?.intents ?? 0) & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("keeps voice states for existing Discord voice config blocks", () => {
    const plugin = createPlugin(undefined, { voice: {} });
    const options = (plugin as unknown as { options?: { intents?: number } }).options;

    expect((options?.intents ?? 0) & GatewayIntents.GuildVoiceStates).toBe(
      GatewayIntents.GuildVoiceStates,
    );
  });

  it("leaves autoInteractions disabled so OpenClaw owns interaction handoff", () => {
    const plugin = createPlugin();

    expect(
      (
        plugin as unknown as {
          options?: {
            autoInteractions: boolean;
            intents: number;
            reconnect: { maxAttempts: number };
          };
        }
      ).options,
    ).toEqual({
      autoInteractions: false,
      intents:
        GatewayIntents.Guilds |
        GatewayIntents.GuildExpressions |
        GatewayIntents.GuildMessages |
        GatewayIntents.MessageContent |
        GatewayIntents.DirectMessages |
        GatewayIntents.GuildMessageReactions |
        GatewayIntents.DirectMessageReactions,
      reconnect: { maxAttempts: 50 },
    });
  });

  it("uses loopback WS without an HTTPS agent and enforces the configured origin", async () => {
    await initializeDiscordProviderEndpointForTest({
      restApiBaseUrl: "http://127.0.0.1:43123/rest/v10",
      gatewayBotUrl: "http://127.0.0.1:43123/gateway-metadata",
      gatewayOrigin: "ws://127.0.0.1:43124",
    });
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const constructorSpy = vi.fn();
    const plugin = createPlugin({
      webSocketCtor: function WebSocketCtor(url: unknown, options: unknown) {
        constructorSpy(url, options);
        return socket;
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
      >["webSocketCtor"],
    });

    (plugin as unknown as { createWebSocket: (url: string) => typeof socket }).createWebSocket(
      "ws://127.0.0.1:43124/socket?v=10&encoding=json",
    );

    expect(constructorSpy).toHaveBeenCalledWith(
      "ws://127.0.0.1:43124/socket?v=10&encoding=json",
      expect.not.objectContaining({ agent: expect.anything() }),
    );
    expect(() =>
      (plugin as unknown as { createWebSocket: (url: string) => typeof socket }).createWebSocket(
        "ws://127.0.0.1:43125/socket?v=10&encoding=json",
      ),
    ).toThrow(/outside the configured WebSocket origin/);
  });

  it("uses a pinned DNS lookup for a remote provider WSS origin", async () => {
    await initializeDiscordProviderEndpointForTest({
      restApiBaseUrl: "http://127.0.0.1:43123/rest/v10",
      gatewayBotUrl: "http://127.0.0.1:43123/gateway-metadata",
      gatewayOrigin: "wss://provider.example",
    });
    const pinnedLookup = vi.fn(
      (_hostname: string, _options: unknown, callback: (error: null, value: string) => void) =>
        callback(null, "10.0.0.8"),
    );
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "provider.example",
      addresses: ["10.0.0.8"],
      lookup: pinnedLookup,
    });
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const constructorSpy = vi.fn();
    const plugin = createPlugin({
      webSocketCtor: function WebSocketCtor(url: unknown, options: unknown) {
        constructorSpy(url, options);
        return socket;
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
      >["webSocketCtor"],
    });

    (plugin as unknown as { createWebSocket: (url: string) => typeof socket }).createWebSocket(
      "wss://provider.example/socket?v=10&encoding=json",
    );

    const options = constructorSpy.mock.calls[0]?.[1] as
      | { agent?: { options?: { lookup?: import("node:net").LookupFunction } } }
      | undefined;
    const lookup = options?.agent?.options?.lookup;
    if (!lookup) {
      throw new Error("expected provider Gateway HTTPS agent lookup");
    }
    const address = await new Promise<string>((resolve, reject) => {
      lookup("provider.example", {}, (error, value) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof value !== "string") {
          reject(new Error("expected scalar provider Gateway lookup address"));
          return;
        }
        resolve(value);
      });
    });

    expect(address).toBe("10.0.0.8");
    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("provider.example", {
      policy: {
        allowedHostnames: ["provider.example"],
        hostnameAllowlist: ["provider.example"],
      },
    });
    expect(pinnedLookup).toHaveBeenCalledWith("provider.example", {}, expect.any(Function));
    expect(constructorSpy).toHaveBeenCalledWith(
      "wss://provider.example/socket?v=10&encoding=json",
      expect.objectContaining({ agent: expect.anything() }),
    );
  });

  it("does not fall back to live Discord when custom Gateway metadata fails", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("provider unavailable");
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("expected loopback TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
    await initializeDiscordProviderEndpointForTest({
      restApiBaseUrl: `http://127.0.0.1:${port}/rest/v10`,
      gatewayBotUrl: `http://127.0.0.1:${port}/metadata`,
      gatewayOrigin: `ws://127.0.0.1:${port}`,
    });
    const registerClient = vi.fn(async () => undefined);
    const plugin = createPlugin({ registerClient });

    try {
      await expect(
        (
          plugin as unknown as {
            registerClient: (client: { options: { token: string } }) => Promise<void>;
          }
        ).registerClient({ options: { token: "test-token" } }),
      ).rejects.toThrow(/Failed to get gateway information from Discord/);
      expect(registerClient).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("emits transport activity for current gateway socket messages", () => {
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const plugin = createPlugin({
      webSocketCtor: function WebSocketCtor() {
        return socket;
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
      >["webSocketCtor"],
    });
    const activitySpy = vi.fn();
    (
      plugin as unknown as {
        emitter: { on: (event: string, listener: (value: unknown) => void) => void };
      }
    ).emitter.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, activitySpy);

    const createdSocket = (
      plugin as unknown as { createWebSocket: (url: string) => typeof socket }
    ).createWebSocket("wss://gateway.discord.gg");
    (plugin as unknown as { ws: unknown }).ws = createdSocket;

    try {
      createdSocket.emit("message", Buffer.from("{}"));

      expect(activitySpy).toHaveBeenCalledWith({ at: 1_700_000_000_000 });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("ignores messages from stale gateway sockets", () => {
    const staleSocket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const currentSocket = new EventEmitter();
    const plugin = createPlugin({
      webSocketCtor: function WebSocketCtor() {
        return staleSocket;
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
      >["webSocketCtor"],
    });
    const activitySpy = vi.fn();
    (
      plugin as unknown as {
        emitter: { on: (event: string, listener: (value: unknown) => void) => void };
      }
    ).emitter.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, activitySpy);

    const createdSocket = (
      plugin as unknown as { createWebSocket: (url: string) => typeof staleSocket }
    ).createWebSocket("wss://gateway.discord.gg");
    expect(createdSocket).toBe(staleSocket);
    (plugin as unknown as { ws: unknown }).ws = currentSocket;

    staleSocket.emit("message", Buffer.from("{}"));

    expect(activitySpy).not.toHaveBeenCalled();
  });

  it("logs Discord gateway websocket error and abnormal close details", () => {
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const plugin = createPlugin(
      {
        webSocketCtor: function WebSocketCtor() {
          return socket;
        } as unknown as NonNullable<
          Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
        >["webSocketCtor"],
      },
      {},
      runtime,
    );
    const createdSocket = (
      plugin as unknown as { createWebSocket: (url: string) => typeof socket }
    ).createWebSocket("wss://gateway.discord.gg");
    const receiverLimitError = Object.assign(new Error("Too many buffered parts"), {
      code: "WS_ERR_TOO_MANY_BUFFERED_PARTS",
    });

    createdSocket.emit("error", receiverLimitError);
    createdSocket.emit("close", 1008, Buffer.from("policy violation"));

    const logs = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("discord: gateway websocket error");
    expect(logs).toContain("code=WS_ERR_TOO_MANY_BUFFERED_PARTS");
    expect(logs).toContain("discord: gateway websocket closed");
    expect(logs).toContain("code=1008");
    expect(logs).toContain("reason=policy violation");
    expect(logs).toContain("lastErrorCode=WS_ERR_TOO_MANY_BUFFERED_PARTS");
    expect(logs).toContain("hint=possible ws receiver buffered-parts limit");
  });

  it("keeps gateway close reason logs UTF-16 safe", () => {
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const plugin = createPlugin(
      {
        webSocketCtor: function WebSocketCtor() {
          return socket;
        } as unknown as NonNullable<
          Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
        >["webSocketCtor"],
      },
      {},
      runtime,
    );
    const createdSocket = (
      plugin as unknown as { createWebSocket: (url: string) => typeof socket }
    ).createWebSocket("wss://gateway.discord.gg");

    createdSocket.emit("close", 1008, Buffer.from(`${"A".repeat(239)}🧪 tail`));

    const log = String(runtime.log.mock.calls.at(-1)?.[0]);
    expect(log).toContain("discord: gateway websocket closed");
    expect(log).toContain("code=1008");
    expect(log).toContain(`reason=${"A".repeat(239)}...`);
    expect(log).toContain("hint=possible ws receiver buffered-parts limit");
  });
});
