import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-"));
  cleanupDirs.push(root);
  return new DebugProxyCaptureStore(path.join(root, "capture.sqlite"), path.join(root, "blobs"));
}

describe("DebugProxyCaptureStore", () => {
  it("keeps the cached store open until the last lease releases", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-lease-"));
    cleanupDirs.push(root);
    const dbPath = path.join(root, "capture.sqlite");
    const blobDir = path.join(root, "blobs");

    const first = acquireDebugProxyCaptureStore(dbPath, blobDir);
    const second = acquireDebugProxyCaptureStore(dbPath, blobDir);

    expect(second.store).toBe(first.store);
    first.release();
    expect(first.store.isClosed).toBe(false);

    second.release();
    expect(first.store.isClosed).toBe(true);

    const reopened = getDebugProxyCaptureStore(dbPath, blobDir);
    expect(Object.is(reopened, first.store)).toBe(false);
    expect(reopened.isClosed).toBe(false);
  });

  it("ignores duplicate close calls", () => {
    const store = makeStore();

    store.close();
    expect(() => store.close()).not.toThrow();
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
      dbPath: store.dbPath,
      blobDir: store.blobDir,
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
    expect(store.queryPreset("double-sends", "session-1")).toEqual([
      expect.objectContaining({
        host: "api.example.com",
        path: "/v1/send",
        method: "POST",
        duplicateCount: 2,
      }),
    ]);
    expect(store.readBlob(firstPayload.dataBlobId ?? "")).toContain('"ok":true');
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
        dbPath: store.dbPath,
        blobDir: store.blobDir,
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
  });
});
