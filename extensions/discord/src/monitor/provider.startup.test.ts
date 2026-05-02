import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, Plugin } from "../internal/discord.js";

const { registerVoiceClientSpy, waitForDiscordGatewayPluginRegistrationMock } = vi.hoisted(() => ({
  registerVoiceClientSpy: vi.fn(),
  waitForDiscordGatewayPluginRegistrationMock: vi.fn(),
}));

vi.mock("../internal/voice.js", () => ({
  VoicePlugin: class VoicePlugin {
    id = "voice";

    registerClient(client: {
      getPlugin: (id: string) => unknown;
      registerListener: (listener: object) => object;
      unregisterListener: (listener: object) => boolean;
    }) {
      registerVoiceClientSpy(client);
      if (!client.getPlugin("gateway")) {
        throw new Error("gateway plugin missing");
      }
      client.registerListener({ type: "voice-listener" });
    }
  },
}));

vi.mock("openclaw/plugin-sdk/dangerous-name-runtime", () => ({
  isDangerousNameMatchingEnabled: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalString: (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  },
}));

vi.mock("../proxy-request-client.js", () => ({
  DISCORD_REST_TIMEOUT_MS: 15_000,
  createDiscordRequestClient: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: vi.fn(),
}));

vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: vi.fn(),
  waitForDiscordGatewayPluginRegistration: waitForDiscordGatewayPluginRegistrationMock,
}));

vi.mock("./gateway-supervisor.js", () => ({
  createDiscordGatewaySupervisor: vi.fn(),
}));

vi.mock("./listeners.js", () => ({
  DiscordMessageListener: function DiscordMessageListener() {
    return { type: "message" };
  },
  DiscordInteractionListener: function DiscordInteractionListener() {
    return { type: "interaction" };
  },
  DiscordPresenceListener: function DiscordPresenceListener() {
    return { type: "presence" };
  },
  DiscordReactionListener: function DiscordReactionListener() {
    return { type: "reaction-add" };
  },
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {
    return { type: "reaction-remove" };
  },
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {
    return { type: "thread-update" };
  },
  registerDiscordListener: vi.fn(),
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: vi.fn(() => undefined),
}));

import { createDiscordRequestClient, DISCORD_REST_TIMEOUT_MS } from "../proxy-request-client.js";
import { registerDiscordListener } from "./listeners.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";

describe("createDiscordMonitorClient", () => {
  beforeEach(() => {
    registerVoiceClientSpy.mockReset();
    waitForDiscordGatewayPluginRegistrationMock.mockReset().mockReturnValue(undefined);
    vi.mocked(createDiscordRequestClient).mockClear();
    vi.mocked(registerDiscordListener).mockClear();
  });

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  function createClientWithPlugins(
    _options: ConstructorParameters<typeof import("../internal/discord.js").Client>[0],
    handlers: ConstructorParameters<typeof import("../internal/discord.js").Client>[1],
    plugins: Plugin[] = [],
  ) {
    const pluginRegistry = plugins.map((plugin) => ({ id: plugin.id, plugin }));
    const listeners = [...(handlers.listeners ?? [])];
    return {
      listeners,
      plugins: pluginRegistry,
      registerListener: (listener: never) => {
        listeners.push(listener);
        return listener;
      },
      unregisterListener: (listener: never) => {
        const index = listeners.indexOf(listener);
        if (index < 0) {
          return false;
        }
        listeners.splice(index, 1);
        return true;
      },
      getPlugin: (id: string) => pluginRegistry.find((entry) => entry.id === id)?.plugin,
    } as unknown as Client;
  }

  function createAutoPresenceController() {
    return {
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      runNow: vi.fn(),
    };
  }

  it("registers voice plugin listeners after gateway setup", async () => {
    const gatewayPlugin = {
      id: "gateway",
      registerClient: vi.fn(),
      registerRoutes: vi.fn(),
    } as Plugin;

    const result = await createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: true,
      discordConfig: {},
      runtime: createRuntime(),
      createClient: createClientWithPlugins,
      createGatewayPlugin: () => gatewayPlugin as never,
      createGatewaySupervisor: () => ({ shutdown: vi.fn(), handleError: vi.fn() }) as never,
      createAutoPresenceController: () => createAutoPresenceController() as never,
      isDisallowedIntentsError: () => false,
    });

    expect(registerVoiceClientSpy).toHaveBeenCalledTimes(1);
    expect(result.client.listeners).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "voice-listener" })]),
    );
  });

  it("waits for gateway registration before creating the supervisor", async () => {
    const gatewayPlugin = { id: "gateway" } as Plugin;
    let resolveRegistration: (() => void) | undefined;
    const registration = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    waitForDiscordGatewayPluginRegistrationMock.mockReturnValue(registration);
    const gatewaySupervisor = { shutdown: vi.fn(), handleError: vi.fn() };
    const createGatewaySupervisor = vi.fn(() => gatewaySupervisor);

    const resultPromise = createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: false,
      discordConfig: {},
      runtime: createRuntime(),
      createClient: createClientWithPlugins,
      createGatewayPlugin: () => gatewayPlugin as never,
      createGatewaySupervisor: createGatewaySupervisor as never,
      createAutoPresenceController: () => createAutoPresenceController() as never,
      isDisallowedIntentsError: () => false,
    });
    await Promise.resolve();

    expect(waitForDiscordGatewayPluginRegistrationMock).toHaveBeenCalledWith(gatewayPlugin);
    expect(createGatewaySupervisor).not.toHaveBeenCalled();

    resolveRegistration?.();
    const result = await resultPromise;

    expect(createGatewaySupervisor).toHaveBeenCalledTimes(1);
    expect(result.gatewaySupervisor).toBe(gatewaySupervisor);
  });

  it("configures internal Discord REST options explicitly", async () => {
    const createClient = vi.fn(createClientWithPlugins);

    await createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: false,
      discordConfig: {},
      runtime: createRuntime(),
      createClient,
      createGatewayPlugin: () => ({ id: "gateway" }) as never,
      createGatewaySupervisor: () => ({ shutdown: vi.fn(), handleError: vi.fn() }) as never,
      createAutoPresenceController: () => createAutoPresenceController() as never,
      isDisallowedIntentsError: () => false,
    });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        requestOptions: {
          timeout: DISCORD_REST_TIMEOUT_MS,
          runtimeProfile: "persistent",
          maxQueueSize: 1000,
        },
      }),
      expect.any(Object),
      expect.any(Array),
    );
  });

  it("passes REST timeout options to proxied Discord fetch", async () => {
    const proxyFetch = vi.fn();

    await createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      proxyFetch,
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: false,
      discordConfig: {},
      runtime: createRuntime(),
      createClient: createClientWithPlugins,
      createGatewayPlugin: () => ({ id: "gateway" }) as never,
      createGatewaySupervisor: () => ({ shutdown: vi.fn(), handleError: vi.fn() }) as never,
      createAutoPresenceController: () => createAutoPresenceController() as never,
      isDisallowedIntentsError: () => false,
    });

    expect(createDiscordRequestClient).toHaveBeenCalledWith("token-1", {
      fetch: proxyFetch,
      timeout: DISCORD_REST_TIMEOUT_MS,
      runtimeProfile: "persistent",
      maxQueueSize: 1000,
    });
  });

  it("propagates gateway registration failures before supervisor startup", async () => {
    const gatewayPlugin = { id: "gateway" } as Plugin;
    const createGatewaySupervisor = vi.fn();
    const createAutoPresenceControllerForTest = vi.fn(createAutoPresenceController);
    waitForDiscordGatewayPluginRegistrationMock.mockReturnValue(
      Promise.reject(new Error("gateway metadata denied")),
    );

    await expect(
      createDiscordMonitorClient({
        accountId: "default",
        applicationId: "app-1",
        token: "token-1",
        commands: [],
        components: [],
        modals: [],
        voiceEnabled: false,
        discordConfig: {},
        runtime: createRuntime(),
        createClient: createClientWithPlugins,
        createGatewayPlugin: () => gatewayPlugin as never,
        createGatewaySupervisor: createGatewaySupervisor as never,
        createAutoPresenceController: createAutoPresenceControllerForTest as never,
        isDisallowedIntentsError: () => false,
      }),
    ).rejects.toThrow("gateway metadata denied");

    expect(createGatewaySupervisor).not.toHaveBeenCalled();
    expect(createAutoPresenceControllerForTest).not.toHaveBeenCalled();
  });
});

describe("registerDiscordMonitorListeners", () => {
  beforeEach(() => {
    vi.mocked(registerDiscordListener).mockClear();
  });

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  function createListenerParams(
    overrides: Partial<Parameters<typeof registerDiscordMonitorListeners>[0]> = {},
  ): Parameters<typeof registerDiscordMonitorListeners>[0] {
    return {
      cfg: {},
      client: { listeners: [] },
      accountId: "default",
      discordConfig: {},
      runtime: createRuntime(),
      botUserId: "bot-1",
      dmEnabled: false,
      groupDmEnabled: false,
      groupDmChannels: [],
      dmPolicy: "disabled",
      allowFrom: [],
      groupPolicy: "allowlist",
      guildEntries: {
        "guild-1": {
          id: "guild-1",
          reactionNotifications: "off",
        },
      },
      logger: {},
      messageHandler: {},
      ...overrides,
    } as Parameters<typeof registerDiscordMonitorListeners>[0];
  }

  function registeredListenerTypes() {
    return vi.mocked(registerDiscordListener).mock.calls.map((call) => {
      const listener = call[1] as { type?: string };
      return listener.type;
    });
  }

  it("skips reaction listeners when every configured guild disables reactions and DMs are off", () => {
    registerDiscordMonitorListeners(createListenerParams());

    expect(registeredListenerTypes()).toEqual(["interaction", "message", "thread-update"]);
  });

  it("keeps reaction listeners when direct messages can emit reaction notifications", () => {
    registerDiscordMonitorListeners(
      createListenerParams({
        dmEnabled: true,
      }),
    );

    expect(registeredListenerTypes()).toContain("reaction-add");
    expect(registeredListenerTypes()).toContain("reaction-remove");
  });

  it("keeps reaction listeners when a configured guild enables reaction notifications", () => {
    registerDiscordMonitorListeners(
      createListenerParams({
        guildEntries: {
          "guild-1": {
            id: "guild-1",
            reactionNotifications: "off",
          },
          "guild-2": {
            id: "guild-2",
            reactionNotifications: "own",
          },
        },
      }),
    );

    expect(registeredListenerTypes()).toContain("reaction-add");
    expect(registeredListenerTypes()).toContain("reaction-remove");
  });
});

describe("fetchDiscordBotIdentity", () => {
  it("derives the bot id from a Discord bot token without calling /users/@me", async () => {
    const fetchUser = vi.fn(async () => {
      throw new Error("network should not be used");
    });
    const logStartupPhase = vi.fn();
    const botId = "1477179610322964541";

    await expect(
      fetchDiscordBotIdentity({
        client: { fetchUser } as never,
        token: `${Buffer.from(botId).toString("base64")}.GhIiP9.vU1xEpJ6NjFm`,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        logStartupPhase,
      }),
    ).resolves.toEqual({ botUserId: botId, botUserName: undefined });

    expect(fetchUser).not.toHaveBeenCalled();
    expect(logStartupPhase).toHaveBeenCalledWith(
      "fetch-bot-identity:done",
      `botUserId=${botId} botUserName=<missing> source=token`,
    );
  });
});
