import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "./internal/discord.js";
import { EMPTY_DISCORD_TEST_OPTS } from "./test-support/config.js";

const mockRest = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client.js", () => ({
  resolveDiscordRest: () => mockRest as unknown as RequestClient,
}));

let fetchMemberGuildPermissionsDiscord: typeof import("./send.permissions.js").fetchMemberGuildPermissionsDiscord;
let canManageGuildRoleDiscord: typeof import("./send.permissions.js").canManageGuildRoleDiscord;
let canManageGuildMemberRoleDiscord: typeof import("./send.permissions.js").canManageGuildMemberRoleDiscord;
let hasAllGuildPermissionsDiscord: typeof import("./send.permissions.js").hasAllGuildPermissionsDiscord;
let hasAnyChannelPermissionDiscord: typeof import("./send.permissions.js").hasAnyChannelPermissionDiscord;
let hasAnyGuildPermissionDiscord: typeof import("./send.permissions.js").hasAnyGuildPermissionDiscord;

type RouteMockParams = {
  guildId?: string;
  channelId?: string;
  channelGuildId?: string;
  channelType?: number;
  ownerId?: string;
  parentChannelId?: string;
  userId?: string;
  targetUserId?: string;
  roles: Array<{ id: string; permissions: string | bigint; position?: number }>;
  memberRoles: string[];
  targetMemberRoles?: string[];
  channelPermissionOverwrites?: Array<{
    id: string;
    type: number;
    allow?: string | bigint;
    deny?: string | bigint;
  }>;
  parentPermissionOverwrites?: Array<{
    id: string;
    type: number;
    allow?: string | bigint;
    deny?: string | bigint;
  }>;
};

function permissionString(value?: string | bigint) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function mockGuildMemberRoutes(params: RouteMockParams): void {
  const guildId = params.guildId ?? "guild-1";
  const channelId = params.channelId ?? "channel-1";
  const userId = params.userId ?? "user-1";
  mockRest.get.mockImplementation(async (route: string) => {
    if (route === Routes.channel(channelId)) {
      return {
        id: channelId,
        type: params.channelType ?? 0,
        guild_id: params.channelGuildId ?? guildId,
        parent_id: params.parentChannelId,
        permission_overwrites: params.channelPermissionOverwrites?.map((overwrite) => ({
          ...overwrite,
          allow: permissionString(overwrite.allow),
          deny: permissionString(overwrite.deny),
        })),
      };
    }
    if (params.parentChannelId && route === Routes.channel(params.parentChannelId)) {
      return {
        id: params.parentChannelId,
        type: 0,
        guild_id: params.channelGuildId ?? guildId,
        permission_overwrites: params.parentPermissionOverwrites?.map((overwrite) => ({
          ...overwrite,
          allow: permissionString(overwrite.allow),
          deny: permissionString(overwrite.deny),
        })),
      };
    }
    if (route === Routes.guild(guildId)) {
      return {
        id: guildId,
        owner_id: params.ownerId ?? "owner-1",
        roles: params.roles.map((role) => ({
          id: role.id,
          permissions:
            typeof role.permissions === "bigint" ? role.permissions.toString() : role.permissions,
          position: role.position ?? 0,
        })),
      };
    }
    if (route === Routes.guildMember(guildId, userId)) {
      return { id: userId, roles: params.memberRoles };
    }
    if (params.targetUserId && route === Routes.guildMember(guildId, params.targetUserId)) {
      return { id: params.targetUserId, roles: params.targetMemberRoles ?? [] };
    }
    throw new Error(`Unexpected route: ${route}`);
  });
}

describe("discord guild permission authorization", () => {
  beforeAll(async () => {
    ({
      fetchMemberGuildPermissionsDiscord,
      canManageGuildRoleDiscord,
      canManageGuildMemberRoleDiscord,
      hasAllGuildPermissionsDiscord,
      hasAnyChannelPermissionDiscord,
      hasAnyGuildPermissionDiscord,
    } = await import("./send.permissions.js"));
  });

  beforeEach(() => {
    mockRest.get.mockReset();
  });

  describe("canManageGuildRoleDiscord", () => {
    it("rejects a sender below the target role", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: "0", position: 0 },
          { id: "role-mod", permissions: PermissionFlagsBits.ManageRoles, position: 5 },
          { id: "role-admin", permissions: "0", position: 10 },
        ],
        memberRoles: ["role-mod"],
      });

      const result = await canManageGuildRoleDiscord(
        "guild-1",
        "user-1",
        "role-admin",
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });
  });

  describe("canManageGuildMemberRoleDiscord", () => {
    it("allows a sender above both the changed role and target member", async () => {
      mockGuildMemberRoutes({
        targetUserId: "target-1",
        roles: [
          { id: "guild-1", permissions: "0", position: 0 },
          { id: "role-mod", permissions: PermissionFlagsBits.ManageRoles, position: 10 },
          { id: "role-low", permissions: "0", position: 4 },
        ],
        memberRoles: ["role-mod"],
        targetMemberRoles: ["role-low"],
      });

      const result = await canManageGuildMemberRoleDiscord(
        "guild-1",
        "user-1",
        "target-1",
        "role-low",
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(true);
    });

    it("rejects a sender below the changed role", async () => {
      mockGuildMemberRoutes({
        targetUserId: "target-1",
        roles: [
          { id: "guild-1", permissions: "0", position: 0 },
          { id: "role-mod", permissions: PermissionFlagsBits.ManageRoles, position: 5 },
          { id: "role-admin", permissions: "0", position: 10 },
        ],
        memberRoles: ["role-mod"],
        targetMemberRoles: [],
      });

      const result = await canManageGuildMemberRoleDiscord(
        "guild-1",
        "user-1",
        "target-1",
        "role-admin",
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });

    it("rejects a non-owner sender changing the guild owner", async () => {
      mockGuildMemberRoutes({
        ownerId: "owner-1",
        targetUserId: "owner-1",
        roles: [
          { id: "guild-1", permissions: "0", position: 0 },
          { id: "role-mod", permissions: PermissionFlagsBits.ManageRoles, position: 10 },
        ],
        memberRoles: ["role-mod"],
        targetMemberRoles: [],
      });

      const result = await canManageGuildMemberRoleDiscord(
        "guild-1",
        "user-1",
        "owner-1",
        "role-mod",
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });

    it("rejects role assignment above the sender's permission bits", async () => {
      mockGuildMemberRoutes({
        targetUserId: "target-1",
        roles: [
          { id: "guild-1", permissions: "0", position: 0 },
          { id: "role-mod", permissions: PermissionFlagsBits.ManageRoles, position: 10 },
          { id: "role-ban", permissions: PermissionFlagsBits.BanMembers, position: 4 },
        ],
        memberRoles: ["role-mod"],
        targetMemberRoles: [],
      });

      const result = await canManageGuildMemberRoleDiscord(
        "guild-1",
        "user-1",
        "target-1",
        "role-ban",
        EMPTY_DISCORD_TEST_OPTS,
        { assignablePermissionCeiling: true },
      );
      expect(result).toBe(false);
    });
  });

  describe("fetchMemberGuildPermissionsDiscord", () => {
    it("returns null when user is not a guild member", async () => {
      mockRest.get.mockRejectedValueOnce(new Error("404 Member not found"));

      const result = await fetchMemberGuildPermissionsDiscord(
        "guild-1",
        "user-1",
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBeNull();
    });

    it("includes @everyone and member roles in computed permissions", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: PermissionFlagsBits.ViewChannel },
          { id: "role-mod", permissions: PermissionFlagsBits.KickMembers },
        ],
        memberRoles: ["role-mod"],
      });

      const result = await fetchMemberGuildPermissionsDiscord(
        "guild-1",
        "user-1",
        EMPTY_DISCORD_TEST_OPTS,
      );
      if (result === null) {
        throw new Error("Expected guild permissions bitfield");
      }
      expect((result & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel).toBe(
        true,
      );
      expect((result & PermissionFlagsBits.KickMembers) === PermissionFlagsBits.KickMembers).toBe(
        true,
      );
    });
  });

  describe("hasAnyGuildPermissionDiscord", () => {
    it("returns true for the guild owner without explicit role bits", async () => {
      mockGuildMemberRoutes({
        ownerId: "user-1",
        roles: [{ id: "guild-1", permissions: "0" }],
        memberRoles: [],
      });

      const result = await hasAnyGuildPermissionDiscord(
        "guild-1",
        "user-1",
        [PermissionFlagsBits.ManageChannels],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(true);
    });

    it("returns true when user has required permission", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: "0" },
          { id: "role-mod", permissions: PermissionFlagsBits.KickMembers },
        ],
        memberRoles: ["role-mod"],
      });

      const result = await hasAnyGuildPermissionDiscord(
        "guild-1",
        "user-1",
        [PermissionFlagsBits.KickMembers],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(true);
    });

    it("returns true when user has ADMINISTRATOR", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: "0" },
          {
            id: "role-admin",
            permissions: PermissionFlagsBits.Administrator,
          },
        ],
        memberRoles: ["role-admin"],
      });

      const result = await hasAnyGuildPermissionDiscord(
        "guild-1",
        "user-1",
        [PermissionFlagsBits.KickMembers],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(true);
    });

    it("returns false when user lacks all required permissions", async () => {
      mockGuildMemberRoutes({
        roles: [{ id: "guild-1", permissions: PermissionFlagsBits.ViewChannel }],
        memberRoles: [],
      });

      const result = await hasAnyGuildPermissionDiscord(
        "guild-1",
        "user-1",
        [PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });
  });

  describe("hasAnyChannelPermissionDiscord", () => {
    it("returns true for the guild owner despite channel overwrites", async () => {
      mockGuildMemberRoutes({
        ownerId: "user-1",
        roles: [{ id: "guild-1", permissions: "0" }],
        memberRoles: [],
        channelPermissionOverwrites: [
          {
            id: "user-1",
            type: 1,
            deny: PermissionFlagsBits.ManageChannels,
          },
        ],
      });

      const result = await hasAnyChannelPermissionDiscord(
        "guild-1",
        "channel-1",
        "user-1",
        [PermissionFlagsBits.ManageChannels],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(true);
    });

    it("applies channel permission overwrites", async () => {
      mockGuildMemberRoutes({
        roles: [{ id: "guild-1", permissions: PermissionFlagsBits.ManageChannels }],
        memberRoles: [],
        channelPermissionOverwrites: [
          {
            id: "user-1",
            type: 1,
            deny: PermissionFlagsBits.ManageChannels,
          },
        ],
      });

      const result = await hasAnyChannelPermissionDiscord(
        "guild-1",
        "channel-1",
        "user-1",
        [PermissionFlagsBits.ManageChannels],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });

    it("applies parent channel overwrites for thread permissions", async () => {
      mockGuildMemberRoutes({
        channelType: ChannelType.GuildPublicThread,
        parentChannelId: "parent-1",
        roles: [{ id: "guild-1", permissions: PermissionFlagsBits.ManageThreads }],
        memberRoles: [],
        parentPermissionOverwrites: [
          {
            id: "user-1",
            type: 1,
            deny: PermissionFlagsBits.ManageThreads,
          },
        ],
      });

      const result = await hasAnyChannelPermissionDiscord(
        "guild-1",
        "channel-1",
        "user-1",
        [PermissionFlagsBits.ManageThreads],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });

    it("returns false when channel belongs to a different guild", async () => {
      mockGuildMemberRoutes({
        channelGuildId: "guild-2",
        roles: [{ id: "guild-1", permissions: PermissionFlagsBits.ManageChannels }],
        memberRoles: [],
      });

      const result = await hasAnyChannelPermissionDiscord(
        "guild-1",
        "channel-1",
        "user-1",
        [PermissionFlagsBits.ManageChannels],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });
  });

  describe("hasAllGuildPermissionsDiscord", () => {
    it("returns false when user has only one of multiple required permissions", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: "0" },
          { id: "role-mod", permissions: PermissionFlagsBits.KickMembers },
        ],
        memberRoles: ["role-mod"],
      });

      const result = await hasAllGuildPermissionsDiscord(
        "guild-1",
        "user-1",
        [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(false);
    });

    it("returns true for hasAll checks when user has ADMINISTRATOR", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: "0" },
          { id: "role-admin", permissions: PermissionFlagsBits.Administrator },
        ],
        memberRoles: ["role-admin"],
      });

      const result = await hasAllGuildPermissionsDiscord(
        "guild-1",
        "user-1",
        [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers],
        EMPTY_DISCORD_TEST_OPTS,
      );
      expect(result).toBe(true);
    });
  });
});
