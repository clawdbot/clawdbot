import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import * as database from "./session-snapshot-database.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.runtime.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import * as snapshots from "./session-snapshot-store.ts";

const key = "agent:main:routed";
const otherKey = "agent:main:other";
const stored: ChatSessionSnapshot = {
  messages: [{ role: "assistant", content: "Stored conversation" }],
  sessionId: "session-1",
  pagination: { hasMore: false, completeSnapshot: true },
  deltaCursor: "stored-cursor",
};

async function seed() {
  const writer = new snapshots.SessionSnapshotStore();
  writer.write(key, stored);
  writer.write(otherKey, { ...stored, sessionId: "other-session" });
  await writer.flush();
  return writer;
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearStoredChatSnapshots();
  vi.unstubAllGlobals();
});

describe("routed transcript prewarm", () => {
  it("reads normally when no prewarm exists", async () => {
    await seed();
    const open = vi.spyOn(indexedDB, "open");
    expect(await new snapshots.SessionSnapshotStore().read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledOnce();
  });

  it("starts before consumption and reuses the matching read only once", async () => {
    await seed();
    const open = vi.spyOn(indexedDB, "open");
    prewarmChatSnapshot(key);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const reader = new snapshots.SessionSnapshotStore();
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledOnce();
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("leaves the prewarm available when another session reads normally", async () => {
    await seed();
    const open = vi.spyOn(indexedDB, "open");
    prewarmChatSnapshot(key);
    const reader = new snapshots.SessionSnapshotStore();
    expect(await reader.read(otherKey)).toEqual({ ...stored, sessionId: "other-session" });
    expect(await reader.read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each(["session", "all", "clear"] as const)(
    "drops prewarm before its import settles on %s invalidation",
    async (scope) => {
      await seed();
      const open = vi.spyOn(indexedDB, "open");
      prewarmChatSnapshot(key);
      await (scope === "clear"
        ? clearStoredChatSnapshots()
        : publishSnapshotInvalidation(scope === "session" ? { sessionKey: key } : {}));
      await vi.dynamicImportSettled();
      expect(open).not.toHaveBeenCalled();
      expect(await new snapshots.SessionSnapshotStore().read(key)).toEqual(
        scope === "clear" ? null : stored,
      );
      expect(open).toHaveBeenCalledOnce();
    },
  );

  it("keeps the routed prewarm when another session is invalidated", async () => {
    await seed();
    const open = vi.spyOn(indexedDB, "open");
    prewarmChatSnapshot(key);
    await publishSnapshotInvalidation({ sessionKey: otherKey });
    expect(await new snapshots.SessionSnapshotStore().read(key)).toEqual(stored);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(["write", "forget"] as const)(
    "retires a completed prewarm before a later %s",
    async (change) => {
      const writer = await seed();
      const read = snapshots.readStoredChatSnapshot;
      const settled = createDeferred();
      vi.spyOn(snapshots, "readStoredChatSnapshot").mockImplementationOnce(async (cacheKey) => {
        const snapshot = await read(cacheKey);
        settled.resolve();
        return snapshot;
      });
      const open = vi.spyOn(indexedDB, "open");
      prewarmChatSnapshot(key);
      await settled.promise;
      const latest = { ...stored, deltaCursor: "latest-cursor" };
      if (change === "write") {
        writer.write(key, latest);
        await writer.flush();
      } else {
        writer.forget(key);
      }
      open.mockClear();
      expect(await writer.read(key)).toEqual(change === "write" ? latest : stored);
      expect(open).toHaveBeenCalledOnce();
    },
  );

  it.each(["session", "all"] as const)(
    "fences a consumed pending read on %s invalidation",
    async (scope) => {
      await seed();
      const open = database.openSessionSnapshotDatabase;
      const opened = createDeferred<IDBDatabase | null>();
      vi.spyOn(database, "openSessionSnapshotDatabase").mockReturnValueOnce(opened.promise);
      prewarmChatSnapshot(key);
      await vi.dynamicImportSettled();
      const reader = new snapshots.SessionSnapshotStore();
      reader.connect();
      try {
        const reading = reader.read(key);
        await publishSnapshotInvalidation(scope === "session" ? { sessionKey: key } : {});
        opened.resolve(await open());
        expect(await reading).toBeNull();
      } finally {
        reader.disconnect();
        await reader.whenIdle();
      }
    },
  );
});
