import { describe, expect, it } from "vitest";
import { normalizeHistoryMediaEntries, recordPendingHistoryEntryWithMedia } from "./history.js";
import type { HistoryEntry } from "./history.types.js";

describe("history media recording", () => {
  it("keeps only bounded local image media", () => {
    expect(
      normalizeHistoryMediaEntries({
        limit: 2,
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png" },
          { path: "https://example.com/b.png", contentType: "image/png" },
          { path: "/tmp/c.pdf", contentType: "application/pdf", kind: "document" },
          { path: "C:\\tmp\\d.jpg", kind: "image" },
          { path: "/tmp/e.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
      { path: "C:\\tmp\\d.jpg", kind: "image", messageId: "msg-1" },
    ]);
  });

  it("records text history unchanged when media resolver has no usable media", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();

    await recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "hello", messageId: "msg-1" },
      media: async () => [{ path: "https://example.com/a.png", contentType: "image/png" }],
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "hello", messageId: "msg-1" },
    ]);
  });

  it("records text history before async media resolution finishes", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    let resolveMedia!: (media: HistoryEntry["media"]) => void;
    const mediaPromise = new Promise<HistoryEntry["media"]>((resolve) => {
      resolveMedia = resolve;
    });

    const pending = recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
      media: async () => await mediaPromise,
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
    ]);

    resolveMedia([{ path: "/tmp/a.png", contentType: "image/png" }]);
    await pending;

    expect(historyMap.get("channel-1")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });
});
