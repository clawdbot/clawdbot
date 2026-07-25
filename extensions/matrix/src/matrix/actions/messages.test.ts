// Matrix tests cover messages plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import * as sendModule from "../send.js";
import { editMatrixMessage, readMatrixMessages } from "./messages.js";

const MATRIX_ACTION_TEST_CFG = {
  channels: {
    matrix: {},
  },
};

function installMatrixActionTestRuntime(): void {
  setMatrixRuntime({
    config: {
      current: () => ({}),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "code",
        resolveTextChunkLimit: () => 4_000,
        convertMarkdownTables: (text: string) => text,
      },
    },
  } as unknown as import("../../runtime-api.js").PluginRuntime);
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

function createPollStartEvent(params?: {
  answers?: Array<Record<string, unknown>>;
  includeDisclosedKind?: boolean;
  maxSelections?: number;
}): Record<string, unknown> {
  return {
    event_id: "$poll",
    sender: "@alice:example.org",
    type: "m.poll.start",
    origin_server_ts: 1,
    content: {
      "m.poll.start": {
        question: { "m.text": "Favorite fruit?" },
        ...(params?.includeDisclosedKind ? { kind: "m.poll.disclosed" } : {}),
        ...(params?.maxSelections !== undefined ? { max_selections: params.maxSelections } : {}),
        answers: params?.answers ?? [{ id: "a1", "m.text": "Apple" }],
      },
    },
  };
}

function createMessagesClient(params: {
  chunk: Array<Record<string, unknown>>;
  hydratedChunk?: Array<Record<string, unknown>>;
  pollRoot?: Record<string, unknown>;
  pollRelations?: Array<Record<string, unknown>>;
  threadRelations?: Array<Record<string, unknown>>;
}) {
  const doRequest = vi.fn(async () => ({
    chunk: params.chunk,
    start: "start-token",
    end: "end-token",
  }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, _events: Array<Record<string, unknown>>) =>
      (params.hydratedChunk ?? _events) as unknown,
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) => {
    if (params.pollRoot?.event_id === eventId) {
      return params.pollRoot;
    }
    return null;
  });
  const getRelations = vi.fn(async (_roomId: string, _eventId: string, relType: string) => ({
    events:
      relType === "m.thread"
        ? (params.threadRelations ?? params.pollRelations ?? [])
        : (params.pollRelations ?? []),
    nextBatch: null,
    prevBatch: null,
  }));

  return {
    client: {
      doRequest,
      hydrateEvents,
      getEvent,
      getRelations,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    doRequest,
    hydrateEvents,
    getEvent,
    getRelations,
  };
}

function createEditClient(originalContent: Record<string, unknown>) {
  const sendMessage = vi.fn().mockResolvedValue("evt-edit");
  const client = {
    getEvent: vi.fn().mockResolvedValue({ content: originalContent }),
    getJoinedRoomMembers: vi.fn().mockResolvedValue([]),
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    sendMessage,
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;

  return { client, sendMessage };
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>) {
  if (!value || typeof value !== "object") {
    throw new Error("Expected record");
  }
  const actual = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(actual[key]).toEqual(expectedValue);
  }
  return actual;
}

function mockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex} to exist`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex} to exist`);
  }
  return call[argIndex];
}

describe("matrix message actions", () => {
  it("forwards timeoutMs to the shared Matrix edit helper", async () => {
    const editSpy = vi.spyOn(sendModule, "editMessageMatrix").mockResolvedValue("evt-edit");

    try {
      const cfg = {} as never;
      const result = await editMatrixMessage("!room:example.org", "$original", "hello", {
        cfg,
        timeoutMs: 12_345,
      });

      expect(result).toEqual({ eventId: "evt-edit" });
      expect(editSpy).toHaveBeenCalledWith("!room:example.org", "$original", "hello", {
        cfg,
        accountId: undefined,
        client: undefined,
        timeoutMs: 12_345,
      });
    } finally {
      editSpy.mockRestore();
    }
  });

  it("routes edits through the shared Matrix edit helper so mentions are preserved", async () => {
    installMatrixActionTestRuntime();
    const { client, sendMessage } = createEditClient({
      body: "hello @alice:example.org",
      "m.mentions": { user_ids: ["@alice:example.org"] },
    });

    const result = await editMatrixMessage(
      "!room:example.org",
      "$original",
      "hello @alice:example.org and @bob:example.org",
      { cfg: MATRIX_ACTION_TEST_CFG, client },
    );

    expect(result).toEqual({ eventId: "evt-edit" });
    expect(mockCallArg(sendMessage, 0, 0)).toBe("!room:example.org");
    const content = expectRecordFields(mockCallArg(sendMessage, 0, 1), {
      "m.mentions": { user_ids: ["@bob:example.org"] },
    });
    expectRecordFields(content["m.new_content"], {
      "m.mentions": { user_ids: ["@alice:example.org", "@bob:example.org"] },
    });
  });

  it("does not re-notify legacy mentions when action edits target pre-m.mentions messages", async () => {
    installMatrixActionTestRuntime();
    const { client, sendMessage } = createEditClient({
      body: "hello @alice:example.org",
    });

    const result = await editMatrixMessage(
      "!room:example.org",
      "$original",
      "hello again @alice:example.org",
      { cfg: MATRIX_ACTION_TEST_CFG, client },
    );

    expect(result).toEqual({ eventId: "evt-edit" });
    expect(mockCallArg(sendMessage, 0, 0)).toBe("!room:example.org");
    const content = expectRecordFields(mockCallArg(sendMessage, 0, 1), {
      "m.mentions": {},
    });
    expectRecordFields(content["m.new_content"], {
      body: "hello again @alice:example.org",
      "m.mentions": { user_ids: ["@alice:example.org"] },
    });
  });

  it("includes poll snapshots when reading message history", async () => {
    const { client, doRequest, getEvent, getRelations } = createMessagesClient({
      chunk: [
        createPollResponseEvent(),
        {
          event_id: "$msg",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 10,
          content: {
            msgtype: "m.text",
            body: "hello",
          },
        },
      ],
      pollRoot: createPollStartEvent({
        includeDisclosedKind: true,
        maxSelections: 1,
        answers: [
          { id: "a1", "m.text": "Apple" },
          { id: "a2", "m.text": "Strawberry" },
        ],
      }),
      pollRelations: [createPollResponseEvent()],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client, limit: 2.9 });

    expect(mockCallArg(doRequest, 0, 0)).toBe("GET");
    expect(String(mockCallArg(doRequest, 0, 1))).toContain("/rooms/!room%3Aexample.org/messages");
    expectRecordFields(mockCallArg(doRequest, 0, 2), { limit: 2 });
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$poll",
      "m.reference",
      undefined,
      {
        from: undefined,
      },
    );
    expect(result.messages).toHaveLength(2);
    expectRecordFields(result.messages[0], {
      eventId: "$poll",
      msgtype: "m.text",
    });
    expect(result.messages[0]?.body).toContain("1. Apple (1 vote)");
    expectRecordFields(result.messages[1], {
      eventId: "$msg",
      body: "hello",
    });
  });

  it("dedupes multiple poll events for the same poll within one read page", async () => {
    const { client, getEvent } = createMessagesClient({
      chunk: [createPollResponseEvent(), createPollStartEvent()],
      pollRoot: createPollStartEvent(),
      pollRelations: [],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages).toHaveLength(1);
    expectRecordFields(result.messages[0], { eventId: "$poll" });
    expect(result.messages[0]?.body).toContain("[Poll]");
    expect(getEvent).toHaveBeenCalledTimes(2);
  });

  it("uses hydrated history events so encrypted poll entries can be read", async () => {
    const { client, hydrateEvents } = createMessagesClient({
      chunk: [
        {
          event_id: "$enc",
          sender: "@bob:example.org",
          type: "m.room.encrypted",
          origin_server_ts: 20,
          content: {},
        },
      ],
      hydratedChunk: [createPollResponseEvent()],
      pollRoot: createPollStartEvent(),
      pollRelations: [],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(mockCallArg(hydrateEvents, 0, 0)).toBe("!room:example.org");
    expect(
      (mockCallArg(hydrateEvents, 0, 1) as Array<Record<string, unknown>>).some(
        (event) => event.event_id === "$enc",
      ),
    ).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.eventId).toBe("$poll");
  });

  it("filters Matrix thread events out of main-room reads", async () => {
    const { client } = createMessagesClient({
      chunk: [
        {
          event_id: "$thread-reply",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 20,
          content: {
            msgtype: "m.text",
            body: "thread reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
          },
        },
        {
          event_id: "$main",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 10,
          content: {
            msgtype: "m.text",
            body: "main room",
          },
        },
      ],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages.map((message) => message.eventId)).toEqual(["$main"]);
  });

  it("filters threaded poll roots out of main-room reads", async () => {
    const threadedPollRoot = createPollStartEvent();
    const threadedPollContent = threadedPollRoot.content as Record<string, unknown>;
    threadedPollRoot.content = {
      ...threadedPollContent,
      "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
    };
    const { client, getEvent } = createMessagesClient({
      chunk: [createPollResponseEvent()],
      pollRoot: threadedPollRoot,
      pollRelations: [createPollResponseEvent()],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(result.messages).toEqual([]);
  });

  it("uses the thread relations endpoint and includes the thread root once", async () => {
    const { client, doRequest, getEvent, getRelations } = createMessagesClient({
      chunk: [],
      pollRelations: [
        {
          event_id: "$thread-reply",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 20,
          content: {
            msgtype: "m.text",
            body: "thread reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
          },
        },
      ],
      pollRoot: {
        event_id: "$thread-root",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: 10,
        content: {
          msgtype: "m.text",
          body: "thread root",
        },
      },
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 5,
    });

    expect(doRequest).not.toHaveBeenCalled();
    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$thread-root",
      "m.thread",
      undefined,
      { dir: "b", from: undefined, limit: 4 },
    );
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$thread-root");
    expect(result.messages.map((message) => message.eventId)).toEqual([
      "$thread-root",
      "$thread-reply",
    ]);
  });

  it("includes poll snapshots from threaded reads", async () => {
    const { client, getEvent, getRelations } = createMessagesClient({
      chunk: [],
      pollRoot: createPollStartEvent({
        includeDisclosedKind: true,
        maxSelections: 1,
        answers: [
          { id: "a1", "m.text": "Apple" },
          { id: "a2", "m.text": "Strawberry" },
        ],
      }),
      pollRelations: [createPollResponseEvent()],
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 5,
    });

    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$thread-root",
      "m.thread",
      undefined,
      { dir: "b", from: undefined, limit: 5 },
    );
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(result.messages[0]?.body).toContain("1. Apple (1 vote)");
  });

  it("includes poll roots when reading the thread they start", async () => {
    const { client, getEvent, getRelations } = createMessagesClient({
      chunk: [],
      pollRoot: createPollStartEvent({
        includeDisclosedKind: true,
        maxSelections: 1,
        answers: [
          { id: "a1", "m.text": "Apple" },
          { id: "a2", "m.text": "Strawberry" },
        ],
      }),
      pollRelations: [createPollResponseEvent()],
      threadRelations: [
        {
          event_id: "$thread-reply",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 20,
          content: {
            msgtype: "m.text",
            body: "thread reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$poll" },
          },
        },
      ],
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$poll",
      limit: 5,
    });

    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$poll",
      "m.reference",
      undefined,
      {
        from: undefined,
      },
    );
    expect(getRelations).toHaveBeenCalledWith("!room:example.org", "$poll", "m.thread", undefined, {
      dir: "b",
      from: undefined,
      limit: 4,
    });
    expect(result.messages.map((message) => message.eventId)).toEqual(["$poll", "$thread-reply"]);
    expect(result.messages[0]?.body).toContain("1. Apple (1 vote)");
  });

  it("does not summarize non-start poll events as thread roots", async () => {
    const { client, getRelations } = createMessagesClient({
      chunk: [],
      pollRoot: createPollResponseEvent(),
      threadRelations: [
        {
          event_id: "$thread-reply",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 20,
          content: {
            msgtype: "m.text",
            body: "thread reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$vote" },
          },
        },
      ],
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$vote",
      limit: 5,
    });

    expect(getRelations).toHaveBeenCalledWith("!room:example.org", "$vote", "m.thread", undefined, {
      dir: "b",
      from: undefined,
      limit: 5,
    });
    expect(result.messages.map((message) => message.eventId)).toEqual(["$thread-reply"]);
  });

  it("counts the thread root toward the requested first-page limit", async () => {
    const { client, doRequest, getEvent, getRelations } = createMessagesClient({
      chunk: [],
      pollRelations: [
        {
          event_id: "$thread-reply",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 20,
          content: {
            msgtype: "m.text",
            body: "thread reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
          },
        },
      ],
      pollRoot: {
        event_id: "$thread-root",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: 10,
        content: {
          msgtype: "m.text",
          body: "thread root",
        },
      },
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 1,
    });

    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$thread-root",
      "m.thread",
      undefined,
      { dir: "b", from: undefined, limit: 1 },
    );
    expect(doRequest).not.toHaveBeenCalled();
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$thread-root");
    expect(result.messages.map((message) => message.eventId)).toEqual(["$thread-root"]);
    expect(result.nextBatch).toEqual(
      expect.stringContaining("openclaw.matrix.thread-relations-start:"),
    );

    const next = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 1,
      before: result.nextBatch ?? undefined,
    });

    expect(getRelations).toHaveBeenLastCalledWith(
      "!room:example.org",
      "$thread-root",
      "m.thread",
      undefined,
      { dir: "b", from: undefined, limit: 1 },
    );
    expect(next.messages.map((message) => message.eventId)).toEqual(["$thread-reply"]);
  });

  it("does not reserve first-page thread capacity for a redacted root", async () => {
    const { client, doRequest, getEvent, getRelations } = createMessagesClient({
      chunk: [],
      pollRelations: [
        {
          event_id: "$thread-reply",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 20,
          content: {
            msgtype: "m.text",
            body: "thread reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
          },
        },
      ],
      pollRoot: {
        event_id: "$thread-root",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: 10,
        unsigned: { redacted_because: {} },
        content: {},
      },
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 1,
    });

    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$thread-root",
      "m.thread",
      undefined,
      { dir: "b", from: undefined, limit: 1 },
    );
    expect(doRequest).not.toHaveBeenCalled();
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$thread-root");
    expect(result.messages.map((message) => message.eventId)).toEqual(["$thread-reply"]);
    expect(result.nextBatch).toBeNull();
  });
});
