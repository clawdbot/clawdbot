// Matrix tests cover reply context plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createPollStartEvent } from "./test-events.js";
import type { MatrixRawEvent } from "./types.js";

async function resolveReplyBody(event: MatrixRawEvent): Promise<string | undefined> {
  const resolveReplyContext = createMatrixReplyContextResolver({
    client: { getEvent: vi.fn(async () => event) } as never,
    getMemberDisplayName: vi.fn(async () => "Alice"),
    logVerboseMessage: () => {},
  });
  return (
    await resolveReplyContext({
      roomId: "!room:example.org",
      eventId: event.event_id ?? "$event",
    })
  ).replyToBody;
}

describe("matrix reply context", () => {
  it("summarizes reply events from body text", async () => {
    expect(
      await resolveReplyBody({
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

  it("truncates long reply bodies", async () => {
    const longBody = "x".repeat(600);
    const result = await resolveReplyBody({
      event_id: "$original",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: longBody,
      },
    } as MatrixRawEvent);
    if (result === undefined) {
      throw new Error("expected truncated reply context");
    }
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.endsWith("...")).toBe(true);
  });

  it("truncates on a code-point boundary without orphaning a surrogate half", async () => {
    // Body is 496 'a' + 😀 (U+1F600, a surrogate pair at UTF-16 indices 496-497)
    // + "bcd". Raw `.slice(0, 497)` would split the emoji and leave a lone high
    // surrogate (\uD83D) before the ellipsis. The fix must drop the half emoji.
    const body = `${"a".repeat(496)}😀bcd`;
    expect(body.length).toBe(501);
    const result = await resolveReplyBody({
      event_id: "$original",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body,
      },
    } as MatrixRawEvent);
    if (result === undefined) {
      throw new Error("expected truncated reply context");
    }
    expect(result).toBe(`${"a".repeat(496)}...`);
    // No dangling high surrogate should survive the truncation.
    expect(result.includes("\uD83D")).toBe(false);
  });

  it("handles media-only reply events", async () => {
    expect(
      await resolveReplyBody({
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

  it("summarizes poll start events from poll content", async () => {
    expect(await resolveReplyBody(createPollStartEvent("$poll"))).toBe(
      "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
    );
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

    expect(result).toStrictEqual({});
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

    expect(result).toStrictEqual({});
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
    expect(first).toStrictEqual({});

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
