/* @vitest-environment jsdom */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheChatSessionSnapshot,
  observeChatCache,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  clearStoredChatSnapshots,
} from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

function snapshot(message: unknown, sessionId = "session-1"): ChatSessionSnapshot {
  return {
    displayedLeafEntryId: "leaf-1",
    messages: [message],
    pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
    sessionId,
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    const rejectTransaction = () => reject(transaction.error ?? new Error("transaction failed"));
    transaction.addEventListener("error", rejectTransaction);
    transaction.addEventListener("abort", rejectTransaction);
  });
}

async function putRawRecord(record: unknown): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put(record);
  await completed;
  database.close();
}

async function readRawRecord(sessionKey: string): Promise<{ savedAt: number } | undefined> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readonly");
  const result = await new Promise<{ savedAt: number } | undefined>((resolve, reject) => {
    const get = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey);
    get.addEventListener("success", () => resolve(get.result));
    get.addEventListener("error", () => reject(get.error ?? new Error("record read failed")));
  });
  await transactionDone(transaction);
  database.close();
  return result;
}

describe("persistent chat session snapshots", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  afterEach(async () => {
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares sanitized snapshots and measured row heights across store owners", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:shared", snapshot({ text: "cached", callback: () => true }));
    writer.recordRowHeight("agent:main:shared", "message:1", 184);
    const savedAt = writer.readSavedAt("agent:main:shared");
    expect(savedAt).not.toBeNull();
    await writer.flush();
    expect(writer.readSavedAt("agent:main:shared")).toBe(savedAt);

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(await reader.read("agent:main:shared")).toEqual(snapshot({ text: "cached" }));
    expect(reader.readSavedAt("agent:main:shared")).toBe(savedAt);
    expect(reader.readRowHeight("agent:main:shared", "message:1")).toBe(184);
  });

  it("seeds the savedAt index once for every synchronous lookup", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:first", snapshot("first"));
    writer.write("agent:main:second", snapshot("second"));
    await writer.flush();
    const open = vi.spyOn(indexedDB, "open");
    const reader = new SessionSnapshotStore();

    await reader.loadSavedAtIndex();
    expect(reader.readSavedAt("agent:main:first")).not.toBeNull();
    expect(reader.readSavedAt("agent:main:second")).not.toBeNull();
    expect(reader.readSavedAt("agent:main:missing")).toBeNull();
    await reader.loadSavedAtIndex();

    expect(open).toHaveBeenCalledOnce();
  });

  it("defers snapshot sanitization until flush", async () => {
    const sessionKey = "agent:main:deferred-sanitize";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("persisted"));
    await writer.flush();

    writer.write(sessionKey, snapshot(1n));
    writer.recordRowHeight(sessionKey, "message:1", 184);
    expect(writer.readRowHeight(sessionKey, "message:1")).toBe(184);

    await writer.flush();
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("does not write a snapshot back after pure hydration", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionKey = "agent:main:hydrate-only";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("persisted"));
    await writer.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);

    now = 2;
    const memoryCache: ChatMessageCache = new Map();
    const reader = new SessionSnapshotStore(memoryCache);
    observeChatCache(memoryCache, reader);
    const hydrated = await reader.read(sessionKey);
    if (!hydrated) {
      throw new Error("expected hydrated snapshot");
    }
    cacheChatSessionSnapshot(
      memoryCache,
      { assistantAgentId: "main", agentsList: null, hello: null },
      { sessionKey },
      hydrated,
    );
    await reader.flush();

    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
  });

  it("evicts the oldest sessions by count and total serialized weight", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    const writer = new SessionSnapshotStore();
    for (let index = 0; index <= 20; index += 1) {
      writer.write(`agent:main:count-${index}`, snapshot(index, `count-${index}`));
      await writer.flush();
    }
    const reader = new SessionSnapshotStore();
    expect(writer.readSavedAt("agent:main:count-0")).toBeNull();
    expect(await reader.read("agent:main:count-0")).toBeNull();
    expect(await reader.read("agent:main:count-20")).not.toBeNull();

    await clearStoredChatSnapshots();
    const large = "x".repeat(9 * 1024 * 1024);
    for (let index = 0; index < 3; index += 1) {
      writer.write(`agent:main:weight-${index}`, snapshot(large, `weight-${index}`));
      await writer.flush();
    }
    const weightReader = new SessionSnapshotStore();
    expect(await weightReader.read("agent:main:weight-0")).toBeNull();
    expect(await weightReader.read("agent:main:weight-2")).not.toBeNull();
  });

  it("resets the whole database when the savedAt seed finds a malformed record", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:valid", snapshot("valid"));
    await writer.flush();
    await putRawRecord({
      sessionKey: "agent:main:corrupt",
      sessionId: "session-1",
      savedAt: Date.now(),
      snapshot: { messages: "not-an-array" },
      rowHeights: new Map(),
    });

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(reader.readSavedAt("agent:main:corrupt")).toBeNull();
    expect(await reader.read("agent:main:valid")).toBeNull();
  });

  it("deletes only the invalidated session record", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:deleted", snapshot("deleted"));
    writer.write("agent:main:retained", snapshot("retained"));
    await writer.flush();

    await writer.delete("agent:main:deleted");
    expect(writer.readSavedAt("agent:main:deleted")).toBeNull();
    expect(writer.readSavedAt("agent:main:retained")).not.toBeNull();

    const reader = new SessionSnapshotStore();
    expect(await reader.read("agent:main:deleted")).toBeNull();
    expect(await reader.read("agent:main:retained")).not.toBeNull();
  });

  it("keeps every operation non-fatal when IndexedDB is unavailable or throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = new SessionSnapshotStore();
    unavailable.write("agent:main:none", snapshot("none"));
    await expect(unavailable.flush()).resolves.toBeUndefined();
    await expect(unavailable.read("agent:main:none")).resolves.toBeNull();
    await expect(unavailable.delete("agent:main:none")).resolves.toBeUndefined();

    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
      deleteDatabase: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const denied = new SessionSnapshotStore();
    denied.write("agent:main:denied", snapshot("denied"));
    await expect(denied.flush()).resolves.toBeUndefined();
    await expect(denied.read("agent:main:denied")).resolves.toBeNull();
    await expect(clearStoredChatSnapshots()).resolves.toBeUndefined();
  });
});
