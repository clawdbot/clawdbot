import type { DatabaseSync } from "node:sqlite";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { loadSqliteVecExtension } from "../sqlite-vec.js";

const log = createSubsystemLogger("memory:vector");

const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const VECTOR_TABLE = "chunks_vec";

export type VectorConfig = {
  enabled: boolean;
  extensionPath?: string;
};

export type VectorState = {
  available: boolean | null;
  extensionPath?: string;
  loadError?: string;
  dims?: number;
};

/**
 * Manages sqlite-vec extension loading and vector table lifecycle.
 */
export class VectorManager {
  private state: VectorState;
  private loadPromise: Promise<boolean> | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: VectorConfig,
    initialState?: Partial<VectorState>,
  ) {
    this.state = {
      available: null,
      extensionPath: config.extensionPath,
      ...initialState,
    };
  }

  /**
   * Ensures the vector extension is loaded and ready.
   * Optionally creates/recreates the vector table if dimensions are provided.
   */
  async ensureReady(dimensions?: number): Promise<boolean> {
    if (!this.config.enabled) return false;

    if (!this.loadPromise) {
      this.loadPromise = this.withTimeout(
        this.loadExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }

    let ready = false;
    try {
      ready = await this.loadPromise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.available = false;
      this.state.loadError = message;
      this.loadPromise = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }

    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }

    return ready;
  }

  /**
   * Loads the sqlite-vec extension.
   */
  private async loadExtension(): Promise<boolean> {
    if (this.state.available !== null) return this.state.available;

    if (!this.config.enabled) {
      this.state.available = false;
      return false;
    }

    try {
      const resolvedPath = this.config.extensionPath?.trim()
        ? resolveUserPath(this.config.extensionPath)
        : undefined;

      const loaded = await loadSqliteVecExtension({
        db: this.db,
        extensionPath: resolvedPath,
      });

      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }

      this.state.extensionPath = loaded.extensionPath;
      this.state.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.available = false;
      this.state.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  /**
   * Ensures the vector table exists with the specified dimensions.
   * Drops and recreates if dimensions change.
   */
  private ensureVectorTable(dimensions: number): void {
    if (this.state.dims === dimensions) return;

    if (this.state.dims && this.state.dims !== dimensions) {
      this.dropVectorTable();
    }

    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );

    this.state.dims = dimensions;
  }

  /**
   * Drops the vector table.
   */
  dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
      this.state.dims = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  /**
   * Gets the current state of the vector manager.
   */
  getState(): Readonly<VectorState> {
    return { ...this.state };
  }

  /**
   * Wraps a promise with a timeout.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(message)), timeoutMs),
      ),
    ]);
  }
}
