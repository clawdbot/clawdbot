import { randomUUID } from "node:crypto";
import type * as LanceDB from "@lancedb/lancedb";
import type { MemoryCategory } from "./config.js";
import { loadLanceDbModule } from "./lancedb-runtime.js";
import {
  hasAgentScopeColumn,
  legacyMemorySchemaError,
  memoryAgentPredicate,
  MEMORY_TABLE_NAME,
  quoteLanceSqlString,
} from "./lancedb-schema.js";

const SCHEMA_SENTINEL_ID = "__schema__";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  createdAt: number;
};

type MemoryListEntry = Omit<MemoryEntry, "vector">;

type MemoryListOptions = {
  orderByCreatedAt?: boolean;
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

export const MEMORY_QUERY_COLUMNS = ["id", "text", "importance", "category", "createdAt"] as const;
export type MemoryQueryColumn = (typeof MEMORY_QUERY_COLUMNS)[number];
export type MemoryQueryFilter = {
  column: MemoryQueryColumn;
  operator: "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "LIKE";
  value: string | number;
};

type MemoryQueryOptions = {
  columns: MemoryQueryColumn[];
  filter?: MemoryQueryFilter;
  limit?: number;
};

type StoredMemoryRow = MemoryEntry & {
  agentId: string;
};

function formatQueryFilter(filter: MemoryQueryFilter): string {
  if (filter.operator === "LIKE" && typeof filter.value !== "string") {
    throw new Error("LIKE requires a string memory filter value");
  }
  if (typeof filter.value === "number" && !Number.isFinite(filter.value)) {
    throw new Error("Memory filter number must be finite");
  }
  const value =
    typeof filter.value === "string" ? quoteLanceSqlString(filter.value) : String(filter.value);
  return `${filter.column} ${filter.operator} ${value}`;
}

function scopedPredicate(agentId: string, filter?: MemoryQueryFilter): string {
  const scope = memoryAgentPredicate(agentId);
  return filter ? `(${scope}) AND (${formatQueryFilter(filter)})` : scope;
}

export class MemoryDB {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly storageOptions?: Record<string, string>,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return await this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDbModule();
    const connectionOptions: LanceDB.ConnectionOptions = this.storageOptions
      ? { storageOptions: this.storageOptions }
      : {};
    const db = await lancedb.connect(this.dbPath, connectionOptions);
    let table: LanceDB.Table | null = null;
    try {
      const tables = await db.tableNames();

      if (tables.includes(MEMORY_TABLE_NAME)) {
        table = await db.openTable(MEMORY_TABLE_NAME);
        if (!hasAgentScopeColumn(await table.schema())) {
          throw legacyMemorySchemaError();
        }
      } else {
        table = await db.createTable(MEMORY_TABLE_NAME, [
          {
            id: SCHEMA_SENTINEL_ID,
            text: "",
            vector: Array.from({ length: this.vectorDim }).fill(0),
            importance: 0,
            category: "other",
            createdAt: 0,
            agentId: SCHEMA_SENTINEL_ID,
          },
        ]);
        await table.delete(`id = ${quoteLanceSqlString(SCHEMA_SENTINEL_ID)}`);
      }

      this.db = db;
      this.table = table;
    } catch (error) {
      table?.close();
      db.close();
      throw error;
    }
  }

  async store(agentId: string, entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    const storedEntry: StoredMemoryRow = { ...fullEntry, agentId };

    await this.table!.add([storedEntry]);
    return fullEntry;
  }

  async search(
    agentId: string,
    vector: number[],
    limit = 5,
    minScore = 0.5,
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // LanceDB applies metadata predicates before vector ranking. Foreign rows
    // must never enter this agent's candidate set or top-K.
    const results = await this.table!.vectorSearch(vector)
      .where(memoryAgentPredicate(agentId))
      .limit(limit)
      .toArray();

    const mapped = results.map((row) => {
      const distance = row["_distance"] ?? 0;
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          importance: row.importance as number,
          category: row.category as MemoryEntry["category"],
          createdAt: row.createdAt as number,
        },
        score,
      };
    });

    return mapped.filter((result) => result.score >= minScore);
  }

  async list(
    agentId: string,
    limit?: number,
    options: MemoryListOptions = {},
  ): Promise<MemoryListEntry[]> {
    await this.ensureInitialized();

    let query = this.table!.query()
      .where(memoryAgentPredicate(agentId))
      .select(["id", "text", "importance", "category", "createdAt"]);
    if (!options.orderByCreatedAt && limit !== undefined) {
      query = query.limit(limit);
    }

    const rows = await query.toArray();
    const entries = rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      importance: row.importance as number,
      category: row.category as MemoryEntry["category"],
      createdAt: row.createdAt as number,
    }));
    if (options.orderByCreatedAt) {
      entries.sort((a, b) => b.createdAt - a.createdAt);
    }

    return limit === undefined ? entries : entries.slice(0, limit);
  }

  async query(agentId: string, options: MemoryQueryOptions): Promise<Record<string, unknown>[]> {
    await this.ensureInitialized();

    let query = this.table!.query()
      // LanceDB 0.30 replaces rather than combines repeated where() calls.
      // Scope and operator filter stay one predicate so scope cannot be lost.
      .where(scopedPredicate(agentId, options.filter))
      .select(options.columns);
    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }
    return (await query.toArray()) as Record<string, unknown>[];
  }

  async delete(agentId: string, id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    const predicate = scopedPredicate(agentId, { column: "id", operator: "=", value: id });
    if ((await this.table!.countRows(predicate)) === 0) {
      return false;
    }
    await this.table!.delete(predicate);
    return true;
  }

  async count(agentId: string): Promise<number> {
    await this.ensureInitialized();
    return await this.table!.countRows(memoryAgentPredicate(agentId));
  }

  close(): void {
    this.table?.close();
    this.db?.close();
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}
