import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type * as LanceDB from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from "apache-arrow";
import type { MemoryCategory } from "./config.js";
import { loadLanceDbModule } from "./lancedb-runtime.js";
import {
  hasAgentScopeColumn,
  hasMemoryScopeColumn,
  legacyMemorySchemaError,
  legacyScopeSchemaError,
  memoryAgentPredicate,
  MEMORY_SCOPE_COLUMN,
  memoryScopePredicate,
  MEMORY_TABLE_NAME,
  quoteLanceSqlString,
} from "./lancedb-schema.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE_INITIALIZATION_ATTEMPTS = 3;

export type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  createdAt: number;
  /** Opaque caller-defined partition within one agent's rows; "" = global. */
  scope?: string;
};

type MemoryListEntry = Omit<MemoryEntry, "vector">;

type MemoryListOptions = {
  orderByCreatedAt?: boolean;
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

export const MEMORY_QUERY_COLUMNS = [
  "id",
  "text",
  "importance",
  "category",
  "createdAt",
  "scope",
] as const;
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

function createMemoryTableSchema(vectorDim: number): Schema {
  return new Schema([
    new Field("id", new Utf8(), true),
    new Field("text", new Utf8(), true),
    new Field("vector", new FixedSizeList(vectorDim, new Field("item", new Float32(), true)), true),
    new Field("importance", new Float64(), true),
    new Field("category", new Utf8(), true),
    new Field("createdAt", new Float64(), true),
    new Field("agentId", new Utf8(), true),
    new Field("scope", new Utf8(), true),
  ]);
}

async function openOrCreateMemoryTable(
  db: LanceDB.Connection,
  vectorDim: number,
): Promise<LanceDB.Table> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TABLE_INITIALIZATION_ATTEMPTS; attempt += 1) {
    let table: LanceDB.Table | null = null;
    try {
      const tables = await db.tableNames();
      table = tables.includes(MEMORY_TABLE_NAME)
        ? await db.openTable(MEMORY_TABLE_NAME)
        : await db.createEmptyTable(MEMORY_TABLE_NAME, createMemoryTableSchema(vectorDim), {
            existOk: true,
          });
      // A concurrent create can expose the table name before its first version
      // is readable. Probe the schema and retry the whole dependency boundary.
      await table.schema();
      return table;
    } catch (error) {
      table?.close();
      lastError = error;
      if (attempt < TABLE_INITIALIZATION_ATTEMPTS) {
        await delay(attempt * 10);
      }
    }
  }
  throw lastError;
}

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
  private hasScopeColumn = true;

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
      table = await openOrCreateMemoryTable(db, this.vectorDim);
      const schema = await table.schema();
      if (!hasAgentScopeColumn(schema)) {
        throw legacyMemorySchemaError();
      }
      // Schema changes are never applied during normal runtime initialization:
      // adding the scope column goes through explicit `openclaw doctor --fix`
      // (see the doctor-only entry in doctor-contract-api.ts), which previews,
      // mutates, and verifies the table. Until that runs, a pre-scope table
      // stays fully usable in legacy mode: every row is global, unscoped
      // operations behave exactly as before the column existed, scoped reads
      // match nothing, and only a scoped write is refused (see store()).
      this.hasScopeColumn = hasMemoryScopeColumn(schema);

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
      scope: "",
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    // A partitioned write cannot be represented on a table that predates the
    // scope column — refusing it (with a Doctor pointer) is the only safe
    // option, because storing it global would silently mis-scope the memory.
    // Global writes keep working: they use the pre-scope row shape.
    if (!this.hasScopeColumn && fullEntry.scope) {
      throw legacyScopeSchemaError();
    }
    const storedEntry: StoredMemoryRow = { ...fullEntry, agentId };
    if (!this.hasScopeColumn) {
      delete storedEntry.scope;
    }

    await this.table!.add([storedEntry]);
    return fullEntry;
  }

  async search(
    agentId: string,
    vector: number[],
    limit = 5,
    minScore = 0.5,
    executionOptions?: Pick<LanceDB.QueryExecutionOptions, "timeoutMs">,
    scope?: string,
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // A legacy (pre-scope) table has no partitioned rows: a scoped search
    // matches nothing by definition, and a scope predicate would error on the
    // missing column, so short-circuit. Its global view ("" and undefined
    // alike) is the plain agent predicate — exactly the pre-scope behavior.
    if (!this.hasScopeColumn && scope) {
      return [];
    }
    // LanceDB applies metadata predicates before vector ranking. Foreign rows
    // must never enter this agent's candidate set or top-K. When a scope is
    // given ("" = global-only, non-empty = that exact partition), it joins the
    // same single predicate — LanceDB replaces rather than combines repeated
    // where() calls, so agent isolation cannot be lost.
    const predicate =
      scope === undefined || !this.hasScopeColumn
        ? memoryAgentPredicate(agentId)
        : `(${memoryAgentPredicate(agentId)}) AND (${memoryScopePredicate(scope)})`;
    const results = await this.table!.vectorSearch(vector)
      .where(predicate)
      .limit(limit)
      .toArray(executionOptions);

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
          // scope is a nullable Utf8 column; legacy rows (NULL or a pre-scope
          // schema) normalize to "" (global).
          scope: typeof row.scope === "string" ? row.scope : "",
        },
        score,
      };
    });

    return mapped.filter((result) => result.score >= minScore);
  }

  // Returns the scope of one of this agent's rows by id ("" = global), or null
  // when the agent has no such row. Used to fence memoryId-based deletes to the
  // caller's partition without leaking other agents' rows.
  async getScopeById(agentId: string, id: string): Promise<string | null> {
    await this.ensureInitialized();
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    const rows = await this.table!.query()
      .where(scopedPredicate(agentId, { column: "id", operator: "=", value: id }))
      .limit(1)
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    // scope is a nullable Utf8 column; NULL or a pre-scope schema reads as ""
    // (global) for the fence comparison.
    const rowScope = rows[0]?.scope;
    return typeof rowScope === "string" ? rowScope : "";
  }

  async list(
    agentId: string,
    limit?: number,
    options: MemoryListOptions = {},
  ): Promise<MemoryListEntry[]> {
    await this.ensureInitialized();

    // Operators need the partition key to know which scope a row lives in;
    // a pre-scope table has no such column, so it is selected conditionally
    // and every legacy row reads as "" (global) — which is exactly its state.
    const columns = ["id", "text", "importance", "category", "createdAt"];
    if (this.hasScopeColumn) {
      columns.push(MEMORY_SCOPE_COLUMN);
    }
    let query = this.table!.query().where(memoryAgentPredicate(agentId)).select(columns);
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
      scope: typeof row.scope === "string" ? row.scope : "",
    }));
    if (options.orderByCreatedAt) {
      entries.sort((a, b) => b.createdAt - a.createdAt);
    }

    return limit === undefined ? entries : entries.slice(0, limit);
  }

  async query(agentId: string, options: MemoryQueryOptions): Promise<Record<string, unknown>[]> {
    await this.ensureInitialized();

    // Legacy (pre-scope) tables: selecting the absent scope column is silently
    // dropped (the output faithfully shows the table's real shape), while an
    // explicit scope FILTER is refused with the Doctor pointer — the operator
    // asked a partition question the table cannot answer yet.
    let columns = options.columns;
    if (!this.hasScopeColumn) {
      if (options.filter?.column === MEMORY_SCOPE_COLUMN) {
        throw legacyScopeSchemaError();
      }
      columns = columns.filter((column) => column !== MEMORY_SCOPE_COLUMN);
    }

    let query = this.table!.query()
      // LanceDB 0.30 replaces rather than combines repeated where() calls.
      // Scope and operator filter stay one predicate so scope cannot be lost.
      .where(scopedPredicate(agentId, options.filter))
      .select(columns);
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
    const result = await this.table!.delete(predicate);
    return result.numDeletedRows > 0;
  }

  async count(agentId: string): Promise<number> {
    await this.ensureInitialized();
    return await this.table!.countRows(memoryAgentPredicate(agentId));
  }

  // Operator statistics: how many of this agent's rows live in a non-global
  // partition. A pre-scope table has no partitioned rows by definition.
  async countScoped(agentId: string): Promise<number> {
    await this.ensureInitialized();
    if (!this.hasScopeColumn) {
      return 0;
    }
    const scoped = `${MEMORY_SCOPE_COLUMN} IS NOT NULL AND ${MEMORY_SCOPE_COLUMN} != ''`;
    return await this.table!.countRows(`(${memoryAgentPredicate(agentId)}) AND (${scoped})`);
  }

  close(): void {
    this.table?.close();
    this.db?.close();
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}
