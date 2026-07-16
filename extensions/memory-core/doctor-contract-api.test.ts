// Memory Core tests cover doctor migration of legacy dreaming state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  configureMemoryCoreDreamingState,
  writeMemoryCoreWorkspaceEntry,
} from "./src/dreaming-state.js";
import { bm25RankToScore, buildFtsQuery } from "./src/memory/hybrid.js";
import { searchKeyword, searchVector } from "./src/memory/manager-search.js";
import {
  dreamingTestState as dreamingTesting,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as shortTermTesting,
} from "./src/test-helpers.js";

function requireStateMigration(index: number) {
  return expectDefined(stateMigrations[index], `Memory Core state migration ${index}`);
}

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function legacyMemoryIndexMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-legacy-sidecar-index-to-agent-sqlite",
  );
  if (!migration) {
    throw new Error("expected memory-core legacy sidecar migration");
  }
  return migration;
}

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

async function writeLegacyMemorySidecar(
  legacyPath: string,
  params: {
    vector?: boolean | "vec0";
    chunkId?: string;
    chunkHash?: string;
    fileHash?: string;
    filePath?: string;
    text?: string;
    cacheEmbedding?: string;
    cacheDims?: number | null;
  } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  const db = new DatabaseSync(legacyPath, { allowExtension: params.vector === "vec0" });
  try {
    const filePath = params.filePath ?? "MEMORY.md";
    const fileHash = params.fileHash ?? "file-hash";
    const chunkId = params.chunkId ?? "chunk-1";
    const chunkHash = params.chunkHash ?? "chunk-hash";
    const text = params.text ?? "remember this";
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE embedding_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
      INSERT INTO meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
    `);
    db.prepare("INSERT INTO files VALUES (?, 'memory', ?, 10, 20)").run(filePath, fileHash);
    db.prepare(
      "INSERT INTO chunks VALUES (?, ?, 'memory', 1, 2, ?, 'embed-model', ?, '[1,0,0]', 30)",
    ).run(chunkId, filePath, chunkHash, text);
    db.prepare(
      "INSERT INTO embedding_cache VALUES ('openai', 'embed-model', 'key', ?, ?, ?, 40)",
    ).run(
      chunkHash,
      params.cacheEmbedding ?? "[1,0,0]",
      params.cacheDims === undefined ? 3 : params.cacheDims,
    );
    if (params.vector === "vec0") {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      db.exec(`
        CREATE VIRTUAL TABLE chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[3]
        )
      `);
      db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run(
        chunkId,
        vectorToBlob([1, 0, 0]),
      );
    } else if (params.vector) {
      db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
      db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run(
        chunkId,
        vectorToBlob([1, 0, 0]),
      );
    }
  } finally {
    db.close();
  }
}

async function createCanonicalMemoryIndex(agentPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath);
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      '{"vectorDims":3}',
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("MEMORY.md", "memory", "canonical-file-hash", 11, 21);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "canonical-chunk",
      "MEMORY.md",
      "memory",
      1,
      1,
      "canonical-hash",
      "embed-model",
      text,
      "[0,1,0]",
      31,
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(text, "canonical-chunk", "MEMORY.md", "memory", "embed-model", 1, 1);
  } finally {
    db.close();
  }
}

async function createUnrelatedCanonicalMemoryIndex(
  agentPath: string,
  options: { vectorDims?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath);
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      JSON.stringify({ vectorDims: options.vectorDims ?? 3 }),
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("OTHER.md", "memory", "canonical-other-file-hash", 11, 21);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "canonical-other-chunk",
      "OTHER.md",
      "memory",
      1,
      1,
      "canonical-other-hash",
      "embed-model",
      "canonical unrelated memory",
      "[0,1,0]",
      31,
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "canonical unrelated memory",
      "canonical-other-chunk",
      "OTHER.md",
      "memory",
      "embed-model",
      1,
      1,
    );
  } finally {
    db.close();
  }
}

async function createCanonicalLegacyMemoryRowsWithFts(agentPath: string, ftsText: string) {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath);
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      '{"vectorDims":3}',
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("MEMORY.md", "memory", "file-hash", 10, 20);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "chunk-1",
      "MEMORY.md",
      "memory",
      1,
      2,
      "chunk-hash",
      "embed-model",
      "remember this",
      "[1,0,0]",
      30,
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(ftsText, "chunk-1", "MEMORY.md", "memory", "embed-model", 1, 2);
  } finally {
    db.close();
  }
}

async function createMismatchedCanonicalVectorIndex(agentPath: string): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[4]
      )
    `);
  } finally {
    db.close();
  }
}

async function createConflictingCanonicalVectorIndex(agentPath: string): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      '{"vectorDims":3}',
    );
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      )
    `);
    db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
      "chunk-1",
      vectorToBlob([0, 1, 0]),
    );
  } finally {
    db.close();
  }
}

function readMemoryRows(agentPath: string) {
  const db = new DatabaseSync(agentPath);
  try {
    return {
      sources: db
        .prepare("SELECT path, source, hash FROM memory_index_sources ORDER BY path, source")
        .all(),
      chunks: db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all(),
      cache: db
        .prepare("SELECT provider, hash FROM memory_embedding_cache ORDER BY provider, hash")
        .all(),
    };
  } finally {
    db.close();
  }
}

function readMemoryCacheRows(agentPath: string) {
  const db = new DatabaseSync(agentPath);
  try {
    return db
      .prepare(
        "SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM memory_embedding_cache ORDER BY provider, hash",
      )
      .all();
  } finally {
    db.close();
  }
}

function readMemoryFtsSql(agentPath: string): string | undefined {
  const db = new DatabaseSync(agentPath);
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get("memory_index_chunks_fts") as { sql?: unknown } | undefined;
    return typeof row?.sql === "string" ? row.sql : undefined;
  } finally {
    db.close();
  }
}

async function searchMigratedVectorRows(agentPath: string) {
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    return await searchVector({
      db,
      vectorTable: "memory_index_chunks_vec",
      providerModel: "embed-model",
      queryVec: [1, 0, 0],
      limit: 1,
      snippetMaxChars: 200,
      ensureVectorReady: async () => true,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });
  } finally {
    db.close();
  }
}

async function searchMigratedKeywordRows(agentPath: string, query: string) {
  const db = new DatabaseSync(agentPath);
  try {
    return await searchKeyword({
      db,
      ftsTable: "memory_index_chunks_fts",
      query,
      ftsTokenizer: "unicode61",
      limit: 10,
      snippetMaxChars: 200,
      sourceFilter: { sql: "", params: [] },
      buildFtsQuery,
      bm25RankToScore,
    });
  } finally {
    db.close();
  }
}

describe("memory-core doctor dreaming migration", () => {
  let rootDir = "";
  let workspaceDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-doctor-"));
    workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  });

  afterEach(async () => {
    resetMemoryCoreDreamingStateForTests();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function context(): PluginDoctorStateMigrationContext {
    return createDoctorContext(env);
  }

  function migrationParams(
    config: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    },
  ) {
    return {
      config,
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: context(),
    };
  }

  it("imports persistent legacy dreaming state and ignores transient locks", async () => {
    const dreamsDir = path.join(workspaceDir, "memory", ".dreams");
    const dailyPath = path.join(dreamsDir, "daily-ingestion.json");
    const sessionPath = path.join(dreamsDir, "session-ingestion.json");
    const recallPath = path.join(dreamsDir, "short-term-recall.json");
    const phasePath = path.join(dreamsDir, "phase-signals.json");
    const lockPath = path.join(dreamsDir, "short-term-promotion.lock");

    await fs.writeFile(
      dailyPath,
      JSON.stringify({
        version: 1,
        files: {
          "memory/2026-04-05.md": {
            size: 42,
            mtimeMs: 1,
            contentHash: "daily-hash",
            ingestedAt: "2026-04-05T10:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        version: 1,
        files: {
          "main/session.jsonl": {
            size: 91,
            mtimeMs: 2,
            lineCount: 3,
            lastContentLine: 3,
            contentHash: "session-hash",
            ingestedAt: "2026-04-05T11:00:00.000Z",
          },
        },
        seenMessages: {
          "main/session.jsonl": ["seen-a", "seen-b"],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      recallPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T12:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            totalScore: 0.9,
            maxScore: 0.9,
            queryHashes: ["hash-a"],
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      phasePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T13:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            lightHits: 1,
            remHits: 2,
            lastLightAt: "2026-04-05T12:00:00.000Z",
            lastRemAt: "2026-04-05T13:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(lockPath, `${process.pid}:${Date.now()}\n`, "utf8");

    const migration = requireStateMigration(0);
    const preview = await migration.detectLegacyState(migrationParams());
    expect(preview?.preview).toEqual([
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core session ingestion"),
      expect.stringContaining("Memory Core short-term recall"),
      expect.stringContaining("Memory Core phase signals"),
    ]);
    expect(preview?.preview.join("\n")).not.toContain("short-term-promotion.lock");

    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core daily ingestion -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core daily ingestion legacy source"),
      "Migrated Memory Core session ingestion -> SQLite plugin state (2 row(s))",
      expect.stringContaining("Archived Memory Core session ingestion legacy source"),
      "Migrated Memory Core short-term recall -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core short-term recall legacy source"),
      "Migrated Memory Core phase signals -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core phase signals legacy source"),
    ]);

    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await expect(fs.access(`${dailyPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${sessionPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${recallPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${phasePath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    const daily = await dreamingTesting.readDailyIngestionState(workspaceDir);
    expect(daily.files["memory/2026-04-05.md"]?.mtimeMs).toBe(1);
    const session = await dreamingTesting.readSessionIngestionState(workspaceDir);
    expect(session.files["main/session.jsonl"]?.contentHash).toBe("session-hash");
    expect(session.seenMessages["main/session.jsonl"]).toEqual(["seen-a", "seen-b"]);
    const recall = await shortTermTesting.readRecallStore(workspaceDir, "2026-04-05T12:00:00.000Z");
    expect(recall.entries["memory:memory/2026-04-05.md:1:1"]?.conceptTags).toContain("glacier");
    const phase = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      "2026-04-05T13:00:00.000Z",
    );
    expect(phase.entries["memory:memory/2026-04-05.md:1:1"]?.remHits).toBe(2);

    for (const sourcePath of [dailyPath, sessionPath, recallPath, phasePath]) {
      await fs.copyFile(`${sourcePath}.migrated`, sourcePath);
    }
    await fs.copyFile(dailyPath, `${dailyPath}.migrated.2`);
    await fs.writeFile(`${dailyPath}.migrated`, "older archive", "utf8");
    await writeMemoryCoreWorkspaceEntry({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      key: "memory/2026-04-05.md",
      value: { ...daily.files["memory/2026-04-05.md"], mtimeMs: 2 },
    });
    const matchingResult = await migration.migrateLegacyState(migrationParams());
    expect(matchingResult.changes).toEqual([]);
    expect(matchingResult.warnings).toEqual([]);
    expect(matchingResult.notices).toEqual([
      expect.stringContaining("Retained acknowledged Memory Core daily ingestion"),
      expect.stringContaining("Retained acknowledged Memory Core session ingestion"),
      expect.stringContaining("Retained acknowledged Memory Core short-term recall"),
      expect.stringContaining("Retained acknowledged Memory Core phase signals"),
    ]);

    const changedDaily = JSON.parse(await fs.readFile(dailyPath, "utf8")) as {
      files: Record<string, { mtimeMs: number }>;
    };
    changedDaily.files["memory/2026-04-05.md"]!.mtimeMs = 999;
    await fs.writeFile(dailyPath, JSON.stringify(changedDaily), "utf8");
    const conflictResult = await migration.migrateLegacyState(migrationParams());
    expect(conflictResult.changes).toEqual([]);
    expect(conflictResult.warnings).toEqual([
      expect.stringContaining("SQLite rows conflict with the legacy source"),
    ]);
    expect(conflictResult.notices).toHaveLength(3);
    await expect(fs.access(dailyPath)).resolves.toBeUndefined();
  });

  it("leaves invalid legacy JSON in place", async () => {
    const recallPath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.writeFile(recallPath, "{", "utf8");

    const result = await requireStateMigration(0).migrateLegacyState(migrationParams());

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Skipped Memory Core short-term recall import"),
    ]);
    await expect(fs.access(recallPath)).resolves.toBeUndefined();
    await expect(fs.access(`${recallPath}.migrated`)).rejects.toThrow();
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    const recall = await shortTermTesting.readRecallStore(workspaceDir, new Date().toISOString());
    expect(recall.entries).toEqual({});
  });

  it("uses migration env when resolving default workspaces", async () => {
    env = { ...env, OPENCLAW_WORKSPACE_DIR: workspaceDir };
    const recallPath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.writeFile(
      recallPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T12:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-05T12:00:00.000Z",
            lastRecalledAt: "2026-04-05T12:00:00.000Z",
            queryHashes: ["hash-a"],
          },
        },
      }),
      "utf8",
    );
    const config = { agents: { list: [{ id: "main", default: true }] } };

    const preview = await requireStateMigration(0).detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([expect.stringContaining("Memory Core short-term recall")]);

    const result = await requireStateMigration(0).migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core short-term recall -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core short-term recall legacy source"),
    ]);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    const recall = await shortTermTesting.readRecallStore(workspaceDir, "2026-04-05T12:00:00.000Z");
    expect(recall.entries["memory:memory/2026-04-05.md:1:1"]?.conceptTags).toContain("glacier");
  });

  it("migrates the legacy memory sidecar index to the per-agent SQLite database", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams());
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${legacyPath} -> ${agentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "file-hash" }],
      chunks: [{ id: "chunk-1", text: "remember this" }],
      cache: [{ provider: "openai", hash: "chunk-hash" }],
    });
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("creates migrated FTS tables with the configured legacy tokenizer", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              fts: { tokenizer: "trigram" },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(readMemoryFtsSql(agentPath)).toContain("tokenize='trigram case_sensitive 0'");
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("migrates retired configured legacy memory sidecar paths", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: path.join(rootDir, "custom-memory", "{agentId}.sqlite"),
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${legacyPath} -> ${agentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "file-hash" }],
      chunks: [{ id: "chunk-1", text: "remember this" }],
      cache: [{ provider: "openai", hash: "chunk-hash" }],
    });
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("migrates all retired configured legacy memory sidecar paths", async () => {
    const stateDir = path.join(rootDir, "state");
    const topLevelPath = path.join(rootDir, "top-memory", "main.sqlite");
    const defaultsPath = path.join(rootDir, "default-memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(topLevelPath, {
      chunkId: "chunk-top",
      chunkHash: "chunk-hash-top",
      fileHash: "file-hash-top",
      filePath: "TOP.md",
      text: "remember top level",
    });
    await writeLegacyMemorySidecar(defaultsPath, {
      chunkId: "chunk-defaults",
      chunkHash: "chunk-hash-defaults",
      fileHash: "file-hash-defaults",
      filePath: "DEFAULTS.md",
      text: "remember defaults",
    });
    const config = {
      memorySearch: {
        store: {
          path: topLevelPath,
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: path.join(rootDir, "default-memory", "{agentId}.sqlite"),
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${defaultsPath} -> ${agentPath}`,
      `- Memory Core legacy memory index: ${topLevelPath} -> ${agentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(
      readMemoryRows(agentPath)
        .chunks.map((chunk) => String(chunk.id))
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["chunk-defaults", "chunk-top"]);
    await expect(fs.access(`${defaultsPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${topLevelPath}.migrated`)).resolves.toBeUndefined();
  });

  it("does not infer agent ownership from configured sidecar filenames", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "shared.sqlite");
    const mainAgentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const sharedAgentPath = path.join(
      stateDir,
      "agents",
      "shared",
      "agent",
      "openclaw-agent.sqlite",
    );
    await writeLegacyMemorySidecar(legacyPath);
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: legacyPath,
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${legacyPath} -> ${mainAgentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(readMemoryRows(mainAgentPath).chunks).toEqual([
      { id: "chunk-1", text: "remember this" },
    ]);
    await expect(fs.access(sharedAgentPath)).rejects.toThrow();
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("ignores transient memory SQLite files when discovering default sidecars", async () => {
    const stateDir = path.join(rootDir, "state");
    const lockPath = path.join(stateDir, "memory", "main.sqlite.reindex-lock.sqlite");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "", "utf8");

    const preview = await legacyMemoryIndexMigration().detectLegacyState(migrationParams());
    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(preview).toBeNull();
    expect(result).toEqual({ changes: [], warnings: [] });
    await expect(
      fs.access(path.join(stateDir, "agents", "main-sqlite-reindex-lock")),
    ).rejects.toThrow();
  });

  it("copies shared retired configured legacy sidecars to each configured agent", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(rootDir, "custom-memory", "shared.sqlite");
    const mainAgentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const workAgentPath = path.join(stateDir, "agents", "work", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: legacyPath,
            },
          },
        },
        list: [
          { id: "main", workspace: workspaceDir },
          { id: "work", workspace: path.join(rootDir, "work") },
        ],
      },
    } as unknown as OpenClawConfig;

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${legacyPath} -> ${mainAgentPath}`,
      `- Memory Core legacy memory index: ${legacyPath} -> ${workAgentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      "Migrated Memory Core legacy memory index for agent work -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    for (const agentPath of [mainAgentPath, workAgentPath]) {
      expect(readMemoryRows(agentPath)).toEqual({
        sources: [{ path: "MEMORY.md", source: "memory", hash: "file-hash" }],
        chunks: [{ id: "chunk-1", text: "remember this" }],
        cache: [{ provider: "openai", hash: "chunk-hash" }],
      });
    }
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("restores legacy sidecar vector rows for vector-backed search", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: true });

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
    );
    const rows = await searchMigratedVectorRows(agentPath);
    expect(rows.map((row) => row.id)).toEqual(["chunk-1"]);
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("archives empty legacy vector sidecars when sqlite-vec cannot load", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    const db = new DatabaseSync(legacyPath);
    try {
      db.exec("DELETE FROM chunks_vec");
    } finally {
      db.close();
    }
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              vector: {
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("leaves malformed legacy vector sidecars retryable", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, vector BLOB)");
      legacyDb
        .prepare("INSERT INTO chunks_vec (id, vector) VALUES (?, ?)")
        .run("chunk-1", vectorToBlob([1, 0, 0]));
    } finally {
      legacyDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Left Memory Core legacy memory index sidecar in place for agent main because legacy vector rows still require sqlite-vec: legacy vector table could not be validated",
      ),
    ]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
    ]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("keeps legacy vector sidecars retryable when sqlite-vec cannot load", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              vector: {
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Left Memory Core legacy memory index sidecar in place for agent main because legacy vector rows still require sqlite-vec",
      ),
    ]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "file-hash" }],
      chunks: [{ id: "chunk-1", text: "remember this" }],
      cache: [{ provider: "openai", hash: "chunk-hash" }],
    });
    const keywordRows = await searchMigratedKeywordRows(agentPath, "remember");
    expect(keywordRows.map((row) => row.id)).toEqual(["chunk-1"]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("archives legacy vector sidecars when vector search is disabled", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              vector: {
                enabled: false,
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    const keywordRows = await searchMigratedKeywordRows(agentPath, "remember");
    expect(keywordRows.map((row) => row.id)).toEqual(["chunk-1"]);
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("archives legacy vector sidecars when memory search provider is none", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "none",
            store: {
              vector: {
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    const keywordRows = await searchMigratedKeywordRows(agentPath, "remember");
    expect(keywordRows.map((row) => row.id)).toEqual(["chunk-1"]);
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("copies custom vector sidecars to the canonical retry path when sqlite-vec cannot load", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: legacyPath,
              vector: {
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const repairedConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.changes).toContain(
      `Copied Memory Core legacy memory index sidecar retry path -> ${retryPath}`,
    );
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Left Memory Core legacy memory index sidecar in place for agent main because legacy vector rows still require sqlite-vec",
      ),
    ]);
    expect(retryPreview?.preview).toEqual([
      `- Memory Core legacy memory index: ${retryPath} -> ${path.join(
        stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      )}`,
    ]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(retryPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("copies custom vector sidecars to a discoverable retry path when the canonical retry exists", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    await writeLegacyMemorySidecar(retryPath, { vector: "vec0" });
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: legacyPath,
              vector: {
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const retryEntries = await fs.readdir(path.join(stateDir, "memory"));
    const alternateRetry = retryEntries.find((entry) =>
      /^main\.retry-[a-f0-9]{12}\.sqlite$/.test(entry),
    );
    expect(alternateRetry).toBeDefined();
    const alternateRetryPath = path.join(stateDir, "memory", alternateRetry ?? "");
    const repairedConfig: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              vector: {
                extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
              },
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.changes).toContain(
      `Copied Memory Core legacy memory index sidecar retry path -> ${alternateRetryPath}`,
    );
    expect(retryPreview?.preview).toEqual(
      expect.arrayContaining([
        `- Memory Core legacy memory index: ${retryPath} -> ${path.join(
          stateDir,
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        )}`,
        `- Memory Core legacy memory index: ${alternateRetryPath} -> ${path.join(
          stateDir,
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        )}`,
      ]),
    );
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(alternateRetryPath)).resolves.toBeUndefined();

    const retryEntriesBefore = (await fs.readdir(path.join(stateDir, "memory")))
      .filter((entry) => entry.startsWith("main.retry-"))
      .toSorted();
    const secondRun = await legacyMemoryIndexMigration().migrateLegacyState(
      migrationParams(repairedConfig),
    );
    const retryEntriesAfter = (await fs.readdir(path.join(stateDir, "memory")))
      .filter((entry) => entry.startsWith("main.retry-"))
      .toSorted();
    expect(secondRun.changes).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Copied Memory Core legacy memory index sidecar retry path"),
      ]),
    );
    expect(retryEntriesAfter).toEqual(retryEntriesBefore);
  });

  it("keeps canonical rows and archives a conflicting derived legacy index", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await createCanonicalMemoryIndex(agentPath, "canonical memory remains authoritative");

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Resolved Memory Core legacy memory index conflict for agent main by keeping canonical per-agent SQLite rows",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "canonical-file-hash" }],
      chunks: [{ id: "canonical-chunk", text: "canonical memory remains authoritative" }],
      cache: [],
    });
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("archives conflicting custom derived indexes without creating a retry copy", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await createCanonicalMemoryIndex(agentPath, "canonical memory remains authoritative");
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: legacyPath,
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const repairedConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.changes).toEqual([
      "Resolved Memory Core legacy memory index conflict for agent main by keeping canonical per-agent SQLite rows",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(result.warnings).toEqual([]);
    expect(retryPreview).toBeNull();
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await expect(fs.access(retryPath)).rejects.toThrow();
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("copies custom sidecars to the retry path when canonical database setup fails", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await fs.mkdir(agentPath, { recursive: true });
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: legacyPath,
            },
          },
        },
        list: [{ id: "main", workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const repairedConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.changes).toEqual([
      `Copied Memory Core legacy memory index sidecar retry path -> ${retryPath}`,
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because the sidecar could not be imported:",
      ),
    ]);
    expect(retryPreview?.preview).toEqual([
      `- Memory Core legacy memory index: ${retryPath} -> ${agentPath}`,
    ]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(retryPath)).resolves.toBeUndefined();
  });

  it("leaves the legacy memory sidecar in place when metadata conflicts", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await createUnrelatedCanonicalMemoryIndex(agentPath, { vectorDims: 4 });

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory meta rows conflict with canonical memory index rows",
      ),
    ]);
    expect(result.changes).toEqual([]);
    expect(readMemoryRows(agentPath).chunks).toEqual([
      { id: "canonical-other-chunk", text: "canonical unrelated memory" },
    ]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("merges legacy sidecar rows into a non-empty canonical index when rows do not conflict", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await createUnrelatedCanonicalMemoryIndex(agentPath);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [
        { path: "MEMORY.md", source: "memory", hash: "file-hash" },
        { path: "OTHER.md", source: "memory", hash: "canonical-other-file-hash" },
      ],
      chunks: [
        { id: "canonical-other-chunk", text: "canonical unrelated memory" },
        { id: "chunk-1", text: "remember this" },
      ],
      cache: [{ provider: "openai", hash: "chunk-hash" }],
    });
    const keywordRows = await searchMigratedKeywordRows(agentPath, "remember");
    expect(keywordRows.map((row) => row.id)).toEqual(["chunk-1"]);
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("keeps canonical cache collisions while importing remaining legacy rows", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb
        .prepare("INSERT INTO embedding_cache VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("cohere", "embed-model", "key", "other-hash", "[1,1,0]", 3, 41);
    } finally {
      legacyDb.close();
    }
    await createUnrelatedCanonicalMemoryIndex(agentPath);
    const canonicalDb = new DatabaseSync(agentPath);
    try {
      canonicalDb
        .prepare(
          "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("openai", "embed-model", "key", "chunk-hash", "[0,1,0]", 3, 99);
    } finally {
      canonicalDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 2 cache row(s))",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [
        { path: "MEMORY.md", source: "memory", hash: "file-hash" },
        { path: "OTHER.md", source: "memory", hash: "canonical-other-file-hash" },
      ],
      chunks: [
        { id: "canonical-other-chunk", text: "canonical unrelated memory" },
        { id: "chunk-1", text: "remember this" },
      ],
      cache: [
        { provider: "cohere", hash: "other-hash" },
        { provider: "openai", hash: "chunk-hash" },
      ],
    });
    expect(readMemoryCacheRows(agentPath)).toEqual([
      {
        provider: "cohere",
        model: "embed-model",
        provider_key: "key",
        hash: "other-hash",
        embedding: "[1,1,0]",
        dims: 3,
        updated_at: 41,
      },
      {
        provider: "openai",
        model: "embed-model",
        provider_key: "key",
        hash: "chunk-hash",
        embedding: "[0,1,0]",
        dims: 3,
        updated_at: 99,
      },
    ]);
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();

    const secondRun = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());
    expect(secondRun).toEqual({ changes: [], warnings: [] });
  });

  it.each([
    {
      reason: "declared dimensions differ",
      canonicalEmbedding: "[0,1,0]",
      canonicalDims: 4,
    },
    {
      reason: "embedding lengths differ",
      canonicalEmbedding: "[0,1,0,0]",
      canonicalDims: 3,
    },
    {
      reason: "both embeddings mismatch their shared dimensions",
      canonicalEmbedding: "[0,1,0,0]",
      canonicalDims: 3,
      legacyEmbedding: "[1,0,0,0]",
    },
    {
      reason: "the canonical embedding is malformed",
      canonicalEmbedding: "not-json",
      canonicalDims: 3,
    },
    {
      reason: "the legacy embedding is malformed",
      canonicalEmbedding: "[0,1,0]",
      canonicalDims: 3,
      legacyEmbedding: "not-json",
    },
    {
      reason: "both declared dimensions are missing",
      canonicalEmbedding: "[0,1,0]",
      canonicalDims: null,
      legacyDims: null,
    },
  ])(
    "leaves legacy sidecars in place when cache collision $reason",
    async ({ canonicalEmbedding, canonicalDims, legacyEmbedding, legacyDims }) => {
      const stateDir = path.join(rootDir, "state");
      const legacyPath = path.join(stateDir, "memory", "main.sqlite");
      const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      await writeLegacyMemorySidecar(legacyPath, {
        cacheEmbedding: legacyEmbedding,
        cacheDims: legacyDims,
      });
      await createUnrelatedCanonicalMemoryIndex(agentPath);
      const canonicalDb = new DatabaseSync(agentPath);
      try {
        canonicalDb
          .prepare(
            "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("openai", "embed-model", "key", "chunk-hash", canonicalEmbedding, canonicalDims, 99);
      } finally {
        canonicalDb.close();
      }

      const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

      expect(result.warnings).toEqual([
        expect.stringContaining(
          "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory embedding_cache rows conflict with canonical memory index rows",
        ),
      ]);
      expect(result.changes).toEqual([]);
      expect(readMemoryRows(agentPath)).toEqual({
        sources: [{ path: "OTHER.md", source: "memory", hash: "canonical-other-file-hash" }],
        chunks: [{ id: "canonical-other-chunk", text: "canonical unrelated memory" }],
        cache: [{ provider: "openai", hash: "chunk-hash" }],
      });
      expect(readMemoryCacheRows(agentPath)).toEqual([
        {
          provider: "openai",
          model: "embed-model",
          provider_key: "key",
          hash: "chunk-hash",
          embedding: canonicalEmbedding,
          dims: canonicalDims,
          updated_at: 99,
        },
      ]);
      await expect(fs.access(legacyPath)).resolves.toBeUndefined();
      await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
    },
  );

  it("leaves legacy vector sidecars in place when vector dimensions conflict", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    await createMismatchedCanonicalVectorIndex(agentPath);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory chunks_vec dimensions 3 do not match canonical memory chunks_vec dimensions 4",
      ),
    ]);
    expect(result.changes).toEqual([]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("leaves legacy vector sidecars in place when canonical vector rows conflict", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    await createConflictingCanonicalVectorIndex(agentPath);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory chunks_vec rows conflict with canonical memory index rows",
      ),
    ]);
    expect(result.changes).toEqual([]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("leaves legacy vector sidecars in place when vector rows have no chunk", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb.exec("DELETE FROM chunks");
    } finally {
      legacyDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory chunks_vec chunk references rows conflict",
      ),
    ]);
    expect(result.changes).toEqual([]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("leaves legacy sidecars in place when canonical FTS rows conflict", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await createCanonicalLegacyMemoryRowsWithFts(agentPath, "stale text");

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory fts rows conflict",
      ),
    ]);
    expect(result.changes).toEqual([]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("leaves legacy vector sidecars in place when canonical metadata dimensions conflict", async () => {
    const stateDir = path.join(rootDir, "state");
    const legacyPath = path.join(stateDir, "memory", "main.sqlite");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    await createUnrelatedCanonicalMemoryIndex(agentPath, { vectorDims: 4 });

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory meta rows conflict with canonical memory index rows",
      ),
    ]);
    expect(result.changes).toEqual([]);
    expect(readMemoryRows(agentPath).chunks).toEqual([
      { id: "canonical-other-chunk", text: "canonical unrelated memory" },
    ]);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
