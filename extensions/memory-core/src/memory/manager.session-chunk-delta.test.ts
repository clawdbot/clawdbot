// Memory Core tests cover incremental session chunk-delta sync behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./manager.js";

// Real sqlite indexing; avoid flaking when sharing a packed CI shard.
vi.setConfig({ testTimeout: 240_000 });

afterAll(() => {
  vi.resetConfig();
});

const embedState = vi.hoisted(() => ({
  batches: [] as string[][],
  failNextBatch: false,
  noProvider: false,
}));

vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderFallbackModel: (_providerId: string, fallbackSourceModel: string) =>
    fallbackSourceModel,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async () =>
    embedState.noProvider
      ? {
          provider: null,
          requestedProvider: "auto",
          providerUnavailableReason: "No API key found for provider",
        }
      : {
          requestedProvider: "openai",
          provider: {
            id: "mock",
            model: "mock-embed",
            maxInputTokens: 8192,
            embedQuery: async () => [1, 0, 0],
            embedBatch: async (texts: string[]) => {
              if (embedState.failNextBatch) {
                embedState.failNextBatch = false;
                throw new Error("mock embeddings unavailable");
              }
              embedState.batches.push([...texts]);
              return texts.map(() => [1, 0, 0]);
            },
          },
        },
}));

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

type ChunkRow = {
  id: string;
  start_line: number;
  end_line: number;
  text: string;
  updated_at: number;
};

function sessionMessageLine(
  role: "user" | "assistant",
  text: string,
  senderIsOwner = false,
): string {
  return JSON.stringify({
    type: "message",
    message: {
      role,
      timestamp: "2026-07-01T10:00:00.000Z",
      content: [{ type: "text", text }],
      ...(role === "user" && senderIsOwner ? { __openclaw: { senderIsOwner: true } } : {}),
    },
  });
}

function transcriptTurns(from: number, to: number, senderIsOwner = false): string {
  const lines: string[] = [];
  for (let turn = from; turn <= to; turn += 1) {
    const id = String(turn).padStart(3, "0");
    lines.push(sessionMessageLine("user", `turn ${id} question about topic-${id}`, senderIsOwner));
    lines.push(sessionMessageLine("assistant", `turn ${id} answer covering topic-${id}`));
  }
  return lines.join("\n") + "\n";
}

describe("memory session chunk-delta sync", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-delta-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    managersForCleanup.clear();
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    embedState.batches = [];
    embedState.failNextBatch = false;
    embedState.noProvider = false;
    clearRuntimeConfigSnapshot();
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
  });

  function createCfg(): Parameters<typeof getMemorySearchManager>[0]["cfg"] {
    return {
      plugins: { enabled: false },
      memory: {
        search: {
          provider: embedState.noProvider ? "auto" : "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          // Hybrid enables FTS so the tests exercise chunk/FTS row parity.
          query: { minScore: 0 },
          // Keep the embedding cache out of the way so embedBatch calls
          // measure exactly which chunks the sync re-embeds.
          cache: { enabled: false },
          sources: ["sessions"],
          experimental: { sessionMemory: true },
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  async function setUpManager(stateDirName: string): Promise<{
    manager: MemoryIndexManager;
    sessionFile: string;
  }> {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(fixtureRoot, stateDirName));
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(
      sessionsDir,
      "session-delta.jsonl.reset.2026-07-01T10-00-00.000Z",
    );
    const cfg = createCfg();
    setRuntimeConfigSnapshot(cfg, cfg);
    const result = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "cli",
    });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managersForCleanup.add(manager);
    return { manager, sessionFile };
  }

  function markSessionDirty(manager: MemoryIndexManager, sessionFile: string): void {
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = true;
    (manager as unknown as { sessionsDirtyFiles: Set<string> }).sessionsDirtyFiles.add(sessionFile);
  }

  function readSessionChunkRows(manager: MemoryIndexManager): ChunkRow[] {
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    };
    return db
      .prepare(
        `SELECT id, start_line, end_line, text, updated_at FROM memory_index_chunks
         WHERE source = 'sessions' ORDER BY start_line, id`,
      )
      .all() as ChunkRow[];
  }

  function readFtsRowCount(manager: MemoryIndexManager): number | null {
    if (!(manager.status().fts?.available ?? false)) {
      return null;
    }
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    };
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM memory_index_chunks_fts WHERE source = 'sessions'`)
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  async function createCliManager(): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({
      cfg: createCfg(),
      agentId: "main",
      purpose: "cli",
    });
    if (!result.manager) {
      throw new Error("CLI manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managersForCleanup.add(manager);
    return manager;
  }

  it("re-embeds only appended chunks and leaves unchanged rows untouched", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-append");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const before = readSessionChunkRows(manager);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const firstChunkText = before[0]?.text ?? "";

    embedState.batches = [];
    await fs.appendFile(sessionFile, transcriptTurns(31, 34), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    expect(after.length).toBeGreaterThanOrEqual(before.length);

    // The append only re-embeds trailing/new chunks, never the whole file.
    const embedded = embedState.batches.flat();
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.length).toBeLessThan(after.length);
    expect(embedded).not.toContain(firstChunkText);

    // Unchanged rows keep their identity and updated_at (no delete-reinsert).
    const afterById = new Map(after.map((row) => [row.id, row]));
    const preserved = before.filter((row) => afterById.get(row.id)?.updated_at === row.updated_at);
    expect(preserved.length).toBeGreaterThanOrEqual(before.length - 2);

    // Appended content is indexed and FTS stays in lockstep with chunk rows.
    expect(after.some((row) => row.text.includes("topic-034"))).toBe(true);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(after.length);
    }
  });

  it("refreshes provenance when retained session text changes trust classification", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-provenance");
    const text = "sender trust rewrite keeps this rendered text identical";
    await fs.writeFile(sessionFile, `${sessionMessageLine("user", text, true)}\n`, "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const before = readSessionChunkRows(manager);
    expect(before).toHaveLength(1);
    await expect(manager.search(text, { maxResults: 1, minScore: 0 })).resolves.toMatchObject([
      {
        provenance: {
          originClass: "owner",
          sessionKind: "unknown",
          observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
        },
      },
    ]);

    embedState.batches = [];
    // senderIsOwner is provenance-only input: rendered text, chunk hashes, and
    // chunk ids remain unchanged while the source hash becomes dirty.
    await fs.writeFile(sessionFile, `${sessionMessageLine("user", text)}\n`, "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    expect(readSessionChunkRows(manager)).toStrictEqual(before);
    expect(embedState.batches).toEqual([]);
    await expect(manager.search(text, { maxResults: 1, minScore: 0 })).resolves.toMatchObject([
      {
        provenance: {
          originClass: "untrusted",
          sessionKind: "unknown",
          observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
        },
      },
    ]);
  });

  it("heals derived-row drift written through a second manager", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-shared-index");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    if (!(manager.status().fts?.available ?? false)) {
      return;
    }

    const before = readSessionChunkRows(manager);
    const removedId = before[0]?.id;
    const otherManager = await createCliManager();
    const otherDb = Reflect.get(otherManager, "db") as {
      prepare: (sql: string) => { run: (...params: unknown[]) => void };
    };
    otherDb.prepare(`DELETE FROM memory_index_chunks_fts WHERE id = ?`).run(removedId);
    expect(readFtsRowCount(manager)).toBe(before.length - 1);

    await fs.appendFile(sessionFile, transcriptTurns(31, 32), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    // Managers in the gateway and CLI share one SQLite index. Every delta plan
    // must therefore re-probe derived-row parity before preserving chunk rows.
    expect(readFtsRowCount(manager)).toBe(after.length);
    expect(after.some((row) => row.id === removedId)).toBe(true);
  });

  it("falls back to a clean rebuild when the transcript is compacted", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-compact");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    expect(readSessionChunkRows(manager).length).toBeGreaterThanOrEqual(2);

    // Compaction rewrites the transcript: old turns collapse into a summary.
    const compacted =
      sessionMessageLine("assistant", "compaction summary replacing earlier turns") +
      "\n" +
      transcriptTurns(29, 32);
    await fs.writeFile(sessionFile, compacted, "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    expect(after.length).toBeGreaterThan(0);
    // No stale rows survive from the pre-compaction transcript.
    expect(after.some((row) => row.text.includes("topic-005"))).toBe(false);
    expect(after.some((row) => row.text.includes("compaction summary"))).toBe(true);
    expect(after.some((row) => row.text.includes("topic-032"))).toBe(true);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(after.length);
    }
  });

  it("keeps the existing index intact when embedding fails mid-delta and converges on retry", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-retry");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const before = readSessionChunkRows(manager);

    await fs.appendFile(sessionFile, transcriptTurns(31, 34), "utf8");
    markSessionDirty(manager, sessionFile);
    embedState.failNextBatch = true;
    await expect(manager.sync({ reason: "test" })).rejects.toThrow();

    // Embeddings are computed before any deletion, so a failure leaves the
    // previously indexed rows fully intact.
    const afterFailure = readSessionChunkRows(manager);
    expect(afterFailure).toStrictEqual(before);

    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const converged = readSessionChunkRows(manager);
    expect(converged.some((row) => row.text.includes("topic-034"))).toBe(true);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(converged.length);
    }
  });

  type PlannerOps = {
    planSessionChunkDelta: (...args: unknown[]) => unknown;
    db: {
      prepare: (sql: string) => {
        run: (...params: unknown[]) => void;
        get: (...params: unknown[]) => unknown;
      };
    };
  };

  it("deletes rows committed by a racing writer between plan and write", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-race-stale");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const indexedPath =
      readSessionChunkRows(manager).length > 0
        ? (
            (Reflect.get(manager, "db") as PlannerOps["db"])
              .prepare(`SELECT path FROM memory_index_chunks WHERE source = 'sessions' LIMIT 1`)
              .get() as { path: string }
          ).path
        : "";

    // Simulate a concurrent writer committing an extra row for this file
    // between this manager's delta plan and its write transaction.
    const ops = manager as unknown as PlannerOps;
    const originalPlan = ops.planSessionChunkDelta.bind(manager);
    ops.planSessionChunkDelta = (...args: unknown[]) => {
      const plan = originalPlan(...args);
      if (plan) {
        ops.db
          .prepare(
            `INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
             VALUES ('race-stale-id', ?, 'sessions', 1, 1, 'race-hash', 'mock-embed', 'race stale text', '[1,0,0]', 0)`,
          )
          .run(indexedPath);
      }
      return plan;
    };

    await fs.appendFile(sessionFile, transcriptTurns(31, 32), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // Stale ids are derived from live rows inside the write transaction, so
    // the racing writer's row is removed even though the plan never saw it.
    const survivor = ops.db
      .prepare(`SELECT id FROM memory_index_chunks WHERE id = 'race-stale-id'`)
      .get();
    expect(survivor).toBeUndefined();
  });

  it("defers the file record when a racing writer removed rows the plan kept", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-race-missing");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const before = readSessionChunkRows(manager);
    const keptRow = before[0];
    const ops = manager as unknown as PlannerOps;
    const recordBefore = ops.db
      .prepare(`SELECT hash FROM memory_index_sources WHERE source = 'sessions'`)
      .get() as { hash: string };

    // Simulate a concurrent writer deleting a row this plan intends to keep.
    const originalPlan = ops.planSessionChunkDelta.bind(manager);
    ops.planSessionChunkDelta = (...args: unknown[]) => {
      const plan = originalPlan(...args);
      if (plan) {
        ops.db.prepare(`DELETE FROM memory_index_chunks WHERE id = ?`).run(keptRow?.id);
        try {
          ops.db.prepare(`DELETE FROM memory_index_chunks_fts WHERE id = ?`).run(keptRow?.id);
        } catch {}
      }
      return plan;
    };

    await fs.appendFile(sessionFile, transcriptTurns(31, 32), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // The kept row cannot be restored (its embedding was skipped), so the
    // file record keeps the old hash and the file stays dirty for re-sync.
    const recordAfter = ops.db
      .prepare(`SELECT hash FROM memory_index_sources WHERE source = 'sessions'`)
      .get() as { hash: string };
    expect(recordAfter.hash).toBe(recordBefore.hash);
    expect(manager.status().dirty).toBe(true);
    expect(Reflect.get(manager, "sessionsDirtyFiles")).toEqual(new Set([sessionFile]));

    ops.planSessionChunkDelta = originalPlan;
    await manager.sync({ reason: "test" });

    // The deferred delta retains its own retry state, so an ordinary follow-up
    // sync replans from live rows and re-embeds what is missing.
    const converged = readSessionChunkRows(manager);
    expect(converged.some((row) => row.text === keptRow?.text)).toBe(true);
    const recordConverged = ops.db
      .prepare(`SELECT hash FROM memory_index_sources WHERE source = 'sessions'`)
      .get() as { hash: string };
    expect(recordConverged.hash).not.toBe(recordBefore.hash);
    expect(Reflect.get(manager, "sessionsDirtyFiles")).toEqual(new Set());
    expect(manager.status().dirty).toBe(false);
    const ftsCount = readFtsRowCount(manager);
    if (ftsCount !== null) {
      expect(ftsCount).toBe(converged.length);
    }
  });

  it("defers the file record when a racing writer removes a derived row after planning", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-race-derived");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    if (!(manager.status().fts?.available ?? false)) {
      return;
    }

    const before = readSessionChunkRows(manager);
    const keptId = before[0]?.id;
    const ops = manager as unknown as PlannerOps;
    const recordBefore = ops.db
      .prepare(`SELECT hash FROM memory_index_sources WHERE source = 'sessions'`)
      .get() as { hash: string };

    // Simulate another process deleting only a derived row after this manager
    // planned the delta but before it acquired the SQLite write lock.
    const originalPlan = ops.planSessionChunkDelta.bind(manager);
    ops.planSessionChunkDelta = (...args: unknown[]) => {
      const plan = originalPlan(...args);
      if (plan) {
        ops.db.prepare(`DELETE FROM memory_index_chunks_fts WHERE id = ?`).run(keptId);
      }
      return plan;
    };

    await fs.appendFile(sessionFile, transcriptTurns(31, 32), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // The write-locked parity check catches the race and leaves the old hash
    // in place so the next sync performs a healing full rewrite.
    const recordAfter = ops.db
      .prepare(`SELECT hash FROM memory_index_sources WHERE source = 'sessions'`)
      .get() as { hash: string };
    expect(recordAfter.hash).toBe(recordBefore.hash);

    ops.planSessionChunkDelta = originalPlan;
    await manager.sync({ reason: "test" });

    const converged = readSessionChunkRows(manager);
    expect(readFtsRowCount(manager)).toBe(converged.length);
    const recordConverged = ops.db
      .prepare(`SELECT hash FROM memory_index_sources WHERE source = 'sessions'`)
      .get() as { hash: string };
    expect(recordConverged.hash).not.toBe(recordBefore.hash);
  });

  it("re-embeds chunks that were persisted with an empty embedding", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-empty-embedding");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // Simulate a partial provider failure that persisted an empty embedding.
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => { run: (...params: unknown[]) => void };
    };
    const degraded = readSessionChunkRows(manager)[0];
    db.prepare(`UPDATE memory_index_chunks SET embedding = '[]' WHERE id = ?`).run(degraded?.id);

    embedState.batches = [];
    await fs.appendFile(sessionFile, transcriptTurns(31, 32), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    // The degraded chunk is re-embedded alongside the appended chunks instead
    // of being frozen as "unchanged" without a usable embedding.
    expect(embedState.batches.flat()).toContain(degraded?.text ?? "");
    const healed = readSessionChunkRows(manager).find((row) => row.id === degraded?.id);
    expect(healed).toBeDefined();
  });

  it("marks vector rebuild when a stale-only delta cannot remove persisted vectors", async () => {
    const { manager, sessionFile } = await setUpManager(".state-delta-stale-vector");
    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const before = readSessionChunkRows(manager);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const retainedTail = before.at(-2);
    const staleId = before.at(-1)?.id;
    if (!retainedTail || !staleId) {
      throw new Error("expected retained and stale session chunks");
    }
    expect(retainedTail.end_line).toBeLessThan(60);

    const db = Reflect.get(manager, "db") as {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        get: (...params: unknown[]) => unknown;
        run: (...params: unknown[]) => void;
      };
    };
    db.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
    db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, '[1,0,0]')").run(
      staleId,
    );
    db.prepare(
      `INSERT INTO memory_index_meta (key, value) VALUES ('memory_vector_rebuild_v1', 'clean')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();

    embedState.batches = [];
    const originalTranscript = await fs.readFile(sessionFile, "utf8");
    const retainedTranscript =
      originalTranscript.split("\n").slice(0, retainedTail.end_line).join("\n") + "\n";
    await fs.writeFile(sessionFile, retainedTranscript, "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    expect(embedState.batches).toEqual([]);
    expect(after.length).toBeLessThan(before.length);
    expect(after.some((row) => row.id === staleId)).toBe(false);
    expect(db.prepare("SELECT id FROM memory_index_chunks_vec WHERE id = ?").get(staleId)).toEqual({
      id: staleId,
    });
    expect(
      db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "1" });
  });

  it("applies deltas in FTS-only mode without an embedding provider", async () => {
    embedState.noProvider = true;
    const { manager, sessionFile } = await setUpManager(".state-delta-fts-only");
    if (!(manager.status().fts?.available ?? false)) {
      return;
    }

    await fs.writeFile(sessionFile, transcriptTurns(1, 30), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });
    const before = readSessionChunkRows(manager);
    expect(before.length).toBeGreaterThanOrEqual(2);

    await fs.appendFile(sessionFile, transcriptTurns(31, 34), "utf8");
    markSessionDirty(manager, sessionFile);
    await manager.sync({ reason: "test" });

    const after = readSessionChunkRows(manager);
    const afterById = new Map(after.map((row) => [row.id, row]));
    const preserved = before.filter((row) => afterById.get(row.id)?.updated_at === row.updated_at);
    expect(preserved.length).toBeGreaterThanOrEqual(before.length - 2);
    expect(after.some((row) => row.text.includes("topic-034"))).toBe(true);
    expect(readFtsRowCount(manager)).toBe(after.length);
  });
});
