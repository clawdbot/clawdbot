import { ChannelType } from "discord-api-types/v10";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { peekSystemEvents, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ButtonInteraction,
  ComponentData,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import {
  enqueueSystemEventMock,
  readAllowFromStoreMock,
  resetDiscordComponentRuntimeMocks,
  upsertPairingRequestMock,
} from "../test-support/component-runtime.js";
import { resolveComponentInteractionContext } from "./agent-components-helpers.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  resolveDiscordComponentOriginatingTo,
} from "./agent-components.js";

describe("agent components", () => {
  const defaultDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "direct", id: "123456789" },
  });
  const defaultGroupDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "group", id: "group-dm-channel" },
  });

  const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;
  const createBaseDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { channel_id: "dm-channel" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides,
    };
    return { interaction, defer, reply };
  };

  const createDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      interaction: interaction as unknown as ButtonInteraction,
      defer,
      reply,
    };
  };

  const createDmSelectInteraction = (overrides: Partial<StringSelectMenuInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction({
      values: ["alpha"],
      ...(overrides as Record<string, unknown>),
    });
    return {
      interaction: interaction as unknown as StringSelectMenuInteraction,
      defer,
      reply,
    };
  };

  const createBaseGroupDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { channel_id: "group-dm-channel" },
      channel: {
        id: "group-dm-channel",
        type: ChannelType.GroupDM,
        name: "incident-room",
      },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides,
    };
    return { interaction, defer, reply };
  };

  const createGroupDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseGroupDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      interaction: interaction as unknown as ButtonInteraction,
      defer,
      reply,
    };
  };

  async function expectSuccessfulDmButtonInteraction(params: {
    dmPolicy: "pairing" | "open";
    expectPairingStoreRead: boolean;
    allowFrom?: string[];
  }) {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello:123456789",
        trusted: false,
      },
    );
    if (params.expectPairingStoreRead) {
      expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
    } else {
      expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    resetDiscordComponentRuntimeMocks();
    resetSystemEventsForTest();
  });

  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    const pairingText = String(reply.mock.calls[0]?.[0]?.content ?? "");
    const code = expectPairingReplyText(pairingText, {
      channel: "discord",
      idLine: "Your Discord user id: 123456789",
    });
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it("blocks DM interactions in allowlist mode when sender is not in configured allowFrom", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("classifies Group DM component interactions separately from direct messages", async () => {
    const { interaction, defer } = createGroupDmButtonInteraction();

    const ctx = await resolveComponentInteractionContext({
      interaction,
      label: "group-dm-test",
      defer: false,
    });

    expect(defer).not.toHaveBeenCalled();
    expect(ctx).toEqual({
      channelId: "group-dm-channel",
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      username: "Alice#1234",
      userId: "123456789",
      replyOpts: { ephemeral: true },
      isDirectMessage: false,
      isGroupDm: true,
      memberRoleIds: [],
      rawGuildId: undefined,
    });
  });

  it("blocks Group DM interactions that are not allowlisted even when dmPolicy is open", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "open",
      discordConfig: {
        dm: {
          groupEnabled: true,
          groupChannels: ["other-group-dm"],
        },
      } as DiscordAccountConfig,
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultGroupDmSessionKey)).toStrictEqual([]);
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("routes allowlisted Group DM interactions to the group session without applying DM policy", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
      discordConfig: {
        dm: {
          groupEnabled: true,
          groupChannels: ["group-dm-channel"],
        },
      } as DiscordAccountConfig,
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultGroupDmSessionKey,
        contextKey: "discord:agent-button:group-dm-channel:hello:123456789",
        trusted: false,
      },
    );
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("authorizes DM interactions from pairing-store entries in pairing mode", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    await expectSuccessfulDmButtonInteraction({
      dmPolicy: "pairing",
      expectPairingStoreRead: true,
    });
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("allows DM component interactions in open mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    await expectSuccessfulDmButtonInteraction({
      dmPolicy: "open",
      expectPairingStoreRead: false,
      allowFrom: ["*"],
    });
  });

  it("uses user conversation ids for direct-message component originating targets", () => {
    expect(
      resolveDiscordComponentOriginatingTo({
        isDirectMessage: true,
        userId: "123456789",
        channelId: "dm-channel",
      }),
    ).toBe("user:123456789");
    expect(
      resolveDiscordComponentOriginatingTo({
        isDirectMessage: false,
        userId: "123456789",
        channelId: "guild-channel",
      }),
    ).toBe("channel:guild-channel");
  });

  it("blocks DM component interactions in disabled mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "DM interactions are disabled.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"],
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-select:dm-channel:hello:123456789",
        trusted: false,
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("accepts cid payloads for agent button interactions", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello_cid" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello_cid clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello_cid:123456789",
        trusted: false,
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("keeps malformed percent cid values without throwing", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello%2G" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello%2G clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello%2G:123456789",
        trusted: false,
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
