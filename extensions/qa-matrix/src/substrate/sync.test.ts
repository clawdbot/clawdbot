import { describe, expect, it } from "vitest";
import type { MatrixQaObservedEvent } from "./events.js";
import { primeMatrixQaRoom, waitForOptionalMatrixQaRoomEvent } from "./sync.js";

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

    const result = await waitForOptionalMatrixQaRoomEvent({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
      observedEvents,
      predicate: (event) => event.sender === "@sut:matrix-qa.test",
      roomId: "!room:matrix-qa.test",
      since: "start-batch",
      timeoutMs: 1,
    });

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
});
