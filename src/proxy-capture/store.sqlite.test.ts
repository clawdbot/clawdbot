// Proxy capture SQLite store tests cover persisted capture reads and writes.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  acquireDebugProxyCaptureStore,
  closeDebugProxyCaptureStore,
  DebugProxyCaptureStore,
  getDebugProxyCaptureStore,
  persistEventPayload,
} from "./store.sqlite.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  closeDebugProxyCaptureStore();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  cleanupTempDirs(cleanupDirs);
});

function makeStore() {
  const root = makeTempDir(cleanupDirs, "openclaw-proxy-capture-");
  return new DebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } });
}

function makeStateEnv(prefix: string): NodeJS.ProcessEnv {
  const root = makeTempDir(cleanupDirs, prefix);
  return { OPENCLAW_STATE_DIR: root };
}

function readMode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe("DebugProxyCaptureStore", () => {
  it("keeps the cached store open until the last lease releases", () => {
    const options = { env: makeStateEnv("openclaw-proxy-capture-lease-") };

    const first = acquireDebugProxyCaptureStore(options);
    const second = acquireDebugProxyCaptureStore(options);

    expect(second.store).toBe(first.store);
    first.release();
    expect(first.store.isClosed).toBe(false);

    second.release();
    expect(first.store.isClosed).toBe(true);

    const reopened = getDebugProxyCaptureStore(options);
    expect(Object.is(reopened, first.store)).toBe(false);
    expect(reopened.isClosed).toBe(false);
  });

  it("rebinds a cached shared store after the state database closes underneath it", () => {
    const options = { env: makeStateEnv("openclaw-proxy-capture-rebind-") };
    const stale = getDebugProxyCaptureStore(options);
    stale.upsertSession({
      id: "exit-session",
      startedAt: 1,
      mode: "proxy-run",
      sourceScope: "openclaw",
      sourceProcess: "cli",
    });

    // Exit-time hook closes the shared handle out from under the cached store;
    // finalizeDebugProxyCapture then re-fetches and must not get a dead handle.
    closeOpenClawStateDatabaseForTest();
    expect(stale.isClosed).toBe(true);

    const rebound = getDebugProxyCaptureStore(options);
    expect(Object.is(rebound, stale)).toBe(false);
    expect(() => rebound.endSession("exit-session")).not.toThrow();
  });

  it("tracks and closes cached stores independently across paths", () => {
    const first = acquireDebugProxyCaptureStore({
      env: makeStateEnv("openclaw-proxy-capture-first-"),
    });
    const second = acquireDebugProxyCaptureStore({
      env: makeStateEnv("openclaw-proxy-capture-second-"),
    });

    first.release();
    expect(first.store.isClosed).toBe(true);
    expect(second.store.isClosed).toBe(false);

    closeDebugProxyCaptureStore();
    expect(second.store.isClosed).toBe(true);
    second.release();
  });

  it("preserves the shipped path-based Plugin SDK overloads", () => {
    const root = makeTempDir(cleanupDirs, "openclaw-proxy-capture-legacy-sdk-");
    const dbPath = path.join(root, "capture.sqlite");
    const blobDir = path.join(root, "blobs");
    const lease = acquireDebugProxyCaptureStore(dbPath, blobDir);

    expect(getDebugProxyCaptureStore(dbPath, blobDir)).toBe(lease.store);
    lease.store.upsertSession({
      id: "legacy-sdk-session",
      startedAt: 1,
      mode: "sdk",
      sourceScope: "openclaw",
      sourceProcess: "plugin",
      dbPath,
      blobDir,
    });
    const blob = lease.store.persistPayload(Buffer.from("legacy sdk payload"), "text/plain");
    lease.store.recordEvent({
      sessionId: "legacy-sdk-session",
      ts: 2,
      sourceScope: "openclaw",
      sourceProcess: "plugin",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "legacy-sdk-flow",
      dataBlobId: blob.blobId,
      dataSha256: blob.sha256,
    });

    expect(lease.store.readBlob(blob.blobId)).toBe("legacy sdk payload");
    expect(blob.path).toBe(path.join(blobDir, `${blob.blobId}.bin.gz`));
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(blob.path)).toBe(true);
    expect(
      lease.store.db
        .prepare("SELECT db_path AS dbPath, blob_dir AS blobDir FROM capture_sessions WHERE id = ?")
        .get("legacy-sdk-session"),
    ).toEqual({ dbPath, blobDir });
    expect(
      lease.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_blobs'")
        .get(),
    ).toBeUndefined();
    expect(
      lease.store.db
        .prepare(
          `SELECT name, strict FROM pragma_table_list
           WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "capture_events", strict: 1 },
      { name: "capture_sessions", strict: 1 },
    ]);
    expect(lease.store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(lease.store.deleteSessions(["legacy-sdk-session"])).toEqual({
      sessions: 1,
      events: 1,
      blobs: 1,
    });
    expect(fs.existsSync(blob.path)).toBe(false);

    lease.release();
    expect(lease.store.isClosed).toBe(true);
  });

  it("uses rollback journaling for captures on NFS-backed volumes", () => {
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0x6969,
      bsize: 1024,
      blocks: 1,
      bfree: 1,
      bavail: 1,
      files: 0,
      frsize: 1024,
      ffree: 0,
    });

    const store = new DebugProxyCaptureStore({
      env: makeStateEnv("openclaw-proxy-capture-nfs-"),
    });
    try {
      expect(store.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "delete",
      });
    } finally {
      store.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "stores capture blobs in the private shared state database",
    () => {
      const env = makeStateEnv("openclaw-proxy-capture-permissions-");
      const root = env.OPENCLAW_STATE_DIR!;
      const store = new DebugProxyCaptureStore({ env });
      const blob = store.persistPayload(Buffer.from("authorization: Bearer secret"));
      const row = store.db
        .prepare(
          `SELECT encoding, size_bytes AS sizeBytes, sha256, data
           FROM capture_blobs
           WHERE blob_id = ?`,
        )
        .get(blob.blobId) as
        | { data: Uint8Array; encoding: string; sha256: string; sizeBytes: number }
        | undefined;

      expect(store.dbPath).toBe(path.join(root, "state", "openclaw.sqlite"));
      expect(fs.existsSync(path.join(root, "debug-proxy", "capture.sqlite"))).toBe(false);
      expect(fs.existsSync(path.join(root, "debug-proxy", "blobs"))).toBe(false);
      expect(row).toMatchObject({
        encoding: "gzip",
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
      });
      expect(Buffer.from(row?.data ?? []).toString("utf8")).not.toContain("Bearer secret");
      expect(readMode(path.dirname(store.dbPath))).toBe(0o700);
      for (const databaseFile of resolveSqliteDatabaseFilePaths(store.dbPath).filter(
        fs.existsSync,
      )) {
        expect(readMode(databaseFile)).toBe(0o600);
      }
    },
  );

  it("ignores duplicate close calls", () => {
    const store = makeStore();

    store.close();
    store.close();
    expect(store.isClosed).toBe(true);
  });

  it("stores sessions, blobs, and duplicate-send query results", () => {
    const store = makeStore();
    store.upsertSession({
      id: "session-1",
      startedAt: Date.now(),
      mode: "proxy-run",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
    });
    const firstPayload = persistEventPayload(store, {
      data: '{"ok":true}',
      contentType: "application/json",
    });
    store.recordEvent({
      sessionId: "session-1",
      ts: 1,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-1",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      ...firstPayload,
    });
    store.recordEvent({
      sessionId: "session-1",
      ts: 2,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-2",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      ...firstPayload,
    });

    expect(store.listSessions(10)).toHaveLength(1);
    const duplicateRows = store.queryPreset("double-sends", "session-1");
    expect(duplicateRows).toHaveLength(1);
    expect(duplicateRows[0]?.host).toBe("api.example.com");
    expect(duplicateRows[0]?.path).toBe("/v1/send");
    expect(duplicateRows[0]?.method).toBe("POST");
    expect(duplicateRows[0]?.duplicateCount).toBe(2);
    expect(store.readBlob(firstPayload.dataBlobId ?? "")).toContain('"ok":true');
  });

  it("keeps byte-limited UTF-8 previews on a complete character boundary", () => {
    const store = makeStore();
    const data = `${"x".repeat(8191)}étail`;

    const payload = persistEventPayload(store, { data });

    expect(payload.dataText).toBe("x".repeat(8191));
    expect(Buffer.byteLength(payload.dataText ?? "", "utf8")).toBeLessThanOrEqual(8192);
    expect(store.readBlob(payload.dataBlobId ?? "")).toBe(data);
  });

  it("creates and later upgrades an implicit session for direct event capture", () => {
    const store = makeStore();
    store.recordEvent({
      sessionId: "session-direct",
      ts: 20,
      sourceScope: "openclaw",
      sourceProcess: "provider",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-direct",
      dataBlobId: "already-purged",
    });

    expect(store.listSessions(10)[0]).toMatchObject({
      id: "session-direct",
      mode: "implicit",
    });
    expect(store.getSessionEvents("session-direct", 10)[0]).toMatchObject({
      dataBlobId: null,
    });

    store.upsertSession({
      id: "session-direct",
      startedAt: 10,
      mode: "runtime",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
    });

    expect(store.listSessions(10)[0]).toMatchObject({
      id: "session-direct",
      mode: "runtime",
      startedAt: 10,
    });
  });

  it("keeps shared blobs when deleting one of multiple referencing sessions", () => {
    const store = makeStore();
    const sharedPayload = persistEventPayload(store, {
      data: '{"shared":true}',
      contentType: "application/json",
    });

    for (const sessionId of ["session-a", "session-b"]) {
      store.upsertSession({
        id: sessionId,
        startedAt: Date.now(),
        mode: "proxy-run",
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
      });
      store.recordEvent({
        sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
        protocol: "https",
        direction: "outbound",
        kind: "request",
        flowId: `flow-${sessionId}`,
        method: "POST",
        host: "api.example.com",
        path: "/v1/shared",
        ...sharedPayload,
      });
    }

    const result = store.deleteSessions(["session-a"]);

    expect(result.sessions).toBe(1);
    expect(result.events).toBe(1);
    expect(result.blobs).toBe(0);
    expect(store.readBlob(sharedPayload.dataBlobId ?? "")).toContain('"shared":true');
    expect(store.listSessions(10).map((session) => session.id)).toEqual(["session-b"]);

    expect(store.deleteSessions(["session-b"])).toEqual({
      sessions: 1,
      events: 1,
      blobs: 1,
    });
    expect(store.readBlob(sharedPayload.dataBlobId ?? "")).toBeNull();
  });
});
