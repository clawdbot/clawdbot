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
  DiscordMessageListener: function DiscordMessageListener() {},
  DiscordInteractionListener: function DiscordInteractionListener() {},
  DiscordPresenceListener: function DiscordPresenceListener() {},
  DiscordReactionListener: function DiscordReactionListener() {},
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {},
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: vi.fn(() => undefined),
}));

import { createDiscordRequestClient, DISCORD_REST_TIMEOUT_MS } from "../proxy-request-client.js";
import { createDiscordMonitorClient } from "./provider.startup.js";

describe("createDiscordMonitorClient", () => {
  beforeEach(() => {
    registerVoiceClientSpy.mockReset();
    waitForDiscordGatewayPluginRegistrationMock.mockReset().mockReturnValue(undefined);
    vi.mocked(createDiscordRequestClient).mockClear();
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
