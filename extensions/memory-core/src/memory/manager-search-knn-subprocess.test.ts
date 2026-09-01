import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVectorKnnInSubprocess } from "./manager-search-knn-subprocess.js";
import type { VectorKnnRequest } from "./manager-search-knn.js";
import { searchVector } from "./manager-search.js";
import { buildMemorySourceFilter } from "./source-filter.js";
import { vectorToBlob } from "./vector-blob.js";

const fixtureChildUrl = new URL("./fixtures/manager-search-knn-child.fixture.mjs", import.meta.url);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
beforeEach(() => {
  vi.mocked(childProcess.spawn).mockReset().mockImplementation(spawn);
});

function useFixtureChild() {
  const children: childProcess.ChildProcessWithoutNullStreams[] = [];
  const ready: Promise<unknown[]>[] = [];
  vi.mocked(childProcess.spawn).mockImplementation((_command, _args, options) => {
    const child = spawn(process.execPath, [fileURLToPath(fixtureChildUrl)], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    ready.push(once(child.stderr, "data"));
    return child;
  });
  return { children, ready };
}

function request(limit: number): VectorKnnRequest {
  return {
    vectorTable: "memory_index_chunks_vec",
    providerModels: ["test-model"],
    queryVec: [1, 0],
    limit,
    snippetMaxChars: 700,
    sourceFilter: { sql: "", params: [] },
  };
}

function insertVectorRow(
  db: DatabaseSync,
  params: {
    id: string;
    source: "memory" | "sessions";
    vector: [number, number];
    text?: string;
  },
): void {
  db.prepare(
    "INSERT INTO memory_index_chunks (id, path, start_line, end_line, text, source, model) VALUES (?, ?, 1, 1, ?, ?, ?)",
  ).run(
    params.id,
    `${params.source}/${params.id}.md`,
    params.text ?? `text ${params.id}`,
    params.source,
    "test-model",
  );
  db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
    params.id,
    vectorToBlob(params.vector),
  );
}

async function createFileBackedVectorDatabase(): Promise<{
  db: DatabaseSync;
  databasePath: string;
  cleanup: () => void;
}> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-knn-"));
  const databasePath = path.join(directory, "memory.sqlite");
  const db = openNodeSqliteDatabase(databasePath, { allowExtension: true });
  try {
    const loaded = await loadSqliteVecExtension({ db });
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "sqlite-vec unavailable in test");
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[2]
      );
    `);
    return {
      db,
      databasePath,
      cleanup: () => {
        db.close();
        fs.rmSync(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    db.close();
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory vector KNN subprocess boundary", () => {
  it("keeps the parent event loop responsive during synchronous child work", async () => {
    const fixture = useFixtureChild();
    let childFinished = false;
    const resultPromise = runVectorKnnInSubprocess({
      databasePath: "fixture:ok",
      request: request(250),
    }).finally(() => {
      childFinished = true;
    });
    await vi.waitFor(() => expect(fixture.ready).toHaveLength(1));
    await fixture.ready[0];
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(childFinished).toBe(false);
    await expect(resultPromise).resolves.toEqual({ rows: [], fallbackScanRequired: false });
  });

  it("hard-kills and reaps a busy child on caller abort, then admits another query", async () => {
    const fixture = useFixtureChild();
    const controller = new AbortController();
    const result = runVectorKnnInSubprocess({
      databasePath: "fixture:ok",
      request: request(30_000),
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("test KNN deadline");
    await vi.waitFor(() => expect(fixture.ready).toHaveLength(1));
    await fixture.ready[0];
    const closed = once(fixture.children[0]!, "close");
    controller.abort(new Error("test KNN deadline"));
    await rejected;
    expect(await closed).toEqual([null, "SIGKILL"]);
    await expect(
      runVectorKnnInSubprocess({ databasePath: "fixture:ok", request: request(1) }),
    ).resolves.toEqual({ rows: [], fallbackScanRequired: false });
  });

  it("retains both admission slots after cleanup timeout until children close", async () => {
    const fixture = useFixtureChild();
    const controller = new AbortController();
    const results = [0, 1].map(() =>
      runVectorKnnInSubprocess({
        databasePath: "fixture:ok",
        request: request(30_000),
        signal: controller.signal,
      }),
    );
    const rejected = results.map((result) =>
      expect(result).rejects.toMatchObject({ code: "termination-timeout" }),
    );
    await vi.waitFor(() => expect(fixture.children).toHaveLength(2));
    await Promise.all(fixture.ready);
    const realKills = fixture.children.map((child) => child.kill.bind(child));
    const closed = fixture.children.map((child) => once(child, "close"));
    const killMocks = fixture.children.map((child) =>
      vi.spyOn(child, "kill").mockReturnValue(false),
    );
    try {
      controller.abort(new Error("terminal cleanup test"));
      await Promise.all(rejected);
      const queuedController = new AbortController();
      const queued = runVectorKnnInSubprocess({
        databasePath: "fixture:ok",
        request: request(1),
        signal: queuedController.signal,
      });
      const queuedRejection = expect(queued).rejects.toThrow("queued KNN deadline");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(fixture.children).toHaveLength(2);
      queuedController.abort(new Error("queued KNN deadline"));
      await queuedRejection;
    } finally {
      killMocks.forEach((mock) => mock.mockRestore());
      realKills.forEach((kill) => kill("SIGKILL"));
      await Promise.all(closed);
    }
    await expect(
      runVectorKnnInSubprocess({ databasePath: "fixture:ok", request: request(1) }),
    ).resolves.toEqual({ rows: [], fallbackScanRequired: false });
  });

  it("queries the real source child across WAL writer visibility and source filters", async () => {
    const fixture = await createFileBackedVectorDatabase();
    try {
      insertVectorRow(fixture.db, { id: "committed", source: "memory", vector: [1, 0] });
      fixture.db.exec("BEGIN IMMEDIATE");
      insertVectorRow(fixture.db, { id: "pending", source: "sessions", vector: [0.9, 0.1] });

      const memoryResult = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(2),
          sourceFilter: buildMemorySourceFilter("c", ["memory"]),
        },
      });
      expect(memoryResult.rows.map((row) => row.id)).toEqual(["committed"]);

      const beforeCommit = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(2),
          sourceFilter: buildMemorySourceFilter("c", ["sessions"]),
        },
      });
      expect(beforeCommit.rows).toEqual([]);

      fixture.db.exec("COMMIT");
      const afterCommit = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(2),
          sourceFilter: buildMemorySourceFilter("c", ["sessions"]),
        },
      });
      expect(afterCommit.rows.map((row) => row.id)).toEqual(["pending"]);
      expect(fixture.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
    } finally {
      try {
        fixture.db.exec("ROLLBACK");
      } catch {}
      fixture.cleanup();
    }
  });

  it("bounds an oversized stored row before child protocol serialization", async () => {
    const fixture = await createFileBackedVectorDatabase();
    try {
      const oversizedText = `${"x".repeat(63)}😀${"y".repeat(3 * 1024 * 1024)}`;
      insertVectorRow(fixture.db, {
        id: "oversized",
        source: "memory",
        vector: [1, 0],
        text: oversizedText,
      });

      const result = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(1),
          snippetMaxChars: 64,
        },
      });

      expect(result).toMatchObject({
        fallbackScanRequired: false,
        rows: [{ id: "oversized", text: "x".repeat(63) }],
      });
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(2 * 1024 * 1024);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed on malformed output, oversized output, and early exit", async () => {
    useFixtureChild();
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:malformed",
        request: request(1),
      }),
    ).rejects.toThrow("malformed JSON");
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:oversized",
        request: request(1),
      }),
    ).rejects.toThrow("stdout exceeded its limit");
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:early-exit",
        request: request(1),
      }),
    ).rejects.toThrow(
      "exited before returning a result (code 7, signal none): fixture KNN failure",
    );
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:oversized-stderr",
        request: request(1),
      }),
    ).rejects.toMatchObject({
      code: "protocol",
      message: "memory vector KNN child stderr exceeded its limit",
    });
  });

  it("fails vector recall closed when the subprocess is unavailable", async () => {
    const prepare = vi.fn(() => {
      throw new Error("same-thread SQLite must not run");
    });
    await expect(
      searchVector({
        db: { prepare } as unknown as DatabaseSync,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "test-model",
        queryVec: [1, 0],
        limit: 1,
        snippetMaxChars: 200,
        ensureVectorReady: async () => true,
        runVectorKnn: async () => {
          throw new Error("subprocess unavailable");
        },
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      }),
    ).rejects.toThrow("subprocess unavailable");
    expect(prepare).not.toHaveBeenCalled();
  });
});
