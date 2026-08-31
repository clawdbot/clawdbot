// Qa Matrix tests cover persisted runtime state probes.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import {
  deleteMatrixSyncStoreCursor,
  waitForMatrixInboundDedupeEntry,
  waitForMatrixSyncStoreWithCursor,
} from "./scenario-runtime-state-files.js";

describe("Matrix QA persisted state probes", () => {
  const tempDirs: string[] = [];
  const identity = { accountId: "target", userId: "@target:matrix-qa.test" };
  const context = createMatrixQaE2eeTestContext({
    sutAccountId: identity.accountId,
    sutUserId: identity.userId,
  });

  function openStore(root: string, namespace: string) {
    return createPluginStateSyncKeyedStoreForTests<unknown>("matrix", {
      namespace,
      maxEntries: 20,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
  }

  async function createStateDir() {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-sync-"));
    tempDirs.push(stateDir);
    return stateDir;
  }

  async function seedSyncStore(params: {
    root: string;
    metadata: typeof identity;
    source: "json" | "sqlite";
    legacyMetadata?: boolean;
    cursor: string;
  }) {
    await mkdir(params.root, { recursive: true });
    if (params.legacyMetadata) {
      await writeFile(path.join(params.root, "storage-meta.json"), JSON.stringify(params.metadata));
    } else {
      openStore(params.root, "storage-meta").register("current", params.metadata);
    }
    const savedSync = { nextBatch: params.cursor, accountData: [], roomsData: {} };
    if (params.source === "json") {
      await writeFile(path.join(params.root, "bot-storage.json"), JSON.stringify({ savedSync }));
      return;
    }
    // These are the persisted sync-cache rows produced by the Matrix store;
    // real plugin-state writes exercise account-local SQLite discovery.
    const data = JSON.stringify(savedSync);
    const store = openStore(params.root, "sync-cache");
    store.register("current:sync:fixture:0", { kind: "sync-chunk", index: 0, data });
    store.register("current:meta", {
      kind: "meta",
      version: 1,
      generation: "fixture",
      chunkCount: 1,
      syncDigest: createHash("sha256").update(data).digest("hex"),
    });
  }

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it.each(["accountId", "userId"] as const)(
    "selects the requested SQLite identity and preserves unrelated state when %s differs",
    async (field) => {
      const stateDir = await createStateDir();
      const other = path.join(stateDir, "matrix", "accounts", "aa-other");
      const target = path.join(stateDir, "matrix", "accounts", "zz-target");
      await seedSyncStore({
        root: other,
        metadata: { ...identity, [field]: "other" },
        source: "sqlite",
        cursor: "other-cursor",
      });
      await seedSyncStore({
        root: target,
        metadata: identity,
        source: "sqlite",
        cursor: "target-cursor",
      });
      for (const root of [other, target]) {
        openStore(root, "idb-snapshot").register("crypto-sentinel", { preserved: root });
      }
      resetPluginStateStoreForTests();

      const selected = await waitForMatrixSyncStoreWithCursor({
        context: createMatrixQaE2eeTestContext(),
        ...identity,
        stateDir,
        timeoutMs: 1_000,
      });
      expect(selected).toMatchObject({
        pathname: path.join(target, "state", "openclaw.sqlite"),
        cursor: "target-cursor",
        source: "sqlite",
      });
      const unrelatedSyncRows = openStore(other, "sync-cache").entries();
      await deleteMatrixSyncStoreCursor(selected);
      expect(openStore(target, "sync-cache").entries()).toEqual([]);
      expect(openStore(other, "sync-cache").entries()).toEqual(unrelatedSyncRows);
      for (const root of [other, target]) {
        expect(openStore(root, "idb-snapshot").lookup("crypto-sentinel")).toEqual({
          preserved: root,
        });
      }
    },
  );

  it.each(["json", "sqlite"] as const)(
    "waits instead of returning another account's %s cursor",
    async (source) => {
      const stateDir = await createStateDir();
      await seedSyncStore({
        root: path.join(stateDir, "matrix", "accounts", "other"),
        metadata: { ...identity, accountId: "other" },
        source,
        legacyMetadata: source === "json",
        cursor: "other-cursor",
      });
      await expect(
        waitForMatrixSyncStoreWithCursor({ context, stateDir, timeoutMs: 20 }),
      ).rejects.toThrow("timed out waiting for Matrix sync store cursor");
    },
  );

  it.each(["json", "sqlite"] as const)(
    "does not let stale JSON metadata override a canonical mismatch for a %s cursor",
    async (source) => {
      const stateDir = await createStateDir();
      const root = path.join(stateDir, "matrix", "accounts", "other");
      await seedSyncStore({
        root,
        metadata: { ...identity, userId: "@other:matrix-qa.test" },
        source,
        cursor: "other-cursor",
      });
      await writeFile(path.join(root, "storage-meta.json"), JSON.stringify(identity));
      await expect(
        waitForMatrixSyncStoreWithCursor({ context, stateDir, timeoutMs: 20 }),
      ).rejects.toThrow("timed out waiting for Matrix sync store cursor");
    },
  );

  it.each(["json", "sqlite"] as const)(
    "recognizes matching pre-doctor metadata for a %s cursor",
    async (source) => {
      const stateDir = await createStateDir();
      await seedSyncStore({
        root: path.join(stateDir, "matrix", "accounts", "target"),
        metadata: identity,
        source,
        legacyMetadata: true,
        cursor: "legacy-cursor",
      });
      await expect(
        waitForMatrixSyncStoreWithCursor({ context, stateDir, timeoutMs: 1_000 }),
      ).resolves.toMatchObject({ cursor: "legacy-cursor", source });
    },
  );

  it("observes inbound dedupe entries committed through the core claimable dedupe", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-dedupe-"));
    tempDirs.push(stateDir);
    const accountRoot = path.join(stateDir, "matrix", "accounts", "sut", "server", "token");
    const eventId = "$event";
    const roomId = "!room:matrix-qa.test";
    // Mirrors the matrix monitor's guard configuration so the probe is proven
    // against the exact persisted row shape the runtime writes, including the
    // account-scoped key the probe must match by suffix.
    const guard = createClaimableDedupe({
      pluginId: "matrix",
      namespacePrefix: "matrix.inbound-dedupe",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      stateMaxEntries: 100,
      env: { ...process.env, OPENCLAW_STATE_DIR: accountRoot },
    });
    const key = `runtime-default\0${roomId}\0${eventId}`;
    await guard.claim(key);
    await guard.commit(key);
    resetPluginStateStoreForTests();

    await expect(
      waitForMatrixInboundDedupeEntry({
        eventId,
        roomId,
        stateDir,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(path.join(accountRoot, "state", "openclaw.sqlite"));
  });
});
