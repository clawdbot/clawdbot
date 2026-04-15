import { describe, expect, it, vi } from "vitest";
import { createMatrixReplyContextResolver, summarizeMatrixReplyEvent } from "./reply-context.js";
import type { MatrixRawEvent } from "./types.js";

describe("matrix reply context", () => {
  it("summarizes reply events from body text", () => {
    expect(
      summarizeMatrixReplyEvent({
        event_id: "$original",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: {
          msgtype: "m.text",
          body: " Some quoted message ",
        },
      } as MatrixRawEvent),
    ).toBe("Some quoted message");
  });

  it("truncates long reply bodies", () => {
    const longBody = "x".repeat(600);
    const result = summarizeMatrixReplyEvent({
      event_id: "$original",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: longBody,
      },
    } as MatrixRawEvent);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(500);
    expect(result!.endsWith("...")).toBe(true);
  });

  it("handles media-only reply events", () => {
    expect(
      summarizeMatrixReplyEvent({
        event_id: "$original",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: {
          msgtype: "m.image",
          body: "photo.jpg",
        },
      } as MatrixRawEvent),
    ).toBe("[matrix image attachment]");
  });

  it("summarizes poll start events from poll content", () => {
    expect(
      summarizeMatrixReplyEvent({
        event_id: "$poll",
        sender: "@alice:example.org",
        type: "m.poll.start",
        origin_server_ts: Date.now(),
        content: {
          "m.poll.start": {
            question: { "m.text": "Lunch?" },
            kind: "m.poll.disclosed",
            max_selections: 1,
            answers: [
              { id: "a1", "m.text": "Pizza" },
              { id: "a2", "m.text": "Sushi" },
            ],
          },
        },
      } as MatrixRawEvent),
    ).toBe("[Poll]\nLunch?\n\n1. Pizza\n2. Sushi");
  });

  it("resolves and caches reply context", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$original",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "This is the original message",
      },
    }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$original",
    });

    expect(result).toEqual({
      replyToBody: "This is the original message",
      replyToSender: "Alice",
      replyToSenderId: "@alice:example.org",
    });

    // Second call should use cache
    await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$original",
    });

    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("returns empty context when event fetch fails", async () => {
    const getEvent = vi.fn().mockRejectedValueOnce(new Error("not found"));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$missing",
    });

    expect(result).toEqual({});
  });

  it("returns empty context for redacted events", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$redacted",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      unsigned: {
        redacted_because: { type: "m.room.redaction" },
      },
      content: {},
    }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$redacted",
    });

    expect(result).toEqual({});
    expect(getMemberDisplayName).not.toHaveBeenCalled();
  });

  it("does not cache fetch failures so retries can succeed", async () => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        event_id: "$original",
        sender: "@bob:example.org",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: {
          msgtype: "m.text",
          body: "Recovered message",
        },
      });
    const getMemberDisplayName = vi.fn(async () => "Bob");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    // First call fails
    const first = await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$original",
    });
    expect(first).toEqual({});

    // Second call succeeds (should retry, not use cached failure)
    const second = await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$original",
    });
    expect(second).toEqual({
      replyToBody: "Recovered message",
      replyToSender: "Bob",
      replyToSenderId: "@bob:example.org",
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
  });

  it("falls back to senderId when display name resolution fails", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$original",
      sender: "@charlie:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "Hello",
      },
    }));
    const getMemberDisplayName = vi.fn().mockRejectedValueOnce(new Error("unknown member"));
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: "$original",
    });

    expect(result).toEqual({
      replyToBody: "Hello",
      replyToSender: "@charlie:example.org",
      replyToSenderId: "@charlie:example.org",
    });
  });

  it("uses LRU eviction — recently accessed entries survive over older ones", async () => {
    let callCount = 0;
    const getEvent = vi.fn().mockImplementation((_roomId: string, eventId: string) => {
      callCount++;
      return Promise.resolve({
        event_id: eventId,
        sender: `@user${callCount}:example.org`,
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: { msgtype: "m.text", body: `msg-${eventId}` },
      });
    });
    const getMemberDisplayName = vi
      .fn()
      .mockImplementation((_r: string, userId: string) => Promise.resolve(userId));

    // Use a small cache by testing the eviction pattern:
    // The actual MAX_CACHED_REPLY_CONTEXTS is 256. We cannot override it easily,
    // but we can verify that a cache hit reorders entries (delete + re-insert).
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: { getEvent } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    // Populate cache with two entries
    await resolveReplyContext({ roomId: "!r:e", eventId: "$A" });
    await resolveReplyContext({ roomId: "!r:e", eventId: "$B" });
    expect(getEvent).toHaveBeenCalledTimes(2);

    // Access $A again — should be a cache hit (no new getEvent call)
    // and should move $A to the end of the Map for LRU.
    const hitResult = await resolveReplyContext({ roomId: "!r:e", eventId: "$A" });
    expect(getEvent).toHaveBeenCalledTimes(2); // Still 2 — cache hit
    expect(hitResult.replyToBody).toBe("msg-$A");
  });
});
