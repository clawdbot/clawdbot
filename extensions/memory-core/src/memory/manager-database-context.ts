// Owns the published index state and the isolated lifetime of shadow reindex work.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { closeMemoryDatabase } from "./manager-db.js";

export class MemoryIndexDatabase {
  readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  } = { enabled: false, available: null };
  readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  vectorReady: Promise<boolean> | null = null;
  lastMetaSerialized: string | null = null;
  vectorDegradedWriteWarningShown = false;
  closed = false;

  constructor(
    readonly db: DatabaseSync,
    readonly release: () => void = () => closeMemoryDatabase(db),
    readonly readOnly = false,
  ) {}
}

// One process-lifetime container; stores belong only to their awaited rebuild.
const reindexDatabase = new AsyncLocalStorage<{
  manager: MemoryManagerDatabaseContext;
  database: MemoryIndexDatabase;
}>();

export abstract class MemoryManagerDatabaseContext {
  protected abstract publishedDatabase: MemoryIndexDatabase;

  protected get database(): MemoryIndexDatabase {
    const context = reindexDatabase.getStore();
    const shadow = context?.manager === this ? context.database : undefined;
    if (shadow?.closed) {
      throw new Error("Memory reindex database context is closed");
    }
    return shadow ?? this.publishedDatabase;
  }

  protected get db(): DatabaseSync {
    return this.database.db;
  }

  protected get vector() {
    return this.database.vector;
  }

  protected get fts() {
    return this.database.fts;
  }

  protected withPublishedDatabase<T>(run: () => T): T {
    // Public calls can originate in reindex progress/provider callbacks. They
    // must never inherit the temporary writer or outlive its connection.
    return reindexDatabase.exit(run);
  }

  protected async withReindexDatabase<T>(
    database: MemoryIndexDatabase,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await reindexDatabase.run({ manager: this, database }, run);
      // Publication attaches the finished file only after its writer closes.
      database.release();
      return result;
    } finally {
      try {
        database.release();
      } catch {}
    }
  }
}
