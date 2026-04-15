import type { RequestClient } from "@buape/carbon";
import { PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockRest = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client.js", () => ({
  resolveDiscordRest: () => mockRest as unknown as RequestClient,
}));

let fetchMemberGuildPermissionsDiscord: typeof import("./send.permissions.js").fetchMemberGuildPermissionsDiscord;
let hasAllGuildPermissionsDiscord: typeof import("./send.permissions.js").hasAllGuildPermissionsDiscord;
let hasAnyGuildPermissionDiscord: typeof import("./send.permissions.js").hasAnyGuildPermissionDiscord;

type RouteMockParams = {
  guildId?: string;
  userId?: string;
  roles: Array<{ id: string; permissions: string | bigint }>;
  memberRoles: string[];
};

function mockGuildMemberRoutes(params: RouteMockParams): void {
  const guildId = params.guildId ?? "guild-1";
  const userId = params.userId ?? "user-1";
  mockRest.get.mockImplementation(async (route: string) => {
    if (route === Routes.guild(guildId)) {
      return {
        id: guildId,
        roles: params.roles.map((role) => ({
          id: role.id,
          permissions:
            typeof role.permissions === "bigint" ? role.permissions.toString() : role.permissions,
        })),
      };
    }
    if (route === Routes.guildMember(guildId, userId)) {
      return { id: userId, roles: params.memberRoles };
    }
    throw new Error(`Unexpected route: ${route}`);
  });
}

describe("discord guild permission authorization", () => {
  beforeAll(async () => {
    ({
      fetchMemberGuildPermissionsDiscord,
      hasAllGuildPermissionsDiscord,
      hasAnyGuildPermissionDiscord,
    } = await import("./send.permissions.js"));
  });

  beforeEach(() => {
    mockRest.get.mockReset();
  });

  describe("fetchMemberGuildPermissionsDiscord", () => {
    it("returns null when user is not a guild member", async () => {
      mockRest.get.mockRejectedValueOnce(new Error("404 Member not found"));

      const result = await fetchMemberGuildPermissionsDiscord("guild-1", "user-1");
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

      const result = await fetchMemberGuildPermissionsDiscord("guild-1", "user-1");
      expect(result).not.toBeNull();
      expect((result! & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel).toBe(
        true,
      );
      expect((result! & PermissionFlagsBits.KickMembers) === PermissionFlagsBits.KickMembers).toBe(
        true,
      );
    });
  });

  describe("hasAnyGuildPermissionDiscord", () => {
    it("returns true when user has required permission", async () => {
      mockGuildMemberRoutes({
        roles: [
          { id: "guild-1", permissions: "0" },
          { id: "role-mod", permissions: PermissionFlagsBits.KickMembers },
        ],
        memberRoles: ["role-mod"],
      });

      const result = await hasAnyGuildPermissionDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
      ]);
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

      const result = await hasAnyGuildPermissionDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
      ]);
      expect(result).toBe(true);
    });

    it("returns false when user lacks all required permissions", async () => {
      mockGuildMemberRoutes({
        roles: [{ id: "guild-1", permissions: PermissionFlagsBits.ViewChannel }],
        memberRoles: [],
      });

      const result = await hasAnyGuildPermissionDiscord("guild-1", "user-1", [
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
      ]);
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

      const result = await hasAllGuildPermissionsDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
      ]);
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

      const result = await hasAllGuildPermissionsDiscord("guild-1", "user-1", [
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
      ]);
      expect(result).toBe(true);
    });
  });
});
