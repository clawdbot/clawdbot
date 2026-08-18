import { describe, expect, it } from "vitest";
import { fetchMatrixPollSnapshot } from "./poll-summary.js";
import type { MatrixRawEvent } from "./sdk.js";

const POLL_START_EVENT: MatrixRawEvent = {
  event_id: "$poll1",
  type: "m.poll.start",
  sender: "@alice:example.org",
  content: {
    "m.poll.start": {
      question: { "m.text": "Lunch?" },
      answers: [
        { id: "yes", "m.text": "Yes" },
        { id: "no", "m.text": "No" },
      ],
    },
  },
} as unknown as MatrixRawEvent;

function createFakeClient(pages: Array<{ events: unknown[]; nextBatch?: string }>) {
  const calls: Array<{ from?: string; limit?: number }> = [];
  return {
    calls,
    client: {
      getEvent: async () => POLL_START_EVENT,
      getRelations: async (
        _roomId: string,
        _eventId: string,
        _rel: string,
        _type: undefined,
        opts: { from?: string; limit?: number },
      ) => {
        calls.push(opts);
        const page = pages[Math.min(calls.length - 1, pages.length - 1)];
        return { events: page.events, nextBatch: page.nextBatch ?? null };
      },
    } as never,
  };
}

describe("fetchMatrixPollSnapshot relation pagination", () => {
  it("stops when the server keeps returning the same nextBatch (no infinite loop)", async () => {
    const { calls, client } = createFakeClient([
      { events: [{ type: "m.poll.response" }], nextBatch: "tok-loop" },
    ]);

    const snapshot = await fetchMatrixPollSnapshot(client, "room-1", POLL_START_EVENT);

    expect(snapshot).not.toBeNull();
    // 1 initial page + at most one repeated batch before the cursor check stops it.
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("caps pagination when the server always advances the batch", async () => {
    const { calls, client } = createFakeClient(
      Array.from({ length: 50 }, (_, index) => ({
        events: [{ type: "m.poll.response" }],
        nextBatch: `tok-${index}`,
      })),
    );

    const snapshot = await fetchMatrixPollSnapshot(client, "room-1", POLL_START_EVENT);

    expect(snapshot).not.toBeNull();
    expect(calls).toHaveLength(10);
    expect(calls.every((call) => call.limit === 100)).toBe(true);
  });
});
