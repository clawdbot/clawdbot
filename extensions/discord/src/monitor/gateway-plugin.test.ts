import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";

const { baseConnectSpy, GatewayIntents, GatewayPlugin } = vi.hoisted(() => {
  const baseConnectSpy = vi.fn<(resume: boolean) => void>();

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
    heartbeatInterval: ReturnType<typeof setInterval> | undefined = undefined;
    firstHeartbeatTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
    isConnecting: boolean = false;
    ws?: unknown;

    constructor(options?: unknown) {
      this.options = options;
    }

    async registerClient(_client: unknown): Promise<void> {}

    connect(resume = false): void {
      baseConnectSpy(resume);
    }
  }

  return { baseConnectSpy, GatewayIntents, GatewayPlugin };
});

vi.mock("@buape/carbon/gateway", () => ({ GatewayIntents, GatewayPlugin }));

vi.mock("@buape/carbon/dist/src/plugins/gateway/index.js", () => ({
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

describe("SafeGatewayPlugin.connect()", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;
  let resolveDiscordGatewayIntents: typeof import("./gateway-plugin.js").resolveDiscordGatewayIntents;
  let resolveDiscordGatewayInfoTimeoutMs: typeof import("./gateway-plugin.js").resolveDiscordGatewayInfoTimeoutMs;

  beforeAll(async () => {
    ({
      createDiscordGatewayPlugin,
      resolveDiscordGatewayIntents,
      resolveDiscordGatewayInfoTimeoutMs,
    } = await import("./gateway-plugin.js"));
  });

  beforeEach(() => {
    baseConnectSpy.mockClear();
  });

  it("includes GuildVoiceStates when voice is enabled by default", () => {
    expect(resolveDiscordGatewayIntents() & GatewayIntents.GuildVoiceStates).toBe(
      GatewayIntents.GuildVoiceStates,
    );
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

  it("keeps the legacy intents-config argument shape working", () => {
    const intents = resolveDiscordGatewayIntents({ presence: true, guildMembers: true });

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

  it("includes GuildVoiceStates when voice is enabled by default", () => {
    expect(resolveDiscordGatewayIntents() & GatewayIntents.GuildVoiceStates).toBe(
      GatewayIntents.GuildVoiceStates,
    );
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

  it("keeps the legacy intents-config argument shape working", () => {
    const intents = resolveDiscordGatewayIntents({ presence: true, guildMembers: true });

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

  it("omits voice states when Discord voice is disabled in account config", () => {
    const plugin = createPlugin(undefined, { voice: { enabled: false } });
    const options = (plugin as unknown as { options?: { intents?: number } }).options;

    expect((options?.intents ?? 0) & GatewayIntents.GuildVoiceStates).toBe(0);
  });

  it("clears stale heartbeatInterval before delegating to super when isConnecting=true", () => {
    const plugin = createPlugin();

    const staleInterval = setInterval(() => {}, 99_999);
    try {
      plugin.heartbeatInterval = staleInterval;

      // isConnecting is private on GatewayPlugin — cast required.
      (plugin as unknown as { isConnecting: boolean }).isConnecting = true;

      plugin.connect(false);

      expect(plugin.heartbeatInterval).toBeUndefined();
      expect(baseConnectSpy).toHaveBeenCalledWith(false);
    } finally {
      clearInterval(staleInterval);
    }
  });

  it("leaves Carbon autoInteractions disabled so OpenClaw owns interaction handoff", () => {
    const plugin = createPlugin();

    expect((plugin as unknown as { options?: { autoInteractions?: boolean } }).options).toEqual(
      expect.objectContaining({ autoInteractions: false }),
    );
  });

  it("keeps OpenClaw metadata timeout out of Carbon gateway options", () => {
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

  it("clears stale firstHeartbeatTimeout before delegating to super when isConnecting=true", () => {
    const plugin = createPlugin();

    const staleTimeout = setTimeout(() => {}, 99_999);
    try {
      plugin.firstHeartbeatTimeout = staleTimeout;

      // isConnecting is private on GatewayPlugin — cast required.
      (plugin as unknown as { isConnecting: boolean }).isConnecting = true;

      plugin.connect(false);

      expect(plugin.firstHeartbeatTimeout).toBeUndefined();
      expect(baseConnectSpy).toHaveBeenCalledWith(false);
    } finally {
      clearTimeout(staleTimeout);
    }
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
