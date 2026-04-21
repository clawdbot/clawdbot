import { describe, expect, it, vi } from "vitest";
import { createPollStartEvent } from "./test-events.js";
import {
  createMatrixThreadContextResolver,
  summarizeMatrixThreadStarterEvent,
} from "./thread-context.js";
import type { MatrixRawEvent } from "./types.js";

describe("matrix thread context", () => {
  it("summarizes thread starter events from body text", () => {
    expect(
      summarizeMatrixThreadStarterEvent({
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

  it("marks media-only thread starter events instead of returning bare filenames", () => {
    expect(
      summarizeMatrixThreadStarterEvent({
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

  it("summarizes poll start thread roots from poll content", () => {
    expect(summarizeMatrixThreadStarterEvent(createPollStartEvent("$root"))).toBe(
      "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
    );
  });
});
