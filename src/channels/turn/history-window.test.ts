import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import { createChannelHistoryWindow } from "./history-window.js";

describe("createChannelHistoryWindow", () => {
  it("records, formats, exposes, and clears a channel history window", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const history = createChannelHistoryWindow({ historyMap });

    history.record({
      historyKey: "room-1",
      limit: 3,
      entry: {
        sender: "Alice",
        body: "first",
        timestamp: 1,
        messageId: "m1",
      },
    });
    await history.recordWithMedia({
      historyKey: "room-1",
      limit: 3,
      messageId: "m2",
      entry: {
        sender: "Bob",
        body: "<media:image>",
        timestamp: 2,
        messageId: "m2",
      },
      media: [
        { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
        { path: "https://example.com/skip.png", contentType: "image/png", kind: "image" },
      ],
    });

    expect(
      history.buildPendingContext({
        historyKey: "room-1",
        limit: 3,
        currentMessage: "now",
        formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
      }),
    ).toContain("Alice: first\nBob: <media:image>");
    expect(history.buildInboundHistory({ historyKey: "room-1", limit: 3 })).toEqual([
      {
        sender: "Alice",
        body: "first",
        timestamp: 1,
        messageId: "m1",
      },
      {
        sender: "Bob",
        body: "<media:image>",
        timestamp: 2,
        messageId: "m2",
        media: [
          { path: "/tmp/image.png", contentType: "image/png", kind: "image", messageId: "m2" },
        ],
      },
    ]);

    history.clear({ historyKey: "room-1", limit: 3 });
    expect(history.buildInboundHistory({ historyKey: "room-1", limit: 3 })).toEqual([]);
  });
});
