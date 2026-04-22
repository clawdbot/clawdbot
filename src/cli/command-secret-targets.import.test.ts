import { beforeEach, describe, expect, it, vi } from "vitest";

describe("command secret targets module import", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not touch the registry during module import", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => {
      throw new Error("registry touched too early");
    });

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));

    const mod = await import("./command-secret-targets.js");

    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
    expect(mod.getModelsCommandSecretTargetIds().has("models.providers.*.apiKey")).toBe(true);
    expect(mod.getQrRemoteCommandSecretTargetIds().has("gateway.remote.token")).toBe(true);
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
    expect(() => mod.getChannelsCommandSecretTargetIds()).toThrow("registry touched too early");
    expect(listSecretTargetRegistryEntries).toHaveBeenCalledTimes(1);
  });

  it("loads registry lazily for agent runtime plugin credential targets", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => [
      { id: "plugins.entries.example.config.webSearch.apiKey" },
      { id: "plugins.entries.example.config.other.apiKey" },
      { id: "channels.telegram.botToken" },
    ]);

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));

    const mod = await import("./command-secret-targets.js");

    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
    const ids = mod.getAgentRuntimeCommandSecretTargetIds();
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.example.config.webSearch.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.example.config.other.apiKey")).toBe(false);
    expect(ids.has("channels.telegram.botToken")).toBe(false);
    expect(listSecretTargetRegistryEntries).toHaveBeenCalledTimes(1);
  });

  it("can resolve configured-channel status targets without the full registry", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => {
      throw new Error("registry touched too early");
    });
    const listReadOnlyChannelPluginsForConfig = vi.fn(() => [
      {
        id: "telegram",
        secrets: {
          secretTargetRegistryEntries: [
            {
              id: "channels.telegram.botToken",
              targetType: "channels.telegram.botToken",
              configFile: "openclaw.json",
              pathPattern: "channels.telegram.botToken",
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
            {
              id: "channels.telegram.gatewayToken",
              targetType: "gateway.auth.token",
              configFile: "openclaw.json",
              pathPattern: "gateway.auth.token",
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
            {
              id: "channels.telegram.gatewayTokenRef",
              targetType: "channels.telegram.gatewayTokenRef",
              configFile: "openclaw.json",
              pathPattern: "channels.telegram.gatewayToken",
              refPathPattern: "gateway.auth.token",
              secretShape: "sibling_ref",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
            {
              id: "channels.discord.token",
              targetType: "channels.discord.token",
              configFile: "openclaw.json",
              pathPattern: "channels.discord.token",
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
        },
      },
      {
        id: "external-chat",
        secrets: {
          secretTargetRegistryEntries: [
            {
              id: "channels.external-chat.token",
              targetType: "channels.external-chat.token",
              configFile: "openclaw.json",
              pathPattern: "channels.external-chat.token",
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
        },
      },
    ]);

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig,
    }));

    const mod = await import("./command-secret-targets.js");
    const targets = mod.getStatusCommandSecretTargetIds({
      channels: {
        "external-chat": { token: "configured" },
        telegram: { botToken: "123456:ABCDEF" },
      },
    });

    expect(targets.has("channels.external-chat.token")).toBe(true);
    expect(targets.has("channels.telegram.botToken")).toBe(true);
    expect(targets.has("channels.discord.token")).toBe(false);
    expect(targets.has("channels.telegram.gatewayToken")).toBe(false);
    expect(targets.has("channels.telegram.gatewayTokenRef")).toBe(false);
    expect(targets.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ includePersistedAuthState: false }),
    );
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
  });
});
