import { describe, expect, it, vi } from "vitest";
import { fetchMatrixPollSnapshot } from "./poll-summary.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";

function createPollStartEvent(): MatrixRawEvent {
  return {
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
  } as MatrixRawEvent;
}

describe("Matrix poll snapshot pagination", () => {
  it.each([
    { name: "a repeated cursor", cursors: ["stuck", "stuck"] },
    { name: "a cursor cycle", cursors: ["first", "second", "first"] },
  ])("fails visibly on $name", async ({ cursors }) => {
    let calls = 0;
    const getRelations = vi.fn(async () => {
      const nextBatch = cursors[calls++];
      if (nextBatch === undefined) {
        throw new Error("test stopped unbounded Matrix poll pagination");
      }
      return { events: [], nextBatch, prevBatch: null };
    });

    await expect(
      fetchMatrixPollSnapshot(
        { getRelations } as unknown as MatrixClient,
        "!room:example.org",
        createPollStartEvent(),
      ),
    ).rejects.toThrow("Matrix poll pagination returned a repeated cursor");
    expect(getRelations).toHaveBeenCalledTimes(cursors.length);
  });

  it("follows valid empty pages before collecting later poll votes", async () => {
    const getRelations = vi
      .fn()
      .mockResolvedValueOnce({ events: [], nextBatch: "next-page", prevBatch: null })
      .mockResolvedValueOnce({
        events: [
          {
            event_id: "$vote",
            sender: "@bob:example.org",
            type: "m.poll.response",
            origin_server_ts: 2,
            content: {
              "m.poll.response": { answers: ["pizza"] },
              "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
            },
          },
        ],
        nextBatch: null,
        prevBatch: null,
      });

    const snapshot = await fetchMatrixPollSnapshot(
      { getRelations } as unknown as MatrixClient,
      "!room:example.org",
      createPollStartEvent(),
    );

    expect(getRelations).toHaveBeenNthCalledWith(
      2,
      "!room:example.org",
      "$poll",
      "m.reference",
      undefined,
      { from: "next-page" },
    );
    expect(snapshot?.text).toContain("1. Pizza (1 vote)");
  });
});
