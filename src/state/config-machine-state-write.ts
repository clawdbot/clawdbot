// Machine-state mutations own serialization and the shared write transaction.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  normalizeConfigMachineStateKey,
  type ConfigMachineStateDatabase,
} from "./config-machine-state.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

function serializeStateValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("config machine state value must be JSON-serializable");
  }
  return serialized;
}

export function writeConfigMachineState(
  key: string,
  value: unknown,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const stateKey = normalizeConfigMachineStateKey(key);
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
  options?: OpenClawStateDatabaseOptions,
): T;
/** Returning undefined removes the key within the same compare-and-update transaction. */
export function updateConfigMachineState<T>(
  key: string,
  update: (current: T | undefined) => T | undefined,
  options?: OpenClawStateDatabaseOptions,
): T | undefined;
export function updateConfigMachineState<T>(
  key: string,
  update: (current: T | undefined) => T | undefined,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const stateKey = normalizeConfigMachineStateKey(key);
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
      // SAFETY: Each key's owner supplies its JSON shape; this generic store only decodes it.
      const value = update(row ? (JSON.parse(row.value_json) as T) : undefined);
      if (value === undefined) {
        if (row) {
          executeSqliteQuerySync(
            database.db,
            db.deleteFrom("config_machine_state").where("state_key", "=", stateKey),
          );
        }
        return undefined;
      }
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

/** Delete one machine-state value, reporting whether a stored value existed. */
export function deleteConfigMachineState(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const stateKey = normalizeConfigMachineStateKey(key);
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database.db);
      const result = executeSqliteQuerySync(
        database.db,
        db.deleteFrom("config_machine_state").where("state_key", "=", stateKey),
      );
      return (result.numAffectedRows ?? 0n) > 0n;
    },
    options,
    { operationLabel: "config-machine-state.delete" },
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
    key: normalizeConfigMachineStateKey(key),
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
