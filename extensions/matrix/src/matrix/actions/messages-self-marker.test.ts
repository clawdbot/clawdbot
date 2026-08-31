// Matrix tests cover isSelf marking on the message read path.
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { readMatrixMessages } from "./messages.js";

function createHistoryMessage(params: {
  eventId: string;
  body: string;
  timestamp: number;
  sender: string;
}): Record<string, unknown> {
  return {
    event_id: params.eventId,
    sender: params.sender,
    type: "m.room.message",
    origin_server_ts: params.timestamp,
    content: { msgtype: "m.text", body: params.body },
  };
}

function createPollResponseEvent(): Record<string, unknown> {
  return {
    event_id: "$vote",
    sender: "@bob:example.org",
    type: "m.poll.response",
    origin_server_ts: 20,
    content: {
      "m.poll.response": { answers: ["a1"] },
      "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
    },
  };
}

function createPollStartEvent(sender: string): Record<string, unknown> {
  return {
    event_id: "$poll",
    sender,
    type: "m.poll.start",
    origin_server_ts: 1,
    content: {
      "m.poll.start": {
        question: { "m.text": "Favorite fruit?" },
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "a1", "m.text": "Apple" },
          { id: "a2", "m.text": "Strawberry" },
        ],
      },
    },
  };
}

function createMessagesClient(params: {
  chunk: Array<Record<string, unknown>>;
  pollRoot?: Record<string, unknown>;
  pollRelations?: Array<Record<string, unknown>>;
  threadRelations?: Array<Record<string, unknown>>;
  selfUserId?: string;
  omitGetUserId?: boolean;
}) {
  const doRequest = vi.fn(async () => ({ chunk: params.chunk, start: "s", end: "e" }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, events: Array<Record<string, unknown>>) => events,
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
    params.pollRoot?.event_id === eventId ? params.pollRoot : null,
  );
  const getRelations = vi.fn(async (_roomId: string, _eventId: string, relType: string) => ({
    events:
      relType === "m.thread"
        ? (params.threadRelations ?? params.pollRelations ?? [])
        : (params.pollRelations ?? []),
    nextBatch: null,
    prevBatch: null,
  }));
  const client: Record<string, unknown> = {
    doRequest,
    hydrateEvents,
    getEvent,
    getRelations,
    stop: vi.fn(),
  };
  if (!params.omitGetUserId) {
    client.getUserId = vi.fn(async () => params.selfUserId);
  }
  return client as unknown as MatrixClient;
}

describe("readMatrixMessages isSelf marking", () => {
  it.each([
    { sender: "@bot:example.org", expectedIsSelf: true, label: "the reading agent's own session" },
    { sender: "@glenn:example.org", expectedIsSelf: false, label: "a different sender" },
  ])("marks isSelf $expectedIsSelf for a message from $label, sender unchanged", async (tc) => {
    const client = createMessagesClient({
      chunk: [
        createHistoryMessage({ eventId: "$msg", body: "hi", timestamp: 10, sender: tc.sender }),
      ],
      selfUserId: "@bot:example.org",
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]).toMatchObject({
      eventId: "$msg",
      sender: tc.sender,
      isSelf: tc.expectedIsSelf,
    });
  });

  it("omits isSelf (not false) when the client has no getUserId", async () => {
    const client = createMessagesClient({
      chunk: [
        createHistoryMessage({ eventId: "$msg", body: "hi", timestamp: 10, sender: "@a:x.org" }),
      ],
      omitGetUserId: true,
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]?.isSelf).toBeUndefined();
    expect(result.messages[0]?.sender).toBe("@a:x.org");
  });

  it("omits isSelf without failing the read when getUserId() rejects", async () => {
    const client = createMessagesClient({
      chunk: [
        createHistoryMessage({ eventId: "$msg", body: "hi", timestamp: 10, sender: "@a:x.org" }),
      ],
    });
    (client as unknown as { getUserId: () => Promise<string> }).getUserId = vi
      .fn()
      .mockRejectedValue(new Error("no session"));

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]?.isSelf).toBeUndefined();
    expect(result.messages[0]?.sender).toBe("@a:x.org");
  });

  it("marks a thread root summary's isSelf from the resolved self user id", async () => {
    const client = createMessagesClient({
      chunk: [],
      pollRoot: {
        event_id: "$thread-root",
        sender: "@bot:example.org",
        type: "m.room.message",
        origin_server_ts: 10,
        content: { msgtype: "m.text", body: "thread root" },
      },
      threadRelations: [],
      selfUserId: "@bot:example.org",
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 5,
    });

    expect(result.messages[0]).toMatchObject({ eventId: "$thread-root", isSelf: true });
  });

  it.each([
    { sender: "@bot:example.org", expectedIsSelf: true, label: "the reading account" },
    { sender: "@alice:example.org", expectedIsSelf: false, label: "another sender" },
  ])("marks isSelf $expectedIsSelf on a poll summary created by $label", async (tc) => {
    const client = createMessagesClient({
      chunk: [createPollResponseEvent()],
      pollRoot: createPollStartEvent(tc.sender),
      pollRelations: [createPollResponseEvent()],
      selfUserId: "@bot:example.org",
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]).toMatchObject({
      eventId: "$poll",
      sender: tc.sender,
      isSelf: tc.expectedIsSelf,
    });
  });

  it("marks isSelf on a poll thread root summary", async () => {
    const client = createMessagesClient({
      chunk: [],
      pollRoot: createPollStartEvent("@bot:example.org"),
      pollRelations: [createPollResponseEvent()],
      threadRelations: [],
      selfUserId: "@bot:example.org",
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$poll",
      limit: 5,
    });

    expect(result.messages[0]).toMatchObject({ eventId: "$poll", isSelf: true });
  });

  it("omits isSelf on a poll summary when self identity cannot be resolved", async () => {
    const client = createMessagesClient({
      chunk: [createPollResponseEvent()],
      pollRoot: createPollStartEvent("@alice:example.org"),
      pollRelations: [createPollResponseEvent()],
      omitGetUserId: true,
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]?.isSelf).toBeUndefined();
    expect(result.messages[0]?.sender).toBe("@alice:example.org");
  });
});
