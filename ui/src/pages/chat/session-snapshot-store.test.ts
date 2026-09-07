/* @vitest-environment jsdom */

import { queryObjects } from "node:v8";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  observeChatCache,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
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

async function putRawRecord(record: unknown, metadata?: unknown): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(
    [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
    "readwrite",
  );
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put(record);
  transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).put(
    metadata ?? {
      savedAt: Date.now(),
      sessionKey: (record as { sessionKey: string }).sessionKey,
      weight: 0,
    },
  );
  await completed;
  database.close();
}

async function putVersionOneRecord(sessionKey: string): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME, 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({ sessionKey });
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

async function readRawMetadata(
  sessionKey: string,
): Promise<{ savedAt: number; weight: number } | undefined> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_METADATA_STORE_NAME, "readonly");
  const result = await new Promise<{ savedAt: number; weight: number } | undefined>(
    (resolve, reject) => {
      const get = transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).get(sessionKey);
      get.addEventListener("success", () => resolve(get.result));
      get.addEventListener("error", () => reject(get.error ?? new Error("metadata read failed")));
    },
  );
  await transactionDone(transaction);
  database.close();
  return result;
}

describe("persistent chat session snapshots", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(async () => {
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares sanitized snapshots across store owners", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:shared", snapshot({ text: "cached", callback: () => true }));
    const savedAt = writer.readSavedAt("agent:main:shared");
    expect(savedAt).not.toBeNull();
    await writer.flush();
    expect(writer.readSavedAt("agent:main:shared")).toBe(savedAt);

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(await reader.read("agent:main:shared")).toEqual(snapshot({ text: "cached" }));
    expect(reader.readSavedAt("agent:main:shared")).toBe(savedAt);
  });

  it("keeps lightweight eviction metadata alongside each snapshot", async () => {
    const sessionKey = "agent:main:metadata";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("cached"));
    await writer.flush();

    const record = await readRawRecord(sessionKey);
    const metadata = await readRawMetadata(sessionKey);
    expect(metadata?.savedAt).toBe(record?.savedAt);
    expect(metadata?.weight).toBeGreaterThan(0);

    await writer.delete(sessionKey);
    expect(await readRawMetadata(sessionKey)).toBeUndefined();
  });

  it("round-trips the optional history delta cursor", async () => {
    const sessionKey = "agent:main:cursor";
    const writer = new SessionSnapshotStore();
    const cached = { ...snapshot("cached"), deltaCursor: "cursor-1" };
    writer.write(sessionKey, cached);
    await writer.flush();

    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(cached);
  });

  it("does not let an append miss replace a richer persisted snapshot", async () => {
    const sessionKey = "agent:main:append-miss";
    const persisted = {
      ...snapshot("unused", "session-rich"),
      deltaCursor: "cursor-rich",
      messages: ["one", "two", "three", "four", "five"],
    };
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, persisted);
    await writer.flush();

    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    store.connect();
    observeChatCache(memoryCache, store);
    try {
      appendChatMessageToCache(
        memoryCache,
        { assistantAgentId: "main", agentsList: null, hello: null },
        { sessionKey },
        "newest",
      );
      await store.flush();

      expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(persisted);
    } finally {
      store.disconnect();
      await store.whenIdle();
    }
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

    await writer.flush();
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("suppresses unchanged writes only for the latest hydration", async () => {
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
    const previousHydration = await reader.read(sessionKey);
    const hydrated = await reader.read(sessionKey);
    if (!previousHydration || !hydrated) {
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
    reader.write(sessionKey, previousHydration);
    await reader.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(2);
  });

  it("releases hydrated snapshots after the message cache evicts them", async () => {
    const sessionKey = "agent:main:evicted-hydration";
    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    observeChatCache(memoryCache, store);
    store.write(sessionKey, snapshot("persisted"));
    await store.flush();

    const { evicted, collectionControl } = await (async () => {
      const hydrated = await store.read(sessionKey);
      if (!hydrated) {
        throw new Error("expected hydrated snapshot");
      }
      cacheChatSessionSnapshot(
        memoryCache,
        { assistantAgentId: "main", agentsList: null, hello: null },
        { sessionKey },
        hydrated,
      );
      return {
        evicted: new WeakRef(hydrated),
        collectionControl: new WeakRef({ unowned: true }),
      };
    })();
    for (let index = 0; index < MAX_CACHED_CHAT_SESSIONS; index += 1) {
      cacheChatSessionSnapshot(
        memoryCache,
        { assistantAgentId: "main", agentsList: null, hello: null },
        { sessionKey: `agent:main:newer-${index}` },
        snapshot(index),
      );
    }
    await store.flush();
    expect(memoryCache.has(sessionKey)).toBe(false);
    await collectGarbageForTest(() => {
      queryObjects(SessionSnapshotStore);
    });
    expect(collectionControl.deref()).toBeUndefined();
    expect(evicted.deref()).toBeUndefined();
    expect(store.readSavedAt("agent:main:newer-0")).not.toBeNull();
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

  it("seeds timestamps without hydrating unrelated snapshots", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:valid", snapshot("valid"));
    await writer.flush();
    await putRawRecord({
      sessionKey: "agent:main:corrupt",
      sessionId: "session-1",
      savedAt: Date.now(),
      snapshot: { messages: "not-an-array" },
    });

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(reader.readSavedAt("agent:main:valid")).not.toBeNull();
    expect(reader.readSavedAt("agent:main:corrupt")).not.toBeNull();
    expect(await reader.read("agent:main:corrupt")).toBeNull();
    expect(await reader.read("agent:main:valid")).toBeNull();
  });

  it("resets the whole database when the savedAt seed finds malformed metadata", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:valid", snapshot("valid"));
    await writer.flush();
    await putRawRecord(
      {
        sessionKey: "agent:main:corrupt",
        sessionId: "session-1",
        savedAt: Date.now(),
        snapshot: snapshot("corrupt metadata"),
      },
      { sessionKey: "agent:main:corrupt", savedAt: "invalid", weight: 0 },
    );

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

  it("preserves an unrelated in-flight transcript while deleting another session", async () => {
    const writer = new SessionSnapshotStore();
    writer.connect();
    try {
      const retainedSession = "agent:main:retained";
      writer.write(retainedSession, snapshot("important transcript"));

      await Promise.all([writer.flush(), writer.delete("agent:main:deleted")]);

      expect(await new SessionSnapshotStore().read(retainedSession)).toEqual(
        snapshot("important transcript"),
      );
      expect(writer.readSavedAt(retainedSession)).not.toBeNull();
    } finally {
      writer.disconnect();
      await writer.whenIdle();
    }
  });

  it.each(["session", "all"])(
    "does not restore an in-flight transcript after %s invalidation",
    async (scope) => {
      const sessionKey = "agent:main:deleted";
      const writer = new SessionSnapshotStore();
      writer.connect();
      try {
        writer.write(sessionKey, snapshot("deleted transcript"));

        await Promise.all([
          writer.flush(),
          scope === "session" ? writer.delete(sessionKey) : clearStoredChatSnapshots(),
        ]);

        expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
        expect(writer.readSavedAt(sessionKey)).toBeNull();
      } finally {
        writer.disconnect();
        await writer.whenIdle();
      }
    },
  );

  it("does not restore deleted metadata while seeding the snapshot index", async () => {
    const sessionKey = "agent:main:deleted-during-seed";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("deleted transcript"));
    await writer.flush();

    const reader = new SessionSnapshotStore();
    reader.connect();
    try {
      let deletion: Promise<void> | undefined;
      const originalGetAll = Reflect.get(
        IDBObjectStore.prototype,
        "getAll",
      ) as IDBObjectStore["getAll"];
      vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementationOnce(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = originalGetAll.apply(this, args);
        request.addEventListener("success", () => {
          deletion = writer.delete(sessionKey);
        });
        return request;
      });

      await reader.loadSavedAtIndex();
      expect(deletion).toBeDefined();
      await deletion;

      expect(reader.readSavedAt(sessionKey)).toBeNull();
    } finally {
      reader.disconnect();
      await reader.whenIdle();
    }
  });

  it("upgrades a version one database before deleting an invalidated snapshot", async () => {
    const sessionKey = "agent:main:legacy-delete";
    await putVersionOneRecord(sessionKey);

    await new SessionSnapshotStore().delete(sessionKey);

    const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("database open failed")),
      );
    });
    expect(database.version).toBe(2);
    expect(Array.from(database.objectStoreNames)).toEqual([
      CHAT_SNAPSHOT_METADATA_STORE_NAME,
      CHAT_SNAPSHOT_STORE_NAME,
    ]);
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readonly",
    );
    const snapshotRequest = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey);
    const metadataRequest = transaction
      .objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME)
      .get(sessionKey);
    const completed = transactionDone(transaction);
    await Promise.all([
      new Promise<void>((resolve) => {
        snapshotRequest.addEventListener("success", () => resolve());
      }),
      new Promise<void>((resolve) => {
        metadataRequest.addEventListener("success", () => resolve());
      }),
      completed,
    ]);
    expect(snapshotRequest.result).toBeUndefined();
    expect(metadataRequest.result).toBeUndefined();
    database.close();
  });

  it("broadcasts invalidation and clears active memory for current and legacy peers", async () => {
    const sessionKey = "agent:main:cross-tab";
    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    store.connect();
    observeChatCache(memoryCache, store);
    cacheChatSessionSnapshot(
      memoryCache,
      { assistantAgentId: "main", agentsList: null, hello: null },
      { sessionKey },
      snapshot("local"),
    );
    await store.flush();
    const setItem = vi.spyOn(localStorage, "setItem");

    try {
      await clearStoredChatSnapshots();
      const currentBroadcastValue = setItem.mock.calls.findLast(
        ([key]) => key === "openclaw.control.chatSnapshots.invalidate.v1",
      )?.[1];
      if (currentBroadcastValue === undefined) {
        throw new Error("expected full-cache invalidation broadcast");
      }
      expect(currentBroadcastValue).toBe("{}");

      for (const peerValue of [currentBroadcastValue, "1"]) {
        cacheChatSessionSnapshot(
          memoryCache,
          { assistantAgentId: "main", agentsList: null, hello: null },
          { sessionKey },
          snapshot("refilled"),
        );
        await store.flush();
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "openclaw.control.chatSnapshots.invalidate.v1",
            newValue: peerValue,
          }),
        );

        expect(memoryCache.size).toBe(0);
        expect(store.readSavedAt(sessionKey)).toBeNull();
      }
    } finally {
      store.disconnect();
      await store.whenIdle();
    }
  });

  it("keeps unrelated peer-tab memory when one session snapshot is deleted", async () => {
    const deletedSessionKey = "agent:main:deleted-in-peer";
    const retainedSessionKey = "agent:main:retained-in-peer";
    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    store.connect();
    observeChatCache(memoryCache, store);
    const cacheSnapshot = (sessionKey: string) =>
      cacheChatSessionSnapshot(
        memoryCache,
        { assistantAgentId: "main", agentsList: null, hello: null },
        { sessionKey },
        snapshot(sessionKey),
      );
    cacheSnapshot(deletedSessionKey);
    cacheSnapshot(retainedSessionKey);
    await store.flush();
    const setItem = vi.spyOn(localStorage, "setItem");

    try {
      await deleteStoredChatSnapshot(deletedSessionKey);
      const broadcastValue = setItem.mock.calls.findLast(
        ([key]) => key === "openclaw.control.chatSnapshots.invalidate.v1",
      )?.[1];
      expect(broadcastValue).toBeDefined();

      cacheSnapshot(deletedSessionKey);
      await store.flush();
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "openclaw.control.chatSnapshots.invalidate.v1",
          newValue: broadcastValue,
        }),
      );

      expect(store.readSavedAt(deletedSessionKey)).toBeNull();
      expect(store.readSavedAt(retainedSessionKey)).not.toBeNull();
      expect(memoryCache.has(deletedSessionKey)).toBe(false);
      expect(memoryCache.has(retainedSessionKey)).toBe(true);
    } finally {
      store.disconnect();
      await store.whenIdle();
    }
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
