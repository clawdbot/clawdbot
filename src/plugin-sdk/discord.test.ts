import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { MessageReceipt } from "./channel-outbound.js";
/**
 * Tests Discord SDK helpers and Discord-facing compatibility behavior.
 */
import type {
  DiscordComponentSendOpts,
  DiscordComponentSendResult,
  OpenClawConfig,
} from "./discord.js";

const mocks = vi.hoisted(() => {
  const runtimeConfig = { channels: { discord: { token: "token" } } };
  const componentEditResult = {
    channelId: "channel",
    messageId: "message",
    receipt: {
      parts: [
        {
          index: 0,
          kind: "card",
          platformMessageId: "message",
          raw: { channel: "discord", channelId: "channel", messageId: "message" },
        },
      ],
      platformMessageIds: ["message"],
      primaryPlatformMessageId: "message",
      raw: [{ channel: "discord", channelId: "channel", messageId: "message" }],
      sentAt: 0,
    },
  };
  const apiModule = {
    buildDiscordComponentMessage: vi.fn((params: { spec: { text?: string } }) => ({
      components: [],
      text: params.spec.text ?? "",
    })),
    collectDiscordStatusIssues: vi.fn(() => []),
    discordOnboardingAdapter: { kind: "discord-onboarding" },
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
    editDiscordComponentMessage: vi.fn(async () => componentEditResult),
    listThreadBindingsBySessionKey: vi.fn(() => []),
    registerBuiltDiscordComponentMessage: vi.fn(),
    unbindThreadBindingsBySessionKey: vi.fn(() => []),
  };

  return {
    apiModule,
    componentEditResult,
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

describe("discord plugin-sdk facade", () => {
  it("exports the @openclaw/discord 2026.3.13 import surface", async () => {
    const discordSdk = await import("./discord.js");

    for (const exportName of [
      "DEFAULT_ACCOUNT_ID",
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

  it("forwards Discord component helpers through the facade", async () => {
    const {
      buildDiscordComponentMessage,
      editDiscordComponentMessage,
      registerBuiltDiscordComponentMessage,
    } = await import("./discord.js");

    const built = buildDiscordComponentMessage({ spec: { text: "hello" } });
    const editResult = await editDiscordComponentMessage(
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
    expect(editResult).toEqual(mocks.componentEditResult);
    expect(mocks.runtimeModule.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: built,
      messageId: "message",
    });
  });

  it("types Discord component edit options and normalized result", () => {
    type IsCfgOptional = object extends Pick<DiscordComponentSendOpts, "cfg"> ? true : false;

    expectTypeOf<IsCfgOptional>().toEqualTypeOf<false>();
    expectTypeOf<DiscordComponentSendOpts["cfg"]>().toEqualTypeOf<OpenClawConfig>();
    expectTypeOf<DiscordComponentSendResult>().toEqualTypeOf<{
      messageId: string;
      channelId: string;
      receipt: MessageReceipt;
    }>();
    expectTypeOf<keyof DiscordComponentSendResult>().toEqualTypeOf<
      "messageId" | "channelId" | "receipt"
    >();
  });

  it("fills runtime config for Discord subagent auto-bind calls without cfg", async () => {
    const { autoBindSpawnedDiscordSubagent } = await import("./discord.js");

    const binding = await autoBindSpawnedDiscordSubagent({
      agentId: "agent",
      channel: "discord",
      childSessionKey: "child",
    });

    expect(mocks.runtimeModule.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    const callParams = mocks.runtimeModule.autoBindSpawnedDiscordSubagent.mock.calls[0]?.[0];
    expect(callParams.agentId).toBe("agent");
    expect(callParams.cfg).toBe(mocks.runtimeConfig);
    expect(callParams.childSessionKey).toBe("child");
    if (!binding) {
      throw new Error("expected Discord subagent binding");
    }
    expect(binding.cfg).toBe(mocks.runtimeConfig);
    expect(binding.targetKind).toBe("subagent");
    expect(binding.targetSessionKey).toBe("child");
  });
});
