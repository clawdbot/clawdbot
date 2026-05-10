import { describe, expect, it } from "vitest";
import { checkTwitchAccessControl } from "./access-control.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

describe("checkTwitchAccessControl", () => {
  const mockAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "test",
    clientId: "test-client-id",
    channel: "testchannel",
  };

  const mockMessage: TwitchChatMessage = {
    username: "testuser",
    userId: "123456",
    message: "hello bot",
    channel: "testchannel",
  };

  function runAccessCheck(params: {
    account?: Partial<TwitchAccountConfig>;
    message?: Partial<TwitchChatMessage>;
  }) {
    return checkTwitchAccessControl({
      message: {
        ...mockMessage,
        ...params.message,
      },
      account: {
        ...mockAccount,
        ...params.account,
      },
      botUsername: "testbot",
    });
  }

  async function expectSingleRoleAllowed(params: {
    role: NonNullable<TwitchAccountConfig["allowedRoles"]>[number];
    message: Partial<TwitchChatMessage>;
  }) {
    const result = await runAccessCheck({
      account: { allowedRoles: [params.role] },
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(true);
    return result;
  }

  async function expectAllowedAccessCheck(params: {
    account?: Partial<TwitchAccountConfig>;
    message?: Partial<TwitchChatMessage>;
  }) {
    const result = await runAccessCheck({
      account: params.account,
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(true);
    return result;
  }

  async function expectAllowFromBlocked(params: {
    allowFrom: string[];
    allowedRoles?: NonNullable<TwitchAccountConfig["allowedRoles"]>;
    message?: Partial<TwitchChatMessage>;
    reason: string;
  }) {
    const result = await runAccessCheck({
      account: {
        allowFrom: params.allowFrom,
        allowedRoles: params.allowedRoles,
      },
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(params.reason);
  }

  describe("when no restrictions are configured", () => {
    it("allows messages that mention the bot (default requireMention)", async () => {
      const result = await runAccessCheck({
        message: {
          message: "@testbot hello",
        },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention default", () => {
    it("defaults to true when undefined", async () => {
      const result = await runAccessCheck({
        message: {
          message: "hello bot",
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("allows mention when requireMention is undefined", async () => {
      const result = await runAccessCheck({
        message: {
          message: "@testbot hello",
        },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention", () => {
    it("allows messages that mention the bot", async () => {
      const result = await runAccessCheck({
        account: { requireMention: true },
        message: { message: "@testbot hello" },
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks messages that don't mention the bot", async () => {
      const result = await runAccessCheck({
        account: { requireMention: true },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("is case-insensitive for bot username", async () => {
      const result = await runAccessCheck({
        account: { requireMention: true },
        message: { message: "@TestBot hello" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowFrom allowlist", () => {
    it("allows users in the allowlist", async () => {
      const result = await expectAllowedAccessCheck({
        account: {
          allowFrom: ["123456", "789012"],
        },
      });
      expect(result.matchKey).toBe("123456");
      expect(result.matchSource).toBe("allowlist");
    });

    it("blocks users not in allowlist when allowFrom is set", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["789012"],
        reason: "allowFrom",
      });
    });

    it("blocks everyone when allowFrom is explicitly empty", async () => {
      await expectAllowFromBlocked({
        allowFrom: [],
        reason: "allowFrom",
      });
    });

    it("blocks messages without userId", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["123456"],
        message: { userId: undefined },
        reason: "user ID not available",
      });
    });

    it("bypasses role checks when user is in allowlist", async () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456"],
        allowedRoles: ["owner"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isOwner: false,
      };

      const result = await checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks user with role when not in allowlist", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
        message: { userId: "123456", isMod: true },
        reason: "allowFrom",
      });
    });

    it("blocks user not in allowlist even when roles configured", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
        message: { userId: "123456", isMod: false },
        reason: "allowFrom",
      });
    });
  });

  describe("allowedRoles", () => {
    it("allows users with matching role", async () => {
      const result = await expectSingleRoleAllowed({
        role: "moderator",
        message: { isMod: true },
      });
      expect(result.matchSource).toBe("role");
    });

    it("allows users with any of multiple roles", async () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator", "vip", "subscriber"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isVip: true,
        isMod: false,
        isSub: false,
      };

      const result = await checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks users without matching role", async () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isMod: false,
      };

      const result = await checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not have any of the required roles");
    });

    it("allows all users when role is 'all'", async () => {
      const result = await expectAllowedAccessCheck({
        account: {
          allowedRoles: ["all"],
        },
      });
      expect(result.matchKey).toBe("all");
    });

    it("handles moderator role", async () => {
      await expectSingleRoleAllowed({
        role: "moderator",
        message: { isMod: true },
      });
    });

    it("handles subscriber role", async () => {
      await expectSingleRoleAllowed({
        role: "subscriber",
        message: { isSub: true },
      });
    });

    it("handles owner role", async () => {
      await expectSingleRoleAllowed({
        role: "owner",
        message: { isOwner: true },
      });
    });

    it("handles vip role", async () => {
      await expectSingleRoleAllowed({
        role: "vip",
        message: { isVip: true },
      });
    });
  });

  describe("combined restrictions", () => {
    it("checks requireMention before allowlist", async () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
        allowFrom: ["123456"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "hello", // No mention
      };

      const result = await checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks requireMention before sender allowlists for unauthorized chat", async () => {
      const result = await runAccessCheck({
        account: {
          requireMention: true,
          allowFrom: ["789012"],
        },
        message: {
          message: "ordinary chat",
          userId: "123456",
        },
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks requireMention before role gates for unauthorized chat", async () => {
      const result = await runAccessCheck({
        account: {
          requireMention: true,
          allowedRoles: ["moderator"],
        },
        message: {
          message: "ordinary chat",
          isMod: false,
        },
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks allowlist before allowedRoles", async () => {
      const result = await runAccessCheck({
        account: {
          allowFrom: ["123456"],
          allowedRoles: ["owner"],
        },
        message: {
          message: "@testbot hello",
          isOwner: false,
        },
      });
      expect(result.allowed).toBe(true);
      expect(result.matchSource).toBe("allowlist");
    });
  });
});
