import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";

const { GatewayIntents, GatewayPlugin } = vi.hoisted(() => {
  const GatewayIntents = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 1,
    MessageContent: 1 << 2,
    DirectMessages: 1 << 3,
    GuildMessageReactions: 1 << 4,
    DirectMessageReactions: 1 << 5,
    GuildPresences: 1 << 6,
    GuildMembers: 1 << 7,
    GuildVoiceStates: 1 << 8,
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

  class GatewayPlugin {
    options: unknown;
    gatewayInfo: unknown;
    emitter = new TestEmitter();
    isConnecting: boolean = false;
    heartbeatInterval?: NodeJS.Timeout;
    firstHeartbeatTimeout?: NodeJS.Timeout;
    ws?: unknown;

    constructor(options?: unknown) {
      this.options = options;
    }

    async registerClient(_client: unknown): Promise<void> {}

    connect(_resume = false): void {
      if (this.isConnecting) {
        return;
      }
    }
  }

  return { GatewayIntents, GatewayPlugin };
});

vi.mock("../internal/gateway.js", () => ({
  GatewayIntents,
  GatewayPlugin,
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  captureHttpExchange: vi.fn(),
  captureWsEvent: vi.fn(),
  resolveEffectiveDebugProxyUrl: () => undefined,
  resolveDebugProxySettings: () => ({ enabled: false }),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (value: string) => value,
}));

describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;
  let parseDiscordGatewayInfoBody: typeof import("./gateway-plugin.js").parseDiscordGatewayInfoBody;
  let resolveDiscordGatewayIntents: typeof import("./gateway-plugin.js").resolveDiscordGatewayIntents;
  let resolveDiscordGatewayInfoTimeoutMs: typeof import("./gateway-plugin.js").resolveDiscordGatewayInfoTimeoutMs;

  beforeAll(async () => {
    ({
      createDiscordGatewayPlugin,
      parseDiscordGatewayInfoBody,
      resolveDiscordGatewayIntents,
      resolveDiscordGatewayInfoTimeoutMs,
    } = await import("./gateway-plugin.js"));
  });

  function createPlugin(
    testing?: NonNullable<Parameters<typeof createDiscordGatewayPlugin>[0]["__testing"]>,
    discordConfig: Parameters<typeof createDiscordGatewayPlugin>[0]["discordConfig"] = {},
  ) {
    return createDiscordGatewayPlugin({
      discordConfig,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      ...(testing ? { __testing: testing } : {}),
    });
  }

  it("omits GuildVoiceStates by default for text-only Discord configs", () => {
    expect(resolveDiscordGatewayIntents() & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("includes GuildVoiceStates when voice is enabled", () => {
    const intents = resolveDiscordGatewayIntents({ voiceEnabled: true });

    expect(intents & GatewayIntents.GuildVoiceStates).toBe(GatewayIntents.GuildVoiceStates);
  });

  it("omits GuildVoiceStates when voice is disabled", () => {
    const intents = resolveDiscordGatewayIntents({ voiceEnabled: false });

    expect(intents & GatewayIntents.GuildVoiceStates).toBe(0);
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

  it("resolves gateway metadata timeout from config, env, then default", () => {
    expect(resolveDiscordGatewayInfoTimeoutMs({ configuredTimeoutMs: 45_000 })).toBe(45_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "25000" },
      }),
    ).toBe(25_000);
    expect(resolveDiscordGatewayInfoTimeoutMs({ env: {} })).toBe(30_000);
  });

  it("parses valid Discord gateway metadata", () => {
    expect(
      parseDiscordGatewayInfoBody(
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
    ).toEqual({
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

  it("rejects malformed Discord gateway metadata", () => {
    expect(() =>
      parseDiscordGatewayInfoBody(
        JSON.stringify({
          url: "",
          shards: 0,
          session_start_limit: {
            total: 1000,
            remaining: 999,
            reset_after: 0,
            max_concurrency: 1,
          },
        }),
      ),
    ).toThrow(/url|shards/);
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

    expect((plugin as unknown as { options?: { autoInteractions?: boolean } }).options).toEqual(
      expect.objectContaining({ autoInteractions: false }),
    );
  });

  it("keeps OpenClaw metadata timeout out of gateway options", () => {
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { gatewayInfoTimeoutMs: 5_000 },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    expect(
      (plugin as unknown as { options?: { gatewayInfoTimeoutMs?: number } }).options
        ?.gatewayInfoTimeoutMs,
    ).toBeUndefined();
  });

  it("emits transport activity for current gateway socket messages", () => {
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const plugin = createPlugin({
      webSocketCtor: function WebSocketCtor() {
        return socket;
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["__testing"]
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

    createdSocket.emit("message", Buffer.from("{}"));

    expect(activitySpy).toHaveBeenCalledWith({ at: expect.any(Number) });
  });

  it("ignores messages from stale gateway sockets", () => {
    const staleSocket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const currentSocket = new EventEmitter();
    const plugin = createPlugin({
      webSocketCtor: function WebSocketCtor() {
        return staleSocket;
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["__testing"]
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
});
