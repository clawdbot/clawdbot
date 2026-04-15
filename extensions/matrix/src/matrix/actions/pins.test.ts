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
      expect.objectContaining({
        eventId: "$a",
        body: "hello",
      }),
    ]);
  });
});
