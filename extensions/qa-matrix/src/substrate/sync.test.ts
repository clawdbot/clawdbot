import { describe, expect, it, vi } from "vitest";
import type { MatrixQaObservedEvent } from "./events.js";
import {
  createMatrixQaRoomObserver,
  primeMatrixQaRoom,
  waitForOptionalMatrixQaRoomEvent,
} from "./sync.js";

describe("matrix sync helpers", () => {
  it("primes the Matrix sync cursor without recording observed events", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ next_batch: "primed-sync-cursor" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      primeMatrixQaRoom({
        accessToken: "token",
        baseUrl: "http://127.0.0.1:28008/",
        fetchImpl,
      }),
    ).resolves.toBe("primed-sync-cursor");
  });

  it("returns a typed no-match result while preserving the latest sync token", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          next_batch: "next-batch-2",
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: [
                    {
                      event_id: "$driver",
                      sender: "@driver:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "hello", msgtype: "m.text" },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const observedEvents: MatrixQaObservedEvent[] = [];

    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1);
    let result: Awaited<ReturnType<typeof waitForOptionalMatrixQaRoomEvent>>;
    try {
      result = await waitForOptionalMatrixQaRoomEvent({
        accessToken: "token",
        baseUrl: "http://127.0.0.1:28008/",
        fetchImpl,
        observedEvents,
        predicate: (event) => event.sender === "@sut:matrix-qa.test",
        roomId: "!room:matrix-qa.test",
        since: "start-batch",
        timeoutMs: 1,
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(result).toEqual({
      matched: false,
      since: "next-batch-2",
    });
    expect(observedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          body: "hello",
          eventId: "$driver",
          roomId: "!room:matrix-qa.test",
          sender: "@driver:matrix-qa.test",
          type: "m.room.message",
        }),
      ]),
    );
  });

  it("keeps recording later same-batch events after the first match", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          next_batch: "next-batch-2",
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: [
                    {
                      event_id: "$sut",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "target", msgtype: "m.text" },
                    },
                    {
                      event_id: "$driver",
                      sender: "@driver:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "trailing event", msgtype: "m.text" },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const observedEvents: MatrixQaObservedEvent[] = [];

    const result = await waitForOptionalMatrixQaRoomEvent({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
      observedEvents,
      predicate: (event) => event.eventId === "$sut",
      roomId: "!room:matrix-qa.test",
      since: "start-batch",
      timeoutMs: 1,
    });

    expect(result).toEqual({
      event: expect.objectContaining({
        eventId: "$sut",
      }),
      matched: true,
      since: "next-batch-2",
    });
    expect(observedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          body: "target",
          eventId: "$sut",
        }),
        expect.objectContaining({
          kind: "message",
          body: "trailing event",
          eventId: "$driver",
        }),
      ]),
    );
  });

  it("lets a second wait reuse later same-batch events without another /sync", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          next_batch: "next-batch-2",
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: [
                    {
                      event_id: "$preview",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "preview", msgtype: "m.notice" },
                    },
                    {
                      event_id: "$final",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: {
                        body: "final",
                        msgtype: "m.text",
                        "m.relates_to": {
                          rel_type: "m.replace",
                          event_id: "$preview",
                          "m.new_content": { body: "final", msgtype: "m.text" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const observedEvents: MatrixQaObservedEvent[] = [];
    const observer = createMatrixQaRoomObserver({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
      observedEvents,
      since: "start-batch",
    });

    const preview = await observer.waitForRoomEvent({
      predicate: (event) => event.eventId === "$preview",
      roomId: "!room:matrix-qa.test",
      timeoutMs: 1_000,
    });
    const finalized = await observer.waitForRoomEvent({
      predicate: (event) => event.eventId === "$final",
      roomId: "!room:matrix-qa.test",
      timeoutMs: 1_000,
    });

    expect(preview.event.eventId).toBe("$preview");
    expect(finalized.event.eventId).toBe("$final");
    expect(calls).toBe(1);
  });

  it("shares one in-flight /sync poll across concurrent waits", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({
          next_batch: "next-batch-2",
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: [
                    {
                      event_id: "$reply",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "reply", msgtype: "m.text" },
                    },
                    {
                      event_id: "$notice",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "notice", msgtype: "m.notice" },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const observer = createMatrixQaRoomObserver({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
      observedEvents: [],
      since: "start-batch",
    });

    const [reply, notice] = await Promise.all([
      observer.waitForRoomEvent({
        predicate: (event) => event.eventId === "$reply",
        roomId: "!room:matrix-qa.test",
        timeoutMs: 1_000,
      }),
      observer.waitForOptionalRoomEvent({
        predicate: (event) => event.eventId === "$notice",
        roomId: "!room:matrix-qa.test",
        timeoutMs: 1_000,
      }),
    ]);

    expect(reply.event.eventId).toBe("$reply");
    expect(notice).toMatchObject({
      event: expect.objectContaining({
        eventId: "$notice",
      }),
      matched: true,
    });
    expect(calls).toBe(1);
  });
});
