// Matrix tests cover thread context plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createPollStartEvent } from "./test-events.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import type { MatrixRawEvent } from "./types.js";

async function resolveThreadSummary(event: MatrixRawEvent): Promise<string | undefined> {
  const resolveThreadContext = createMatrixThreadContextResolver({
    client: { getEvent: vi.fn(async () => event) } as never,
    getMemberDisplayName: vi.fn(async () => "Alice"),
    logVerboseMessage: () => {},
  });
  return (
    await resolveThreadContext({
      roomId: "!room:example.org",
      threadRootId: event.event_id ?? "$root",
    })
  ).summary;
}

describe("matrix thread context", () => {
  it("summarizes thread starter events from body text", async () => {
    expect(
      await resolveThreadSummary({
        event_id: "$root",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: {
          msgtype: "m.text",
          body: " Thread starter body ",
        },
      } as MatrixRawEvent),
    ).toBe("Thread starter body");
  });

  it("truncates long thread starter bodies on code-point boundaries", async () => {
    const summary = await resolveThreadSummary({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        // 496 "a" + astral emoji (surrogate pair at units 496-497) + tail.
        // A raw slice(0, 497) would cut the pair and leave a lone high surrogate.
        body: `${"a".repeat(496)}\u{1F600}bcd`,
      },
    } as MatrixRawEvent);
    expect(summary).toBe(`${"a".repeat(496)}...`);
    expect(summary && /[\uD800-\uDFFF]/.test(summary)).toBe(false);
  });

  it("marks media-only thread starter events instead of returning bare filenames", async () => {
    expect(
      await resolveThreadSummary({
        event_id: "$root",
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

  it("resolves and caches thread starter context", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "Root topic",
      },
    }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveThreadContext = createMatrixThreadContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    await expect(
      resolveThreadContext({
        roomId: "!room:example.org",
        threadRootId: "$root",
      }),
    ).resolves.toEqual({
      threadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      senderId: "@alice:example.org",
      senderLabel: "Alice",
      summary: "Root topic",
    });

    await resolveThreadContext({
      roomId: "!room:example.org",
      threadRootId: "$root",
    });

    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("does not cache thread starter fetch failures", async () => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        event_id: "$root",
        sender: "@alice:example.org",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: {
          msgtype: "m.text",
          body: "Recovered topic",
        },
      });
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveThreadContext = createMatrixThreadContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    await expect(
      resolveThreadContext({
        roomId: "!room:example.org",
        threadRootId: "$root",
      }),
    ).resolves.toEqual({
      threadStarterBody: "Matrix thread root $root",
    });

    await expect(
      resolveThreadContext({
        roomId: "!room:example.org",
        threadRootId: "$root",
      }),
    ).resolves.toEqual({
      threadStarterBody: "Matrix thread root $root from Alice:\nRecovered topic",
      senderId: "@alice:example.org",
      senderLabel: "Alice",
      summary: "Recovered topic",
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("summarizes poll start thread roots from poll content", async () => {
    expect(await resolveThreadSummary(createPollStartEvent("$root"))).toBe(
      "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
    );
  });
});
