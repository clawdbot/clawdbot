// Qa Lab Matrix tests cover sync behavior.
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
    expect(observedEvents).toEqual([
      {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$driver",
        sender: "@driver:matrix-qa.test",
        stateKey: undefined,
        type: "m.room.message",
        originServerTs: undefined,
        body: "hello",
        formattedBody: undefined,
        msgtype: "m.text",
        membership: undefined,
      },
    ]);
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
      event: {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$sut",
        sender: "@sut:matrix-qa.test",
        stateKey: undefined,
        type: "m.room.message",
        originServerTs: undefined,
        body: "target",
        formattedBody: undefined,
        msgtype: "m.text",
        membership: undefined,
      },
      matched: true,
      since: "next-batch-2",
    });
    expect(observedEvents).toEqual([
      {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$sut",
        sender: "@sut:matrix-qa.test",
        stateKey: undefined,
        type: "m.room.message",
        originServerTs: undefined,
        body: "target",
        formattedBody: undefined,
        msgtype: "m.text",
        membership: undefined,
      },
      {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$driver",
        sender: "@driver:matrix-qa.test",
        stateKey: undefined,
        type: "m.room.message",
        originServerTs: undefined,
        body: "trailing event",
        formattedBody: undefined,
        msgtype: "m.text",
        membership: undefined,
      },
    ]);
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
                      content: {
                        body: "preview",
                        msgtype: "m.notice",
                        "m.relates_to": {
                          rel_type: "m.thread",
                          event_id: "$root",
                          is_falling_back: true,
                          "m.in_reply_to": { event_id: "$driver" },
                        },
                      },
                    },
                    {
                      event_id: "$final",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: {
                        body: "final",
                        msgtype: "m.text",
                        "m.new_content": { body: "final", msgtype: "m.text" },
                        "m.relates_to": {
                          rel_type: "m.replace",
                          event_id: "$preview",
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
    expect(finalized.event).toMatchObject({
      body: "final",
      eventId: "$final",
      replacesEventId: "$preview",
      relatesTo: {
        eventId: "$root",
        inReplyToId: "$driver",
        isFallingBack: true,
        relType: "m.thread",
      },
    });
    expect(calls).toBe(1);
  });

  it("keeps independent cursors for events observed while polling another room", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          next_batch: "next-batch-2",
          rooms: {
            join: {
              "!main:matrix-qa.test": {
                timeline: {
                  events: [
                    {
                      event_id: "$main-reply",
                      sender: "@sut:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "main reply", msgtype: "m.text" },
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

    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1);
    try {
      await expect(
        observer.waitForOptionalRoomEvent({
          predicate: (event) => event.sender === "@sut:matrix-qa.test",
          roomId: "!secondary:matrix-qa.test",
          timeoutMs: 1,
        }),
      ).resolves.toEqual({ matched: false, since: "next-batch-2" });
    } finally {
      nowSpy.mockRestore();
    }

    await expect(
      observer.waitForRoomEvent({
        predicate: (event) => event.eventId === "$main-reply",
        roomId: "!main:matrix-qa.test",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ event: { eventId: "$main-reply" } });
    expect(calls).toBe(1);
  });

  it("shares one in-flight /sync poll across concurrent waits", async () => {
    let calls = 0;
    let markFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let releaseFetch: () => void = () => {};
    const fetchCanComplete = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      markFetchStarted();
      await fetchCanComplete;
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

    const waits = Promise.all([
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

    await fetchStarted;
    await Promise.resolve();
    releaseFetch();
    const [reply, notice] = await waits;

    expect(reply.event.eventId).toBe("$reply");
    expect(notice).toEqual({
      event: {
        kind: "notice",
        roomId: "!room:matrix-qa.test",
        eventId: "$notice",
        sender: "@sut:matrix-qa.test",
        stateKey: undefined,
        type: "m.room.message",
        originServerTs: undefined,
        body: "notice",
        formattedBody: undefined,
        msgtype: "m.notice",
        membership: undefined,
      },
      matched: true,
      since: "next-batch-2",
    });
    expect(calls).toBe(1);
  });

  it("treats its own long-poll deadline as empty and recovers on the next wait", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const expiredSignal = AbortSignal.abort(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(expiredSignal)
      .mockReturnValue(new AbortController().signal);
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        now = 1;
        throw init?.signal instanceof AbortSignal ? init.signal.reason : expiredSignal.reason;
      }
      return Response.json({
        next_batch: "recovered-batch",
        rooms: {
          join: {
            "!room:matrix-qa.test": {
              timeline: {
                events: [
                  {
                    event_id: "$recovered",
                    sender: "@sut:matrix-qa.test",
                    type: "m.room.message",
                    content: { body: "recovered", msgtype: "m.text" },
                  },
                ],
              },
            },
          },
        },
      });
    };
    const observer = createMatrixQaRoomObserver({
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
      observedEvents: [],
      since: "start-batch",
    });

    try {
      await expect(
        observer.waitForOptionalRoomEvent({
          predicate: (event) => event.eventId === "$missing",
          roomId: "!room:matrix-qa.test",
          timeoutMs: 1,
        }),
      ).resolves.toEqual({ matched: false, since: "start-batch" });

      now = 2;
      await expect(
        observer.waitForRoomEvent({
          predicate: (event) => event.eventId === "$recovered",
          roomId: "!room:matrix-qa.test",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ event: { eventId: "$recovered" }, since: "recovered-batch" });
    } finally {
      nowSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
    expect(calls).toBe(2);
  });

  it("preserves terminal sync failures, including unrelated TimeoutErrors", async () => {
    const timeoutError = new DOMException("upstream protocol timeout", "TimeoutError");
    const observer = createMatrixQaRoomObserver({
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl: async () => {
        throw timeoutError;
      },
      observedEvents: [],
      since: "start-batch",
    });

    await expect(
      observer.waitForOptionalRoomEvent({
        predicate: () => false,
        roomId: "!room:matrix-qa.test",
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(timeoutError);

    const authObserver = createMatrixQaRoomObserver({
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl: async () => Response.json({ error: "invalid access token" }, { status: 401 }),
      observedEvents: [],
      since: "start-batch",
    });
    await expect(
      authObserver.waitForOptionalRoomEvent({
        predicate: () => false,
        roomId: "!room:matrix-qa.test",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("invalid access token");
  });

  it("preserves response-body failures raised after its long-poll deadline fires", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const bodyError = new Error("late Matrix response body failure");
    const observer = createMatrixQaRoomObserver({
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              deadline.abort();
              controller.error(bodyError);
            },
          }),
        ),
      observedEvents: [],
      since: "start-batch",
    });

    try {
      await expect(
        observer.waitForOptionalRoomEvent({
          predicate: () => false,
          roomId: "!room:matrix-qa.test",
          timeoutMs: 1_000,
        }),
      ).rejects.toBe(bodyError);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
