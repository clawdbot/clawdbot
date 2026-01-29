import type { DatabaseSync } from "node:sqlite";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

const log = createSubsystemLogger("memory");

export type VectorSearchResult = {
  id: string;
  score: number;
};

export interface VectorStore {
  ensureReady(dimensions: number): Promise<boolean>;
  upsert(id: string, embedding: number[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByPath(path: string, source: string, db: DatabaseSync): Promise<void>;
  search(
    queryVec: number[],
    limit: number,
    filter: { model: string; sources: string[] },
    db: DatabaseSync,
  ): Promise<VectorSearchResult[]>;
}

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

const VECTOR_TABLE = "chunks_vec";

export class SqliteVecStore implements VectorStore {
  private db: DatabaseSync;
  private enabled: boolean;
  private extensionPath?: string;
  private available: boolean | null = null;
  private loadError?: string;
  private dims?: number;
  private ready: Promise<boolean> | null = null;
  private readonly VECTOR_LOAD_TIMEOUT_MS = 30_000;

  constructor(params: { db: DatabaseSync; enabled: boolean; extensionPath?: string }) {
    this.db = params.db;
    this.enabled = params.enabled;
    this.extensionPath = params.extensionPath;
  }

  async ensureReady(dimensions: number): Promise<boolean> {
    if (!this.enabled) return false;
    if (!this.ready) {
      this.ready = this.withTimeout(
        this.loadVectorExtension(),
        this.VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(this.VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = await this.ready;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.available = false;
      this.loadError = message;
      this.ready = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  async upsert(id: string, embedding: number[]): Promise<void> {
    if (!this.available || !this.dims) {
      throw new Error("Vector store not ready");
    }
    try {
      this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
    } catch {}
    this.db
      .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
      .run(id, vectorToBlob(embedding));
  }

  async delete(id: string): Promise<void> {
    if (!this.available) return;
    try {
      this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
    } catch {}
  }

  async deleteByPath(path: string, source: string, db: DatabaseSync): Promise<void> {
    if (!this.available) return;
    try {
      db.prepare(
        `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
      ).run(path, source);
    } catch {}
  }

  async search(
    queryVec: number[],
    limit: number,
    filter: { model: string; sources: string[] },
    db: DatabaseSync,
  ): Promise<VectorSearchResult[]> {
    if (!this.available || queryVec.length === 0 || limit <= 0) return [];
    if (!(await this.ensureReady(queryVec.length))) return [];

    const sourceFilter =
      filter.sources.length === 0
        ? { sql: "", params: [] }
        : {
            sql: ` AND c.source IN (${filter.sources.map(() => "?").join(", ")})`,
            params: filter.sources,
          };

    const rows = db
      .prepare(
        `SELECT c.id,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${VECTOR_TABLE} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${sourceFilter.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(vectorToBlob(queryVec), filter.model, ...sourceFilter.params, limit) as Array<{
      id: string;
      dist: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      score: 1 - row.dist,
    }));
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.available !== null) return this.available;
    if (!this.enabled) {
      this.available = false;
      return false;
    }
    try {
      const resolvedPath = this.extensionPath?.trim()
        ? this.extensionPath.trim()
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      this.extensionPath = loaded.extensionPath;
      this.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.available = false;
      this.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.dims === dimensions) return;
    if (this.dims && this.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF NOT EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
      ),
    ]);
  }
}
