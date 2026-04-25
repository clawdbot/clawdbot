import type { Client, Plugin } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerVoiceClientSpy, waitForDiscordGatewayPluginRegistrationMock } = vi.hoisted(() => ({
  registerVoiceClientSpy: vi.fn(),
  waitForDiscordGatewayPluginRegistrationMock: vi.fn(),
}));

vi.mock("@buape/carbon/voice", () => ({
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
      client.registerListener({ type: "legacy-voice-listener" });
    }
  },
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
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
  createDiscordRequestClient: vi.fn(),
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
  DiscordPresenceListener: function DiscordPresenceListener() {},
  DiscordReactionListener: function DiscordReactionListener() {},
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {},
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: vi.fn(() => undefined),
}));

import { createDiscordMonitorClient } from "./provider.startup.js";

describe("createDiscordMonitorClient", () => {
  beforeEach(() => {
    registerVoiceClientSpy.mockReset();
    waitForDiscordGatewayPluginRegistrationMock.mockReset().mockReturnValue(undefined);
  });

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  function createClientWithPlugins(
    _options: ConstructorParameters<typeof import("@buape/carbon").Client>[0],
    handlers: ConstructorParameters<typeof import("@buape/carbon").Client>[1],
    plugins: Plugin[] = [],
  ) {
    const pluginRegistry = plugins.map((plugin) => ({ id: plugin.id, plugin }));
    return {
      listeners: [...(handlers.listeners ?? [])],
      plugins: pluginRegistry,
      getPlugin: (id: string) => pluginRegistry.find((entry) => entry.id === id)?.plugin,
    } as Client;
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

  it("adds listener compat for legacy voice plugins", async () => {
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
      expect.arrayContaining([expect.objectContaining({ type: "legacy-voice-listener" })]),
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
