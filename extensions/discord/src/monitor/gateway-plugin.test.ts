import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  } as const;

  class GatewayPlugin {
    options: unknown;
    gatewayInfo: unknown;
    heartbeatInterval: ReturnType<typeof setInterval> | undefined = undefined;
    firstHeartbeatTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
    isConnecting: boolean = false;

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

  beforeAll(async () => {
    ({ createDiscordGatewayPlugin } = await import("./gateway-plugin.js"));
  });

  beforeEach(() => {
    baseConnectSpy.mockClear();
  });

  function createPlugin() {
    return createDiscordGatewayPlugin({
      discordConfig: {},
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
  }

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
});
