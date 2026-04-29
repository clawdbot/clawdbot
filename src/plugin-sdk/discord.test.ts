import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runtimeConfig = { channels: { discord: { token: "token" } } };
  const apiModule = {
    buildDiscordComponentMessage: vi.fn((params: { spec: { text?: string } }) => ({
      components: [],
      text: params.spec.text ?? "",
    })),
    collectDiscordStatusIssues: vi.fn(() => []),
    discordOnboardingAdapter: { kind: "legacy-onboarding" },
    inspectDiscordAccount: vi.fn(() => ({ accountId: "default" })),
    listDiscordAccountIds: vi.fn(() => ["default"]),
    listDiscordDirectoryGroupsFromConfig: vi.fn(() => []),
    listDiscordDirectoryPeersFromConfig: vi.fn(() => []),
    looksLikeDiscordTargetId: vi.fn(() => true),
    normalizeDiscordMessagingTarget: vi.fn(() => "channel:123"),
    normalizeDiscordOutboundTarget: vi.fn(() => ({ ok: true, to: "channel:123" })),
    resolveDefaultDiscordAccountId: vi.fn(() => "default"),
    resolveDiscordAccount: vi.fn(() => ({
      accountId: "default",
      config: {},
      enabled: true,
      token: "token",
      tokenSource: "config",
    })),
    resolveDiscordGroupRequireMention: vi.fn(() => true),
    resolveDiscordGroupToolPolicy: vi.fn(() => undefined),
  };
  const runtimeModule = {
    autoBindSpawnedDiscordSubagent: vi.fn(async (params) => ({
      accountId: params.accountId ?? "default",
      channelId: "123",
      targetKind: "subagent",
      targetSessionKey: params.childSessionKey,
      threadId: "456",
      cfg: params.cfg,
    })),
    collectDiscordAuditChannelIds: vi.fn(() => ({ channelIds: [], unresolvedChannels: [] })),
    editDiscordComponentMessage: vi.fn(async () => ({ id: "message" })),
    listThreadBindingsBySessionKey: vi.fn(() => []),
    registerBuiltDiscordComponentMessage: vi.fn(),
    unbindThreadBindingsBySessionKey: vi.fn(() => []),
  };

  return {
    apiModule,
    runtimeModule,
    runtimeConfig,
    loadBundledPluginPublicSurfaceModuleSync: vi.fn((params: { artifactBasename: string }) => {
      if (params.artifactBasename === "runtime-api.js") {
        return runtimeModule;
      }
      return apiModule;
    }),
  };
});

vi.mock("./facade-loader.js", () => ({
  createLazyFacadeObjectValue: (load: () => object) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          return Reflect.get(load(), property);
        },
      },
    ),
  loadBundledPluginPublicSurfaceModuleSync: mocks.loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("./runtime-config-snapshot.js", () => ({
  getRuntimeConfig: () => mocks.runtimeConfig,
  getRuntimeConfigSnapshot: () => mocks.runtimeConfig,
}));

describe("discord plugin-sdk compatibility facade", () => {
  it("exports the @openclaw/discord 2026.3.13 import surface", async () => {
    const discordSdk = await import("./discord.js");

    for (const exportName of [
      "DEFAULT_ACCOUNT_ID",
      "DiscordConfigSchema",
      "PAIRING_APPROVED_MESSAGE",
      "applyAccountNameToChannelSection",
      "autoBindSpawnedDiscordSubagent",
      "buildDiscordComponentMessage",
      "buildChannelConfigSchema",
      "buildComputedAccountStatusSnapshot",
      "buildTokenChannelStatusSummary",
      "collectDiscordAuditChannelIds",
      "collectDiscordStatusIssues",
      "discordOnboardingAdapter",
      "emptyPluginConfigSchema",
      "getChatChannelMeta",
      "inspectDiscordAccount",
      "listDiscordAccountIds",
      "listDiscordDirectoryGroupsFromConfig",
      "listDiscordDirectoryPeersFromConfig",
      "listThreadBindingsBySessionKey",
      "looksLikeDiscordTargetId",
      "migrateBaseNameToDefaultAccount",
      "normalizeAccountId",
      "normalizeDiscordMessagingTarget",
      "normalizeDiscordOutboundTarget",
      "projectCredentialSnapshotFields",
      "editDiscordComponentMessage",
      "registerBuiltDiscordComponentMessage",
      "resolveConfiguredFromCredentialStatuses",
      "resolveDefaultDiscordAccountId",
      "resolveDiscordAccount",
      "resolveDiscordGroupRequireMention",
      "resolveDiscordGroupToolPolicy",
      "unbindThreadBindingsBySessionKey",
    ]) {
      expect(discordSdk).toHaveProperty(exportName);
    }
  });

  it("forwards Discord component helpers through the compatibility facade", async () => {
    const {
      buildDiscordComponentMessage,
      editDiscordComponentMessage,
      registerBuiltDiscordComponentMessage,
    } = await import("./discord.js");

    const built = buildDiscordComponentMessage({ spec: { text: "hello" } });
    await editDiscordComponentMessage(
      "channel",
      "message",
      { text: "edited" },
      { cfg: mocks.runtimeConfig },
    );
    registerBuiltDiscordComponentMessage({
      buildResult: built,
      messageId: "message",
    });

    expect(mocks.apiModule.buildDiscordComponentMessage).toHaveBeenCalledWith({
      spec: { text: "hello" },
    });
    expect(mocks.runtimeModule.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel",
      "message",
      { text: "edited" },
      { cfg: mocks.runtimeConfig },
    );
    expect(mocks.runtimeModule.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: built,
      messageId: "message",
    });
  });

  it("keeps legacy Discord subagent auto-bind calls working without cfg", async () => {
    const { autoBindSpawnedDiscordSubagent } = await import("./discord.js");

    const binding = await autoBindSpawnedDiscordSubagent({
      agentId: "agent",
      channel: "discord",
      childSessionKey: "child",
    });

    expect(mocks.runtimeModule.autoBindSpawnedDiscordSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent",
        cfg: mocks.runtimeConfig,
        childSessionKey: "child",
      }),
    );
    expect(binding).toEqual(
      expect.objectContaining({
        cfg: mocks.runtimeConfig,
        targetKind: "subagent",
        targetSessionKey: "child",
      }),
    );
  });
});
