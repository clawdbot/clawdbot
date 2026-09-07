import {
  ChannelType,
  PermissionFlagsBits,
  type APIMessage,
  type GatewayGuildCreateDispatchData,
} from "discord-api-types/v10";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import { DiscordGuildJoinIntroductionListener } from "./listeners.guild-join.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";

const mocks = vi.hoisted(() => ({
  reportChannelRoomJoin: vi.fn(async () => ({ kind: "posted" as const })),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "molty",
    sessionKey: "agent:molty:discord:channel:system-channel",
  })),
  canViewDiscordGuildChannel: vi.fn(async () => true),
  hasAnyChannelPermissionDiscord: vi.fn(async () => true),
  readMessagesDiscord: vi.fn(async (): Promise<APIMessage[]> => []),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")>()),
  reportChannelRoomJoin: mocks.reportChannelRoomJoin,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: mocks.resolveAgentRoute,
}));

vi.mock("../send.permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.permissions.js")>()),
  canViewDiscordGuildChannel: mocks.canViewDiscordGuildChannel,
  hasAnyChannelPermissionDiscord: mocks.hasAnyChannelPermissionDiscord,
}));

vi.mock("../send.messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.messages.js")>()),
  readMessagesDiscord: mocks.readMessagesDiscord,
}));

function guildCreateEvent(
  overrides: Partial<GatewayGuildCreateDispatchData> = {},
): GatewayGuildCreateDispatchData {
  return {
    id: "guild-1",
    name: "OpenClaw Guild",
    joined_at: new Date().toISOString(),
    system_channel_id: "system-channel",
    channels: [
      {
        id: "fallback-channel",
        name: "fallback",
        topic: "Fallback room",
        type: ChannelType.GuildText,
      },
      {
        id: "system-channel",
        name: "operations",
        topic: "Deployment coordination",
        type: ChannelType.GuildText,
      },
    ] as GatewayGuildCreateDispatchData["channels"],
    ...overrides,
  } as GatewayGuildCreateDispatchData;
}

function createListener(
  overrides: Partial<ConstructorParameters<typeof DiscordGuildJoinIntroductionListener>[0]> = {},
) {
  return new DiscordGuildJoinIntroductionListener({
    cfg: {},
    accountId: "work",
    botUserId: "bot-1",
    groupPolicy: "allowlist",
    guildEntries: {
      "guild-1": {
        requireMention: true,
        users: ["human-1"],
        channels: {
          "system-channel": { enabled: true },
          "fallback-channel": { enabled: true },
        },
      },
    },
    ...overrides,
  });
}

function createClient(): Client {
  return { rest: {}, fetchUser: vi.fn() } as unknown as Client;
}

describe("Discord guild join introductions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canViewDiscordGuildChannel.mockReset().mockResolvedValue(true);
    mocks.hasAnyChannelPermissionDiscord.mockReset().mockResolvedValue(true);
    mocks.readMessagesDiscord.mockReset().mockResolvedValue([]);
  });

  it("introduces the bot in the permitted system channel using readable room context", async () => {
    mocks.readMessagesDiscord.mockResolvedValue([
      {
        content: "Newest deployment",
        author: { username: "casey", global_name: "Casey" },
      } as APIMessage,
      { content: "Older rollout", author: { username: "alex", global_name: null } } as APIMessage,
    ]);

    await createListener().handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledOnce();
    const params = vi.mocked(reportChannelRoomJoin).mock.calls[0]?.[0];
    expect(params).toMatchObject({
      channel: "discord",
      accountId: "work",
      conversationId: "guild-1",
      deliverTo: "channel:system-channel",
      roomAllowed: true,
    });
    expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledWith(
      "guild-1",
      "system-channel",
      "bot-1",
      expect.objectContaining({ accountId: "work" }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "system-channel",
      "bot-1",
      [PermissionFlagsBits.SendMessages],
      expect.objectContaining({ accountId: "work" }),
    );
    await expect(params?.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#operations",
      purpose: "Deployment coordination",
      recentMessages: [
        { sender: "alex", text: "Older rollout" },
        { sender: "Casey", text: "Newest deployment" },
      ],
    });
  });

  it("rejects a guild introduction whose policy changes during permission lookup", async () => {
    const guilds = { "guild-1": { channels: { "system-channel": { enabled: true } } } };
    let cfg: OpenClawConfig = { channels: { discord: { groupPolicy: "allowlist", guilds } } };
    const readPolicy = createDiscordLivePolicyReader({
      cfg,
      accountId: "work",
      readConfig: () => cfg,
      resolvedAllowlist: { guildEntries: guilds, allowFrom: [] },
    });
    const entered = createDeferred<void>();
    const permission = createDeferred<boolean>();
    mocks.canViewDiscordGuildChannel.mockImplementationOnce(() => {
      entered.resolve();
      return permission.promise;
    });
    const listener = createListener({ cfg, readPolicy });
    const pending = listener.handle(guildCreateEvent(), createClient());
    await entered.promise;
    cfg = { channels: { discord: { groupPolicy: "disabled", guilds: {} } } };
    permission.resolve(true);
    await pending;
    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    await listener.handle(guildCreateEvent(), createClient());
    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ roomAllowed: false }),
    );
  });

  it("never introduces the bot for a stale guild-create reconnect snapshot", async () => {
    await createListener().handle(
      guildCreateEvent({ joined_at: new Date(Date.now() - 10 * 60 * 1_000).toISOString() }),
      createClient(),
    );

    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    expect(mocks.canViewDiscordGuildChannel).not.toHaveBeenCalled();
  });

  it("falls back to the first guild text channel the bot can both view and write", async () => {
    mocks.hasAnyChannelPermissionDiscord.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await createListener().handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:fallback-channel", roomAllowed: true }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledTimes(2);
  });

  it("skips a writable policy-denied system channel for an allowed fallback", async () => {
    await createListener({
      guildEntries: {
        "guild-1": { channels: { "fallback-channel": { enabled: true } } },
      },
    }).handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:fallback-channel", roomAllowed: true }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledTimes(2);
  });

  it("keeps the room metadata when Discord denies message-history access", async () => {
    mocks.readMessagesDiscord.mockRejectedValue(new Error("Missing ReadMessageHistory"));

    await createListener().handle(guildCreateEvent(), createClient());

    const params = vi.mocked(reportChannelRoomJoin).mock.calls[0]?.[0];
    await expect(params?.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#operations",
      purpose: "Deployment coordination",
    });
  });

  it("passes actual guild and channel admission to the core instead of sender authorization", async () => {
    await createListener({
      guildEntries: {
        "different-guild": { channels: { "system-channel": { enabled: true } } },
      },
    }).handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:system-channel", roomAllowed: false }),
    );
  });

  it("skips a guild with no writable text destination", async () => {
    mocks.canViewDiscordGuildChannel.mockResolvedValue(false);
    const logger = { info: vi.fn() };

    await createListener({ logger }).handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    expect(mocks.hasAnyChannelPermissionDiscord).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Discord guild join introduction skipped: no writable text channel",
      { guildId: "guild-1", accountId: "work" },
    );
  });
});
