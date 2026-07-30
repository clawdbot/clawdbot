// Machine-owned values retired from openclaw.json live in the shared state database.
import { existsSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type ConfigMachineStateDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

function normalizeStateKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("config machine state key must not be empty");
  }
  return normalized;
}

function serializeStateValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("config machine state value must be JSON-serializable");
  }
  return serialized;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineState<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
  if (!existsSync(pathname)) {
    return undefined;
  }
  return withOpenClawStateDatabaseReadOnly(({ db: database }) => {
    if (!tableExists(database, "config_machine_state")) {
      return undefined;
    }
    const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
    const row = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", normalizeStateKey(key)),
    );
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }, options);
}

export function writeConfigMachineState(
  key: string,
  value: unknown,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const stateKey = normalizeStateKey(key);
  const valueJson = serializeStateValue(value);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("config_machine_state")
          .values({ state_key: stateKey, value_json: valueJson, updated_at_ms: now })
          .onConflict((conflict) =>
            conflict.column("state_key").doUpdateSet({ value_json: valueJson, updated_at_ms: now }),
          ),
      );
    },
    options,
    { operationLabel: "config-machine-state.write" },
  );
}

/** Atomically update one machine-state value from its current database value. */
export function updateConfigMachineState<T>(
  key: string,
  update: (current: T | undefined) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const stateKey = normalizeStateKey(key);
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("config_machine_state")
          .select("value_json")
          .where("state_key", "=", stateKey),
      );
      const value = update(row ? (JSON.parse(row.value_json) as T) : undefined);
      const valueJson = serializeStateValue(value);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("config_machine_state")
          .values({ state_key: stateKey, value_json: valueJson, updated_at_ms: now })
          .onConflict((conflict) =>
            conflict.column("state_key").doUpdateSet({ value_json: valueJson, updated_at_ms: now }),
          ),
      );
      return value;
    },
    options,
    { operationLabel: "config-machine-state.update" },
  );
}

/** Import retired config values without replacing newer canonical database state. */
export function importConfigMachineState(
  entries: ReadonlyArray<readonly [key: string, value: unknown]>,
  options: OpenClawStateDatabaseOptions = {},
): { imported: string[]; kept: string[] } {
  if (entries.length === 0) {
    return { imported: [], kept: [] };
  }
  const normalized = entries.map(([key, value]) => ({
    key: normalizeStateKey(key),
    valueJson: serializeStateValue(value),
  }));
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database.db);
      const imported: string[] = [];
      const kept: string[] = [];
      for (const entry of normalized) {
        const existing = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("config_machine_state")
            .select("state_key")
            .where("state_key", "=", entry.key),
        );
        if (existing) {
          kept.push(entry.key);
          continue;
        }
        executeSqliteQuerySync(
          database.db,
          db.insertInto("config_machine_state").values({
            state_key: entry.key,
            value_json: entry.valueJson,
            updated_at_ms: now,
          }),
        );
        imported.push(entry.key);
      }
      return { imported, kept };
    },
    options,
    { operationLabel: "config-machine-state.import" },
  );
}
