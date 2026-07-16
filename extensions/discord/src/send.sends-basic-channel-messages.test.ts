import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordWebMediaMockFactory, makeDiscordRest } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", () => discordWebMediaMockFactory());

let deleteMessageDiscord: typeof import("./send.js").deleteMessageDiscord;
let editMessageDiscord: typeof import("./send.js").editMessageDiscord;
let fetchChannelPermissionsDiscord: typeof import("./send.js").fetchChannelPermissionsDiscord;
let fetchReactionsDiscord: typeof import("./send.js").fetchReactionsDiscord;
let pinMessageDiscord: typeof import("./send.js").pinMessageDiscord;
let reactMessageDiscord: typeof import("./send.js").reactMessageDiscord;
let readMessagesDiscord: typeof import("./send.js").readMessagesDiscord;
let removeOwnReactionsDiscord: typeof import("./send.js").removeOwnReactionsDiscord;
let removeReactionDiscord: typeof import("./send.js").removeReactionDiscord;
let searchMessagesDiscord: typeof import("./send.js").searchMessagesDiscord;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;
let unpinMessageDiscord: typeof import("./send.js").unpinMessageDiscord;
let loadWebMedia: typeof import("openclaw/plugin-sdk/web-media").loadWebMedia;
let __resetDiscordDirectoryCacheForTest: typeof import("./directory-cache.js").__resetDiscordDirectoryCacheForTest;
let rememberDiscordDirectoryUser: typeof import("./directory-cache.js").rememberDiscordDirectoryUser;

beforeAll(async () => {
  ({
    deleteMessageDiscord,
    editMessageDiscord,
    fetchChannelPermissionsDiscord,
    fetchReactionsDiscord,
    pinMessageDiscord,
    reactMessageDiscord,
    readMessagesDiscord,
    removeOwnReactionsDiscord,
    removeReactionDiscord,
    searchMessagesDiscord,
    sendMessageDiscord,
    unpinMessageDiscord,
  } = await import("./send.js"));
  ({ loadWebMedia } = await import("openclaw/plugin-sdk/web-media"));
  ({ __resetDiscordDirectoryCacheForTest, rememberDiscordDirectoryUser } =
    await import("./directory-cache.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetDiscordDirectoryCacheForTest();
});

describe("sendMessageDiscord", () => {
  function expectReplyReference(
    body: { message_reference?: unknown } | undefined,
    messageId: string,
  ) {
    expect(body?.message_reference).toEqual({
      message_id: messageId,
      fail_if_not_exists: false,
    });
  }

  async function sendChunkedReplyAndCollectBodies(params: { text: string; mediaUrl?: string }) {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    await sendMessageDiscord("channel:789", params.text, {
      rest,
      token: "t",
      replyTo: "orig-123",
      ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    });
    expect(postMock).toHaveBeenCalledTimes(2);
    return {
      firstBody: postMock.mock.calls[0]?.[1]?.body as { message_reference?: unknown } | undefined,
      secondBody: postMock.mock.calls[1]?.[1]?.body as { message_reference?: unknown } | undefined,
    };
  }

  function setupForumSend(secondResponse: { id: string; channel_id: string }) {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildForum });
    postMock
      .mockResolvedValueOnce({
        id: "thread1",
        message: { id: "starter1", channel_id: "thread1" },
      })
      .mockResolvedValueOnce(secondResponse);
    return { rest, postMock };
  }

  it("sends basic channel messages", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    // Channel type lookup returns a normal text channel (not a forum).
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    const res = await sendMessageDiscord("channel:789", "hello world", {
      rest,
      token: "t",
    });
    expect(res).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({ body: { content: "hello world" } }),
    );
  });

  it("rewrites cached @username mentions to id-based mentions", async () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789012345678",
      handles: ["Alice"],
    });
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    await sendMessageDiscord("channel:789", "ping @Alice", {
      rest,
      token: "t",
      accountId: "default",
    });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({ body: { content: "ping <@123456789012345678>" } }),
    );
  });

  it("uses configured defaultAccount for cached mention rewriting when accountId is omitted", async () => {
    rememberDiscordDirectoryUser({
      accountId: "work",
      userId: "222333444555666777",
      handles: ["Alice"],
    });
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    await sendMessageDiscord("channel:789", "ping @Alice", {
      rest,
      token: "t",
      cfg: {
        channels: {
          discord: {
            defaultAccount: "work",
            accounts: {
              work: {
                token: "Bot work-token", // pragma: allowlist secret
              },
            },
          },
        },
      } as never,
    });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({ body: { content: "ping <@222333444555666777>" } }),
    );
  });

  it("auto-creates a forum thread when target is a Forum channel", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    // Channel type lookup returns a Forum channel.
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({
      id: "thread1",
      message: { id: "starter1", channel_id: "thread1" },
    });
    const res = await sendMessageDiscord("channel:forum1", "Discussion topic\nBody of the post", {
      rest,
      token: "t",
    });
    expect(res).toEqual({ messageId: "starter1", channelId: "thread1" });
    // Should POST to threads route, not channelMessages.
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("forum1"),
      expect.objectContaining({
        body: {
          name: "Discussion topic",
          message: { content: "Discussion topic\nBody of the post" },
        },
      }),
    );
  });

  it("posts media as a follow-up message in forum channels", async () => {
    const { rest, postMock } = setupForumSend({ id: "media1", channel_id: "thread1" });
    const res = await sendMessageDiscord("channel:forum1", "Topic", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(res).toEqual({ messageId: "starter1", channelId: "thread1" });
    expect(postMock).toHaveBeenNthCalledWith(
      1,
      Routes.threads("forum1"),
      expect.objectContaining({
        body: {
          name: "Topic",
          message: { content: "Topic" },
        },
      }),
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      Routes.channelMessages("thread1"),
      expect.objectContaining({
        body: expect.objectContaining({
          files: [expect.objectContaining({ name: "photo.jpg" })],
        }),
      }),
    );
  });

  it("chunks long forum posts into follow-up messages", async () => {
    const { rest, postMock } = setupForumSend({ id: "msg2", channel_id: "thread1" });
    const longText = "a".repeat(2001);
    await sendMessageDiscord("channel:forum1", longText, {
      rest,
      token: "t",
    });
    const firstBody = postMock.mock.calls[0]?.[1]?.body as {
      message?: { content?: string };
    };
    const secondBody = postMock.mock.calls[1]?.[1]?.body as { content?: string };
    expect(firstBody?.message?.content).toHaveLength(2000);
    expect(secondBody?.content).toBe("a");
  });

  it("starts DM when recipient is a user", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockResolvedValueOnce({ id: "chan1" })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "chan1" });
    const res = await sendMessageDiscord("user:123", "hiya", {
      rest,
      token: "t",
    });
    expect(postMock).toHaveBeenNthCalledWith(
      1,
      Routes.userChannels(),
      expect.objectContaining({ body: { recipient_id: "123" } }),
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      Routes.channelMessages("chan1"),
      expect.objectContaining({ body: { content: "hiya" } }),
    );
    expect(res.channelId).toBe("chan1");
  });

  it("rejects bare numeric IDs as ambiguous", async () => {
    const { rest } = makeDiscordRest();
    await expect(
      sendMessageDiscord("273512430271856640", "hello", { rest, token: "t" }),
    ).rejects.toThrow(/Ambiguous Discord recipient/);
    await expect(
      sendMessageDiscord("273512430271856640", "hello", { rest, token: "t" }),
    ).rejects.toThrow(/user:273512430271856640/);
    await expect(
      sendMessageDiscord("273512430271856640", "hello", { rest, token: "t" }),
    ).rejects.toThrow(/channel:273512430271856640/);
  });

  it("adds missing permission hints on 50013", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    const perms = PermissionFlagsBits.ViewChannel;
    const apiError = Object.assign(new Error("Missing Permissions"), {
      code: 50013,
      status: 403,
    });
    postMock.mockRejectedValueOnce(apiError);
    getMock
      .mockResolvedValueOnce({ type: ChannelType.GuildText })
      .mockResolvedValueOnce({
        id: "789",
        guild_id: "guild1",
        type: 0,
        permission_overwrites: [],
      })
      .mockResolvedValueOnce({ id: "bot1" })
      .mockResolvedValueOnce({
        id: "guild1",
        roles: [{ id: "guild1", permissions: perms.toString() }],
      })
      .mockResolvedValueOnce({ roles: [] });

    let error: unknown;
    try {
      await sendMessageDiscord("channel:789", "hello", { rest, token: "t" });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toMatch(/missing permissions/i);
    expect(String(error)).toMatch(/SendMessages/);
  });

  it("uploads media attachments", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });
    const res = await sendMessageDiscord("channel:789", "photo", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(res.messageId).toBe("msg");
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        body: expect.objectContaining({
          files: [expect.objectContaining({ name: "photo.jpg" })],
        }),
      }),
    );
    expect(loadWebMedia).toHaveBeenCalledWith(
      "file:///tmp/photo.jpg",
      expect.objectContaining({ maxBytes: 100 * 1024 * 1024 }),
    );
  });

  it("prefers the caller-provided filename for media attachments", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });

    await sendMessageDiscord("channel:789", "photo", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/generated-image",
      filename: "renderable.png",
    });

    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        body: expect.objectContaining({
          files: [expect.objectContaining({ name: "renderable.png" })],
        }),
      }),
    );
  });

  it("uses configured discord mediaMaxMb for uploads", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });

    await sendMessageDiscord("channel:789", "photo", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/photo.jpg",
      cfg: {
        channels: {
          discord: {
            mediaMaxMb: 32,
          },
        },
      },
    });

    expect(loadWebMedia).toHaveBeenCalledWith(
      "file:///tmp/photo.jpg",
      expect.objectContaining({ maxBytes: 32 * 1024 * 1024 }),
    );
  });

  it("sends media with empty text without content field", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });
    const res = await sendMessageDiscord("channel:789", "", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(res.messageId).toBe("msg");
    const body = postMock.mock.calls[0]?.[1]?.body;
    expect(body).not.toHaveProperty("content");
    expect(body).toHaveProperty("files");
  });

  it("preserves whitespace in media captions", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });
    await sendMessageDiscord("channel:789", "  spaced  ", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/photo.jpg",
    });
    const body = postMock.mock.calls[0]?.[1]?.body;
    expect(body).toHaveProperty("content", "  spaced  ");
  });

  it("includes message_reference when replying", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    await sendMessageDiscord("channel:789", "hello", {
      rest,
      token: "t",
      replyTo: "orig-123",
    });
    const body = postMock.mock.calls[0]?.[1]?.body;
    expect(body?.message_reference).toEqual({
      message_id: "orig-123",
      fail_if_not_exists: false,
    });
  });

  it("preserves reply reference across all text chunks", async () => {
    const { firstBody, secondBody } = await sendChunkedReplyAndCollectBodies({
      text: "a".repeat(2001),
    });
    expectReplyReference(firstBody, "orig-123");
    expectReplyReference(secondBody, "orig-123");
  });

  it("preserves reply reference for follow-up text chunks after media caption split", async () => {
    const { firstBody, secondBody } = await sendChunkedReplyAndCollectBodies({
      text: "a".repeat(2500),
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expectReplyReference(firstBody, "orig-123");
    expectReplyReference(secondBody, "orig-123");
  });
});

describe("reactMessageDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reacts with unicode emoji", async () => {
    const { rest, putMock } = makeDiscordRest();
    await reactMessageDiscord("chan1", "msg1", "✅", { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "%E2%9C%85"),
    );
  });

  it("normalizes variation selectors in unicode emoji", async () => {
    const { rest, putMock } = makeDiscordRest();
    await reactMessageDiscord("chan1", "msg1", "⭐️", { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "%E2%AD%90"),
    );
  });

  it("reacts with custom emoji syntax", async () => {
    const { rest, putMock } = makeDiscordRest();
    await reactMessageDiscord("chan1", "msg1", "<:party_blob:123>", {
      rest,
      token: "t",
    });
    expect(putMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "party_blob%3A123"),
    );
  });
});

describe("removeReactionDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes a unicode emoji reaction", async () => {
    const { rest, deleteMock } = makeDiscordRest();
    await removeReactionDiscord("chan1", "msg1", "✅", { rest, token: "t" });
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "%E2%9C%85"),
    );
  });
});

describe("removeOwnReactionsDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes all own reactions on a message", async () => {
    const { rest, getMock, deleteMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      reactions: [
        { emoji: { name: "✅", id: null } },
        { emoji: { name: "party_blob", id: "123" } },
      ],
    });
    const res = await removeOwnReactionsDiscord("chan1", "msg1", {
      rest,
      token: "t",
    });
    expect(res).toEqual({ ok: true, removed: ["✅", "party_blob:123"] });
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "%E2%9C%85"),
    );
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "party_blob%3A123"),
    );
  });
});

describe("fetchReactionsDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns reactions with users", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock
      .mockResolvedValueOnce({
        reactions: [
          { count: 2, emoji: { name: "✅", id: null } },
          { count: 1, emoji: { name: "party_blob", id: "123" } },
        ],
      })
      .mockResolvedValueOnce([{ id: "u1", username: "alpha", discriminator: "0001" }])
      .mockResolvedValueOnce([{ id: "u2", username: "beta" }]);
    const res = await fetchReactionsDiscord("chan1", "msg1", {
      rest,
      token: "t",
    });
    expect(res).toEqual([
      {
        emoji: { id: null, name: "✅", raw: "✅" },
        count: 2,
        users: [{ id: "u1", username: "alpha", tag: "alpha#0001" }],
      },
      {
        emoji: { id: "123", name: "party_blob", raw: "party_blob:123" },
        count: 1,
        users: [{ id: "u2", username: "beta", tag: "beta" }],
      },
    ]);
  });
});

describe("fetchChannelPermissionsDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates permissions from guild roles", async () => {
    const { rest, getMock } = makeDiscordRest();
    const perms = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
    getMock
      .mockResolvedValueOnce({
        id: "chan1",
        guild_id: "guild1",
        permission_overwrites: [],
      })
      .mockResolvedValueOnce({ id: "bot1" })
      .mockResolvedValueOnce({
        id: "guild1",
        roles: [
          { id: "guild1", permissions: perms.toString() },
          { id: "role2", permissions: "0" },
        ],
      })
      .mockResolvedValueOnce({ roles: ["role2"] });
    const res = await fetchChannelPermissionsDiscord("chan1", {
      rest,
      token: "t",
    });
    expect(res.guildId).toBe("guild1");
    expect(res.permissions).toContain("ViewChannel");
    expect(res.permissions).toContain("SendMessages");
    expect(res.isDm).toBe(false);
  });

  it("treats Administrator as all permissions despite overwrites", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock
      .mockResolvedValueOnce({
        id: "chan1",
        guild_id: "guild1",
        permission_overwrites: [
          {
            id: "guild1",
            deny: PermissionFlagsBits.ViewChannel.toString(),
            allow: "0",
          },
        ],
      })
      .mockResolvedValueOnce({ id: "bot1" })
      .mockResolvedValueOnce({
        id: "guild1",
        roles: [{ id: "guild1", permissions: PermissionFlagsBits.Administrator.toString() }],
      })
      .mockResolvedValueOnce({ roles: [] });
    const res = await fetchChannelPermissionsDiscord("chan1", {
      rest,
      token: "t",
    });
    expect(res.permissions).toContain("Administrator");
    expect(res.permissions).toContain("ViewChannel");
  });
});

describe("readMessagesDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes query params as an object", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue([]);
    await readMessagesDiscord("chan1", { limit: 5, before: "10" }, { rest, token: "t" });
    const call = getMock.mock.calls[0];
    const options = call?.[1] as Record<string, unknown>;
    expect(options).toEqual({ limit: 5, before: "10" });
  });
});

describe("edit/delete message helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("edits message content", async () => {
    const { rest, patchMock } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await editMessageDiscord("chan1", "m1", { content: "hello" }, { rest, token: "t" });
    expect(patchMock).toHaveBeenCalledWith(
      Routes.channelMessage("chan1", "m1"),
      expect.objectContaining({ body: { content: "hello" } }),
    );
  });

  it("deletes message", async () => {
    const { rest, deleteMock } = makeDiscordRest();
    deleteMock.mockResolvedValue({});
    await deleteMessageDiscord("chan1", "m1", { rest, token: "t" });
    expect(deleteMock).toHaveBeenCalledWith(Routes.channelMessage("chan1", "m1"));
  });
});

describe("pin helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins and unpins messages", async () => {
    const { rest, putMock, deleteMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    await pinMessageDiscord("chan1", "m1", { rest, token: "t" });
    await unpinMessageDiscord("chan1", "m1", { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(Routes.channelPin("chan1", "m1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.channelPin("chan1", "m1"));
  });
});

describe("searchMessagesDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses URLSearchParams for search", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ total_results: 0, messages: [] });
    await searchMessagesDiscord(
      { guildId: "g1", content: "hello", limit: 5 },
      { rest, token: "t" },
    );
    const call = getMock.mock.calls[0];
    expect(call?.[0]).toBe("/guilds/g1/messages/search?content=hello&limit=5");
  });

  it("supports channel/author arrays and clamps limit", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ total_results: 0, messages: [] });
    await searchMessagesDiscord(
      {
        guildId: "g1",
        content: "hello",
        channelIds: ["c1", "c2"],
        authorIds: ["u1"],
        limit: 99,
      },
      { rest, token: "t" },
    );
    const call = getMock.mock.calls[0];
    expect(call?.[0]).toBe(
      "/guilds/g1/messages/search?content=hello&channel_id=c1&channel_id=c2&author_id=u1&limit=25",
    );
  });
});
