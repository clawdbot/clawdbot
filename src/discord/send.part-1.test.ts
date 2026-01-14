import { PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
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
    } as unknown as import("@buape/carbon").RequestClient,
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

  it("rejects bare numeric IDs as ambiguous", async () => {
    const { rest } = makeRest();
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
    const { rest, postMock, getMock } = makeRest();
    const perms = PermissionFlagsBits.ViewChannel;
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
        body: expect.objectContaining({
          files: [expect.objectContaining({ name: "photo.jpg" })],
        }),
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

describe("removeReactionDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes a unicode emoji reaction", async () => {
    const { rest, deleteMock } = makeRest();
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
    const { rest, getMock, deleteMock } = makeRest();
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
    const perms =
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
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
});

describe("readMessagesDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes query params as an object", async () => {
    const { rest, getMock } = makeRest();
    getMock.mockResolvedValue([]);
    await readMessagesDiscord(
      "chan1",
      { limit: 5, before: "10" },
      { rest, token: "t" },
    );
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
    expect(call?.[0]).toBe("/guilds/g1/messages/search?content=hello&limit=5");
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
    expect(call?.[0]).toBe(
      "/guilds/g1/messages/search?content=hello&channel_id=c1&channel_id=c2&author_id=u1&limit=25",
    );
  });
});
