import { describe, expect, it } from "vitest";
import { checkTwitchAccessControl, extractMentions } from "./access-control.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

describe("checkTwitchAccessControl", () => {
  const mockAccount: TwitchAccountConfig = {
    username: "testbot",
    token: "oauth:test",
  };

  const mockMessage: TwitchChatMessage = {
    username: "testuser",
    userId: "123456",
    message: "hello bot",
    channel: "testchannel",
  };

  describe("when no restrictions are configured", () => {
    it("allows messages that mention the bot (default requireMention)", () => {
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };
      const result = checkTwitchAccessControl({
        message,
        account: mockAccount,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention default", () => {
    it("defaults to true when undefined", () => {
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "hello bot",
      };

      const result = checkTwitchAccessControl({
        message,
        account: mockAccount,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("allows mention when requireMention is undefined", () => {
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account: mockAccount,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention", () => {
    it("allows messages that mention the bot", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks messages that don't mention the bot", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
      };

      const result = checkTwitchAccessControl({
        message: mockMessage,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("is case-insensitive for bot username", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@TestBot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowFrom allowlist", () => {
    it("allows users in the allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456", "789012"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchKey).toBe("123456");
      expect(result.matchSource).toBe("allowlist");
    });

    it("allows users not in allowlist via fallback (open access)", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["789012"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      // Falls through to final fallback since allowedRoles is not set
      expect(result.allowed).toBe(true);
    });

    it("blocks messages without userId", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        userId: undefined,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("user ID not available");
    });

    it("bypasses role checks when user is in allowlist", () => {
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

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows user with role even if not in allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        userId: "123456",
        isMod: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchSource).toBe("role");
    });

    it("blocks user with neither allowlist nor role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        userId: "123456",
        isMod: false,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not have any of the required roles");
    });
  });

  describe("allowedRoles", () => {
    it("allows users with matching role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isMod: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchSource).toBe("role");
    });

    it("allows users with any of multiple roles", () => {
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

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks users without matching role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isMod: false,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not have any of the required roles");
    });

    it("allows all users when role is 'all'", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["all"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchKey).toBe("all");
    });

    it("handles moderator role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isMod: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("handles subscriber role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["subscriber"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isSub: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("handles owner role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["owner"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isOwner: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("handles vip role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["vip"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isVip: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("combined restrictions", () => {
    it("checks requireMention before allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
        allowFrom: ["123456"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "hello", // No mention
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks allowlist before allowedRoles", () => {
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

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchSource).toBe("allowlist");
    });
  });
});

describe("extractMentions", () => {
  it("extracts single mention", () => {
    const mentions = extractMentions("hello @testbot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("extracts multiple mentions", () => {
    const mentions = extractMentions("hello @testbot and @otheruser");
    expect(mentions).toEqual(["testbot", "otheruser"]);
  });

  it("returns empty array when no mentions", () => {
    const mentions = extractMentions("hello everyone");
    expect(mentions).toEqual([]);
  });

  it("handles mentions at start of message", () => {
    const mentions = extractMentions("@testbot hello");
    expect(mentions).toEqual(["testbot"]);
  });

  it("handles mentions at end of message", () => {
    const mentions = extractMentions("hello @testbot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("converts mentions to lowercase", () => {
    const mentions = extractMentions("hello @TestBot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("extracts alphanumeric usernames", () => {
    const mentions = extractMentions("hello @user123");
    expect(mentions).toEqual(["user123"]);
  });

  it("handles underscores in usernames", () => {
    const mentions = extractMentions("hello @test_user");
    expect(mentions).toEqual(["test_user"]);
  });

  it("handles empty string", () => {
    const mentions = extractMentions("");
    expect(mentions).toEqual([]);
  });
});
