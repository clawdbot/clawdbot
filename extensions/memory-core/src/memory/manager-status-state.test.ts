// Memory Core tests cover manager status state plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  collectMemoryStatusAggregate,
  collectMemoryStorageStatus,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";

describe("memory manager status state", () => {
  it("distinguishes retained cache payload, WAL, and reusable space without changing the database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-storage-status-"));
    const databasePath = path.join(root, "agent.sqlite");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE memory_embedding_cache (embedding TEXT);
        INSERT INTO memory_embedding_cache VALUES ('[1,2]'), ('🦞');
        CREATE TABLE other_owner (payload BLOB);
        INSERT INTO other_owner VALUES (zeroblob(1048576));
        DELETE FROM other_owner;
      `);
      const before = db.prepare("SELECT total_changes() AS changes").get();
      const storage = collectMemoryStorageStatus(db, databasePath);
      expect(storage.embeddingCacheEntries).toBe(2);
      expect(storage.embeddingCacheBytes).toBe(9);
      expect(storage.databaseBytes).toBe(fs.statSync(databasePath).size);
      expect(storage.walBytes).toBe(fs.statSync(`${databasePath}-wal`).size);
      expect(storage.walBytes).toBeGreaterThan(1048576);
      expect(storage.reusableBytes).toBeGreaterThanOrEqual(1048576);
      expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(collectMemoryStorageStatus(db, databasePath).walBytes).toBe(0);
      db.exec("VACUUM");
      expect(collectMemoryStorageStatus(db, databasePath)).toMatchObject({
        reusableBytes: 0,
        embeddingCacheEntries: 2,
        embeddingCacheBytes: 9,
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "requested provider before initialization",
      params: {
        provider: null,
        providerInitialized: false,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      },
      expected: {
        provider: "openai",
        model: "mock-embed",
        searchMode: "hybrid" as const,
      },
    },
    {
      name: "FTS-only after providerless initialization",
      params: {
        provider: null,
        providerInitialized: true,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      },
      expected: {
        provider: "none",
        model: undefined,
        searchMode: "fts-only" as const,
      },
    },
  ])("reports $name", ({ params, expected }) => {
    expect(resolveStatusProviderInfo(params)).toEqual(expected);
  });

  it("counts ordinary status without evaluating stored payload columns", () => {
    const db = new DatabaseSync(":memory:");
    let payloadReads = 0;
    try {
      db.function("read_payload", { deterministic: true }, (source) => {
        payloadReads += 1;
        return `${String(source)} payload`;
      });
      db.exec(`
        CREATE TABLE memory_index_sources (source TEXT);
        CREATE TABLE memory_index_chunks (
          source TEXT,
          text TEXT GENERATED ALWAYS AS (read_payload(source)) VIRTUAL,
          embedding TEXT GENERATED ALWAYS AS (read_payload(source)) VIRTUAL
        );
        CREATE INDEX sources_by_source ON memory_index_sources(source);
        CREATE INDEX chunks_by_source ON memory_index_chunks(source);
        INSERT INTO memory_index_sources VALUES ('memory'), ('sessions');
        INSERT INTO memory_index_chunks(source) VALUES ('memory'), ('sessions');
      `);
      payloadReads = 0;

      const status = collectMemoryStatusAggregate({ db, sources: ["memory", "sessions"] });

      expect(payloadReads).toBe(0);
      expect(status).toEqual({
        files: 2,
        chunks: 2,
        sourceCounts: [
          { source: "memory", files: 1, chunks: 1 },
          { source: "sessions", files: 1, chunks: 1 },
        ],
      });
    } finally {
      db.close();
    }
  });

  it("reports stored payload bytes by source without counting characters or other sources", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE memory_index_sources (source TEXT);
        CREATE TABLE memory_index_chunks (source TEXT, text TEXT, embedding TEXT);
        INSERT INTO memory_index_sources VALUES ('memory'), ('memory'), ('sessions');
        INSERT INTO memory_index_chunks VALUES
          ('memory', '🦞', '[1,2]'), ('memory', 'abc', '[]'),
          ('sessions', 'session', '[3]');
      `);
      expect(
        collectMemoryStatusAggregate({
          db,
          includeChunkBytes: true,
          sources: ["memory", "sessions"],
        }),
      ).toEqual({
        files: 3,
        chunks: 3,
        sourceCounts: [
          { source: "memory", files: 2, chunks: 2, chunkBytes: 14 },
          { source: "sessions", files: 1, chunks: 1, chunkBytes: 10 },
        ],
      });
      expect(
        collectMemoryStatusAggregate({
          db,
          includeChunkBytes: true,
          sources: ["memory"],
          sourceFilterSql: " AND source IN (?)",
          sourceFilterParams: ["memory"],
        }),
      ).toEqual({
        files: 2,
        chunks: 2,
        sourceCounts: [{ source: "memory", files: 2, chunks: 2, chunkBytes: 14 }],
      });
      db.exec("DELETE FROM memory_index_sources; DELETE FROM memory_index_chunks;");
      expect(
        collectMemoryStatusAggregate({ db, sources: ["memory"], includeChunkBytes: true }),
      ).toEqual({
        files: 0,
        chunks: 0,
        sourceCounts: [{ source: "memory", files: 0, chunks: 0, chunkBytes: 0 }],
      });
    } finally {
      db.close();
    }
  });
});
