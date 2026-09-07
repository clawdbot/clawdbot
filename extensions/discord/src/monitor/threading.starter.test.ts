// Discord tests cover threading.starter plugin behavior.
import { ComponentType, MessageFlags, StickerFormatType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { ChannelType, DiscordError, type Client } from "../internal/discord.js";
import { getCachedThreadStarter, setCachedThreadStarter } from "./threading.cache.js";
import { resolveDiscordThreadStarter } from "./threading.js";

type ResolvedThreadStarter = NonNullable<Awaited<ReturnType<typeof resolveDiscordThreadStarter>>>;
let threadIdIndex = 0;

type ThreadStarterRestMessage = {
  content?: string | null;
  components?: unknown;
  flags?: number;
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
  stickers?: unknown[];
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

const COMPONENTS_V2_STARTER_BODY = [
  {
    type: ComponentType.Container,
    components: [
      { type: ComponentType.TextDisplay, content: "Deploy failed" },
      {
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, content: "staging pipeline exited 1" }],
        accessory: { type: ComponentType.Thumbnail, media: { url: "attachment://log.png" } },
      },
    ],
  },
];

function createDiscordError(status: number): DiscordError {
  return new DiscordError(new Response(null, { status }), {});
}

function requireThreadStarter(
  result: Awaited<ReturnType<typeof resolveDiscordThreadStarter>>,
): ResolvedThreadStarter {
  if (!result) {
    throw new Error("expected resolved Discord thread starter");
  }
  return result;
}

function requireCachedThreadStarter(value: ReturnType<typeof getCachedThreadStarter>) {
  if (!value || value.kind !== "hit") {
    throw new Error("expected cached Discord thread starter");
  }
  return value.starter;
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
    accountId: "test-account",
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
        accountId: "test-account",
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
    setCachedThreadStarter(
      key,
      { kind: "hit", starter: { text: "stale", author: "Alice" } },
      1_000_000,
    );

    expect(getCachedThreadStarter(key, now)).toBeUndefined();
  });

  it("retains recently used thread starters when the 500-entry cache reaches capacity", () => {
    const prefix = `lru-thread-${++threadIdIndex}-`;
    for (let index = 0; index < 500; index += 1) {
      setCachedThreadStarter(
        `${prefix}${index}`,
        { kind: "hit", starter: { text: `starter-${index}`, author: "Alice" } },
        1_000_000,
      );
    }

    expect(requireCachedThreadStarter(getCachedThreadStarter(`${prefix}0`, 1_000_001)).text).toBe(
      "starter-0",
    );
    setCachedThreadStarter(
      `${prefix}500`,
      { kind: "hit", starter: { text: "new starter", author: "Alice" } },
      1_000_002,
    );

    expect(requireCachedThreadStarter(getCachedThreadStarter(`${prefix}0`, 1_000_003)).text).toBe(
      "starter-0",
    );
    expect(getCachedThreadStarter(`${prefix}1`, 1_000_003)).toBeUndefined();
    expect(requireCachedThreadStarter(getCachedThreadStarter(`${prefix}500`, 1_000_003)).text).toBe(
      "new starter",
    );
  });

  it.each([
    { name: "a missing starter", get: () => vi.fn().mockResolvedValue(null) },
    {
      name: "an inaccessible starter",
      get: () => vi.fn().mockRejectedValue(createDiscordError(403)),
    },
  ])("negative-caches $name for 30 seconds", async ({ get: createGet }) => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-08-24T00:00:00.000Z");
      vi.setSystemTime(now);
      const get = createGet();
      const client = { rest: { get } } as unknown as Client;
      const params = {
        channel: { id: `missing-starter-${++threadIdIndex}` },
        client,
        accountId: "test-account",
        parentId: "parent-1",
        parentType: ChannelType.GuildText,
        resolveTimestampMs: () => undefined,
      };

      await expect(resolveDiscordThreadStarter(params)).resolves.toBeNull();
      await expect(resolveDiscordThreadStarter(params)).resolves.toBeNull();
      expect(get).toHaveBeenCalledOnce();

      vi.setSystemTime(now.getTime() + 30_000);
      await expect(resolveDiscordThreadStarter(params)).resolves.toBeNull();
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent starter lookups for the same account and thread", async () => {
    let releaseGet!: (message: ThreadStarterRestMessage | null) => void;
    const response = new Promise<ThreadStarterRestMessage | null>((resolve) => {
      releaseGet = resolve;
    });
    const get = vi.fn(() => response);
    const client = { rest: { get } } as unknown as Client;
    const params = {
      channel: { id: `concurrent-starter-${++threadIdIndex}` },
      client,
      accountId: "test-account",
      parentId: "parent-1",
      parentType: ChannelType.GuildText,
      resolveTimestampMs: () => undefined,
    };

    const first = resolveDiscordThreadStarter(params);
    const second = resolveDiscordThreadStarter(params);
    expect(get).toHaveBeenCalledOnce();

    releaseGet(null);
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(get).toHaveBeenCalledOnce();
  });

  it("does not coalesce missing metadata with a lookup that has a parent id", async () => {
    const get = vi.fn().mockResolvedValue(createStarterMessage({ content: "resolved" }));
    const client = { rest: { get } } as unknown as Client;
    const params = {
      channel: { id: `metadata-single-flight-${++threadIdIndex}` },
      client,
      accountId: "test-account",
      parentType: ChannelType.GuildText,
      resolveTimestampMs: () => undefined,
    };

    const missingMetadata = resolveDiscordThreadStarter(params);
    const completeMetadata = resolveDiscordThreadStarter({ ...params, parentId: "parent-1" });

    await expect(missingMetadata).resolves.toBeNull();
    await expect(completeMetadata).resolves.toMatchObject({ text: "resolved" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("does not negative-cache transient REST failures", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValue(createStarterMessage({ content: "recovered starter" }));
    const client = { rest: { get } } as unknown as Client;
    const params = {
      channel: { id: `transient-starter-${++threadIdIndex}` },
      client,
      accountId: "test-account",
      parentId: "parent-1",
      parentType: ChannelType.GuildText,
      resolveTimestampMs: () => undefined,
    };

    await expect(resolveDiscordThreadStarter(params)).resolves.toBeNull();
    await expect(resolveDiscordThreadStarter(params)).resolves.toMatchObject({
      text: "recovered starter",
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("scopes negative cache entries to the Discord account", async () => {
    const deniedGet = vi.fn().mockRejectedValue(createDiscordError(403));
    const allowedGet = vi.fn().mockResolvedValue(createStarterMessage({ content: "visible" }));
    const threadId = `account-scoped-starter-${++threadIdIndex}`;
    const baseParams = {
      channel: { id: threadId },
      parentId: "parent-1",
      parentType: ChannelType.GuildText,
      resolveTimestampMs: () => undefined,
    };

    await expect(
      resolveDiscordThreadStarter({
        ...baseParams,
        client: { rest: { get: deniedGet } } as unknown as Client,
        accountId: "account-a",
      }),
    ).resolves.toBeNull();
    await expect(
      resolveDiscordThreadStarter({
        ...baseParams,
        client: { rest: { get: allowedGet } } as unknown as Client,
        accountId: "account-b",
      }),
    ).resolves.toMatchObject({ text: "visible" });
    expect(deniedGet).toHaveBeenCalledOnce();
    expect(allowedGet).toHaveBeenCalledOnce();
  });

  it("does not cache missing parent metadata", async () => {
    const get = vi.fn().mockResolvedValue(createStarterMessage({ content: "resolved" }));
    const client = { rest: { get } } as unknown as Client;
    const channel = { id: `metadata-starter-${++threadIdIndex}` };

    await expect(
      resolveDiscordThreadStarter({
        channel,
        client,
        accountId: "test-account",
        parentType: ChannelType.GuildText,
        resolveTimestampMs: () => undefined,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveDiscordThreadStarter({
        channel,
        client,
        accountId: "test-account",
        parentId: "parent-1",
        parentType: ChannelType.GuildText,
        resolveTimestampMs: () => undefined,
      }),
    ).resolves.toMatchObject({ text: "resolved" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("resolves thread starters when their parent type is unavailable", async () => {
    const threadId = `unknown-parent-type-starter-${++threadIdIndex}`;
    const get = vi.fn().mockResolvedValue(createStarterMessage({ content: "visible starter" }));

    await expect(
      resolveDiscordThreadStarter({
        channel: { id: threadId },
        client: { rest: { get } } as unknown as Client,
        accountId: "test-account",
        parentId: "parent-1",
        resolveTimestampMs: () => undefined,
      }),
    ).resolves.toMatchObject({ text: "visible starter" });
    expect(get).toHaveBeenCalledExactlyOnceWith(`/channels/parent-1/messages/${threadId}`);
  });

  it("keeps parent-route misses separate when forum metadata recovers", async () => {
    const threadId = `recovering-forum-starter-${++threadIdIndex}`;
    const get = vi.fn(async (path: string) =>
      path === `/channels/${threadId}/messages/${threadId}`
        ? createStarterMessage({ content: "recovered forum starter" })
        : null,
    );
    const client = { rest: { get } } as unknown as Client;
    const params = {
      channel: { id: threadId },
      client,
      accountId: "test-account",
      parentId: "parent-1",
      resolveTimestampMs: () => undefined,
    };

    await expect(
      resolveDiscordThreadStarter({ ...params, parentType: undefined }),
    ).resolves.toBeNull();
    expect(get).toHaveBeenCalledExactlyOnceWith(`/channels/parent-1/messages/${threadId}`);

    await expect(
      resolveDiscordThreadStarter({ ...params, parentType: ChannelType.GuildForum }),
    ).resolves.toMatchObject({ text: "recovered forum starter" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(2, `/channels/${threadId}/messages/${threadId}`);
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

  it.each([
    { name: "text channel", parentType: ChannelType.GuildText },
    { name: "forum", parentType: ChannelType.GuildForum },
  ])(
    "keeps Components v2 text from a component-only starter in a $name thread",
    async ({ parentType }) => {
      const { result } = await resolveStarter({
        message: createStarterMessage({
          components: COMPONENTS_V2_STARTER_BODY,
          flags: MessageFlags.IsComponentsV2,
        }),
        parentType,
      });

      expect(requireThreadStarter(result).text).toBe("Deploy failed\nstaging pipeline exited 1");
    },
  );

  it("prefers starter content over Components v2 text", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        content: "starter content",
        components: COMPONENTS_V2_STARTER_BODY,
      }),
    });

    expect(requireThreadStarter(result).text).toBe("starter content");
  });

  it("prefers Components v2 text over a forwarded snapshot when a starter carries both", async () => {
    const { result } = await resolveStarter({
      message: createStarterMessage({
        components: COMPONENTS_V2_STARTER_BODY,
        flags: MessageFlags.IsComponentsV2 | MessageFlags.HasSnapshot,
        message_snapshots: [createForwardedSnapshot({ content: "forwarded content" })],
      }),
    });

    expect(requireThreadStarter(result).text).toBe("Deploy failed\nstaging pipeline exited 1");
  });

  it("renders the sticker placeholder for every REST sticker shape", async () => {
    const sticker = { id: "s1", name: "party", format_type: StickerFormatType.PNG };
    const shapes: Record<string, ThreadStarterRestMessage> = {
      stickerItemsOnly: { sticker_items: [sticker] },
      stickersOnly: { stickers: [sticker] },
      emptyStickersBesideStickerItems: { stickers: [], sticker_items: [sticker] },
    };

    const texts: Record<string, string | null> = {};
    for (const [name, message] of Object.entries(shapes)) {
      const { result } = await resolveStarter({ message: createStarterMessage(message) });
      texts[name] = result?.text ?? null;
    }

    expect(texts).toEqual({
      stickerItemsOnly: "<media:sticker>",
      stickersOnly: "<media:sticker>",
      emptyStickersBesideStickerItems: "<media:sticker>",
    });
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
