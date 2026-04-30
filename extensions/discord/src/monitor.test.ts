import { typedCases } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild } from "./internal/discord.js";
import {
  allowListMatches,
  type DiscordGuildEntryResolved,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordOwnerAccess,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./monitor/allow-list.js";
import { buildDiscordMediaPayload } from "./monitor/message-utils.js";
import { resolveDiscordReplyTarget, sanitizeDiscordThreadName } from "./monitor/threading.js";
type DiscordReactionEvent = Parameters<
  import("./monitor/listeners.js").DiscordReactionListener["handle"]
>[0];
type DiscordReactionClient = Parameters<
  import("./monitor/listeners.js").DiscordReactionListener["handle"]
>[1];

const readAllowFromStoreMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  };
});

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
      roles: value.roles,
      channels: value.channels,
    };
  }
  return out;
};

function createAutoThreadMentionContext() {
  const guildInfo: DiscordGuildEntryResolved = {
    requireMention: true,
    channels: {
      general: { enabled: true, autoThread: true },
    },
  };
  const channelConfig = resolveDiscordChannelConfig({
    guildInfo,
    channelId: "1",
    channelName: "General",
    channelSlug: "general",
  });
  return { guildInfo, channelConfig };
}

beforeEach(() => {
  vi.useRealTimers();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
});

describe("registerDiscordListener", () => {
  class FakeListener {
    readonly testListener = true;
  }

  it("dedupes listeners by constructor", () => {
    const listeners: object[] = [];

    expect(registerDiscordListener(listeners, new FakeListener())).toBe(true);
    expect(registerDiscordListener(listeners, new FakeListener())).toBe(false);
    expect(listeners).toHaveLength(1);
  });
});

describe("DiscordMessageListener", () => {
  function createDeferred() {
    let resolve: (() => void) | null = null;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return {
      promise,
      resolve: () => {
        if (typeof resolve === "function") {
          (resolve as () => void)();
        }
      },
    };
  }

  async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("returns immediately while handler continues in background", async () => {
    let handlerResolved = false;
    const deferred = createDeferred();
    const handler = vi.fn(async () => {
      await deferred.promise;
      handlerResolved = true;
    });
    const listener = new DiscordMessageListener(handler);

    const handlePromise = listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("./internal/discord.js").Client,
    );

    // handle() returns immediately while the background queue starts on the next tick.
    await expect(handlePromise).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledOnce();
    expect(handlerResolved).toBe(false);

    // Release and let background handler finish.
    deferred.resolve();
    await Promise.resolve();
    expect(handlerResolved).toBe(true);
  });

  it("dispatches subsequent events concurrently without blocking on prior handler", async () => {
    const first = createDeferred();
    const second = createDeferred();
    let runCount = 0;
    const handler = vi.fn(async () => {
      runCount += 1;
      if (runCount === 1) {
        await first.promise;
        return;
      }
      await second.promise;
    });
    const listener = new DiscordMessageListener(handler);

    await expect(
      listener.handle(
        {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
        {} as unknown as import("./internal/discord.js").Client,
      ),
    ).resolves.toBeUndefined();
    await expect(
      listener.handle(
        {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
        {} as unknown as import("./internal/discord.js").Client,
      ),
    ).resolves.toBeUndefined();

    // Both handlers are dispatched concurrently (fire-and-forget).
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);

    first.resolve();
    second.resolve();
    await Promise.resolve();
  });

  it("logs handler failures", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >;
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const listener = new DiscordMessageListener(handler, logger);

    await listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("./internal/discord.js").Client,
    );
    await flushAsyncWork();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("discord handler failed"));
  });

  it("does not apply its own slow-listener logging", async () => {
    const deferred = createDeferred();
    const handler = vi.fn(() => deferred.promise);
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >;
    const listener = new DiscordMessageListener(handler, logger);

    const handlePromise = listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("./internal/discord.js").Client,
    );
    await expect(handlePromise).resolves.toBeUndefined();

    deferred.resolve();
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledOnce();
    // The listener no longer wraps message handlers with slow-listener logging.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("discord allowlist helpers", () => {
  it("normalizes slugs", () => {
    expect(normalizeDiscordSlug("Friends of OpenClaw")).toBe("friends-of-openclaw");
    expect(normalizeDiscordSlug("#General")).toBe("general");
    expect(normalizeDiscordSlug("Dev__Chat")).toBe("dev-chat");
  });

  it("matches ids by default and names only when enabled", () => {
    const allow = normalizeDiscordAllowList(
      ["123", "steipete", "Friends of OpenClaw"],
      ["discord:", "user:", "guild:", "channel:"],
    );
    expect(allow).not.toBeNull();
    if (!allow) {
      throw new Error("Expected allow list to be normalized");
    }
    expect(allowListMatches(allow, { id: "123" })).toBe(true);
    expect(allowListMatches(allow, { name: "steipete" })).toBe(false);
    expect(allowListMatches(allow, { name: "friends-of-openclaw" })).toBe(false);
    expect(allowListMatches(allow, { name: "steipete" }, { allowNameMatching: true })).toBe(true);
    expect(
      allowListMatches(allow, { name: "friends-of-openclaw" }, { allowNameMatching: true }),
    ).toBe(true);
    expect(allowListMatches(allow, { name: "other" })).toBe(false);
  });

  it("matches pk-prefixed allowlist entries", () => {
    const allow = normalizeDiscordAllowList(["pk:member-123"], ["discord:", "user:", "pk:"]);
    expect(allow).not.toBeNull();
    if (!allow) {
      throw new Error("Expected allow list to be normalized");
    }
    expect(allowListMatches(allow, { id: "member-123" })).toBe(true);
    expect(allowListMatches(allow, { id: "member-999" })).toBe(false);
  });

  it("does not treat DM wildcard access as owner access", () => {
    const wildcardOnly = resolveDiscordOwnerAccess({
      allowFrom: ["*"],
      sender: { id: "123" },
    });
    expect(wildcardOnly.ownerAllowList).toBeNull();
    expect(wildcardOnly.ownerAllowed).toBe(false);

    const explicitOwner = resolveDiscordOwnerAccess({
      allowFrom: ["*", "user:123"],
      sender: { id: "123" },
    });
    expect(explicitOwner.ownerAllowList).not.toBeNull();
    expect(explicitOwner.ownerAllowed).toBe(true);
  });
});

describe("discord guild/channel resolution", () => {
  it("resolves guild entry by id", () => {
    const guildEntries = makeEntries({
      "123": { slug: "friends-of-openclaw" },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of OpenClaw"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-openclaw");
  });

  it("resolves guild entry by raw guild id when guild object is missing", () => {
    const guildEntries = makeEntries({
      "123": { slug: "friends-of-openclaw" },
    });
    const resolved = resolveDiscordGuildEntry({
      guildId: "123",
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-openclaw");
  });

  it("resolves guild entry by slug key", () => {
    const guildEntries = makeEntries({
      "friends-of-openclaw": { slug: "friends-of-openclaw" },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of OpenClaw"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-openclaw");
  });

  it("falls back to wildcard guild entry", () => {
    const guildEntries = makeEntries({
      "*": { requireMention: false },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of OpenClaw"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.requireMention).toBe(false);
  });

  it("resolves channel config by slug", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
        help: {
          enabled: true,
          requireMention: true,
          skills: ["search"],
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
    expect(help?.enabled).toBe(true);
    expect(help?.users).toEqual(["123"]);
    expect(help?.systemPrompt).toBe("Use short answers.");
    expect(help?.autoThread).toBe(true);
  });

  it("denies channel when config present but no match", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
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

  it("treats empty channel config map as no channel allowlist", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {},
    };
    const channel = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
    });
    expect(channel).toBeNull();
  });

  it("inherits parent config for thread channels", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
        random: { enabled: false },
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
        general: { enabled: true },
        random: { enabled: false },
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
        general: { enabled: true, requireMention: false },
        "*": { enabled: true, autoThread: true, requireMention: true },
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
        "*": { enabled: true, requireMention: false },
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

  it("treats empty channel config map as no thread allowlist", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {},
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
    expect(thread).toBeNull();
  });
});

describe("discord mention gating", () => {
  it("requires mention by default", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        general: { enabled: true },
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

  it("applies autoThread mention rules based on thread ownership", () => {
    const cases = [
      { name: "bot-owned thread", threadOwnerId: "bot123", expected: false },
      { name: "user-owned thread", threadOwnerId: "user456", expected: true },
      { name: "unknown thread owner", threadOwnerId: undefined, expected: true },
    ] as const;

    for (const testCase of cases) {
      const { guildInfo, channelConfig } = createAutoThreadMentionContext();
      expect(
        resolveDiscordShouldRequireMention({
          isGuildMessage: true,
          isThread: true,
          botId: "bot123",
          threadOwnerId: testCase.threadOwnerId,
          channelConfig,
          guildInfo,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });

  it("inherits parent channel mention rules for threads", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        "parent-1": { enabled: true, requireMention: false },
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
  it("applies open/disabled/allowlist policy rules", () => {
    const cases = [
      {
        name: "open policy always allows",
        input: {
          groupPolicy: "open" as const,
          guildAllowlisted: false,
          channelAllowlistConfigured: false,
          channelAllowed: false,
        },
        expected: true,
      },
      {
        name: "disabled policy always blocks",
        input: {
          groupPolicy: "disabled" as const,
          guildAllowlisted: true,
          channelAllowlistConfigured: true,
          channelAllowed: true,
        },
        expected: false,
      },
      {
        name: "allowlist blocks when guild not allowlisted",
        input: {
          groupPolicy: "allowlist" as const,
          guildAllowlisted: false,
          channelAllowlistConfigured: false,
          channelAllowed: true,
        },
        expected: false,
      },
      {
        name: "allowlist allows when guild allowlisted and no channel allowlist",
        input: {
          groupPolicy: "allowlist" as const,
          guildAllowlisted: true,
          channelAllowlistConfigured: false,
          channelAllowed: true,
        },
        expected: true,
      },
      {
        name: "allowlist allows when channel is allowed",
        input: {
          groupPolicy: "allowlist" as const,
          guildAllowlisted: true,
          channelAllowlistConfigured: true,
          channelAllowed: true,
        },
        expected: true,
      },
      {
        name: "allowlist blocks when channel is not allowed",
        input: {
          groupPolicy: "allowlist" as const,
          guildAllowlisted: true,
          channelAllowlistConfigured: true,
          channelAllowed: false,
        },
        expected: false,
      },
    ] as const;

    for (const testCase of cases) {
      expect(isDiscordGroupAllowedByPolicy(testCase.input), testCase.name).toBe(testCase.expected);
    }
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
        channels: ["openclaw-dm"],
        channelId: "1",
        channelName: "OpenClaw DM",
        channelSlug: "openclaw-dm",
      }),
    ).toBe(true);
    expect(
      resolveGroupDmAllow({
        channels: ["openclaw-dm"],
        channelId: "1",
        channelName: "Other",
        channelSlug: "other",
      }),
    ).toBe(false);
  });
});

describe("discord reply target selection", () => {
  it("handles off/first/all reply modes", () => {
    const cases = [
      { name: "off mode", replyToMode: "off" as const, hasReplied: false, expected: undefined },
      {
        name: "first mode before reply",
        replyToMode: "first" as const,
        hasReplied: false,
        expected: "123",
      },
      {
        name: "first mode after reply",
        replyToMode: "first" as const,
        hasReplied: true,
        expected: undefined,
      },
      {
        name: "all mode before reply",
        replyToMode: "all" as const,
        hasReplied: false,
        expected: "123",
      },
      {
        name: "all mode after reply",
        replyToMode: "all" as const,
        hasReplied: true,
        expected: "123",
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        resolveDiscordReplyTarget({
          replyToMode: testCase.replyToMode,
          replyToId: "123",
          hasReplied: testCase.hasReplied,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
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
  it("applies mode-specific reaction notification rules", () => {
    const cases = typedCases<{
      name: string;
      input: Parameters<typeof shouldEmitDiscordReactionNotification>[0];
      expected: boolean;
    }>([
      {
        name: "unset defaults to own (author is bot)",
        input: {
          mode: undefined,
          botId: "bot-1",
          messageAuthorId: "bot-1",
          userId: "user-1",
        },
        expected: true,
      },
      {
        name: "unset defaults to own (author is not bot)",
        input: {
          mode: undefined,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "user-2",
        },
        expected: false,
      },
      {
        name: "off mode",
        input: {
          mode: "off" as const,
          botId: "bot-1",
          messageAuthorId: "bot-1",
          userId: "user-1",
        },
        expected: false,
      },
      {
        name: "all mode",
        input: {
          mode: "all" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "user-2",
        },
        expected: true,
      },
      {
        name: "all mode blocks non-allowlisted guild member",
        input: {
          mode: "all" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "user-2",
          guildInfo: { users: ["trusted-user"] },
        },
        expected: false,
      },
      {
        name: "own mode with bot-authored message",
        input: {
          mode: "own" as const,
          botId: "bot-1",
          messageAuthorId: "bot-1",
          userId: "user-2",
        },
        expected: true,
      },
      {
        name: "own mode with non-bot-authored message",
        input: {
          mode: "own" as const,
          botId: "bot-1",
          messageAuthorId: "user-2",
          userId: "user-3",
        },
        expected: false,
      },
      {
        name: "own mode still blocks member outside users allowlist",
        input: {
          mode: "own" as const,
          botId: "bot-1",
          messageAuthorId: "bot-1",
          userId: "user-3",
          guildInfo: { users: ["trusted-user"] },
        },
        expected: false,
      },
      {
        name: "allowlist mode without match",
        input: {
          mode: "allowlist" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "user-2",
          allowlist: [] as string[],
        },
        expected: false,
      },
      {
        name: "allowlist mode with id match",
        input: {
          mode: "allowlist" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "123",
          userName: "steipete",
          guildInfo: { users: ["123", "other"] },
        },
        expected: true,
      },
      {
        name: "allowlist mode does not match usernames by default",
        input: {
          mode: "allowlist" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "999",
          userName: "trusted-user",
          guildInfo: { users: ["trusted-user"] },
        },
        expected: false,
      },
      {
        name: "allowlist mode matches usernames when explicitly enabled",
        input: {
          mode: "allowlist" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "999",
          userName: "trusted-user",
          guildInfo: { users: ["trusted-user"] },
          allowNameMatching: true,
        },
        expected: true,
      },
      {
        name: "allowlist mode matches allowed role",
        input: {
          mode: "allowlist" as const,
          botId: "bot-1",
          messageAuthorId: "user-1",
          userId: "999",
          guildInfo: { roles: ["role:trusted-role"] },
          memberRoleIds: ["trusted-role"],
        },
        expected: true,
      },
    ]);

    for (const testCase of cases) {
      expect(
        shouldEmitDiscordReactionNotification({
          ...testCase.input,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
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

// --- DM reaction integration tests ---
// These test that handleDiscordReactionEvent (via DiscordReactionListener)
// properly handles DM reactions instead of silently dropping them.

const { enqueueSystemEventSpy, resolveAgentRouteMock } = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn(),
  resolveAgentRouteMock: vi.fn((params: unknown) => ({
    agentId: "default",
    channel: "discord",
    accountId: "acc-1",
    sessionKey: "discord:acc-1:dm:user-1",
    mainSessionKey: "discord:acc-1:dm:user-1",
    lastRoutePolicy: "session" as const,
    matchedBy: "default" as const,
    ...(typeof params === "object" && params !== null ? { _params: params } : {}),
  })),
}));

const channelRuntimeModule = await import("openclaw/plugin-sdk/system-event-runtime");
vi.spyOn(channelRuntimeModule, "enqueueSystemEvent").mockImplementation(enqueueSystemEventSpy);

const routingModule = await import("openclaw/plugin-sdk/routing");
vi.spyOn(routingModule, "resolveAgentRoute").mockImplementation(resolveAgentRouteMock);

const { DiscordMessageListener, DiscordReactionListener, registerDiscordListener } =
  await import("./monitor/listeners.js");

function makeReactionEvent(overrides?: {
  guildId?: string;
  channelId?: string;
  userId?: string;
  messageId?: string;
  emojiName?: string;
  botAsAuthor?: boolean;
  messageAuthorId?: string;
  messageFetch?: ReturnType<typeof vi.fn>;
  guild?: { name?: string; id?: string };
  memberRoleIds?: string[];
}) {
  const userId = overrides?.userId ?? "user-1";
  const messageId = overrides?.messageId ?? "msg-1";
  const channelId = overrides?.channelId ?? "channel-1";
  const messageFetch =
    overrides?.messageFetch ??
    vi.fn(async () => ({
      author: {
        id: overrides?.messageAuthorId ?? (overrides?.botAsAuthor ? "bot-1" : "other-user"),
        username: overrides?.botAsAuthor ? "bot" : "otheruser",
        discriminator: "0",
      },
    }));
  return {
    guild_id: overrides?.guildId,
    channel_id: channelId,
    message_id: messageId,
    emoji: { name: overrides?.emojiName ?? "👍", id: null },
    guild: overrides?.guild,
    rawMember: overrides?.memberRoleIds ? { roles: overrides.memberRoleIds } : undefined,
    user: {
      id: userId,
      bot: false,
      username: "testuser",
      discriminator: "0",
    },
    message: {
      fetch: messageFetch,
    },
  } as unknown as DiscordReactionEvent;
}

function makeReactionClient(options?: {
  channelType?: ChannelType;
  channelName?: string;
  parentId?: string;
  parentName?: string;
}) {
  const channelType = options?.channelType ?? ChannelType.DM;
  const channelName =
    options?.channelName ?? (channelType === ChannelType.DM ? undefined : "test-channel");
  const parentId = options?.parentId;
  const parentName = options?.parentName ?? "parent-channel";

  return {
    fetchChannel: vi.fn(async (channelId: string) => {
      if (parentId && channelId === parentId) {
        return { type: ChannelType.GuildText, name: parentName, parentId: undefined };
      }
      return { type: channelType, name: channelName, parentId };
    }),
  } as unknown as DiscordReactionClient;
}

function getReactionClientFetchChannelMock(client: DiscordReactionClient) {
  return (client as unknown as { fetchChannel: ReturnType<typeof vi.fn> }).fetchChannel;
}

function makeReactionListenerParams(overrides?: {
  botUserId?: string;
  dmEnabled?: boolean;
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowNameMatching?: boolean;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}) {
  return {
    cfg: {} as import("openclaw/plugin-sdk/config-types").OpenClawConfig,
    accountId: "acc-1",
    runtime: {} as import("openclaw/plugin-sdk/runtime-env").RuntimeEnv,
    botUserId: overrides?.botUserId ?? "bot-1",
    dmEnabled: overrides?.dmEnabled ?? true,
    groupDmEnabled: overrides?.groupDmEnabled ?? true,
    groupDmChannels: overrides?.groupDmChannels ?? [],
    dmPolicy: overrides?.dmPolicy ?? "open",
    allowFrom: overrides?.allowFrom ?? ["*"],
    groupPolicy: overrides?.groupPolicy ?? "open",
    allowNameMatching: overrides?.allowNameMatching ?? false,
    guildEntries: overrides?.guildEntries,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >,
  };
}

describe("discord DM reaction handling", () => {
  beforeEach(() => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  });

  it("processes DM reactions with or without guild allowlists", async () => {
    const cases = [
      { name: "no guild allowlist", guildEntries: undefined },
      {
        name: "guild allowlist configured",
        guildEntries: makeEntries({
          "guild-123": { slug: "guild-123" },
        }),
      },
    ] as const;

    for (const testCase of cases) {
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      const data = makeReactionEvent({ botAsAuthor: true });
      const client = makeReactionClient({ channelType: ChannelType.DM });
      const listener = new DiscordReactionListener(
        makeReactionListenerParams({ guildEntries: testCase.guildEntries }),
      );

      await listener.handle(data, client);

      expect(enqueueSystemEventSpy, testCase.name).toHaveBeenCalledOnce();
      const [text, opts] = enqueueSystemEventSpy.mock.calls[0];
      expect(text, testCase.name).toContain("Discord reaction added");
      expect(text, testCase.name).toContain("👍");
      expect(text, testCase.name).toContain("dm");
      expect(text, testCase.name).not.toContain("undefined");
      expect(opts.sessionKey, testCase.name).toBe("discord:acc-1:dm:user-1");
    }
  });

  it("blocks DM reactions when dmPolicy is disabled", async () => {
    const data = makeReactionEvent({ botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({ dmPolicy: "disabled" }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks DM reactions for unauthorized sender in allowlist mode", async () => {
    const data = makeReactionEvent({ botAsAuthor: true, userId: "user-1" });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        dmPolicy: "allowlist",
        allowFrom: ["user:user-2"],
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows DM reactions for authorized sender in allowlist mode", async () => {
    const data = makeReactionEvent({ botAsAuthor: true, userId: "user-1" });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        dmPolicy: "allowlist",
        allowFrom: ["user:user-1"],
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
  });

  it("blocks group DM reactions when group DMs are disabled", async () => {
    const data = makeReactionEvent({ botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.GroupDM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({ groupDmEnabled: false }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks guild reactions when groupPolicy is disabled", async () => {
    const data = makeReactionEvent({
      guildId: "guild-123",
      botAsAuthor: true,
      guild: { id: "guild-123", name: "Guild" },
    });
    const client = makeReactionClient({ channelType: ChannelType.GuildText });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({ groupPolicy: "disabled" }),
    );

    await listener.handle(data, client);

    expect(getReactionClientFetchChannelMock(client)).not.toHaveBeenCalled();
    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks guild reactions for sender outside users allowlist", async () => {
    const data = makeReactionEvent({
      guildId: "guild-123",
      userId: "attacker-user",
      botAsAuthor: true,
      guild: { id: "guild-123", name: "Test Guild" },
    });
    const client = makeReactionClient({ channelType: ChannelType.GuildText });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        guildEntries: makeEntries({
          "guild-123": {
            users: ["user:trusted-user"],
          },
        }),
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    expect(resolveAgentRouteMock).not.toHaveBeenCalled();
  });

  it("allows guild reactions for sender in channel role allowlist override", async () => {
    resolveAgentRouteMock.mockReturnValueOnce({
      agentId: "default",
      channel: "discord",
      accountId: "acc-1",
      sessionKey: "discord:acc-1:guild-123:channel-1",
      mainSessionKey: "discord:acc-1:guild-123:channel-1",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });

    const data = makeReactionEvent({
      guildId: "guild-123",
      userId: "member-user",
      botAsAuthor: true,
      guild: { id: "guild-123", name: "Test Guild" },
      memberRoleIds: ["trusted-role"],
    });
    const client = makeReactionClient({ channelType: ChannelType.GuildText });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        guildEntries: makeEntries({
          "guild-123": {
            roles: ["role:blocked-role"],
            channels: {
              "channel-1": {
                enabled: true,
                roles: ["role:trusted-role"],
              },
            },
          },
        }),
      }),
    );

    await listener.handle(data, client);

    expect(getReactionClientFetchChannelMock(client)).toHaveBeenCalled();
    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
    const [text] = enqueueSystemEventSpy.mock.calls[0];
    expect(text).toContain("Discord reaction added");
  });

  it("routes DM reactions with peer kind 'direct' and user id", async () => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();

    const data = makeReactionEvent({ userId: "user-42", botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(makeReactionListenerParams());

    await listener.handle(data, client);

    expect(resolveAgentRouteMock).toHaveBeenCalledOnce();
    const routeArgs = (resolveAgentRouteMock.mock.calls[0]?.[0] ?? {}) as {
      peer?: unknown;
    };
    if (!routeArgs) {
      throw new Error("expected route arguments");
    }
    expect(routeArgs.peer).toEqual({ kind: "direct", id: "user-42" });
  });

  it("routes group DM reactions with peer kind 'group'", async () => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();

    const data = makeReactionEvent({ botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.GroupDM });
    const listener = new DiscordReactionListener(makeReactionListenerParams());

    await listener.handle(data, client);

    expect(resolveAgentRouteMock).toHaveBeenCalledOnce();
    const routeArgs = (resolveAgentRouteMock.mock.calls[0]?.[0] ?? {}) as {
      peer?: unknown;
    };
    if (!routeArgs) {
      throw new Error("expected route arguments");
    }
    expect(routeArgs.peer).toEqual({ kind: "group", id: "channel-1" });
  });
});

describe("discord reaction notification modes", () => {
  const guildId = "guild-900";
  const guild = fakeGuild(guildId, "Mode Guild");

  it("applies message-fetch behavior across notification modes and channel types", async () => {
    const cases = typedCases<{
      name: string;
      reactionNotifications: "off" | "all" | "allowlist" | "own";
      users: string[] | undefined;
      userId: string | undefined;
      channelType: ChannelType;
      channelId: string | undefined;
      parentId: string | undefined;
      messageAuthorId: string;
      expectedFetchChannelCalls: number;
      expectedMessageFetchCalls: number;
      expectedEnqueueCalls: number;
    }>([
      {
        name: "off mode",
        reactionNotifications: "off" as const,
        users: undefined,
        userId: undefined,
        channelType: ChannelType.GuildText,
        channelId: undefined,
        parentId: undefined,
        messageAuthorId: "other-user",
        expectedFetchChannelCalls: 0,
        expectedMessageFetchCalls: 0,
        expectedEnqueueCalls: 0,
      },
      {
        name: "all mode",
        reactionNotifications: "all" as const,
        users: undefined,
        userId: undefined,
        channelType: ChannelType.GuildText,
        channelId: undefined,
        parentId: undefined,
        messageAuthorId: "other-user",
        expectedFetchChannelCalls: 1,
        expectedMessageFetchCalls: 0,
        expectedEnqueueCalls: 1,
      },
      {
        name: "allowlist mode",
        reactionNotifications: "allowlist" as const,
        users: ["123"] as string[],
        userId: "123",
        channelType: ChannelType.GuildText,
        channelId: undefined,
        parentId: undefined,
        messageAuthorId: "other-user",
        expectedFetchChannelCalls: 1,
        expectedMessageFetchCalls: 0,
        expectedEnqueueCalls: 1,
      },
      {
        name: "allowlist mode denied without channel overrides",
        reactionNotifications: "allowlist" as const,
        users: ["trusted-user"] as string[],
        userId: "untrusted-user",
        channelType: ChannelType.GuildText,
        channelId: undefined,
        parentId: undefined,
        messageAuthorId: "other-user",
        expectedFetchChannelCalls: 0,
        expectedMessageFetchCalls: 0,
        expectedEnqueueCalls: 0,
      },
      {
        name: "own mode",
        reactionNotifications: "own" as const,
        users: undefined,
        userId: undefined,
        channelType: ChannelType.GuildText,
        channelId: undefined,
        parentId: undefined,
        messageAuthorId: "bot-1",
        expectedFetchChannelCalls: 1,
        expectedMessageFetchCalls: 1,
        expectedEnqueueCalls: 1,
      },
      {
        name: "all mode thread channel",
        reactionNotifications: "all" as const,
        users: undefined,
        userId: undefined,
        channelType: ChannelType.PublicThread,
        channelId: "thread-1",
        parentId: "parent-1",
        messageAuthorId: "other-user",
        expectedFetchChannelCalls: 2,
        expectedMessageFetchCalls: 0,
        expectedEnqueueCalls: 1,
      },
    ]);

    for (const testCase of cases) {
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      const messageFetch = vi.fn(async () => ({
        author: { id: testCase.messageAuthorId, username: "author", discriminator: "0" },
      }));
      const data = makeReactionEvent({
        guildId,
        guild,
        userId: testCase.userId,
        channelId: testCase.channelId,
        messageFetch,
      });
      const client = makeReactionClient({
        channelType: testCase.channelType,
        parentId: testCase.parentId,
      });
      const guildEntries = makeEntries({
        [guildId]: {
          reactionNotifications: testCase.reactionNotifications,
          users: testCase.users ? [...testCase.users] : undefined,
        },
      });
      const listener = new DiscordReactionListener(makeReactionListenerParams({ guildEntries }));

      await listener.handle(data, client);

      expect(getReactionClientFetchChannelMock(client), testCase.name).toHaveBeenCalledTimes(
        testCase.expectedFetchChannelCalls,
      );
      expect(messageFetch, testCase.name).toHaveBeenCalledTimes(testCase.expectedMessageFetchCalls);
      expect(enqueueSystemEventSpy, testCase.name).toHaveBeenCalledTimes(
        testCase.expectedEnqueueCalls,
      );
    }
  });
});
