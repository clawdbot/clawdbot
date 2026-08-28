// Matrix tests cover pins plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { listMatrixPins, pinMatrixMessage, unpinMatrixMessage } from "./pins.js";

function createPinsClient(seedPinned: string[], knownBodies: Record<string, string> = {}) {
  let pinned = [...seedPinned];
  const getRoomStateEvent = vi.fn(async () => ({ pinned: [...pinned] }));
  const sendStateEvent = vi.fn(
    async (_roomId: string, _type: string, _key: string, payload: unknown) => {
      pinned = [...((payload as { pinned: string[] }).pinned ?? [])];
    },
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) => {
    const body = knownBodies[eventId];
    if (!body) {
      throw new Error("missing");
    }
    return {
      event_id: eventId,
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: { msgtype: "m.text", body },
    };
  });

  return {
    client: {
      getRoomStateEvent,
      sendStateEvent,
      getEvent,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    getPinned: () => pinned,
    sendStateEvent,
  };
}

describe("matrix pins actions", () => {
  it("pins a message once even when asked twice", async () => {
    const { client, getPinned, sendStateEvent } = createPinsClient(["$a"]);

    const first = await pinMatrixMessage("!room:example.org", "$b", { client });
    const second = await pinMatrixMessage("!room:example.org", "$b", { client });

    expect(first.pinned).toEqual(["$a", "$b"]);
    expect(second.pinned).toEqual(["$a", "$b"]);
    expect(getPinned()).toEqual(["$a", "$b"]);
    expect(sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it("unpinds only the selected message id", async () => {
    const { client, getPinned } = createPinsClient(["$a", "$b", "$c"]);

    const result = await unpinMatrixMessage("!room:example.org", "$b", { client });

    expect(result.pinned).toEqual(["$a", "$c"]);
    expect(getPinned()).toEqual(["$a", "$c"]);
  });

  it("lists pinned ids and summarizes only resolvable events", async () => {
    const { client } = createPinsClient(["$a", "$missing"], { $a: "hello" });

    const result = await listMatrixPins("!room:example.org", { client });

    expect(result.pinned).toEqual(["$a", "$missing"]);
    expect(result.events).toEqual([
      {
        attachment: undefined,
        body: "hello",
        eventId: "$a",
        msgtype: "m.text",
        relatesTo: undefined,
        sender: "@alice:example.org",
        timestamp: 123,
      },
    ]);
  });

  it("keeps other pinned messages visible when a poll repeats its pagination cursor", async () => {
    let pollPageCalls = 0;
    const getRelations = vi.fn(async () => {
      pollPageCalls += 1;
      if (pollPageCalls > 2) {
        throw new Error("test stopped unbounded Matrix poll pagination");
      }
      return { events: [], nextBatch: "stuck", prevBatch: null };
    });
    const client = {
      getRoomStateEvent: async () => ({ pinned: ["$poll", "$message"] }),
      getEvent: async (_roomId: string, eventId: string) =>
        eventId === "$poll"
          ? {
              event_id: "$poll",
              sender: "@alice:example.org",
              type: "m.poll.start",
              origin_server_ts: 1,
              content: {
                "m.poll.start": {
                  question: { "m.text": "Lunch?" },
                  answers: [{ id: "pizza", "m.text": "Pizza" }],
                },
              },
            }
          : {
              event_id: "$message",
              sender: "@alice:example.org",
              type: "m.room.message",
              origin_server_ts: 2,
              content: { msgtype: "m.text", body: "Still visible" },
            },
      getRelations,
      stop: vi.fn(),
    } as unknown as MatrixClient;

    const result = await listMatrixPins("!room:example.org", { client });

    expect(result.pinned).toEqual(["$poll", "$message"]);
    expect(result.events.map((event) => event.eventId)).toEqual(["$message"]);
    expect(getRelations).toHaveBeenCalledTimes(2);
  });
});
