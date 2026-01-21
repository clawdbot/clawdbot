import type { Guild } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import {
  allowListMatches,
  buildDiscordMediaPayload,
  type DiscordGuildEntryResolved,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  registerDiscordListener,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordReplyTarget,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
  sanitizeDiscordThreadName,
  shouldEmitDiscordReactionNotification,
} from "./monitor.js";
import { DiscordMessageListener } from "./monitor/listeners.js";

const fakeGuild = (id: string, name: string) => ({ id, name }) as Guild;

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

describe("registerDiscordListener", () => {
  class FakeListener {}

  it("dedupes listeners by constructor", () => {
    const listeners: object[] = [];

    expect(registerDiscordListener(listeners, new FakeListener())).toBe(true);
    expect(registerDiscordListener(listeners, new FakeListener())).toBe(false);
    expect(listeners).toHaveLength(1);
  });
});

describe("DiscordMessageListener", () => {
  it("returns before the handler finishes", async () => {
    let handlerResolved = false;
    let resolveHandler: (() => void) | null = null;
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = () => {
        handlerResolved = true;
        resolve();
      };
    });
    const handler = vi.fn(() => handlerPromise);
    const listener = new DiscordMessageListener(handler);

    await listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("@buape/carbon").Client,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handlerResolved).toBe(false);

    resolveHandler?.();
    await handlerPromise;
  });

  it("logs handler failures", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<typeof import("../logging/subsystem.js").createSubsystemLogger>;
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const listener = new DiscordMessageListener(handler, logger);

    await listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("@buape/carbon").Client,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("discord handler failed"));
  });

  it("logs slow handlers after the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      let resolveHandler: (() => void) | null = null;
      const handlerPromise = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
      const handler = vi.fn(() => handlerPromise);
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as ReturnType<typeof import("../logging/subsystem.js").createSubsystemLogger>;
      const listener = new DiscordMessageListener(handler, logger);

      await listener.handle(
        {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
        {} as unknown as import("@buape/carbon").Client,
      );

      vi.setSystemTime(31_000);
      resolveHandler?.();
      await handlerPromise;
      await Promise.resolve();

      expect(logger.warn).toHaveBeenCalled();
      const [, meta] = logger.warn.mock.calls[0] ?? [];
      expect(meta?.durationMs).toBeGreaterThanOrEqual(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
        help: {
          allow: true,
          requireMention: true,
          skills: ["search"],
          enabled: false,
          users: ["123"],
          systemPrompt: "Use short answers.",
          autoThread: true,
        },
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
    expect(help?.skills).toEqual(["search"]);
    expect(help?.enabled).toBe(false);
    expect(help?.users).toEqual(["123"]);
    expect(help?.systemPrompt).toBe("Use short answers.");
    expect(help?.autoThread).toBe(true);
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

  it("inherits parent config for thread channels", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { allow: true },
        random: { allow: false },
      },
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: "thread-123",
      channelName: "topic",
      channelSlug: "topic",
      parentId: "999",
      parentName: "random",
      parentSlug: "random",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(false);
  });

  it("does not match thread name/slug when resolving allowlists", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { allow: true },
        random: { allow: false },
      },
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: "thread-999",
      channelName: "general",
      channelSlug: "general",
      parentId: "999",
      parentName: "random",
      parentSlug: "random",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(false);
  });

  it("applies wildcard channel config when no specific match", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { allow: true, requireMention: false },
        "*": { allow: true, autoThread: true, requireMention: true },
      },
    };
    // Specific channel should NOT use wildcard
    const general = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "123",
      channelName: "general",
      channelSlug: "general",
    });
    expect(general?.allowed).toBe(true);
    expect(general?.requireMention).toBe(false);
    expect(general?.autoThread).toBeUndefined();
    expect(general?.matchSource).toBe("direct");

    // Unknown channel should use wildcard
    const random = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
    });
    expect(random?.allowed).toBe(true);
    expect(random?.autoThread).toBe(true);
    expect(random?.requireMention).toBe(true);
    expect(random?.matchSource).toBe("wildcard");
  });

  it("falls back to wildcard when thread channel and parent are missing", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        "*": { allow: true, requireMention: false },
      },
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: "thread-123",
      channelName: "topic",
      channelSlug: "topic",
      parentId: "parent-999",
      parentName: "general",
      parentSlug: "general",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(true);
    expect(thread?.matchKey).toBe("*");
    expect(thread?.matchSource).toBe("wildcard");
  });
});

describe("discord mention gating", () => {
  it("requires mention by default", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        general: { allow: true },
      },
    };
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "1",
      channelName: "General",
      channelSlug: "general",
    });
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: false,
        channelConfig,
        guildInfo,
      }),
    ).toBe(true);
  });

  it("does not require mention inside autoThread threads", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        general: { allow: true, autoThread: true },
      },
    };
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "1",
      channelName: "General",
      channelSlug: "general",
    });
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: true,
        botId: "bot123",
        threadOwnerId: "bot123",
        channelConfig,
        guildInfo,
      }),
    ).toBe(false);
  });

  it("requires mention inside user-created threads with autoThread enabled", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        general: { allow: true, autoThread: true },
      },
    };
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "1",
      channelName: "General",
      channelSlug: "general",
    });
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: true,
        botId: "bot123",
        threadOwnerId: "user456",
        channelConfig,
        guildInfo,
      }),
    ).toBe(true);
  });

  it("requires mention when thread owner is unknown", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        general: { allow: true, autoThread: true },
      },
    };
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "1",
      channelName: "General",
      channelSlug: "general",
    });
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: true,
        botId: "bot123",
        channelConfig,
        guildInfo,
      }),
    ).toBe(true);
  });

  it("inherits parent channel mention rules for threads", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        "parent-1": { allow: true, requireMention: false },
      },
    };
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: "thread-1",
      channelName: "topic",
      channelSlug: "topic",
      parentId: "parent-1",
      parentName: "Parent",
      parentSlug: "parent",
      scope: "thread",
    });
    expect(channelConfig?.matchSource).toBe("parent");
    expect(channelConfig?.matchKey).toBe("parent-1");
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: true,
        channelConfig,
        guildInfo,
      }),
    ).toBe(false);
  });
});

describe("discord groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "open",
        guildAllowlisted: false,
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "disabled",
        guildAllowlisted: true,
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("blocks allowlist when guild is not allowlisted", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: false,
        channelAllowlistConfigured: false,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("allows allowlist when guild allowlisted but no channel allowlist", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: true,
        channelAllowlistConfigured: false,
        channelAllowed: true,
      }),
    ).toBe(true);
  });

  it("allows allowlist when channel is allowed", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: true,
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(true);
  });

  it("blocks allowlist when channel is not allowed", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: true,
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

describe("discord autoThread name sanitization", () => {
  it("strips mentions and collapses whitespace", () => {
    const name = sanitizeDiscordThreadName("  <@123>  <@&456> <#789>  Help   here  ", "msg-1");
    expect(name).toBe("Help here");
  });

  it("falls back to thread + id when empty after cleaning", () => {
    const name = sanitizeDiscordThreadName("   <@123>", "abc");
    expect(name).toBe("Thread abc");
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

describe("discord media payload", () => {
  it("preserves attachment order for MediaPaths/MediaUrls", () => {
    const payload = buildDiscordMediaPayload([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.png", contentType: "image/png" },
      { path: "/tmp/c.png", contentType: "image/png" },
    ]);
    expect(payload.MediaPath).toBe("/tmp/a.png");
    expect(payload.MediaUrl).toBe("/tmp/a.png");
    expect(payload.MediaType).toBe("image/png");
    expect(payload.MediaPaths).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
    expect(payload.MediaUrls).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
  });
});
