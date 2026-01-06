import { PermissionsBitField, Routes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addRoleDiscord,
  banMemberDiscord,
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchChannelPermissionsDiscord,
  fetchReactionsDiscord,
  listGuildEmojisDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeRoleDiscord,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  timeoutMemberDiscord,
  unpinMessageDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
} from "./send.js";

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("img"),
    fileName: "photo.jpg",
    contentType: "image/jpeg",
    kind: "image",
  }),
  loadWebMediaRaw: vi.fn().mockResolvedValue({
    buffer: Buffer.from("img"),
    fileName: "asset.png",
    contentType: "image/png",
    kind: "image",
  }),
}));

const makeRest = () => {
  const postMock = vi.fn();
  const putMock = vi.fn();
  const getMock = vi.fn();
  const patchMock = vi.fn();
  const deleteMock = vi.fn();
  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock,
    } as unknown as import("discord.js").REST,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
};

describe("sendMessageDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends basic channel messages", async () => {
    const { rest, postMock } = makeRest();
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

  it("starts DM when recipient is a user", async () => {
    const { rest, postMock } = makeRest();
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

  it("adds missing permission hints on 50013", async () => {
    const { rest, postMock, getMock } = makeRest();
    const perms = new PermissionsBitField([
      PermissionsBitField.Flags.ViewChannel,
    ]);
    const apiError = Object.assign(new Error("Missing Permissions"), {
      code: 50013,
      status: 403,
    });
    postMock.mockRejectedValueOnce(apiError);
    getMock
      .mockResolvedValueOnce({
        id: "789",
        guild_id: "guild1",
        type: 0,
        permission_overwrites: [],
      })
      .mockResolvedValueOnce({ id: "bot1" })
      .mockResolvedValueOnce({
        id: "guild1",
        roles: [{ id: "guild1", permissions: perms.bitfield.toString() }],
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
    const { rest, postMock } = makeRest();
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
        files: [expect.objectContaining({ name: "photo.jpg" })],
      }),
    );
  });

  it("includes message_reference when replying", async () => {
    const { rest, postMock } = makeRest();
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

  it("replies only on the first chunk", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    await sendMessageDiscord("channel:789", "a".repeat(2001), {
      rest,
      token: "t",
      replyTo: "orig-123",
    });
    expect(postMock).toHaveBeenCalledTimes(2);
    const firstBody = postMock.mock.calls[0]?.[1]?.body;
    const secondBody = postMock.mock.calls[1]?.[1]?.body;
    expect(firstBody?.message_reference).toEqual({
      message_id: "orig-123",
      fail_if_not_exists: false,
    });
    expect(secondBody?.message_reference).toBeUndefined();
  });
});

describe("reactMessageDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reacts with unicode emoji", async () => {
    const { rest, putMock } = makeRest();
    await reactMessageDiscord("chan1", "msg1", "✅", { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "%E2%9C%85"),
    );
  });

  it("normalizes variation selectors in unicode emoji", async () => {
    const { rest, putMock } = makeRest();
    await reactMessageDiscord("chan1", "msg1", "⭐️", { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "%E2%AD%90"),
    );
  });

  it("reacts with custom emoji syntax", async () => {
    const { rest, putMock } = makeRest();
    await reactMessageDiscord("chan1", "msg1", "<:party_blob:123>", {
      rest,
      token: "t",
    });
    expect(putMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "msg1", "party_blob%3A123"),
    );
  });
});

describe("fetchReactionsDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns reactions with users", async () => {
    const { rest, getMock } = makeRest();
    getMock
      .mockResolvedValueOnce({
        reactions: [
          { count: 2, emoji: { name: "✅", id: null } },
          { count: 1, emoji: { name: "party_blob", id: "123" } },
        ],
      })
      .mockResolvedValueOnce([
        { id: "u1", username: "alpha", discriminator: "0001" },
      ])
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
    const { rest, getMock } = makeRest();
    const perms = new PermissionsBitField([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
    ]);
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
          { id: "guild1", permissions: perms.bitfield.toString() },
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
});

describe("readMessagesDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes query params as URLSearchParams", async () => {
    const { rest, getMock } = makeRest();
    getMock.mockResolvedValue([]);
    await readMessagesDiscord(
      "chan1",
      { limit: 5, before: "10" },
      { rest, token: "t" },
    );
    const call = getMock.mock.calls[0];
    const options = call?.[1] as { query?: URLSearchParams };
    expect(options.query?.toString()).toBe("limit=5&before=10");
  });
});

describe("edit/delete message helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("edits message content", async () => {
    const { rest, patchMock } = makeRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await editMessageDiscord(
      "chan1",
      "m1",
      { content: "hello" },
      { rest, token: "t" },
    );
    expect(patchMock).toHaveBeenCalledWith(
      Routes.channelMessage("chan1", "m1"),
      expect.objectContaining({ body: { content: "hello" } }),
    );
  });

  it("deletes message", async () => {
    const { rest, deleteMock } = makeRest();
    deleteMock.mockResolvedValue({});
    await deleteMessageDiscord("chan1", "m1", { rest, token: "t" });
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.channelMessage("chan1", "m1"),
    );
  });
});

describe("pin helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins and unpins messages", async () => {
    const { rest, putMock, deleteMock } = makeRest();
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
    const { rest, getMock } = makeRest();
    getMock.mockResolvedValue({ total_results: 0, messages: [] });
    await searchMessagesDiscord(
      { guildId: "g1", content: "hello", limit: 5 },
      { rest, token: "t" },
    );
    const call = getMock.mock.calls[0];
    const options = call?.[1] as { query?: URLSearchParams };
    expect(options.query?.toString()).toBe("content=hello&limit=5");
  });

  it("supports channel/author arrays and clamps limit", async () => {
    const { rest, getMock } = makeRest();
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
    const options = call?.[1] as { query?: URLSearchParams };
    expect(options.query?.toString()).toBe(
      "content=hello&channel_id=c1&channel_id=c2&author_id=u1&limit=25",
    );
  });
});

describe("threads and moderation helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a thread", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1" },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1", "m1"),
      expect.objectContaining({ body: { name: "thread" } }),
    );
  });

  it("lists active threads by guild", async () => {
    const { rest, getMock } = makeRest();
    getMock.mockResolvedValue({ threads: [] });
    await listThreadsDiscord({ guildId: "g1" }, { rest, token: "t" });
    expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
  });

  it("times out a member", async () => {
    const { rest, patchMock } = makeRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await timeoutMemberDiscord(
      { guildId: "g1", userId: "u1", durationMinutes: 10 },
      { rest, token: "t" },
    );
    expect(patchMock).toHaveBeenCalledWith(
      Routes.guildMember("g1", "u1"),
      expect.objectContaining({
        body: expect.objectContaining({
          communication_disabled_until: expect.any(String),
        }),
      }),
    );
  });

  it("adds and removes roles", async () => {
    const { rest, putMock, deleteMock } = makeRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    await addRoleDiscord(
      { guildId: "g1", userId: "u1", roleId: "r1" },
      { rest, token: "t" },
    );
    await removeRoleDiscord(
      { guildId: "g1", userId: "u1", roleId: "r1" },
      { rest, token: "t" },
    );
    expect(putMock).toHaveBeenCalledWith(
      Routes.guildMemberRole("g1", "u1", "r1"),
    );
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.guildMemberRole("g1", "u1", "r1"),
    );
  });

  it("bans a member", async () => {
    const { rest, putMock } = makeRest();
    putMock.mockResolvedValue({});
    await banMemberDiscord(
      { guildId: "g1", userId: "u1", deleteMessageDays: 2 },
      { rest, token: "t" },
    );
    expect(putMock).toHaveBeenCalledWith(
      Routes.guildBan("g1", "u1"),
      expect.objectContaining({ body: { delete_message_days: 2 } }),
    );
  });
});

describe("listGuildEmojisDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists emojis for a guild", async () => {
    const { rest, getMock } = makeRest();
    getMock.mockResolvedValue([{ id: "e1", name: "party" }]);
    await listGuildEmojisDiscord("g1", { rest, token: "t" });
    expect(getMock).toHaveBeenCalledWith(Routes.guildEmojis("g1"));
  });
});

describe("uploadEmojiDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads emoji assets", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "e1" });
    await uploadEmojiDiscord(
      {
        guildId: "g1",
        name: "party_blob",
        mediaUrl: "file:///tmp/party.png",
        roleIds: ["r1"],
      },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.guildEmojis("g1"),
      expect.objectContaining({
        body: {
          name: "party_blob",
          image: "data:image/png;base64,aW1n",
          roles: ["r1"],
        },
      }),
    );
  });
});

describe("uploadStickerDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads sticker assets", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "s1" });
    await uploadStickerDiscord(
      {
        guildId: "g1",
        name: "clawdbot_wave",
        description: "Clawdbot waving",
        tags: "👋",
        mediaUrl: "file:///tmp/wave.png",
      },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.guildStickers("g1"),
      expect.objectContaining({
        body: {
          name: "clawdbot_wave",
          description: "Clawdbot waving",
          tags: "👋",
        },
        files: [
          expect.objectContaining({
            name: "asset.png",
            contentType: "image/png",
          }),
        ],
      }),
    );
  });
});

describe("sendStickerDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends sticker payloads", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    const res = await sendStickerDiscord("channel:789", ["123"], {
      rest,
      token: "t",
      content: "hiya",
    });
    expect(res).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        body: {
          content: "hiya",
          sticker_ids: ["123"],
        },
      }),
    );
  });
});

describe("sendPollDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends polls with answers", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    const res = await sendPollDiscord(
      "channel:789",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      {
        rest,
        token: "t",
      },
    );
    expect(res).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        body: expect.objectContaining({
          poll: {
            question: { text: "Lunch?" },
            answers: [
              { poll_media: { text: "Pizza" } },
              { poll_media: { text: "Sushi" } },
            ],
            duration: 24,
            allow_multiselect: false,
            layout_type: 1,
          },
        }),
      }),
    );
  });
});
