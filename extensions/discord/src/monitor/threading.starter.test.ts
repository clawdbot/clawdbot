import { StickerFormatType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Client } from "../internal/discord.js";
import {
  __resetDiscordThreadStarterCacheForTest,
  resolveDiscordThreadStarter,
} from "./threading.js";

type ResolvedThreadStarter = NonNullable<Awaited<ReturnType<typeof resolveDiscordThreadStarter>>>;

type ThreadStarterRestMessage = {
  content?: string | null;
  embeds?: Array<{ title?: string | null; description?: string | null }>;
  message_snapshots?: Array<{
    message?: {
      content?: string | null;
      attachments?: unknown[];
      embeds?: Array<{ title?: string | null; description?: string | null }>;
      sticker_items?: unknown[];
    };
  }>;
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

async function resolveStarter(params: {
  message: ThreadStarterRestMessage;
  parentId?: string;
  parentType?: ChannelType;
  resolveTimestampMs?: () => number | undefined;
}) {
  const get = vi.fn().mockResolvedValue(params.message);
  const client = { rest: { get } } as unknown as Client;

  const result = await resolveDiscordThreadStarter({
    channel: { id: "thread-1" },
    client,
    parentId: params.parentId ?? "parent-1",
    parentType: params.parentType ?? ChannelType.GuildText,
    resolveTimestampMs: params.resolveTimestampMs ?? (() => undefined),
  });

  return { get, result };
}

describe("resolveDiscordThreadStarter", () => {
  beforeEach(() => {
    __resetDiscordThreadStarterCacheForTest();
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
    expect(starter.text).toContain("<media:image> (1 image)");
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
    expect(starter.text).toContain("<media:sticker> (1 sticker)");
  });

  it("uses the thread id as the message channel id for forum parents", async () => {
    const { get, result } = await resolveStarter({
      message: createStarterMessage({ content: "starter content" }),
      parentId: undefined,
      parentType: ChannelType.GuildForum,
    });

    expect(requireThreadStarter(result).text).toBe("starter content");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toBe("/channels/thread-1/messages/thread-1");
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
