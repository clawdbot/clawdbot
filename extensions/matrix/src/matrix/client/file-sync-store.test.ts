// Matrix tests cover sync cache plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  openMatrixSyncCacheStoreOptions,
  SqliteBackedMatrixSyncStore,
  type MatrixSyncCacheRecord,
} from "./file-sync-store.js";

function createSyncResponse(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        "!room:example.org": {
          summary: {
            "m.heroes": [],
          },
          state: { events: [] },
          timeline: {
            events: [
              {
                content: {
                  body: "hello",
                  msgtype: "m.text",
                },
                event_id: "$message",
                origin_server_ts: 1,
                sender: "@user:example.org",
                type: "m.room.message",
              },
            ],
            prev_batch: "t0",
          },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
      invite: {},
      leave: {},
      knock: {},
    },
    account_data: {
      events: [
        {
          content: { theme: "dark" },
          type: "com.openclaw.test",
        },
      ],
    },
  };
}

describe("SqliteBackedMatrixSyncStore", () => {
  const tempDirs: string[] = [];

  function createStorageRoot(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    return tempDir;
  }

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    resetPluginStateStoreForTests();
  });

  it("persists sync data so restart resumes from the saved cursor", async () => {
    const storageRoot = createStorageRoot();
    const syncResponse = createSyncResponse("s123");

    const firstStore = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(firstStore.hasSavedSync()).toBe(false);
    await firstStore.setSyncData(syncResponse);
    await firstStore.flush();
    expect(fs.existsSync(path.join(storageRoot, "bot-storage.json"))).toBe(false);

    const secondStore = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(secondStore.hasSavedSync()).toBe(true);
    await expect(secondStore.getSavedSyncToken()).resolves.toBe("s123");

    const savedSync = await secondStore.getSavedSync();
    expect(savedSync).toEqual({
      nextBatch: "s123",
      accountData: syncResponse.account_data.events,
      roomsData: {
        join: {
          "!room:example.org": {
            summary: {
              "m.heroes": [],
            },
            state: { events: [] },
            "org.matrix.msc4222.state_after": { events: [] },
            timeline: {
              events: [
                {
                  content: {
                    body: "hello",
                    msgtype: "m.text",
                  },
                  event_id: "$message",
                  origin_server_ts: 1,
                  sender: "@user:example.org",
                  type: "m.room.message",
                },
              ],
              prev_batch: "t0",
            },
            ephemeral: { events: [] },
            account_data: { events: [] },
            unread_notifications: {},
          },
        },
        invite: {},
        leave: {},
        knock: {},
      },
    });
    expect(secondStore.hasSavedSyncFromCleanShutdown()).toBe(false);
  });

  it("restores the sync cache after the storage root moves", async () => {
    const storageRoot = createStorageRoot();
    const movedStorageRoot = `${storageRoot}-moved`;

    const firstStore = new SqliteBackedMatrixSyncStore(storageRoot);
    await firstStore.setSyncData(createSyncResponse("portable-token"));
    await firstStore.flush();
    resetPluginStateStoreForTests();
    fs.renameSync(storageRoot, movedStorageRoot);
    tempDirs.push(movedStorageRoot);

    const secondStore = new SqliteBackedMatrixSyncStore(movedStorageRoot);
    expect(secondStore.hasSavedSync()).toBe(true);
    await expect(secondStore.getSavedSyncToken()).resolves.toBe("portable-token");
  });

  it("ignores metadata with impossible chunk counts", async () => {
    const storageRoot = createStorageRoot();
    const store = createPluginStateSyncKeyedStoreForTests<MatrixSyncCacheRecord>(
      "matrix",
      openMatrixSyncCacheStoreOptions(storageRoot),
    );
    store.register("current:meta", {
      kind: "meta",
      version: 1,
      generation: "corrupt",
      chunkCount: 20_000,
      cleanShutdown: true,
    });

    const syncStore = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(syncStore.hasSavedSync()).toBe(false);
    await expect(syncStore.getSavedSyncToken()).resolves.toBe(null);
  });

  it("fails persistence instead of silently dropping sync data when sqlite is unavailable", async () => {
    const storageRoot = createStorageRoot();
    const runtime = getMatrixRuntime();
    vi.spyOn(runtime.state, "openSyncKeyedStore").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    const syncStore = new SqliteBackedMatrixSyncStore(storageRoot);
    await syncStore.setSyncData(createSyncResponse("unavailable-token"));

    await expect(syncStore.flush()).rejects.toThrow(/sqlite store is unavailable/i);
  });

  it("claims current-token storage ownership when sync state is persisted", async () => {
    const storageRoot = createStorageRoot();
    fs.writeFileSync(
      path.join(storageRoot, "storage-meta.json"),
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accountId: "default",
        accessTokenHash: "token-hash",
        deviceId: null,
      }),
      "utf8",
    );

    const store = new SqliteBackedMatrixSyncStore(storageRoot);
    await store.setSyncData(createSyncResponse("claimed-token"));
    await store.flush();

    const meta = JSON.parse(
      fs.readFileSync(path.join(storageRoot, "storage-meta.json"), "utf8"),
    ) as { currentTokenStateClaimed?: boolean };
    expect(meta.currentTokenStateClaimed).toBe(true);
  });

  it("only treats sync state as restart-safe after a clean shutdown persist", async () => {
    const storageRoot = createStorageRoot();

    const firstStore = new SqliteBackedMatrixSyncStore(storageRoot);
    await firstStore.setSyncData(createSyncResponse("s123"));
    await firstStore.flush();

    const afterDirtyPersist = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(afterDirtyPersist.hasSavedSync()).toBe(true);
    expect(afterDirtyPersist.hasSavedSyncFromCleanShutdown()).toBe(false);

    firstStore.markCleanShutdown();
    await firstStore.flush();

    const afterCleanShutdown = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(afterCleanShutdown.hasSavedSync()).toBe(true);
    expect(afterCleanShutdown.hasSavedSyncFromCleanShutdown()).toBe(true);
  });

  it("clears the clean-shutdown marker once fresh sync data arrives", async () => {
    const storageRoot = createStorageRoot();

    const firstStore = new SqliteBackedMatrixSyncStore(storageRoot);
    await firstStore.setSyncData(createSyncResponse("s123"));
    firstStore.markCleanShutdown();
    await firstStore.flush();

    const restartedStore = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(restartedStore.hasSavedSyncFromCleanShutdown()).toBe(true);

    await restartedStore.setSyncData(createSyncResponse("s456"));
    await restartedStore.flush();

    const afterNewSync = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(afterNewSync.hasSavedSync()).toBe(true);
    expect(afterNewSync.hasSavedSyncFromCleanShutdown()).toBe(false);
    await expect(afterNewSync.getSavedSyncToken()).resolves.toBe("s456");
  });

  it("coalesces background persistence until the debounce window elapses", async () => {
    vi.useFakeTimers();
    const storageRoot = createStorageRoot();

    const store = new SqliteBackedMatrixSyncStore(storageRoot);
    await store.setSyncData(createSyncResponse("s111"));
    await store.setSyncData(createSyncResponse("s222"));
    await store.storeClientOptions({ lazyLoadMembers: true });

    const beforeDebounce = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(beforeDebounce.hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(249);
    const beforeElapsed = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(beforeElapsed.hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await store.flush();

    const persisted = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(persisted.hasSavedSync()).toBe(true);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("s222");
    await expect(persisted.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });

  it("persists client options alongside sync state", async () => {
    const storageRoot = createStorageRoot();

    const firstStore = new SqliteBackedMatrixSyncStore(storageRoot);
    await firstStore.storeClientOptions({ lazyLoadMembers: true });
    await firstStore.flush();

    const secondStore = new SqliteBackedMatrixSyncStore(storageRoot);
    await expect(secondStore.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });

  it("ignores legacy raw sync cache files", async () => {
    const storageRoot = createStorageRoot();

    fs.writeFileSync(
      path.join(storageRoot, "bot-storage.json"),
      JSON.stringify({
        next_batch: "legacy-token",
        rooms: {
          join: {},
        },
        account_data: {
          events: [],
        },
      }),
      "utf8",
    );

    const store = new SqliteBackedMatrixSyncStore(storageRoot);
    expect(store.hasSavedSync()).toBe(false);
    await expect(store.getSavedSyncToken()).resolves.toBe(null);
  });
});
