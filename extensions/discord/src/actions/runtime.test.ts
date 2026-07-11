// Discord tests cover runtime plugin behavior.
import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPresences, setPresence } from "../monitor/presence-cache.js";
import { DiscordThreadInitialMessageError } from "../send.js";
import { discordGuildActionRuntime, handleDiscordGuildAction } from "./runtime.guild.js";
import { handleDiscordAction } from "./runtime.js";
import {
  discordMessagingActionRuntime,
  handleDiscordMessagingAction,
} from "./runtime.messaging.js";
import {
  discordModerationActionRuntime,
  handleDiscordModerationAction,
} from "./runtime.moderation.js";

const originalDiscordMessagingActionRuntime = { ...discordMessagingActionRuntime };
const originalDiscordGuildActionRuntime = { ...discordGuildActionRuntime };
const originalDiscordModerationActionRuntime = { ...discordModerationActionRuntime };

type DiscordChannelInfoTest = {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string;
};

const defaultFetchChannelInfoDiscord = async (
  channelId: string,
): Promise<DiscordChannelInfoTest> => ({
  id: channelId,
  type: ChannelType.GuildText,
  guild_id: "G1",
});

const discordSendMocks = {
  addRoleDiscord: vi.fn(async () => ({ ok: true })),
  banMemberDiscord: vi.fn(async () => ({})),
  canManageGuildRoleDiscord: vi.fn(async () => true),
  canManageGuildMemberRoleDiscord: vi.fn(async () => true),
  createChannelDiscord: vi.fn(async () => ({
    id: "new-channel",
    name: "test",
    type: 0,
  })),
  createScheduledEventDiscord: vi.fn(async () => ({ id: "event-1" })),
  createThreadDiscord: vi.fn(async () => ({})),
  deleteChannelDiscord: vi.fn(async () => ({ ok: true, channelId: "C1" })),
  deleteMessageDiscord: vi.fn(async () => ({})),
  editChannelDiscord: vi.fn(async () => ({
    id: "C1",
    name: "edited",
  })),
  editMessageDiscord: vi.fn(async () => ({})),
  fetchChannelInfoDiscord: vi.fn(defaultFetchChannelInfoDiscord),
  fetchChannelPermissionsDiscord: vi.fn(async () => ({})),
  fetchGuildInfoDiscord: vi.fn(async (guildId: string) => ({
    id: guildId,
    name: "Guild",
  })),
  fetchMemberInfoDiscord: vi.fn(async () => ({ user: { id: "U1" } })),
  hasAnyChannelPermissionDiscord: vi.fn(async () => true),
  hasAnyGuildPermissionDiscord: vi.fn(async () => true),
  fetchMessageDiscord: vi.fn(async () => ({})),
  fetchReactionsDiscord: vi.fn(async () => ({})),
  fetchRoleInfoDiscord: vi.fn(async () => []),
  fetchVoiceStatusDiscord: vi.fn(async () => ({})),
  kickMemberDiscord: vi.fn(async () => ({})),
  listGuildChannelsDiscord: vi.fn(async (): Promise<DiscordChannelInfoTest[]> => []),
  listGuildEmojisDiscord: vi.fn(async () => []),
  listPinsDiscord: vi.fn(async () => ({})),
  listScheduledEventsDiscord: vi.fn(async () => []),
  listThreadsDiscord: vi.fn(async () => ({})),
  moveChannelDiscord: vi.fn(async () => ({ ok: true })),
  pinMessageDiscord: vi.fn(async () => ({})),
  reactMessageDiscord: vi.fn(async () => ({})),
  readMessagesDiscord: vi.fn(async () => []),
  removeChannelPermissionDiscord: vi.fn(async () => ({ ok: true })),
  removeOwnReactionsDiscord: vi.fn(async () => ({ removed: ["👍"] })),
  removeReactionDiscord: vi.fn(async () => ({})),
  removeRoleDiscord: vi.fn(async () => ({ ok: true })),
  searchMessagesDiscord: vi.fn(async () => ({})),
  sendDiscordComponentMessage: vi.fn(async () => ({})),
  sendMessageDiscord: vi.fn(async () => ({})),
  sendPollDiscord: vi.fn(async () => ({})),
  sendStickerDiscord: vi.fn(async () => ({})),
  sendVoiceMessageDiscord: vi.fn(async () => ({})),
  setChannelPermissionDiscord: vi.fn(async () => ({ ok: true })),
  timeoutMemberDiscord: vi.fn(async () => ({})),
  unpinMessageDiscord: vi.fn(async () => ({})),
};

const {
  addRoleDiscord,
  canManageGuildRoleDiscord,
  canManageGuildMemberRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  createThreadDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchChannelPermissionsDiscord,
  fetchGuildInfoDiscord,
  fetchMemberInfoDiscord,
  fetchReactionsDiscord,
  fetchMessageDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  hasAnyChannelPermissionDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listPinsDiscord,
  listScheduledEventsDiscord,
  listThreadsDiscord,
  moveChannelDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeChannelPermissionDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  searchMessagesDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendVoiceMessageDiscord,
  setChannelPermissionDiscord,
  timeoutMemberDiscord,
} = discordSendMocks;

const enableAllActions = () => true;
const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      token: "token",
      groupPolicy: "open",
    },
  },
} as OpenClawConfig;

function discordAllowlistCfg(guilds: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "token",
        groupPolicy: "allowlist",
        guilds,
      },
    },
  } as OpenClawConfig;
}

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCall(source: MockCallSource, label: string, callIndex = 0): Array<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call;
}

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const value = mockCall(source, label, callIndex)[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function handleMessagingAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: (key: keyof DiscordActionConfig) => boolean,
  cfg: OpenClawConfig = DISCORD_TEST_CFG,
  options?: {
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
      workspaceDir?: string;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    conversationReadOrigin?: "delegated" | "direct-operator";
    readContext?: {
      requesterAccountId?: string | null;
      currentChannelProvider?: string | null;
      currentChannelId?: string | null;
    };
  },
) {
  return handleDiscordMessagingAction(action, params, isActionEnabled, cfg, options);
}

function handleGuildAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: (key: keyof DiscordActionConfig) => boolean,
  cfg: OpenClawConfig = DISCORD_TEST_CFG,
  options?: {
    mediaLocalRoots?: readonly string[];
    conversationReadOrigin?: "delegated" | "direct-operator";
  },
) {
  return handleDiscordGuildAction(action, params, isActionEnabled, cfg, options);
}

function handleModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean,
  cfg: OpenClawConfig = DISCORD_TEST_CFG,
) {
  return handleDiscordModerationAction(action, params, isActionEnabled, cfg);
}

const disabledActions = (key: keyof DiscordActionConfig) => key !== "reactions";
const channelInfoEnabled = (key: keyof DiscordActionConfig) => key === "channelInfo";
const moderationEnabled = (key: keyof DiscordActionConfig) => key === "moderation";
const rolesEnabled = (key: keyof DiscordActionConfig) => key === "roles";

beforeEach(() => {
  vi.clearAllMocks();
  fetchChannelInfoDiscord.mockImplementation(defaultFetchChannelInfoDiscord);
  clearPresences();
  Object.assign(
    discordMessagingActionRuntime,
    originalDiscordMessagingActionRuntime,
    discordSendMocks,
  );
  Object.assign(discordGuildActionRuntime, originalDiscordGuildActionRuntime, discordSendMocks);
  Object.assign(
    discordModerationActionRuntime,
    originalDiscordModerationActionRuntime,
    discordSendMocks,
  );
});

describe("handleDiscordMessagingAction", () => {
  it.each([
    {
      name: "without account",
      params: {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
      },
      expectedOptions: { cfg: DISCORD_TEST_CFG, accountId: "default" },
    },
    {
      name: "with accountId",
      params: {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
        accountId: "ops",
      },
      expectedOptions: { cfg: DISCORD_TEST_CFG, accountId: "ops" },
    },
  ])("adds reactions $name", async ({ params, expectedOptions }) => {
    await handleMessagingAction("react", params, enableAllActions);
    if (expectedOptions) {
      expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅", expectedOptions);
      return;
    }
    expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅", {
      cfg: DISCORD_TEST_CFG,
    });
  });

  it("uses configured defaultAccount when cfg is provided and accountId is omitted", async () => {
    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: {
            work: { token: "token-work" },
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
      },
      enableAllActions,
      cfg,
    );

    expect(reactMessageDiscord).toHaveBeenCalledTimes(1);
    expect(mockCall(reactMessageDiscord, "reactMessageDiscord")).toEqual([
      "C1",
      "M1",
      "✅",
      { cfg, accountId: "work" },
    ]);
  });

  it("surfaces incomplete archived thread pages at the action boundary", async () => {
    listThreadsDiscord.mockResolvedValueOnce({
      threads: [
        {
          id: "thread-1",
          name: "Old project",
          thread_metadata: {
            archive_timestamp: "2026-05-25T17:00:00.000Z",
          },
        },
      ],
      members: [],
      has_more: true,
    });

    const result = await handleMessagingAction(
      "threadList",
      {
        guildId: "G1",
        channelId: "C1",
        includeArchived: true,
        before: "2026-05-26T17:00:00.000Z",
        limit: 1,
      },
      enableAllActions,
    );

    expect(mockCall(listThreadsDiscord, "listThreadsDiscord")).toEqual([
      {
        guildId: "G1",
        channelId: "C1",
        includeArchived: true,
        before: "2026-05-26T17:00:00.000Z",
        limit: 1,
      },
      { cfg: DISCORD_TEST_CFG },
    ]);
    expect(result.details).toMatchObject({
      ok: true,
      complete: false,
      hasMore: true,
      returnedCount: 1,
      source: "discord.threadList.archived",
      nextBefore: "2026-05-25T17:00:00.000Z",
      query: {
        guildId: "G1",
        channelId: "C1",
        includeArchived: true,
        before: "2026-05-26T17:00:00.000Z",
        limit: 1,
      },
    });
    expect((result.details as { threads?: unknown }).threads).toEqual({
      threads: [
        {
          id: "thread-1",
          name: "Old project",
          thread_metadata: {
            archive_timestamp: "2026-05-25T17:00:00.000Z",
          },
        },
      ],
      members: [],
      has_more: true,
    });
  });

  it("omits archived thread pagination cursors when Discord omits archive timestamps", async () => {
    listThreadsDiscord.mockResolvedValueOnce({
      threads: [
        {
          id: "thread-without-archive-timestamp",
          name: "Legacy project",
        },
      ],
      members: [],
      has_more: true,
    });

    const result = await handleMessagingAction(
      "threadList",
      {
        guildId: "G1",
        channelId: "C1",
        includeArchived: true,
        limit: 1,
      },
      enableAllActions,
    );

    expect(result.details).toMatchObject({
      ok: true,
      complete: false,
      hasMore: true,
      returnedCount: 1,
      source: "discord.threadList.archived",
    });
    expect(result.details).not.toHaveProperty("nextBefore");
  });

  it("marks active thread results complete when Discord returns no pagination state", async () => {
    listThreadsDiscord.mockResolvedValueOnce({
      threads: [{ id: "thread-active", name: "Current project" }],
      members: [{ id: "member-1" }],
    });

    const result = await handleMessagingAction(
      "threadList",
      {
        guildId: "G1",
      },
      enableAllActions,
    );

    expect(result.details).toMatchObject({
      ok: true,
      complete: true,
      hasMore: false,
      returnedCount: 1,
      source: "discord.threadList.active",
      query: {
        guildId: "G1",
        includeArchived: false,
      },
    });
    expect((result.details as { threads?: unknown }).threads).toEqual({
      threads: [{ id: "thread-active", name: "Current project" }],
      members: [{ id: "member-1" }],
    });
    expect(result.details).not.toHaveProperty("nextBefore");
  });

  it("rejects archived Discord thread lists for non-allowlisted target channels", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction(
        "threadList",
        { guildId: "111", channelId: "333", includeArchived: true },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(listThreadsDiscord).not.toHaveBeenCalled();
  });

  it("requires guild-wide authorization for active Discord thread lists", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction(
        "threadList",
        { guildId: "111", channelId: "222" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow(
      "Discord active thread lists require a wildcard channel allowlist so each read target can be authorized.",
    );
    expect(listThreadsDiscord).not.toHaveBeenCalled();
  });

  it("allows guild-wide Discord thread lists when the guild has a wildcard channel allowlist", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "*": { enabled: true },
        },
      },
    });

    await handleMessagingAction("threadList", { guildId: "111" }, enableAllActions, cfg);

    expect(listThreadsDiscord).toHaveBeenCalledWith(
      {
        guildId: "111",
        channelId: undefined,
        includeArchived: undefined,
        before: undefined,
        limit: undefined,
      },
      { cfg },
    );
  });

  it("resolves Discord DM targets for reaction adds", async () => {
    const resolveReactionTarget = vi.fn(async () => "DM1");
    discordMessagingActionRuntime.resolveDiscordReactionTargetChannelId = resolveReactionTarget;

    await handleMessagingAction(
      "react",
      {
        to: "user:U1",
        messageId: "M1",
        emoji: "✅",
      },
      enableAllActions,
    );

    expect(resolveReactionTarget).toHaveBeenCalledWith({
      target: "user:U1",
      cfg: DISCORD_TEST_CFG,
      accountId: "default",
    });
    expect(reactMessageDiscord).toHaveBeenCalledWith("DM1", "M1", "✅", {
      cfg: DISCORD_TEST_CFG,
      accountId: "default",
    });
  });

  it("resolves Discord DM targets for direct-operator reaction listing", async () => {
    const resolveReactionTarget = vi.fn(async () => "DM1");
    discordMessagingActionRuntime.resolveDiscordReactionTargetChannelId = resolveReactionTarget;
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "DM1",
      type: ChannelType.DM,
    });

    await handleMessagingAction(
      "reactions",
      {
        to: "user:U1",
        messageId: "M1",
      },
      enableAllActions,
      DISCORD_TEST_CFG,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(resolveReactionTarget).toHaveBeenCalledWith({
      target: "user:U1",
      cfg: DISCORD_TEST_CFG,
      accountId: "default",
    });
    expect(fetchReactionsDiscord).toHaveBeenCalledWith("DM1", "M1", {
      cfg: DISCORD_TEST_CFG,
      accountId: "default",
      limit: undefined,
    });
  });

  it.each([
    { name: "DM", type: ChannelType.DM },
    { name: "group DM", type: ChannelType.GroupDM },
  ])("blocks delegated reads of arbitrary Discord $name targets", async ({ type }) => {
    const resolveReactionTarget = vi.fn(async () => "DM1");
    discordMessagingActionRuntime.resolveDiscordReactionTargetChannelId = resolveReactionTarget;
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "DM1",
      type,
    });

    await expect(
      handleMessagingAction(
        "reactions",
        {
          to: "user:U1",
          messageId: "M1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");

    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("rejects a Discord DM paired with a caller-supplied guild ID", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "DM1",
      type: ChannelType.DM,
    });

    await expect(
      handleMessagingAction(
        "fetchMessage",
        {
          guildId: "G1",
          channelId: "DM1",
          messageId: "M1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");

    expect(fetchMessageDiscord).not.toHaveBeenCalled();
  });

  it("fails closed when Discord cannot verify a caller-supplied guild target", async () => {
    fetchChannelInfoDiscord.mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(
      handleMessagingAction(
        "fetchMessage",
        {
          guildId: "G1",
          channelId: "C1",
          messageId: "M1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");

    expect(fetchMessageDiscord).not.toHaveBeenCalled();
  });

  it("rejects fractional Discord reaction limits before fetching reactions", async () => {
    await expect(
      handleMessagingAction(
        "reactions",
        {
          channelId: "C1",
          messageId: "M1",
          limit: 2.5,
        },
        enableAllActions,
      ),
    ).rejects.toThrow("limit must be a positive integer");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("rejects Discord reaction reads for non-allowlisted target channels", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reaction add",
      action: "react",
      params: { emoji: "✅" },
      providerCall: discordSendMocks.reactMessageDiscord,
    },
    {
      name: "reaction removal",
      action: "react",
      params: { emoji: "✅", remove: true },
      providerCall: discordSendMocks.removeReactionDiscord,
    },
    {
      name: "message edit",
      action: "editMessage",
      params: { content: "updated" },
      providerCall: discordSendMocks.editMessageDiscord,
    },
    {
      name: "message deletion",
      action: "deleteMessage",
      params: {},
      providerCall: discordSendMocks.deleteMessageDiscord,
    },
    {
      name: "pin",
      action: "pinMessage",
      params: {},
      providerCall: discordSendMocks.pinMessageDiscord,
    },
    {
      name: "unpin",
      action: "unpinMessage",
      params: {},
      providerCall: discordSendMocks.unpinMessageDiscord,
    },
  ])("rejects blocked Discord $name before mutation", async ({ action, params, providerCall }) => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "444",
      guild_id: "111",
      name: "blocked",
      type: ChannelType.GuildText,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction(
        action,
        {
          channelId: "444",
          messageId: "M1",
          ...params,
        },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");

    expect(providerCall).not.toHaveBeenCalled();
  });

  it("allows a delegated read of the exact current Discord channel and account", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "444",
      guild_id: "111",
      name: "current-target",
      type: ChannelType.GuildText,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await handleMessagingAction(
      "reactions",
      { channelId: "444", messageId: "M1" },
      enableAllActions,
      cfg,
      {
        readContext: {
          requesterAccountId: "DEFAULT",
          currentChannelProvider: "Discord",
          currentChannelId: "channel:444",
        },
      },
    );

    expect(fetchReactionsDiscord).toHaveBeenCalledWith("444", "M1", {
      cfg,
      accountId: "default",
      limit: undefined,
    });
  });

  it("does not borrow current Discord visibility from another account", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "444",
      guild_id: "111",
      name: "current-target",
      type: ChannelType.GuildText,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1" },
        enableAllActions,
        cfg,
        {
          readContext: {
            requesterAccountId: "other",
            currentChannelProvider: "discord",
            currentChannelId: "444",
          },
        },
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("keeps explicitly disabled current Discord channels blocked", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "444",
      guild_id: "111",
      name: "current-target",
      type: ChannelType.GuildText,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "444": { enabled: false },
        },
      },
    });

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1" },
        enableAllActions,
        cfg,
        {
          readContext: {
            requesterAccountId: "default",
            currentChannelProvider: "discord",
            currentChannelId: "444",
          },
        },
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("lets a direct operator read an unconfigured Discord channel", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "444",
      guild_id: "111",
      name: "operator-target",
      type: ChannelType.GuildText,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await handleMessagingAction(
      "reactions",
      { channelId: "444", messageId: "M1" },
      enableAllActions,
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(fetchReactionsDiscord).toHaveBeenCalledWith("444", "M1", {
      cfg,
      accountId: "default",
      limit: undefined,
    });
  });

  it.each([
    {
      name: "disabled group scope",
      cfg: {
        channels: {
          discord: {
            token: "token",
            groupPolicy: "disabled",
          },
        },
      } as OpenClawConfig,
      channel: {
        id: "444",
        guild_id: "111",
        name: "blocked",
        type: ChannelType.GuildText,
      },
    },
    {
      name: "explicitly disabled channel",
      cfg: discordAllowlistCfg({
        "111": {
          channels: {
            "444": { enabled: false },
          },
        },
      }),
      channel: {
        id: "444",
        guild_id: "111",
        name: "blocked",
        type: ChannelType.GuildText,
      },
    },
    {
      name: "disabled direct-message scope",
      cfg: {
        channels: {
          discord: {
            defaultAccount: "qa",
            accounts: {
              qa: {
                token: "token",
                groupPolicy: "open",
                dm: { enabled: false, policy: "disabled" },
                guilds: {
                  "111": {
                    channels: {
                      "*": { enabled: true },
                    },
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      channel: {
        id: "444",
        type: ChannelType.DM,
      },
    },
    {
      name: "disabled group direct-message scope",
      cfg: {
        channels: {
          discord: {
            token: "token",
            groupPolicy: "open",
            dm: { enabled: true, policy: "pairing", groupEnabled: false },
          },
        },
      } as OpenClawConfig,
      channel: {
        id: "444",
        name: "qa-group",
        type: ChannelType.GroupDM,
      },
    },
    {
      name: "group direct-message target outside its allowlist",
      cfg: {
        channels: {
          discord: {
            token: "token",
            groupPolicy: "open",
            dm: {
              enabled: true,
              policy: "pairing",
              groupEnabled: true,
              groupChannels: ["allowed-group"],
            },
          },
        },
      } as OpenClawConfig,
      channel: {
        id: "444",
        name: "blocked-group",
        type: ChannelType.GroupDM,
      },
    },
  ])("keeps $name blocked for direct operators", async ({ cfg, channel }) => {
    fetchChannelInfoDiscord.mockResolvedValueOnce(channel);
    const accountId = cfg.channels?.discord?.defaultAccount;

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1", accountId },
        enableAllActions,
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("lets a direct operator read an enabled, allowlisted Discord group DM", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "444",
      name: "allowed-group",
      type: ChannelType.GroupDM,
    });
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "disabled",
          dm: {
            enabled: false,
            policy: "disabled",
            groupEnabled: true,
            groupChannels: ["allowed-group"],
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction(
      "reactions",
      { channelId: "444", messageId: "M1" },
      enableAllActions,
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(fetchReactionsDiscord).toHaveBeenCalledWith("444", "M1", {
      cfg,
      accountId: "default",
      limit: undefined,
    });
  });

  it("fails closed across disabled Discord scopes when target metadata is unavailable", async () => {
    fetchChannelInfoDiscord.mockRejectedValueOnce(new Error("metadata unavailable"));
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "disabled",
          dm: { enabled: true, policy: "pairing" },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1" },
        enableAllActions,
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("fails closed when Discord metadata cannot distinguish a disabled group DM", async () => {
    fetchChannelInfoDiscord.mockRejectedValueOnce(new Error("metadata unavailable"));
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "open",
          dm: {
            enabled: true,
            policy: "pairing",
            groupEnabled: false,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1" },
        enableAllActions,
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("fails closed around explicit disabled channels when target metadata is unavailable", async () => {
    fetchChannelInfoDiscord.mockRejectedValueOnce(new Error("metadata unavailable"));
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "open",
          dm: { enabled: true, policy: "pairing" },
          guilds: {
            "111": {
              channels: {
                blocked: { enabled: false },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "reactions",
        { channelId: "444", messageId: "M1" },
        enableAllActions,
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchReactionsDiscord).not.toHaveBeenCalled();
  });

  it("removes reactions on empty emoji", async () => {
    await handleMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "",
      },
      enableAllActions,
    );
    expect(removeOwnReactionsDiscord).toHaveBeenCalledWith("C1", "M1", {
      cfg: DISCORD_TEST_CFG,
      accountId: "default",
    });
  });

  it("rejects reaction clearing outside allowlisted Discord channels", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction(
        "react",
        {
          channelId: "444",
          messageId: "M1",
          emoji: "",
        },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(removeOwnReactionsDiscord).not.toHaveBeenCalled();
  });

  it("removes reactions when remove flag set", async () => {
    await handleMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
        remove: true,
      },
      enableAllActions,
    );
    expect(removeReactionDiscord).toHaveBeenCalledWith("C1", "M1", "✅", {
      cfg: DISCORD_TEST_CFG,
      accountId: "default",
    });
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "",
          remove: true,
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "✅",
        },
        disabledActions,
      ),
    ).rejects.toThrow(/Discord reactions are disabled/);
  });

  it("parses string booleans for poll options", async () => {
    await handleMessagingAction(
      "poll",
      {
        to: "channel:123",
        question: "Lunch?",
        answers: ["Pizza", "Sushi"],
        allowMultiselect: "true",
        durationHours: "24",
      },
      enableAllActions,
    );

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:123",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 2,
        durationHours: 24,
      },
      { cfg: DISCORD_TEST_CFG, content: undefined },
    );
  });

  it("rejects Discord permission reads for non-allowlisted target channels", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction("permissions", { channelId: "444" }, enableAllActions, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchChannelPermissionsDiscord).not.toHaveBeenCalled();
  });

  it("adds normalized timestamps to readMessages payloads", async () => {
    readMessagesDiscord.mockResolvedValueOnce([
      { id: "1", timestamp: "2026-01-15T10:00:00.000Z" },
    ] as never);

    const result = await handleMessagingAction(
      "readMessages",
      { channelId: "C1" },
      enableAllActions,
    );
    const payload = result.details as {
      messages: Array<{ timestampMs?: number; timestampUtc?: string }>;
    };

    const expectedMs = Date.parse("2026-01-15T10:00:00.000Z");
    expect(payload.messages[0].timestampMs).toBe(expectedMs);
    expect(payload.messages[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("rejects unexpected readMessages payloads with a boundary error", async () => {
    readMessagesDiscord.mockResolvedValueOnce({ ok: true } as never);

    await expect(
      handleMessagingAction("readMessages", { channelId: "C1" }, enableAllActions),
    ).rejects.toThrow("Discord message read returned object with keys ok instead of an array.");
  });

  it("threads provided cfg into readMessages calls", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
        },
      },
    } as OpenClawConfig;
    await handleMessagingAction("readMessages", { channelId: "C1" }, enableAllActions, cfg);
    expect(readMessagesDiscord).toHaveBeenCalledWith(
      "C1",
      { limit: undefined, before: undefined, after: undefined, around: undefined },
      { cfg },
    );
  });

  it("rejects fractional Discord read limits before reading messages", async () => {
    await expect(
      handleMessagingAction(
        "readMessages",
        {
          channelId: "C1",
          limit: "3.5",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("limit must be a positive integer");
    expect(readMessagesDiscord).not.toHaveBeenCalled();
  });

  it("reads from allowlisted Discord target channels", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "222",
      guild_id: "111",
      type: ChannelType.GuildText,
    });
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction("readMessages", { channelId: "222" }, enableAllActions, cfg);

    expect(readMessagesDiscord).toHaveBeenCalledWith(
      "222",
      { limit: undefined, before: undefined, after: undefined, around: undefined },
      { cfg },
    );
  });

  it.each([
    {
      name: "delegated",
      options: undefined,
    },
    {
      name: "direct operator",
      options: { conversationReadOrigin: "direct-operator" as const },
    },
    {
      name: "current conversation",
      options: {
        readContext: {
          requesterAccountId: "default",
          currentChannelProvider: "discord",
          currentChannelId: "333",
        },
      },
    },
  ])("rejects $name reads beneath an explicitly disabled category", async ({ options }) => {
    fetchChannelInfoDiscord.mockImplementation(async (channelId: string) => {
      if (channelId === "333") {
        return {
          id: channelId,
          guild_id: "111",
          name: "enabled-child",
          parent_id: "222",
          type: ChannelType.GuildText,
        };
      }
      return {
        id: "222",
        guild_id: "111",
        name: "private",
        type: ChannelType.GuildCategory,
      };
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          private: { enabled: false },
          "333": { enabled: true },
        },
      },
    });
    const cases = [
      {
        action: "permissions",
        params: { channelId: "333" },
        runtime: fetchChannelPermissionsDiscord,
      },
      { action: "readMessages", params: { channelId: "333" }, runtime: readMessagesDiscord },
      { action: "listPins", params: { channelId: "333" }, runtime: listPinsDiscord },
      {
        action: "reactions",
        params: { channelId: "333", messageId: "message-1" },
        runtime: fetchReactionsDiscord,
      },
    ];

    for (const testCase of cases) {
      await expect(
        handleMessagingAction(testCase.action, testCase.params, enableAllActions, cfg, options),
      ).rejects.toThrow("Discord read target channel is not allowed.");
      expect(testCase.runtime).not.toHaveBeenCalled();
    }
  });

  it("rejects thread reads when the thread's category ancestor is disabled", async () => {
    fetchChannelInfoDiscord.mockImplementation(async (channelId: string) => {
      if (channelId === "444") {
        return {
          id: channelId,
          guild_id: "111",
          name: "project-thread",
          parent_id: "333",
          type: ChannelType.GuildPublicThread,
        };
      }
      if (channelId === "333") {
        return {
          id: channelId,
          guild_id: "111",
          name: "enabled-child",
          parent_id: "222",
          type: ChannelType.GuildText,
        };
      }
      return {
        id: "222",
        guild_id: "111",
        name: "private",
        type: ChannelType.GuildCategory,
      };
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          private: { enabled: false },
          "333": { enabled: true },
          "444": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction("readMessages", { channelId: "444" }, enableAllActions, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchChannelInfoDiscord.mock.calls.map((call) => call[0])).toEqual([
      "444",
      "333",
      "222",
    ]);
    expect(readMessagesDiscord).not.toHaveBeenCalled();
  });

  it("fails closed when disabled-channel policy exists and ancestry metadata is incomplete", async () => {
    fetchChannelInfoDiscord.mockImplementation(async (channelId: string) => {
      if (channelId === "333") {
        return {
          id: channelId,
          guild_id: "111",
          name: "enabled-child",
          parent_id: "222",
          type: ChannelType.GuildText,
        };
      }
      throw new Error("metadata unavailable");
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          private: { enabled: false },
          "333": { enabled: true },
        },
      },
    });

    await expect(
      handleMessagingAction("readMessages", { channelId: "333" }, enableAllActions, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(readMessagesDiscord).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "implicit guild lookup",
      action: "readMessages",
      params: { channelId: "333" },
      runtime: readMessagesDiscord,
    },
    {
      name: "explicit guild input",
      action: "fetchMessage",
      params: { guildId: "111", channelId: "333", messageId: "message-1" },
      runtime: fetchMessageDiscord,
    },
  ])(
    "fails closed for $name when disabled ancestry cannot be verified",
    async ({ action, params, runtime }) => {
      fetchChannelInfoDiscord.mockRejectedValueOnce(new Error("metadata unavailable"));
      const cfg = discordAllowlistCfg({
        "111": {
          channels: {
            "222": { enabled: false },
            "333": { enabled: true },
          },
        },
      });

      await expect(handleMessagingAction(action, params, enableAllActions, cfg)).rejects.toThrow(
        "Discord read target channel is not allowed.",
      );
      expect(runtime).not.toHaveBeenCalled();
    },
  );

  it("reads from Discord target channels allowlisted under a guild slug", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "222",
      guild_id: "111",
      type: 0,
    });
    fetchGuildInfoDiscord.mockResolvedValueOnce({
      id: "111",
      name: "Friends of OpenClaw",
    });
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "friends-of-openclaw": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction("readMessages", { channelId: "222" }, enableAllActions, cfg);

    expect(fetchGuildInfoDiscord).toHaveBeenCalledWith("111", { cfg });
    expect(readMessagesDiscord).toHaveBeenCalledWith(
      "222",
      { limit: undefined, before: undefined, after: undefined, around: undefined },
      { cfg },
    );
  });

  it("rejects Discord reads for non-allowlisted target channels", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction("readMessages", { channelId: "333" }, enableAllActions, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(readMessagesDiscord).not.toHaveBeenCalled();
  });

  it("fails closed for Discord message reads when provider config is missing", async () => {
    const cfg = {} as OpenClawConfig;

    await expect(
      handleMessagingAction("readMessages", { channelId: "C1" }, enableAllActions, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(readMessagesDiscord).not.toHaveBeenCalled();

    await expect(
      handleMessagingAction(
        "fetchMessage",
        { messageLink: "https://discord.com/channels/111/222/333" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchMessageDiscord).not.toHaveBeenCalled();
  });

  it("adds normalized timestamps to fetchMessage payloads", async () => {
    fetchMessageDiscord.mockResolvedValueOnce({
      id: "1",
      timestamp: "2026-01-15T11:00:00.000Z",
    });

    const result = await handleMessagingAction(
      "fetchMessage",
      { guildId: "G1", channelId: "C1", messageId: "M1" },
      enableAllActions,
    );
    const payload = result.details as { message?: { timestampMs?: number; timestampUtc?: string } };

    const expectedMs = Date.parse("2026-01-15T11:00:00.000Z");
    expect(payload.message?.timestampMs).toBe(expectedMs);
    expect(payload.message?.timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("threads provided cfg into fetchMessage calls", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
        },
      },
    } as OpenClawConfig;
    await handleMessagingAction(
      "fetchMessage",
      { guildId: "G1", channelId: "C1", messageId: "M1" },
      enableAllActions,
      cfg,
    );
    expect(fetchMessageDiscord).toHaveBeenCalledWith("C1", "M1", { cfg });
  });

  it("fetches Discord messages from channels allowlisted under a guild slug", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "222",
      guild_id: "111",
      type: 0,
    });
    fetchGuildInfoDiscord.mockResolvedValueOnce({
      id: "111",
      name: "Friends of OpenClaw",
    });
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "friends-of-openclaw": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction(
      "fetchMessage",
      { messageLink: "https://discord.com/channels/111/222/333" },
      enableAllActions,
      cfg,
    );

    expect(fetchGuildInfoDiscord).toHaveBeenCalledWith("111", { cfg });
    expect(fetchMessageDiscord).toHaveBeenCalledWith("222", "333", { cfg });
  });

  it("rejects Discord message links for non-allowlisted target channels", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "fetchMessage",
        { messageLink: "https://discord.com/channels/111/333/444" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchMessageDiscord).not.toHaveBeenCalled();
  });

  it("allows Discord message links in threads under allowlisted parent channels", async () => {
    fetchChannelInfoDiscord.mockImplementation(async (channelId: string) => {
      if (channelId === "333") {
        return {
          id: "333",
          guild_id: "111",
          name: "incident-thread",
          parent_id: "222",
          type: ChannelType.PublicThread,
        };
      }
      if (channelId === "222") {
        return {
          id: "222",
          guild_id: "111",
          name: "team-updates",
          type: ChannelType.GuildText,
        };
      }
      return { id: channelId, guild_id: "111", type: ChannelType.GuildText };
    });
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction(
      "fetchMessage",
      { messageLink: "https://discord.com/channels/111/333/444" },
      enableAllActions,
      cfg,
    );

    expect(fetchMessageDiscord).toHaveBeenCalledWith("333", "444", { cfg });
  });

  it("rejects Discord message links when the fetched channel belongs to a different guild", async () => {
    fetchChannelInfoDiscord.mockImplementation(async (channelId: string) => ({
      id: channelId,
      guild_id: "222",
      name: "allowed-channel",
      type: 0,
    }));
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "allowed-channel": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "fetchMessage",
        { messageLink: "https://discord.com/channels/111/333/444" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchMessageDiscord).not.toHaveBeenCalled();
  });

  it.each([
    { action: "readMessages", runtimeCall: readMessagesDiscord },
    { action: "listPins", runtimeCall: listPinsDiscord },
  ])(
    "rejects Discord $action when the fetched guild is not allowlisted by a matching channel name",
    async ({ action, runtimeCall }) => {
      fetchChannelInfoDiscord.mockImplementation(async (channelId: string) => ({
        id: channelId,
        guild_id: "222",
        name: "allowed-channel",
        type: 0,
      }));
      const cfg = {
        channels: {
          discord: {
            token: "token",
            groupPolicy: "allowlist",
            guilds: {
              "111": {
                channels: {
                  "allowed-channel": { enabled: true },
                },
              },
            },
          },
        },
      } as OpenClawConfig;

      await expect(
        handleMessagingAction(action, { channelId: "333" }, enableAllActions, cfg),
      ).rejects.toThrow("Discord read target channel is not allowed.");
      expect(runtimeCall).not.toHaveBeenCalled();
    },
  );

  it("adds normalized timestamps to listPins payloads", async () => {
    listPinsDiscord.mockResolvedValueOnce([{ id: "1", timestamp: "2026-01-15T12:00:00.000Z" }]);

    const result = await handleMessagingAction("listPins", { channelId: "C1" }, enableAllActions);
    const payload = result.details as {
      pins: Array<{ timestampMs?: number; timestampUtc?: string }>;
    };

    const expectedMs = Date.parse("2026-01-15T12:00:00.000Z");
    expect(payload.pins[0].timestampMs).toBe(expectedMs);
    expect(payload.pins[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("rejects Discord pin reads for non-allowlisted target channels", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction("listPins", { channelId: "444" }, enableAllActions, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(listPinsDiscord).not.toHaveBeenCalled();
  });

  it("adds normalized timestamps to searchMessages payloads", async () => {
    searchMessagesDiscord.mockResolvedValueOnce({
      total_results: 1,
      messages: [[{ id: "1", timestamp: "2026-01-15T13:00:00.000Z" }]],
    });

    const result = await handleMessagingAction(
      "searchMessages",
      { guildId: "G1", content: "hi" },
      enableAllActions,
    );
    const payload = result.details as {
      results?: { messages?: Array<Array<{ timestampMs?: number; timestampUtc?: string }>> };
    };

    const expectedMs = Date.parse("2026-01-15T13:00:00.000Z");
    expect(payload.results?.messages?.[0]?.[0]?.timestampMs).toBe(expectedMs);
    expect(payload.results?.messages?.[0]?.[0]?.timestampUtc).toBe(
      new Date(expectedMs).toISOString(),
    );
  });

  it("rejects Discord searches for non-allowlisted target channels", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "searchMessages",
        { guildId: "111", channelId: "444", content: "canary" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(searchMessagesDiscord).not.toHaveBeenCalled();
  });

  it("requires explicit Discord search targets when channels are allowlisted", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "222": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "searchMessages",
        { guildId: "111", content: "canary" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow(
      "Discord message search requires channelId or channelIds so each read target can be authorized.",
    );
    expect(searchMessagesDiscord).not.toHaveBeenCalled();
  });

  it("requires explicit Discord search targets when a direct operator has disabled channels", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          blocked: { enabled: false },
        },
      },
    });

    await expect(
      handleMessagingAction(
        "searchMessages",
        { guildId: "111", content: "hello" },
        enableAllActions,
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow(
      "Discord message search requires channelId or channelIds so each read target can be authorized.",
    );
    expect(searchMessagesDiscord).not.toHaveBeenCalled();
  });

  it("fails closed for Discord guild-wide searches when provider config is missing", async () => {
    const cfg = {} as OpenClawConfig;

    await expect(
      handleMessagingAction(
        "searchMessages",
        { guildId: "111", content: "canary" },
        enableAllActions,
        cfg,
      ),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(searchMessagesDiscord).not.toHaveBeenCalled();
  });

  it("allows guild-wide Discord searches when the guild has a wildcard channel allowlist", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "token",
          groupPolicy: "allowlist",
          guilds: {
            "111": {
              channels: {
                "*": { enabled: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleMessagingAction(
      "searchMessages",
      { guildId: "111", content: "canary" },
      enableAllActions,
      cfg,
    );

    expect(searchMessagesDiscord).toHaveBeenCalledWith(
      {
        guildId: "111",
        content: "canary",
        channelIds: undefined,
        authorIds: undefined,
        limit: undefined,
      },
      { cfg },
    );
  });

  it("resolves guildId from channel info when guildId is omitted in searchMessages", async () => {
    fetchChannelInfoDiscord
      .mockResolvedValueOnce({
        id: "C1",
        type: ChannelType.GuildText,
        guild_id: "resolved-guild",
      })
      .mockResolvedValueOnce({
        id: "C1",
        type: ChannelType.GuildText,
        guild_id: "resolved-guild",
      });
    searchMessagesDiscord.mockResolvedValueOnce({ total_results: 0, messages: [] });

    await handleMessagingAction(
      "searchMessages",
      { channelId: "C1", content: "hello" },
      enableAllActions,
    );

    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("C1", expect.anything());
    expect(searchMessagesDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "resolved-guild", content: "hello" }),
      expect.anything(),
    );
  });

  it("normalizes channel: prefixed channelId before resolving guildId in searchMessages", async () => {
    fetchChannelInfoDiscord
      .mockResolvedValueOnce({
        id: "C1",
        type: ChannelType.GuildText,
        guild_id: "resolved-guild",
      })
      .mockResolvedValueOnce({
        id: "C1",
        type: ChannelType.GuildText,
        guild_id: "resolved-guild",
      });
    searchMessagesDiscord.mockResolvedValueOnce({ total_results: 0, messages: [] });

    await handleMessagingAction(
      "searchMessages",
      { channelId: "channel:C1", content: "hello" },
      enableAllActions,
    );

    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("C1", expect.anything());
    expect(searchMessagesDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "resolved-guild", content: "hello", channelIds: ["C1"] }),
      expect.anything(),
    );
  });

  it("accepts query as alias for content in searchMessages", async () => {
    searchMessagesDiscord.mockResolvedValueOnce({ total_results: 0, messages: [] });

    await handleMessagingAction(
      "searchMessages",
      { guildId: "G1", query: "find this" },
      enableAllActions,
    );

    expect(searchMessagesDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "G1", content: "find this" }),
      expect.anything(),
    );
  });

  it("throws descriptive error when guildId cannot be resolved in searchMessages", async () => {
    await expect(
      handleMessagingAction("searchMessages", { content: "hello" }, enableAllActions),
    ).rejects.toThrow(
      "Discord search requires guildId. Provide guildId explicitly, or provide channelId so the guild can be resolved from the channel.",
    );
    expect(searchMessagesDiscord).not.toHaveBeenCalled();
  });

  it("sends voice messages from a local file path", async () => {
    sendVoiceMessageDiscord.mockClear();
    sendMessageDiscord.mockClear();

    await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        path: "/tmp/voice.mp3",
        asVoice: true,
        silent: true,
      },
      enableAllActions,
    );

    expect(sendVoiceMessageDiscord).toHaveBeenCalledWith("channel:123", "/tmp/voice.mp3", {
      cfg: DISCORD_TEST_CFG,
      reply: undefined,
      silent: true,
    });
    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("forwards trusted mediaLocalRoots into sendMessageDiscord", async () => {
    sendMessageDiscord.mockClear();
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const mediaAccess = { localRoots: ["/tmp/agent-root"], readFile: mediaReadFile };
    await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        content: "hello",
        mediaUrl: "/tmp/image.png",
      },
      enableAllActions,
      DISCORD_TEST_CFG,
      { mediaAccess, mediaLocalRoots: ["/tmp/agent-root"], mediaReadFile },
    );
    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    const call = mockCall(sendMessageDiscord, "sendMessageDiscord");
    const sendOptions = mockObjectArg(sendMessageDiscord, "sendMessageDiscord", 0, 2);
    expect(call[0]).toBe("channel:123");
    expect(call[1]).toBe("hello");
    expect(sendOptions.mediaAccess).toBe(mediaAccess);
    expect(sendOptions.mediaUrl).toBe("/tmp/image.png");
    expect(sendOptions.mediaLocalRoots).toEqual(["/tmp/agent-root"]);
    expect(sendOptions.mediaReadFile).toBe(mediaReadFile);
  });

  it("allows media-only message sends", async () => {
    sendMessageDiscord.mockClear();
    await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        mediaUrl: "/tmp/image.png",
      },
      enableAllActions,
      DISCORD_TEST_CFG,
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );
    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    const call = mockCall(sendMessageDiscord, "sendMessageDiscord");
    const sendOptions = mockObjectArg(sendMessageDiscord, "sendMessageDiscord", 0, 2);
    expect(call[0]).toBe("channel:123");
    const content = call[1];
    expect(content).toBe("");
    expect(sendOptions.mediaUrl).toBe("/tmp/image.png");
    expect(sendOptions.mediaLocalRoots).toEqual(["/tmp/agent-root"]);
  });

  it("ignores empty components objects for regular media sends", async () => {
    sendMessageDiscord.mockClear();
    sendDiscordComponentMessage.mockClear();

    await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        content: "hello",
        mediaUrl: "/tmp/image.png",
        components: {},
      },
      enableAllActions,
      DISCORD_TEST_CFG,
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );

    expect(sendDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    const call = mockCall(sendMessageDiscord, "sendMessageDiscord");
    const sendOptions = mockObjectArg(sendMessageDiscord, "sendMessageDiscord", 0, 2);
    expect(call[0]).toBe("channel:123");
    const content = call[1];
    expect(content).toBe("hello");
    expect(sendOptions.mediaUrl).toBe("/tmp/image.png");
    expect(sendOptions.mediaLocalRoots).toEqual(["/tmp/agent-root"]);
  });

  it("forwards the optional filename into sendMessageDiscord", async () => {
    sendMessageDiscord.mockClear();
    await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        content: "hello",
        mediaUrl: "/tmp/generated-image",
        filename: "image.png",
      },
      enableAllActions,
    );
    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    const call = mockCall(sendMessageDiscord, "sendMessageDiscord");
    const sendOptions = mockObjectArg(sendMessageDiscord, "sendMessageDiscord", 0, 2);
    expect(call[0]).toBe("channel:123");
    const content = call[1];
    expect(content).toBe("hello");
    expect(sendOptions.mediaUrl).toBe("/tmp/generated-image");
    expect(sendOptions.filename).toBe("image.png");
  });

  it("renames an existing thread when threadName is provided on sendMessage", async () => {
    sendMessageDiscord.mockResolvedValueOnce({
      messageId: "M1",
      channelId: "T1",
    });
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "T1",
      type: 11,
    });
    editChannelDiscord.mockResolvedValueOnce({
      id: "T1",
      name: "new-thread",
    });

    const result = await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:T1",
        content: "hello",
        threadName: "new-thread",
      },
      enableAllActions,
    );

    expect(sendMessageDiscord).toHaveBeenCalledWith("channel:T1", "hello", {
      cfg: DISCORD_TEST_CFG,
      accountId: undefined,
      mediaAccess: undefined,
      mediaUrl: undefined,
      filename: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
      reply: undefined,
      components: undefined,
      embeds: undefined,
      silent: false,
    });
    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("T1", { cfg: DISCORD_TEST_CFG });
    expect(editChannelDiscord).toHaveBeenCalledWith(
      {
        channelId: "T1",
        name: "new-thread",
      },
      { cfg: DISCORD_TEST_CFG },
    );
    expect(result.details).toEqual({
      ok: true,
      result: {
        messageId: "M1",
        channelId: "T1",
      },
      threadRename: {
        ok: true,
        channelId: "T1",
        name: "new-thread",
      },
    });
  });

  it("forwards sendMessage suppressEmbeds overrides", async () => {
    sendMessageDiscord.mockClear();

    await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        content: "https://example.com",
        suppressEmbeds: false,
      },
      enableAllActions,
    );

    const sendOptions = mockObjectArg(sendMessageDiscord, "sendMessageDiscord", 0, 2);
    expect(sendOptions.suppressEmbeds).toBe(false);
  });

  it("warns instead of renaming when threadName is provided but channel management is disabled", async () => {
    sendMessageDiscord.mockResolvedValueOnce({
      messageId: "M1",
      channelId: "T1",
    });

    const messagesOnly = (key: keyof DiscordActionConfig) => key === "messages";
    const result = await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:T1",
        content: "hello",
        threadName: "new-thread",
      },
      messagesOnly,
    );

    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    expect(fetchChannelInfoDiscord).not.toHaveBeenCalled();
    expect(editChannelDiscord).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      ok: true,
      result: {
        messageId: "M1",
        channelId: "T1",
      },
      warning: "Discord threadName was ignored because Discord channel management is disabled.",
    });
  });

  it("warns instead of renaming when threadName is provided for a non-thread send target", async () => {
    sendMessageDiscord.mockResolvedValueOnce({
      messageId: "M1",
      channelId: "C1",
    });
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "C1",
      type: 0,
    });

    const result = await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:C1",
        content: "hello",
        threadName: "new-thread",
      },
      enableAllActions,
    );

    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("C1", { cfg: DISCORD_TEST_CFG });
    expect(editChannelDiscord).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      ok: true,
      result: {
        messageId: "M1",
        channelId: "C1",
      },
      warning: "Discord threadName was ignored because the send target is not a thread.",
    });
  });

  it("preserves message delivery and warns when thread rename fails", async () => {
    sendMessageDiscord.mockResolvedValueOnce({
      messageId: "M1",
      channelId: "T1",
    });
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "T1",
      type: 11,
    });
    editChannelDiscord.mockRejectedValueOnce(new Error("missing permissions"));

    const result = await handleMessagingAction(
      "sendMessage",
      {
        to: "channel:T1",
        content: "hello",
        threadName: "new-thread",
      },
      enableAllActions,
    );

    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    expect(editChannelDiscord).toHaveBeenCalledWith(
      {
        channelId: "T1",
        name: "new-thread",
      },
      { cfg: DISCORD_TEST_CFG },
    );
    expect(result.details).toEqual({
      ok: true,
      result: {
        messageId: "M1",
        channelId: "T1",
      },
      warning: "Discord message was sent, but thread rename failed: missing permissions",
    });
  });

  it("rejects voice messages that include content", async () => {
    await expect(
      handleMessagingAction(
        "sendMessage",
        {
          to: "channel:123",
          mediaUrl: "/tmp/voice.mp3",
          asVoice: true,
          content: "hello",
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Voice messages cannot include text content/);
  });

  it("forwards optional thread content", async () => {
    createThreadDiscord.mockClear();
    await handleMessagingAction(
      "threadCreate",
      {
        channelId: "C1",
        name: "Forum thread",
        content: "Initial forum post body",
      },
      enableAllActions,
    );
    expect(createThreadDiscord).toHaveBeenCalledWith(
      "C1",
      {
        name: "Forum thread",
        messageId: undefined,
        autoArchiveMinutes: undefined,
        content: "Initial forum post body",
        appliedTags: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("returns partial success when Discord creates the thread but initial message send fails", async () => {
    const thread = { id: "T1", name: "thread", type: 11 };
    createThreadDiscord.mockRejectedValueOnce(
      new DiscordThreadInitialMessageError(
        thread as ConstructorParameters<typeof DiscordThreadInitialMessageError>[0],
        new Error("missing access"),
      ),
    );

    const result = await handleMessagingAction(
      "threadCreate",
      {
        channelId: "C1",
        name: "thread",
        content: "Initial post",
      },
      enableAllActions,
    );

    expect(result.details).toEqual({
      ok: true,
      partial: true,
      thread,
      warning: "Discord thread was created, but sending the initial message failed.",
      initialMessageError: "missing access",
    });
  });
});

describe("handleDiscordGuildAction", () => {
  it("uses configured defaultAccount for omitted memberInfo presence lookup", async () => {
    setPresence("work", "U1", {
      user: { id: "U1" },
      guild_id: "G1",
      status: "online",
      activities: [],
      client_status: {},
    } as never);

    discordGuildActionRuntime.fetchMemberInfoDiscord = vi.fn(async () => ({
      user: { id: "U1" },
    })) as never;

    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: {
            work: { token: "token-work" },
          },
        },
      },
    } as OpenClawConfig;
    const result = await handleGuildAction(
      "memberInfo",
      {
        guildId: "G1",
        userId: "U1",
      },
      enableAllActions,
      cfg,
    );

    expect(discordGuildActionRuntime.fetchMemberInfoDiscord).toHaveBeenCalledWith("G1", "U1", {
      cfg,
      accountId: "work",
    });
    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(true);
    expect(details.status).toBe("online");
    expect(details.activities).toEqual([]);
  });

  it.each([
    {
      action: "memberInfo",
      params: { guildId: "333", userId: "U1" },
      runtimeCall: fetchMemberInfoDiscord,
    },
    { action: "roleInfo", params: { guildId: "333" }, runtimeCall: fetchRoleInfoDiscord },
    { action: "emojiList", params: { guildId: "333" }, runtimeCall: listGuildEmojisDiscord },
    { action: "channelList", params: { guildId: "333" }, runtimeCall: listGuildChannelsDiscord },
    {
      action: "voiceStatus",
      params: { guildId: "333", userId: "U1" },
      runtimeCall: fetchVoiceStatusDiscord,
    },
    { action: "eventList", params: { guildId: "333" }, runtimeCall: listScheduledEventsDiscord },
  ])(
    "rejects Discord guild metadata action $action for non-allowlisted guilds",
    async ({ action, params, runtimeCall }) => {
      const cfg = discordAllowlistCfg({
        "111": {
          channels: {
            "*": { enabled: true },
          },
        },
      });

      await expect(handleGuildAction(action, params, enableAllActions, cfg)).rejects.toThrow(
        "Discord read target channel is not allowed.",
      );
      expect(runtimeCall).not.toHaveBeenCalled();
    },
  );

  it("requires a guild-wide allowlist for Discord guild metadata reads", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleGuildAction("memberInfo", { guildId: "111", userId: "U1" }, enableAllActions, cfg),
    ).rejects.toThrow(
      "Discord guild metadata reads require a wildcard channel allowlist for this guild.",
    );
    expect(fetchMemberInfoDiscord).not.toHaveBeenCalled();
  });

  it("allows Discord guild metadata reads when the guild has a wildcard channel allowlist", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "*": { enabled: true },
        },
      },
    });

    await handleGuildAction("roleInfo", { guildId: "111" }, enableAllActions, cfg);

    expect(fetchRoleInfoDiscord).toHaveBeenCalledWith("111", { cfg });
  });

  it("lets a direct operator read metadata for an unconfigured Discord guild", async () => {
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "*": { enabled: true },
        },
      },
    });

    await handleGuildAction("roleInfo", { guildId: "333" }, enableAllActions, cfg, {
      conversationReadOrigin: "direct-operator",
    });

    expect(fetchRoleInfoDiscord).toHaveBeenCalledWith("333", { cfg });
  });

  it("omits explicitly disabled channels from a direct operator channel list", async () => {
    const channels = [
      { id: "222", name: "configured", type: ChannelType.GuildText },
      { id: "333", name: "disabled", type: ChannelType.GuildText },
      { id: "444", name: "unconfigured", type: ChannelType.GuildText },
    ];
    listGuildChannelsDiscord.mockResolvedValueOnce(channels);
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
          disabled: { enabled: false },
        },
      },
    });

    const result = await handleGuildAction(
      "channelList",
      { guildId: "111" },
      enableAllActions,
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(result.details).toEqual({
      ok: true,
      channels: [channels[0], channels[2]],
    });
  });

  it("omits descendants of disabled parents from a direct operator channel list", async () => {
    const channels = [
      { id: "222", name: "private", type: ChannelType.GuildCategory },
      {
        id: "333",
        name: "private-child",
        parent_id: "222",
        type: ChannelType.GuildText,
      },
      {
        id: "555",
        name: "private-thread",
        parent_id: "333",
        type: ChannelType.GuildPublicThread,
      },
      { id: "444", name: "public", type: ChannelType.GuildText },
    ];
    listGuildChannelsDiscord.mockResolvedValueOnce(channels);
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          private: { enabled: false },
        },
      },
    });

    const result = await handleGuildAction(
      "channelList",
      { guildId: "111" },
      enableAllActions,
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(result.details).toEqual({
      ok: true,
      channels: [channels[3]],
    });
  });

  it("rejects Discord channel info reads for non-allowlisted target channels", async () => {
    fetchChannelInfoDiscord.mockResolvedValue({
      id: "333",
      guild_id: "111",
      name: "private",
      type: 0,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await expect(
      handleGuildAction("channelInfo", { channelId: "333" }, channelInfoEnabled, cfg),
    ).rejects.toThrow("Discord read target channel is not allowed.");
    expect(fetchChannelInfoDiscord).toHaveBeenCalledTimes(1);
  });

  it("allows Discord channel info reads for allowlisted target channels", async () => {
    fetchChannelInfoDiscord.mockResolvedValue({
      id: "222",
      guild_id: "111",
      name: "allowed",
      type: 0,
    });
    const cfg = discordAllowlistCfg({
      "111": {
        channels: {
          "222": { enabled: true },
        },
      },
    });

    await handleGuildAction("channelInfo", { channelId: "222" }, channelInfoEnabled, cfg);

    expect(fetchChannelInfoDiscord).toHaveBeenCalledTimes(2);
    expect(mockCall(fetchChannelInfoDiscord, "fetchChannelInfoDiscord", 1)).toEqual([
      "222",
      { cfg },
    ]);
  });
});

const channelsEnabled = (key: keyof DiscordActionConfig) => key === "channels";
const channelsDisabled = () => false;

describe("handleDiscordGuildAction - channel management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a channel", async () => {
    const result = await handleGuildAction(
      "channelCreate",
      {
        guildId: "G1",
        name: "test-channel",
        type: 0,
        topic: "Test topic",
      },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith(
      {
        guildId: "G1",
        name: "test-channel",
        type: 0,
        parentId: undefined,
        topic: "Test topic",
        position: undefined,
        nsfw: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
    expect(result.details).toEqual({
      ok: true,
      channel: {
        id: "new-channel",
        name: "test",
        type: 0,
      },
    });
  });

  it("prefers channelType when creating a channel", async () => {
    await handleGuildAction(
      "channelCreate",
      {
        guildId: "G1",
        name: "forum-thread",
        channelType: 11,
        type: 0,
      },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "G1",
        name: "forum-thread",
        type: 11,
      }),
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("respects channel gating for channelCreate", async () => {
    await expect(
      handleGuildAction("channelCreate", { guildId: "G1", name: "test" }, channelsDisabled),
    ).rejects.toThrow(/Discord channel management is disabled/);
  });

  it("preserves trusted owner/manual channel actions without sender ids", async () => {
    await handleGuildAction("channelDelete", { channelId: "C1" }, channelsEnabled);

    expect(hasAnyChannelPermissionDiscord).not.toHaveBeenCalled();
    expect(hasAnyGuildPermissionDiscord).not.toHaveBeenCalled();
    expect(deleteChannelDiscord).toHaveBeenCalledWith("C1", { cfg: DISCORD_TEST_CFG });
  });

  it("rejects Discord sender channel actions when sender lacks MANAGE_CHANNELS", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "C1",
      type: 0,
      guild_id: "G1",
    });
    hasAnyChannelPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleGuildAction(
        "channelDelete",
        { channelId: "C1", senderUserId: "sender-1", accountId: "ops" },
        channelsEnabled,
      ),
    ).rejects.toThrow(/required permissions/);

    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("C1", {
      cfg: DISCORD_TEST_CFG,
      accountId: "ops",
    });
    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "C1",
      "sender-1",
      [PermissionFlagsBits.ManageChannels],
      { cfg: DISCORD_TEST_CFG, accountId: "ops" },
    );
    expect(hasAnyGuildPermissionDiscord).not.toHaveBeenCalled();
    expect(deleteChannelDiscord).not.toHaveBeenCalled();
  });

  it("uses guild permissions for Discord sender channel create actions", async () => {
    await handleGuildAction(
      "channelCreate",
      { guildId: "G1", name: "test", senderUserId: "sender-1", accountId: "ops" },
      channelsEnabled,
    );

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "sender-1",
      [PermissionFlagsBits.ManageChannels],
      { cfg: DISCORD_TEST_CFG, accountId: "ops" },
    );
    expect(hasAnyChannelPermissionDiscord).not.toHaveBeenCalled();
    expect(createChannelDiscord).toHaveBeenCalled();
  });

  it("uses thread permissions for Discord sender thread edits", async () => {
    const threadChannel = {
      id: "T1",
      type: ChannelType.GuildPublicThread,
      guild_id: "G1",
    };
    fetchChannelInfoDiscord
      .mockResolvedValueOnce(threadChannel)
      .mockResolvedValueOnce(threadChannel);

    await handleGuildAction(
      "channelEdit",
      { channelId: "T1", archived: true, senderUserId: "sender-1" },
      channelsEnabled,
    );

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "T1",
      "sender-1",
      [PermissionFlagsBits.ManageThreads],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(editChannelDiscord).toHaveBeenCalled();
  });

  it("requires ManageThreads for Discord sender thread unlocks", async () => {
    const threadChannel = {
      id: "T1",
      type: ChannelType.GuildPublicThread,
      guild_id: "G1",
    };
    fetchChannelInfoDiscord
      .mockResolvedValueOnce(threadChannel)
      .mockResolvedValueOnce(threadChannel);

    await handleGuildAction(
      "channelEdit",
      { channelId: "T1", locked: false, senderUserId: "sender-1" },
      channelsEnabled,
    );

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "T1",
      "sender-1",
      [PermissionFlagsBits.ManageThreads],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(editChannelDiscord).toHaveBeenCalled();
  });

  it("requires ManageThreads to reopen locked Discord sender threads", async () => {
    const threadChannel = {
      id: "T1",
      type: ChannelType.GuildPublicThread,
      guild_id: "G1",
      thread_metadata: { locked: true },
    };
    fetchChannelInfoDiscord
      .mockResolvedValueOnce(threadChannel)
      .mockResolvedValueOnce(threadChannel);

    await handleGuildAction(
      "channelEdit",
      { channelId: "T1", archived: false, senderUserId: "sender-1" },
      channelsEnabled,
    );

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "T1",
      "sender-1",
      [PermissionFlagsBits.ManageThreads],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(editChannelDiscord).toHaveBeenCalled();
  });

  it("allows SendMessagesInThreads for unlocked Discord sender thread reopens", async () => {
    const threadChannel = {
      id: "T1",
      type: ChannelType.GuildPublicThread,
      guild_id: "G1",
      thread_metadata: { locked: false },
    };
    fetchChannelInfoDiscord
      .mockResolvedValueOnce(threadChannel)
      .mockResolvedValueOnce(threadChannel);

    await handleGuildAction(
      "channelEdit",
      { channelId: "T1", archived: false, senderUserId: "sender-1" },
      channelsEnabled,
    );

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "T1",
      "sender-1",
      [PermissionFlagsBits.ManageThreads, PermissionFlagsBits.SendMessagesInThreads],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(editChannelDiscord).toHaveBeenCalled();
  });

  it("uses channel event permissions for Discord sender channel events", async () => {
    await handleGuildAction(
      "eventCreate",
      {
        guildId: "G1",
        channelId: "C1",
        name: "standup",
        startTime: "2026-05-27T12:00:00.000Z",
        senderUserId: "sender-1",
      },
      (key) => key === "events",
    );

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "C1",
      "sender-1",
      [PermissionFlagsBits.ManageEvents, PermissionFlagsBits.CreateEvents],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(hasAnyGuildPermissionDiscord).not.toHaveBeenCalled();
    expect(createScheduledEventDiscord).toHaveBeenCalled();
  });

  it("reports disabled channel actions before Discord permission lookups", async () => {
    await expect(
      handleGuildAction(
        "channelDelete",
        { channelId: "C1", senderUserId: "sender-1" },
        channelsDisabled,
      ),
    ).rejects.toThrow(/Discord channel management is disabled/);

    expect(fetchChannelInfoDiscord).not.toHaveBeenCalled();
    expect(hasAnyChannelPermissionDiscord).not.toHaveBeenCalled();
    expect(hasAnyGuildPermissionDiscord).not.toHaveBeenCalled();
    expect(deleteChannelDiscord).not.toHaveBeenCalled();
  });

  it("preserves trusted owner/manual role actions without sender ids", async () => {
    await handleGuildAction("roleAdd", { guildId: "G1", userId: "U1", roleId: "R1" }, rolesEnabled);

    expect(hasAnyGuildPermissionDiscord).not.toHaveBeenCalled();
    expect(canManageGuildMemberRoleDiscord).not.toHaveBeenCalled();
    expect(addRoleDiscord).toHaveBeenCalledWith(
      { guildId: "G1", userId: "U1", roleId: "R1" },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("rejects Discord sender role actions when sender cannot manage the role hierarchy", async () => {
    canManageGuildMemberRoleDiscord.mockResolvedValueOnce(false);

    await expect(
      handleGuildAction(
        "roleAdd",
        { guildId: "G1", userId: "U1", roleId: "R1", senderUserId: "sender-1" },
        rolesEnabled,
      ),
    ).rejects.toThrow(/cannot manage/);

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "sender-1",
      [PermissionFlagsBits.ManageRoles],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(canManageGuildMemberRoleDiscord).toHaveBeenCalledWith(
      "G1",
      "sender-1",
      "U1",
      "R1",
      { cfg: DISCORD_TEST_CFG },
      { assignablePermissionCeiling: true },
    );
    expect(addRoleDiscord).not.toHaveBeenCalled();
  });

  it("forwards accountId for channelList", async () => {
    await handleGuildAction("channelList", { guildId: "G1", accountId: "ops" }, channelInfoEnabled);
    expect(listGuildChannelsDiscord).toHaveBeenCalledWith("G1", {
      cfg: DISCORD_TEST_CFG,
      accountId: "ops",
    });
  });

  it("edits a channel", async () => {
    await handleGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        name: "new-name",
        topic: "new topic",
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith(
      {
        channelId: "C1",
        name: "new-name",
        topic: "new topic",
        position: undefined,
        parentId: undefined,
        nsfw: undefined,
        rateLimitPerUser: undefined,
        archived: undefined,
        locked: undefined,
        autoArchiveDuration: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("forwards thread edit fields", async () => {
    await handleGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith(
      {
        channelId: "C1",
        name: undefined,
        topic: undefined,
        position: undefined,
        parentId: undefined,
        nsfw: undefined,
        rateLimitPerUser: undefined,
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("rejects fractional Discord channel edit integers before editing channels", async () => {
    await expect(
      handleGuildAction(
        "channelEdit",
        {
          channelId: "C1",
          position: 1.5,
        },
        channelsEnabled,
      ),
    ).rejects.toThrow("position must be a non-negative integer");
    expect(editChannelDiscord).not.toHaveBeenCalled();
  });

  it.each([
    ["parentId is null", { parentId: null }],
    ["clearParent is true", { clearParent: true }],
  ])("clears the channel parent when %s", async (_label, payload) => {
    await handleGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        ...payload,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith(
      {
        channelId: "C1",
        name: undefined,
        topic: undefined,
        position: undefined,
        parentId: null,
        nsfw: undefined,
        rateLimitPerUser: undefined,
        archived: undefined,
        locked: undefined,
        autoArchiveDuration: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("deletes a channel", async () => {
    await handleGuildAction("channelDelete", { channelId: "C1" }, channelsEnabled);
    expect(deleteChannelDiscord).toHaveBeenCalledWith("C1", { cfg: DISCORD_TEST_CFG });
  });

  it("moves a channel", async () => {
    await handleGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        parentId: "P1",
        position: 5,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith(
      {
        guildId: "G1",
        channelId: "C1",
        parentId: "P1",
        position: 5,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("rejects fractional Discord channel move positions before moving channels", async () => {
    await expect(
      handleGuildAction(
        "channelMove",
        {
          guildId: "G1",
          channelId: "C1",
          position: "5.5",
        },
        channelsEnabled,
      ),
    ).rejects.toThrow("position must be a non-negative integer");
    expect(moveChannelDiscord).not.toHaveBeenCalled();
  });

  it.each([
    ["parentId is null", { parentId: null }],
    ["clearParent is true", { clearParent: true }],
  ])("clears the channel parent on move when %s", async (_label, payload) => {
    await handleGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        ...payload,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith(
      {
        guildId: "G1",
        channelId: "C1",
        parentId: null,
        position: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("creates a category with type=4", async () => {
    await handleGuildAction(
      "categoryCreate",
      { guildId: "G1", name: "My Category" },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith(
      {
        guildId: "G1",
        name: "My Category",
        type: 4,
        position: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("edits a category", async () => {
    await handleGuildAction(
      "categoryEdit",
      { categoryId: "CAT1", name: "Renamed Category" },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith(
      {
        channelId: "CAT1",
        name: "Renamed Category",
        position: undefined,
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("deletes a category", async () => {
    await handleGuildAction("categoryDelete", { categoryId: "CAT1" }, channelsEnabled);
    expect(deleteChannelDiscord).toHaveBeenCalledWith("CAT1", { cfg: DISCORD_TEST_CFG });
  });

  it.each([
    {
      name: "role",
      params: {
        channelId: "C1",
        targetId: "R1",
        targetType: "role" as const,
        allow: "1024",
        deny: "2048",
      },
      expected: {
        channelId: "C1",
        targetId: "R1",
        targetType: 0,
        allow: "1024",
        deny: "2048",
      },
    },
    {
      name: "member",
      params: {
        channelId: "C1",
        targetId: "U1",
        targetType: "member" as const,
        allow: "1024",
      },
      expected: {
        channelId: "C1",
        targetId: "U1",
        targetType: 1,
        allow: "1024",
        deny: undefined,
      },
    },
  ])("sets channel permissions for $name", async ({ params, expected }) => {
    await handleGuildAction("channelPermissionSet", params, channelsEnabled);
    expect(setChannelPermissionDiscord).toHaveBeenCalledWith(expected, {
      cfg: DISCORD_TEST_CFG,
    });
  });

  it("uses channel-scoped ManageRoles for Discord sender channel permission edits", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "C1",
      type: 0,
      guild_id: "G1",
    });

    await handleGuildAction(
      "channelPermissionSet",
      {
        channelId: "C1",
        targetId: "R1",
        targetType: "role",
        allow: "1024",
        senderUserId: "sender-1",
      },
      channelsEnabled,
    );

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "C1",
      "sender-1",
      [PermissionFlagsBits.ManageRoles],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(setChannelPermissionDiscord).toHaveBeenCalled();
  });

  it("rejects Discord sender role overwrites above the sender role hierarchy", async () => {
    fetchChannelInfoDiscord.mockResolvedValueOnce({
      id: "C1",
      type: 0,
      guild_id: "G1",
    });
    canManageGuildRoleDiscord.mockResolvedValueOnce(false);

    await expect(
      handleGuildAction(
        "channelPermissionSet",
        {
          channelId: "C1",
          targetId: "R1",
          targetType: "role",
          allow: "1024",
          senderUserId: "sender-1",
        },
        channelsEnabled,
      ),
    ).rejects.toThrow(/role overwrite/);

    expect(canManageGuildRoleDiscord).toHaveBeenCalledWith("G1", "sender-1", "R1", {
      cfg: DISCORD_TEST_CFG,
    });
    expect(setChannelPermissionDiscord).not.toHaveBeenCalled();
  });

  it("removes channel permissions", async () => {
    await handleGuildAction(
      "channelPermissionRemove",
      { channelId: "C1", targetId: "R1" },
      channelsEnabled,
    );
    expect(removeChannelPermissionDiscord).toHaveBeenCalledWith("C1", "R1", {
      cfg: DISCORD_TEST_CFG,
    });
  });
});

describe("handleDiscordModerationAction", () => {
  it("forwards accountId for timeout", async () => {
    await handleModerationAction(
      "timeout",
      {
        guildId: "G1",
        userId: "U1",
        durationMinutes: 5,
        accountId: "ops",
      },
      moderationEnabled,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledTimes(1);
    const params = mockObjectArg(timeoutMemberDiscord, "timeoutMemberDiscord", 0, 0);
    expect(params.guildId).toBe("G1");
    expect(params.userId).toBe("U1");
    expect(params.durationMinutes).toBe(5);
    expect(mockCall(timeoutMemberDiscord, "timeoutMemberDiscord")[1]).toEqual({
      cfg: DISCORD_TEST_CFG,
      accountId: "ops",
    });
  });

  it("rejects fractional Discord moderation durations before timing out members", async () => {
    await expect(
      handleModerationAction(
        "timeout",
        {
          guildId: "G1",
          userId: "U1",
          durationMinutes: 5.5,
        },
        moderationEnabled,
      ),
    ).rejects.toThrow("durationMinutes must be a non-negative integer");
    expect(timeoutMemberDiscord).not.toHaveBeenCalled();
  });

  it("preserves zero-minute Discord timeouts for clearing existing timeouts", async () => {
    await handleModerationAction(
      "timeout",
      {
        guildId: "G1",
        userId: "U1",
        durationMinutes: 0,
      },
      moderationEnabled,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledTimes(1);
    const params = mockObjectArg(timeoutMemberDiscord, "timeoutMemberDiscord", 0, 0);
    expect(params.durationMinutes).toBe(0);
  });
});

describe("handleDiscordAction per-account gating", () => {
  it("allows moderation when account config enables it", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { token: "tok-ops", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { action: "timeout", guildId: "G1", userId: "U1", durationMinutes: 5, accountId: "ops" },
      cfg,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledTimes(1);
    const params = mockObjectArg(timeoutMemberDiscord, "timeoutMemberDiscord", 0, 0);
    expect(params.guildId).toBe("G1");
    expect(params.userId).toBe("U1");
    expect(mockCall(timeoutMemberDiscord, "timeoutMemberDiscord")[1]).toEqual({
      cfg,
      accountId: "ops",
    });
  });

  it("blocks moderation when account omits it", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            chat: { token: "tok-chat" },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleDiscordAction(
        { action: "timeout", guildId: "G1", userId: "U1", durationMinutes: 5, accountId: "chat" },
        cfg,
      ),
    ).rejects.toThrow(/Discord moderation is disabled/);
  });

  it("uses account-merged config, not top-level config", async () => {
    // Top-level has no moderation, but the account does
    const cfg = {
      channels: {
        discord: {
          token: "tok-base",
          accounts: {
            ops: { token: "tok-ops", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { action: "kick", guildId: "G1", userId: "U1", accountId: "ops" },
      cfg,
    );
    expect(kickMemberDiscord).toHaveBeenCalled();
  });

  it("inherits top-level channel gate when account overrides moderation only", async () => {
    const cfg = {
      channels: {
        discord: {
          actions: { channels: false },
          accounts: {
            ops: { token: "tok-ops", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleDiscordAction(
        { action: "channelCreate", guildId: "G1", name: "alerts", accountId: "ops" },
        cfg,
      ),
    ).rejects.toThrow(/channel management is disabled/i);
  });

  it("allows account to explicitly re-enable top-level disabled channel gate", async () => {
    const cfg = {
      channels: {
        discord: {
          actions: { channels: false },
          accounts: {
            ops: {
              token: "tok-ops",
              actions: { moderation: true, channels: true },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { action: "channelCreate", guildId: "G1", name: "alerts", accountId: "ops" },
      cfg,
    );

    expect(createChannelDiscord).toHaveBeenCalledTimes(1);
    const params = mockObjectArg(createChannelDiscord, "createChannelDiscord", 0, 0);
    expect(params.guildId).toBe("G1");
    expect(params.name).toBe("alerts");
    expect(mockCall(createChannelDiscord, "createChannelDiscord")[1]).toEqual({
      cfg,
      accountId: "ops",
    });
  });
});
