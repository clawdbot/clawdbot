// Turn history window tests cover channel turn transcript window selection.
import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import { createChannelHistoryWindow, type PersistedChannelHistory } from "./history-window.js";

function createPersistenceStore() {
  const values = new Map<string, PersistedChannelHistory>();
  return {
    values,
    store: {
      lookup: (key: string) => values.get(key),
      update: (
        key: string,
        updateValue: (
          current: PersistedChannelHistory | undefined,
        ) => PersistedChannelHistory | undefined,
      ) => {
        const next = updateValue(values.get(key));
        if (next === undefined) {
          return values.delete(key);
        }
        values.set(key, next);
        return true;
      },
      delete: (key: string) => values.delete(key),
    },
  };
}

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

  it("restores text and document references from SQLite-backed state after restart", async () => {
    const persistence = createPersistenceStore();
    const first = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: { store: persistence.store, keyPrefix: "imessage:main", now: () => 100 },
    });
    await first.recordWithMedia({
      historyKey: "group-1",
      limit: 50,
      messageId: "pdf-1",
      entry: {
        sender: "Alice",
        body: "This is the worksheet",
        timestamp: 10,
        messageId: "pdf-1",
      },
      media: [
        {
          path: "/state/media/inbound/worksheet.pdf",
          contentType: "application/pdf",
          kind: "document",
        },
      ],
    });

    const afterRestart = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: { store: persistence.store, keyPrefix: "imessage:main", now: () => 100 },
    });
    expect(afterRestart.buildInboundHistory({ historyKey: "group-1", limit: 50 })).toEqual([
      {
        sender: "Alice",
        body: "This is the worksheet",
        timestamp: 10,
        messageId: "pdf-1",
        media: [
          {
            path: "/state/media/inbound/worksheet.pdf",
            contentType: "application/pdf",
            kind: "document",
            messageId: "pdf-1",
          },
        ],
      },
    ]);
  });

  it("consumes only the captured high-water mark and preserves concurrent messages", () => {
    const persistence = createPersistenceStore();
    const history = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: { store: persistence.store, keyPrefix: "feishu:legal", now: () => 100 },
    });
    history.record({
      historyKey: "group-1",
      limit: 50,
      entry: { sender: "Alice", body: "before", timestamp: 10, messageId: "m1" },
    });
    const turnSnapshot = history.snapshot({ historyKey: "group-1", limit: 50 });
    history.record({
      historyKey: "group-1",
      limit: 50,
      entry: { sender: "Bob", body: "arrived during reply", timestamp: 11, messageId: "m2" },
    });

    history.consume({ historyKey: "group-1", limit: 50, snapshot: turnSnapshot });

    expect(history.snapshot({ historyKey: "group-1", limit: 50 }).entries).toEqual([
      { sender: "Bob", body: "arrived during reply", timestamp: 11, messageId: "m2" },
    ]);
  });

  it("persists an empty watermark after consuming the complete snapshot", () => {
    const persistence = createPersistenceStore();
    const first = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: { store: persistence.store, keyPrefix: "imessage:main", now: () => 100 },
    });
    first.record({
      historyKey: "group-1",
      limit: 50,
      entry: { sender: "Alice", body: "consumed", timestamp: 10, messageId: "m1" },
    });
    const turnSnapshot = first.snapshot({ historyKey: "group-1", limit: 50 });
    first.consume({ historyKey: "group-1", limit: 50, snapshot: turnSnapshot });

    const afterRestart = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: { store: persistence.store, keyPrefix: "imessage:main", now: () => 100 },
    });
    expect(afterRestart.snapshot({ historyKey: "group-1", limit: 50 }).entries).toEqual([]);
    expect(persistence.values.get("imessage:main:group-1")?.nextSequence).toBe(2);
  });

  it("deduplicates message ids and enforces time and serialized-byte bounds", () => {
    const persistence = createPersistenceStore();
    let now = 100_000;
    const history = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: {
        store: persistence.store,
        now: () => now,
        ttlMs: 1_000,
        maxBytes: 600,
      },
    });
    history.record({
      historyKey: "group-1",
      limit: 50,
      entry: { sender: "Alice", body: "expired", timestamp: 98_000, messageId: "old" },
    });
    history.record({
      historyKey: "group-1",
      limit: 50,
      entry: { sender: "Alice", body: "x".repeat(2_000), timestamp: now, messageId: "new" },
    });
    history.record({
      historyKey: "group-1",
      limit: 50,
      entry: { sender: "Alice", body: "duplicate", timestamp: now, messageId: "new" },
    });
    now += 1;

    const entries = history.snapshot({ historyKey: "group-1", limit: 50 }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.messageId).toBe("new");
    expect(entries[0]?.body.length).toBeLessThan(2_000);
    expect(
      Buffer.byteLength(JSON.stringify(persistence.values.get("group-1")), "utf8"),
    ).toBeLessThanOrEqual(600);
  });

  it.each([
    {
      name: "out-of-order sequences",
      value: {
        schemaVersion: 1,
        nextSequence: 3,
        items: [
          { sequence: 2, entry: { sender: "a", body: "two" } },
          { sequence: 1, entry: { sender: "b", body: "one" } },
        ],
      },
    },
    {
      name: "invalid media metadata",
      value: {
        schemaVersion: 1,
        nextSequence: 2,
        items: [
          {
            sequence: 1,
            entry: {
              sender: "a",
              body: "file",
              media: [{ path: "/tmp/file.pdf", sizeBytes: "large" }],
            },
          },
        ],
      },
    },
  ])("fails closed on $name in persisted history", ({ value }) => {
    const persistence = createPersistenceStore();
    persistence.values.set("account:group", value as PersistedChannelHistory);
    const history = createChannelHistoryWindow({
      historyMap: new Map(),
      persistence: { store: persistence.store, keyPrefix: "account" },
    });

    expect(() => history.snapshot({ historyKey: "group", limit: 10 })).toThrow(
      "persisted channel history has an unsupported or corrupt shape",
    );
  });
});
