import { describe, expect, it } from "vitest";
import { discordPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";

// Split from channel.test.ts to keep it under the max-lines lint budget; these
// describes exercise pure config/binding/policy surfaces and need no transport mocks.

describe("discordPlugin bindings", () => {
  it("derives DM current conversation ids from direct sender context", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      chatType: "direct",
      from: "discord:123456789012345678",
      originatingTo: "channel:dm-channel-1",
      fallbackTo: "channel:dm-channel-1",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves user-prefixed current conversation ids for DM binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "user:123456789012345678",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves channel-prefixed current conversation ids for channel binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:987654321098765432",
    });

    expect(result).toEqual({
      conversationId: "channel:987654321098765432",
    });
  });

  it("preserves channel-prefixed parent ids for thread binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:thread-42",
      threadId: "thread-42",
      threadParentId: "parent-9",
    });

    expect(result).toEqual({
      conversationId: "thread-42",
      parentConversationId: "channel:parent-9",
    });
  });
});

describe("discordPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes and mentions", () => {
    const resolveDmPolicy = discordPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        discord: {
          token: "discord-token",
          dmPolicy: "allowlist",
          allowFrom: ["  discord:<@!123456789>  "],
        },
      },
    } as OpenClawConfig;

    const result = resolveDmPolicy({
      cfg,
      account: discordPlugin.config.resolveAccount(cfg, "default"),
    });
    if (!result) {
      throw new Error("discord resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  discord:<@!123456789>  "]);
    expect(result.policyPath).toBe("channels.discord.dmPolicy");
    expect(result.allowFromPath).toBe("channels.discord.");
    expect(result.normalizeEntry?.("  discord:<@!123456789>  ")).toBe("123456789");
    expect(result.normalizeEntry?.("  user:987654321  ")).toBe("987654321");
  });
});

describe("discordPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      discordPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toBe(true);
    expect(
      discordPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toEqual({ allow: ["message.channel"] });
  });
});
