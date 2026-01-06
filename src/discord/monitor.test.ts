import { describe, expect, it } from "vitest";
import {
  allowListMatches,
  type DiscordGuildEntryResolved,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordGuildEntry,
  resolveDiscordReplyTarget,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./monitor.js";

const fakeGuild = (id: string, name: string) =>
  ({ id, name }) as unknown as import("discord.js").Guild;

const makeEntries = (
  entries: Record<string, Partial<DiscordGuildEntryResolved>>,
): Record<string, DiscordGuildEntryResolved> => {
  const out: Record<string, DiscordGuildEntryResolved> = {};
  for (const [key, value] of Object.entries(entries)) {
    out[key] = {
      slug: value.slug,
      requireMention: value.requireMention,
      reactionNotifications: value.reactionNotifications,
      users: value.users,
      channels: value.channels,
    };
  }
  return out;
};

describe("discord allowlist helpers", () => {
  it("normalizes slugs", () => {
    expect(normalizeDiscordSlug("Friends of Clawd")).toBe("friends-of-clawd");
    expect(normalizeDiscordSlug("#General")).toBe("general");
    expect(normalizeDiscordSlug("Dev__Chat")).toBe("dev-chat");
  });

  it("matches ids or names", () => {
    const allow = normalizeDiscordAllowList(
      ["123", "steipete", "Friends of Clawd"],
      ["discord:", "user:", "guild:", "channel:"],
    );
    expect(allow).not.toBeNull();
    if (!allow) {
      throw new Error("Expected allow list to be normalized");
    }
    expect(allowListMatches(allow, { id: "123" })).toBe(true);
    expect(allowListMatches(allow, { name: "steipete" })).toBe(true);
    expect(allowListMatches(allow, { name: "friends-of-clawd" })).toBe(true);
    expect(allowListMatches(allow, { name: "other" })).toBe(false);
  });
});

describe("discord guild/channel resolution", () => {
  it("resolves guild entry by id", () => {
    const guildEntries = makeEntries({
      "123": { slug: "friends-of-clawd" },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of Clawd"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-clawd");
  });

  it("resolves guild entry by slug key", () => {
    const guildEntries = makeEntries({
      "friends-of-clawd": { slug: "friends-of-clawd" },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of Clawd"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-clawd");
  });

  it("falls back to wildcard guild entry", () => {
    const guildEntries = makeEntries({
      "*": { requireMention: false },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of Clawd"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.requireMention).toBe(false);
  });

  it("resolves channel config by slug", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { allow: true },
        help: { allow: true, requireMention: true },
      },
    };
    const channel = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "456",
      channelName: "General",
      channelSlug: "general",
    });
    expect(channel?.allowed).toBe(true);
    expect(channel?.requireMention).toBeUndefined();

    const help = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "789",
      channelName: "Help",
      channelSlug: "help",
    });
    expect(help?.allowed).toBe(true);
    expect(help?.requireMention).toBe(true);
  });

  it("denies channel when config present but no match", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { allow: true },
      },
    };
    const channel = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
    });
    expect(channel?.allowed).toBe(false);
  });
});

describe("discord groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "open",
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "disabled",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("blocks allowlist when no channel allowlist configured", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: false,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("allows allowlist when channel is allowed", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(true);
  });

  it("blocks allowlist when channel is not allowed", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: false,
      }),
    ).toBe(false);
  });
});

describe("discord group DM gating", () => {
  it("allows all when no allowlist", () => {
    expect(
      resolveGroupDmAllow({
        channels: undefined,
        channelId: "1",
        channelName: "dm",
        channelSlug: "dm",
      }),
    ).toBe(true);
  });

  it("matches group DM allowlist", () => {
    expect(
      resolveGroupDmAllow({
        channels: ["clawd-dm"],
        channelId: "1",
        channelName: "Clawd DM",
        channelSlug: "clawd-dm",
      }),
    ).toBe(true);
    expect(
      resolveGroupDmAllow({
        channels: ["clawd-dm"],
        channelId: "1",
        channelName: "Other",
        channelSlug: "other",
      }),
    ).toBe(false);
  });
});

describe("discord reply target selection", () => {
  it("skips replies when mode is off", () => {
    expect(
      resolveDiscordReplyTarget({
        replyToMode: "off",
        replyToId: "123",
        hasReplied: false,
      }),
    ).toBeUndefined();
  });

  it("replies only once when mode is first", () => {
    expect(
      resolveDiscordReplyTarget({
        replyToMode: "first",
        replyToId: "123",
        hasReplied: false,
      }),
    ).toBe("123");
    expect(
      resolveDiscordReplyTarget({
        replyToMode: "first",
        replyToId: "123",
        hasReplied: true,
      }),
    ).toBeUndefined();
  });

  it("replies on every message when mode is all", () => {
    expect(
      resolveDiscordReplyTarget({
        replyToMode: "all",
        replyToId: "123",
        hasReplied: false,
      }),
    ).toBe("123");
    expect(
      resolveDiscordReplyTarget({
        replyToMode: "all",
        replyToId: "123",
        hasReplied: true,
      }),
    ).toBe("123");
  });
});

describe("discord reaction notification gating", () => {
  it("defaults to own when mode is unset", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: undefined,
        botId: "bot-1",
        messageAuthorId: "bot-1",
        userId: "user-1",
      }),
    ).toBe(true);
    expect(
      shouldEmitDiscordReactionNotification({
        mode: undefined,
        botId: "bot-1",
        messageAuthorId: "user-1",
        userId: "user-2",
      }),
    ).toBe(false);
  });

  it("skips when mode is off", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "off",
        botId: "bot-1",
        messageAuthorId: "bot-1",
        userId: "user-1",
      }),
    ).toBe(false);
  });

  it("allows all reactions when mode is all", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "all",
        botId: "bot-1",
        messageAuthorId: "user-1",
        userId: "user-2",
      }),
    ).toBe(true);
  });

  it("requires bot ownership when mode is own", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "own",
        botId: "bot-1",
        messageAuthorId: "bot-1",
        userId: "user-2",
      }),
    ).toBe(true);
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "own",
        botId: "bot-1",
        messageAuthorId: "user-2",
        userId: "user-3",
      }),
    ).toBe(false);
  });

  it("requires allowlist matches when mode is allowlist", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "allowlist",
        botId: "bot-1",
        messageAuthorId: "user-1",
        userId: "user-2",
        allowlist: [],
      }),
    ).toBe(false);
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "allowlist",
        botId: "bot-1",
        messageAuthorId: "user-1",
        userId: "123",
        userName: "steipete",
        allowlist: ["123", "other"],
      }),
    ).toBe(true);
  });
});
