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
      loadConfig: () => ({}),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "code",
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
}) {
  const doRequest = vi.fn(async () => ({
    chunk: params.chunk,
    start: "start-token",
    end: "end-token",
  }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, _events: Array<Record<string, unknown>>) =>
      (params.hydratedChunk ?? params.chunk) as unknown,
  );
  const getEvent = vi.fn(async () => params.pollRoot ?? null);
  const getRelations = vi.fn(async () => ({
    events: params.pollRelations ?? [],
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
    expect(sendMessage).toHaveBeenCalledWith(
      "!room:example.org",
      expect.objectContaining({
        "m.mentions": { user_ids: ["@bob:example.org"] },
        "m.new_content": expect.objectContaining({
          "m.mentions": { user_ids: ["@alice:example.org", "@bob:example.org"] },
        }),
      }),
    );
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
    expect(sendMessage).toHaveBeenCalledWith(
      "!room:example.org",
      expect.objectContaining({
        "m.mentions": {},
        "m.new_content": expect.objectContaining({
          body: "hello again @alice:example.org",
          "m.mentions": { user_ids: ["@alice:example.org"] },
        }),
      }),
    );
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

    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/rooms/!room%3Aexample.org/messages"),
      expect.objectContaining({ limit: 2 }),
    );
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
    expect(result.messages).toEqual([
      expect.objectContaining({
        eventId: "$poll",
        body: expect.stringContaining("1. Apple (1 vote)"),
        msgtype: "m.text",
      }),
      expect.objectContaining({
        eventId: "$msg",
        body: "hello",
      }),
    ]);
  });

  it("dedupes multiple poll events for the same poll within one read page", async () => {
    const { client, getEvent } = createMessagesClient({
      chunk: [createPollResponseEvent(), createPollStartEvent()],
      pollRoot: createPollStartEvent(),
      pollRelations: [],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        eventId: "$poll",
        body: expect.stringContaining("[Poll]"),
      }),
    );
    expect(getEvent).toHaveBeenCalledTimes(1);
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

    expect(hydrateEvents).toHaveBeenCalledWith(
      "!room:example.org",
      expect.arrayContaining([expect.objectContaining({ event_id: "$enc" })]),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.eventId).toBe("$poll");
  });
});
