// Matrix tests cover reactions plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { listMatrixEmojis, listMatrixReactions, removeMatrixReactions } from "./reactions.js";

function createReactionsClient(params: {
  chunk: Array<{
    event_id?: string;
    sender?: string;
    key?: string;
  }>;
  userId?: string | null;
}) {
  const doRequest = vi.fn(
    async (
      _method: string,
      _path: string,
      _query: unknown,
    ): Promise<{ chunk: Array<Record<string, unknown>>; next_batch?: string }> => ({
      chunk: params.chunk.map((item) => ({
        event_id: item.event_id ?? "",
        sender: item.sender ?? "",
        content: item.key
          ? {
              "m.relates_to": {
                rel_type: "m.annotation",
                event_id: "$target",
                key: item.key,
              },
            }
          : {},
      })),
    }),
  );
  const getUserId = vi.fn(async () => params.userId ?? null);
  const redactEvent = vi.fn(async () => undefined);

  return {
    client: {
      doRequest,
      getUserId,
      redactEvent,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    doRequest,
    redactEvent,
  };
}

describe("matrix reaction actions", () => {
  it("lists sorted room and personal MSC2545 emoticons while rejecting malformed and sticker-only images", async () => {
    const doRequest = vi.fn(async () => [
      {
        type: "im.ponies.room_emotes",
        state_key: "",
        content: {
          images: {
            zebra: { url: "mxc://example.org/zebra" },
            sticker: { url: "mxc://example.org/sticker", usage: ["sticker"] },
            wrongUrl: { url: "https://example.org/wrong" },
            incompleteMxc: { url: "mxc://example.org" },
            wrongUsage: { url: "mxc://example.org/wrong-usage", usage: "emoticon" },
            malformed: null,
          },
        },
      },
      {
        type: "im.ponies.room_emotes",
        state_key: "extra-pack",
        content: {
          pack: { usage: ["sticker"] },
          images: {
            hidden: { url: "mxc://example.org/hidden" },
            alpha: { url: "mxc://example.org/alpha", usage: ["emoticon", "sticker"] },
          },
        },
      },
      { type: "im.ponies.room_emotes", state_key: "broken", content: { images: [] } },
      { type: "m.room.name", state_key: "", content: { images: { ignored: {} } } },
    ]);
    const getAccountData = vi.fn(async () => ({
      images: { middle: { url: "mxc://example.org/middle", usage: ["emoticon"] } },
    }));
    const client = { doRequest, getAccountData, stop: vi.fn() } as unknown as MatrixClient;

    await expect(listMatrixEmojis("!room:example.org", { client })).resolves.toStrictEqual([
      { name: "alpha", identifier: "alpha", url: "mxc://example.org/alpha" },
      { name: "middle", identifier: "middle", url: "mxc://example.org/middle" },
      { name: "zebra", identifier: "zebra", url: "mxc://example.org/zebra" },
    ]);
    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/rooms/!room%3Aexample.org/state",
    );
    expect(getAccountData).toHaveBeenCalledWith("im.ponies.user_emotes");
  });

  it("caps sorted custom-emote results at 100 and accepts a missing personal pack", async () => {
    const images = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => {
        const shortcode = `emoji_${String(index).padStart(3, "0")}`;
        return [shortcode, { url: `mxc://example.org/${shortcode}` }];
      }),
    );
    const client = {
      doRequest: vi.fn(async () => [
        { type: "im.ponies.room_emotes", state_key: "", content: { images } },
      ]),
      getAccountData: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MatrixClient;

    const emojis = await listMatrixEmojis("!room:example.org", { client, limit: 500 });

    expect(emojis).toHaveLength(100);
    expect(emojis[0]?.name).toBe("emoji_000");
    expect(emojis.at(-1)?.name).toBe("emoji_099");
    await expect(listMatrixEmojis("!room:example.org", { client, limit: 2 })).resolves.toHaveLength(
      2,
    );
  });

  it("fails visibly when the room-state response is malformed", async () => {
    const client = {
      doRequest: vi.fn(async () => ({ state: [] })),
      getAccountData: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MatrixClient;

    await expect(listMatrixEmojis("!room:example.org", { client })).rejects.toThrow(
      "Matrix room state response is invalid.",
    );
  });

  it("aggregates reactions by key and unique sender", async () => {
    const { client, doRequest } = createReactionsClient({
      chunk: [
        { event_id: "$1", sender: "@alice:example.org", key: "👍" },
        { event_id: "$2", sender: "@bob:example.org", key: "👍" },
        { event_id: "$3", sender: "@alice:example.org", key: "👎" },
        { event_id: "$4", sender: "@bot:example.org" },
      ],
      userId: "@bot:example.org",
    });

    const result = await listMatrixReactions("!room:example.org", "$msg", { client, limit: 2.9 });

    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v1/rooms/!room%3Aexample.org/relations/%24msg/m.annotation/m.reaction",
      { dir: "b", limit: 2 },
    );
    expect(result).toStrictEqual([
      {
        key: "👍",
        count: 2,
        users: ["@alice:example.org", "@bob:example.org"],
      },
      {
        key: "👎",
        count: 1,
        users: ["@alice:example.org"],
      },
    ]);
  });

  it("removes only current-user reactions matching emoji filter", async () => {
    const { client, redactEvent } = createReactionsClient({
      chunk: [
        { event_id: "$1", sender: "@me:example.org", key: "👍" },
        { event_id: "$2", sender: "@me:example.org", key: "👎" },
        { event_id: "$3", sender: "@other:example.org", key: "👍" },
      ],
      userId: "@me:example.org",
    });

    const result = await removeMatrixReactions("!room:example.org", "$msg", {
      client,
      emoji: "👍",
    });

    expect(result).toEqual({ removed: 1 });
    expect(redactEvent).toHaveBeenCalledTimes(1);
    expect(redactEvent).toHaveBeenCalledWith("!room:example.org", "$1");
  });

  it("removes current-user reactions found after the first relations page", async () => {
    const { client, doRequest, redactEvent } = createReactionsClient({
      chunk: [],
      userId: "@me:example.org",
    });
    doRequest
      .mockResolvedValueOnce({
        chunk: [
          {
            event_id: "$other",
            sender: "@other:example.org",
            content: {
              "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
            },
          },
        ],
        next_batch: "older-reactions",
      })
      .mockResolvedValueOnce({
        chunk: [
          {
            event_id: "$mine",
            sender: "@me:example.org",
            content: {
              "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
            },
          },
        ],
      });

    await expect(
      removeMatrixReactions("!room:example.org", "$msg", { client, emoji: "👍" }),
    ).resolves.toEqual({ removed: 1 });
    expect(doRequest).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/_matrix/client/v1/rooms/!room%3Aexample.org/relations/%24msg/m.annotation/m.reaction",
      { dir: "b", limit: 200, from: "older-reactions" },
    );
    expect(redactEvent).toHaveBeenCalledWith("!room:example.org", "$mine");
  });

  it("continues listing across empty relation pages", async () => {
    const { client, doRequest } = createReactionsClient({
      chunk: [],
      userId: "@me:example.org",
    });
    doRequest
      .mockResolvedValueOnce({ chunk: [], next_batch: "older-reactions" })
      .mockResolvedValueOnce({
        chunk: [
          {
            event_id: "$mine",
            sender: "@me:example.org",
            content: {
              "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
            },
          },
        ],
      });

    await expect(listMatrixReactions("!room:example.org", "$msg", { client })).resolves.toEqual([
      { key: "👍", count: 1, users: ["@me:example.org"] },
    ]);
    expect(doRequest).toHaveBeenCalledTimes(2);
  });

  it("fails visibly when the relations server repeats a pagination cursor", async () => {
    const { client, doRequest, redactEvent } = createReactionsClient({
      chunk: [],
      userId: "@me:example.org",
    });
    doRequest.mockResolvedValue({ chunk: [], next_batch: "same-cursor" });

    await expect(removeMatrixReactions("!room:example.org", "$msg", { client })).rejects.toThrow(
      "repeated cursor",
    );
    expect(doRequest).toHaveBeenCalledTimes(2);
    expect(redactEvent).not.toHaveBeenCalled();
  });

  it("returns removed=0 when current user id is unavailable", async () => {
    const { client, redactEvent } = createReactionsClient({
      chunk: [{ event_id: "$1", sender: "@me:example.org", key: "👍" }],
      userId: null,
    });

    const result = await removeMatrixReactions("!room:example.org", "$msg", { client });

    expect(result).toEqual({ removed: 0 });
    expect(redactEvent).not.toHaveBeenCalled();
  });

  it("returns an empty list when the relations response is malformed", async () => {
    const doRequest = vi.fn(async () => ({ chunk: null }));
    const client = {
      doRequest,
      getUserId: vi.fn(async () => "@me:example.org"),
      redactEvent: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MatrixClient;

    const result = await listMatrixReactions("!room:example.org", "$msg", { client });

    expect(result).toStrictEqual([]);
  });

  it("rejects blank message ids before querying Matrix relations", async () => {
    const { client, doRequest } = createReactionsClient({
      chunk: [],
      userId: "@me:example.org",
    });

    await expect(listMatrixReactions("!room:example.org", "   ", { client })).rejects.toThrow(
      "messageId",
    );
    expect(doRequest).not.toHaveBeenCalled();
  });
});
