// Discord tests cover threading.starter plugin behavior.
import { StickerFormatType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { ChannelType, type Client } from "../internal/discord.js";
import { getCachedThreadStarter, setCachedThreadStarter } from "./threading.cache.js";
import { resolveDiscordThreadStarter } from "./threading.js";

type ResolvedThreadStarter = NonNullable<Awaited<ReturnType<typeof resolveDiscordThreadStarter>>>;
let threadIdIndex = 0;

type ThreadStarterRestMessage = {
  content?: string | null;
  attachments?: unknown[];
  embeds?: Array<{ title?: string | null; description?: string | null }>;
  message_snapshots?: Array<{
    message?: {
      content?: string | null;
      attachments?: unknown[];
      embeds?: Array<{ title?: string | null; description?: string | null }>;
      sticker_items?: unknown[];
    };
  }>;
  sticker_items?: unknown[];
  author?: {
    id?: string | null;
    username?: string | null;
    discriminator?: string | null;
  };
  member?: {
    roles?: string[];
  };
  timestamp?: string | null;
};

function createStarterAuthor(
  overrides: Record<string, unknown> = {},
): NonNullable<ThreadStarterRestMessage["author"]> {
  return {
    id: "u1",
    username: "Alice",
    discriminator: "0",
    ...overrides,
  } as NonNullable<ThreadStarterRestMessage["author"]>;
}

function createForwardedSnapshotMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    content: "",
    attachments: [],
    embeds: [],
    ...overrides,
  };
}

function createForwardedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    message: createForwardedSnapshotMessage(overrides),
  };
}

function createStarterMessage(overrides: ThreadStarterRestMessage = {}): ThreadStarterRestMessage {
  return {
    content: "",
    embeds: [],
    author: createStarterAuthor(),
    ...overrides,
  };
}

function requireThreadStarter(
  result: Awaited<ReturnType<typeof resolveDiscordThreadStarter>>,
): ResolvedThreadStarter {
  if (!result) {
    throw new Error("expected resolved Discord thread starter");
  }
  return result;
}

function firstRestGetPath(get: ReturnType<typeof vi.fn>): unknown {
  const [call] = get.mock.calls;
  if (!call) {
    throw new Error("expected Discord REST GET call");
  }
  return call[0];
}

async function resolveStarter(params: {
  message: ThreadStarterRestMessage;
  parentId?: string;
  parentType?: ChannelType;
  resolveTimestampMs?: () => number | undefined;
}) {
  const get = vi.fn().mockResolvedValue(params.message);
  const client = { rest: { get } } as unknown as Client;
  const threadId = `thread-${++threadIdIndex}`;

  const result = await resolveDiscordThreadStarter({
    channel: { id: threadId },
    client,
    parentId: params.parentId ?? "parent-1",
    parentType: params.parentType ?? ChannelType.GuildText,
    resolveTimestampMs: params.resolveTimestampMs ?? (() => undefined),
  });

  return { get, result, threadId };
}

describe("resolveDiscordThreadStarter", () => {
  it("refreshes edited starter content in threads that stay active for a full day", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-08-23T00:00:00.000Z");
      vi.setSystemTime(startedAt);
      let content = "Original assignment";
      const get = vi.fn(async () => createStarterMessage({ content }));
      const client = { rest: { get } } as unknown as Client;
      const params = {
        channel: { id: `active-thread-${++threadIdIndex}` },
        client,
        parentId: "parent-1",
        parentType: ChannelType.GuildText,
        resolveTimestampMs: () => undefined,
      };

      expect(requireThreadStarter(await resolveDiscordThreadStarter(params)).text).toBe(
        "Original assignment",
      );
      content = "Updated assignment";

      for (let minute = 4; minute <= 24 * 60; minute += 4) {
        vi.setSystemTime(startedAt.getTime() + minute * 60_000);
        await resolveDiscordThreadStarter(params);
      }

      expect(requireThreadStarter(await resolveDiscordThreadStarter(params)).text).toBe(
        "Updated assignment",
      );
      expect(get.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "the exact five-minute freshness boundary", now: 1_300_000 },
    { name: "a clock rollback before the starter was fetched", now: 999_999 },
  ])("invalidates cached thread starters at $name", ({ now }) => {
    const key = `expired-thread-${++threadIdIndex}`;
    setCachedThreadStarter(key, { text: "stale", author: "Alice" }, 1_000_000);

    expect(getCachedThreadStarter(key, now)).toBeUndefined();
  });

  it("retains recently used thread starters when the 500-entry cache reaches capacity", () => {
    const prefix = `lru-thread-${++threadIdIndex}-`;
    for (let index = 0; index < 500; index += 1) {
      setCachedThreadStarter(
        `${prefix}${index}`,
        { text: `starter-${index}`, author: "Alice" },
        1_000_000,
      );
    }

    expect(getCachedThreadStarter(`${prefix}0`, 1_000_001)?.text).toBe("starter-0");
    setCachedThreadStarter(`${prefix}500`, { text: "new starter", author: "Alice" }, 1_000_002);

    expect(getCachedThreadStarter(`${prefix}0`, 1_000_003)?.text).toBe("starter-0");
    expect(getCachedThreadStarter(`${prefix}1`, 1_000_003)).toBeUndefined();
    expect(getCachedThreadStarter(`${prefix}500`, 1_000_003)?.text).toBe("new starter");
  });

  it("falls back to joined embed title and description when content is empty", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        content: "   ",
        embeds: [{ title: "Alert", description: "Details" }],
        timestamp: "2026-02-24T12:00:00.000Z",
      }),
      resolveTimestampMs: () => 123,
    });

    expect(requireThreadStarter(result)).toEqual({
      text: "Alert\nDetails",
      author: "Alice",
      authorId: "u1",
      authorName: "Alice",
      authorTag: "Alice",
      memberRoleIds: undefined,
      timestamp: 123,
    });
  });

  it("preserves ordered text from later embeds in REST-fetched thread starters", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        embeds: [{}, { title: "Alert", description: "Details" }, { description: "Follow-up" }],
      }),
    });

    expect(requireThreadStarter(result).text).toBe("Alert\nDetails\nFollow-up");
  });

  it("prefers starter content over embed fallback text", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        content: "starter content",
        embeds: [{ title: "Alert", description: "Details" }],
      }),
    });

    if (!result) {
      throw new Error("starter content should have produced a resolved starter payload");
    }
    expect(result.text).toBe("starter content");
  });

  it("preserves username, tag, and role metadata for downstream visibility checks", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        content: "starter content",
        author: createStarterAuthor({ discriminator: "1234" }),
        member: {
          roles: ["role-1", "role-2"],
        },
      }),
    });

    expect(requireThreadStarter(result)).toEqual({
      text: "starter content",
      author: "Alice#1234",
      authorId: "u1",
      authorName: "Alice",
      authorTag: "Alice#1234",
      memberRoleIds: ["role-1", "role-2"],
      timestamp: undefined,
    });
  });

  it("extracts text from forwarded message snapshots when content is empty", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        message_snapshots: [createForwardedSnapshot({ content: "forwarded task content" })],
        author: createStarterAuthor({ id: "u2", username: "Bob" }),
        timestamp: "2026-04-03T07:00:00.000Z",
      }),
      resolveTimestampMs: () => 456,
    });

    const starter = requireThreadStarter(result);
    expect(starter.text).toContain("forwarded task content");
    expect(starter.author).toBe("Bob");
    expect(starter.timestamp).toBe(456);
  });

  it("prefers content over forwarded message snapshots", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        content: "direct content",
        message_snapshots: [createForwardedSnapshot({ content: "forwarded content" })],
        author: createStarterAuthor({ id: "u3", username: "Charlie" }),
      }),
    });

    expect(requireThreadStarter(result).text).toBe("direct content");
  });

  it("joins multiple forwarded message snapshots", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        message_snapshots: [
          createForwardedSnapshot({ content: "first forwarded message" }),
          createForwardedSnapshot({ content: "second forwarded message" }),
        ],
        author: createStarterAuthor({ id: "u5", username: "Eve" }),
      }),
    });

    const starter = requireThreadStarter(result);
    expect(starter.text).toContain("first forwarded message");
    expect(starter.text).toContain("second forwarded message");
  });

  it("preserves forwarded attachment placeholders in thread starter context", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        message_snapshots: [
          createForwardedSnapshot({
            attachments: [
              {
                id: "a1",
                filename: "forwarded.png",
                content_type: "image/png",
                url: "https://cdn.discordapp.com/forwarded.png",
              },
            ],
          }),
        ],
        author: createStarterAuthor({ id: "u6", username: "Frank" }),
      }),
    });

    const starter = requireThreadStarter(result);
    expect(starter.text).toContain("[Forwarded message]");
    expect(starter.text).toContain("<media:image>");
    expect(starter.text).not.toContain("(1 image)");
  });

  it("preserves forwarded sticker placeholders in thread starter context", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        message_snapshots: [
          createForwardedSnapshot({
            sticker_items: [
              {
                id: "s1",
                name: "party",
                format_type: StickerFormatType.PNG,
              },
            ],
          }),
        ],
        author: createStarterAuthor({ id: "u7", username: "Grace" }),
      }),
    });

    const starter = requireThreadStarter(result);
    expect(starter.text).toContain("[Forwarded message]");
    expect(starter.text).toContain("<media:sticker>");
    expect(starter.text).not.toContain("(1 sticker)");
  });

  it("renders native media for attachment-only thread starters", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        attachments: [
          {
            id: "a1",
            filename: "starter.png",
            content_type: "image/png",
            url: "https://cdn.discordapp.com/starter.png",
          },
        ],
      }),
    });

    expect(requireThreadStarter(result).text).toBe("<media:image>");
  });

  it("uses the thread id as the message channel id for forum parents", async () => {
    const { get, result, threadId } = await resolveStarter({
      message: createStarterMessage({ content: "starter content" }),
      parentId: undefined,
      parentType: ChannelType.GuildForum,
    });

    expect(requireThreadStarter(result).text).toBe("starter content");
    expect(get).toHaveBeenCalledTimes(1);
    expect(firstRestGetPath(get)).toBe(`/channels/${threadId}/messages/${threadId}`);
  });

  it("returns null when content, embeds, and snapshots are all empty", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        message_snapshots: [],
        author: createStarterAuthor({ id: "u4", username: "Dave" }),
      }),
    });

    expect(result).toBeNull();
  });
});
