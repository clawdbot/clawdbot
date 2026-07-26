import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolveAllAgentSessionStoreCandidateTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  collectSharedStateSessionKeys,
  deleteRepairJournal,
  readRepairJournal,
  readRepairJournalReadOnly,
  rewriteSharedStateSessionKeys,
  type ReservedKeyRename,
  writeRepairJournal,
} from "./doctor-session-incognito-key-repair-state.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

export type ReservedIncognitoKeyRepairReport = {
  found: number;
  repaired: number;
};

export function repairReservedIncognitoSessionKeys(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ReservedIncognitoKeyRepairReport {
  const targets = listExistingAgentDatabaseTargets(params.cfg, params.env);
  const reservedKeys = new Set<string>();
  const sharedDatabase = params.apply ? openOpenClawStateDatabase({ env: params.env }) : undefined;
  const journalRenames = sharedDatabase
    ? readRepairJournal(sharedDatabase.db)
    : readRepairJournalReadOnly(params.env);
  const occupiedKeys = sharedDatabase
    ? collectSharedStateSessionKeys(sharedDatabase.db)
    : new Set<string>();
  for (const target of targets) {
    const inspected = withOpenClawAgentDatabaseReadOnly(
      (database) => ({
        occupied: params.apply ? collectOccupiedSessionKeys(database.db) : new Set<string>(),
        reserved: listReservedIncognitoKeys(database.db),
      }),
      { agentId: target.agentId, env: params.env, path: target.sqlitePath },
    );
    if (!inspected.found) {
      continue;
    }
    for (const key of inspected.value.reserved) {
      reservedKeys.add(key);
    }
    for (const key of inspected.value.occupied) {
      occupiedKeys.add(key);
    }
  }
  const pendingKeys = new Set(reservedKeys);
  for (const rename of journalRenames) {
    pendingKeys.add(rename.from);
  }
  if (!params.apply) {
    return { found: pendingKeys.size, repaired: 0 };
  }
  if (reservedKeys.size === 0 && journalRenames.length === 0) {
    return { found: 0, repaired: 0 };
  }

  for (const rename of journalRenames) {
    occupiedKeys.add(rename.to);
  }
  const journalSources = new Set(journalRenames.map((rename) => rename.from));
  const newRenames = planReservedIncognitoKeyRenames(
    [...reservedKeys].filter((key) => !journalSources.has(key)).toSorted(),
    occupiedKeys,
  );
  const renames = [...journalRenames, ...newRenames];
  const renameMap = new Map(renames.map((item) => [item.from, item.to]));
  runOpenClawStateWriteTransaction(
    (database) => writeRepairJournal(database.db, renames),
    { env: params.env },
    { operationLabel: "doctor.journal-reserved-incognito-session-keys" },
  );
  runOpenClawStateWriteTransaction(
    (database) => rewriteSharedStateSessionKeys(database.db, renameMap),
    { env: params.env },
    { operationLabel: "doctor.rename-reserved-incognito-shared-state-keys" },
  );
  for (const target of targets) {
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    const options = { agentId: target.agentId, env: params.env, path: target.sqlitePath };
    try {
      runOpenClawAgentWriteTransaction(
        (database) => applyReservedIncognitoKeyRenames(database.db, renames),
        options,
        { operationLabel: "doctor.rename-reserved-incognito-session-keys" },
      );
    } finally {
      if (!wasOpen) {
        closeOpenClawAgentDatabaseByPath(target.sqlitePath);
      }
    }
  }
  runOpenClawStateWriteTransaction(
    (database) => deleteRepairJournal(database.db),
    { env: params.env },
    { operationLabel: "doctor.complete-reserved-incognito-session-keys" },
  );
  return { found: pendingKeys.size, repaired: renames.length };
}

function listExistingAgentDatabaseTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; sqlitePath: string }> {
  const seenPaths = new Set<string>();
  return resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }).flatMap((target) => {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (seenPaths.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      return [];
    }
    seenPaths.add(sqlitePath);
    return [{ agentId: target.agentId, sqlitePath }];
  });
}

function planReservedIncognitoKeyRenames(
  keys: readonly string[],
  occupied: Set<string>,
): ReservedKeyRename[] {
  return keys.map((key) => {
    const base = legacyIncognitoSessionKey(key);
    const internalEffectsKey = parseAgentSessionKey(key)?.rest.startsWith(
      "internal-session-effects:",
    );
    if (internalEffectsKey && occupied.has(base)) {
      throw new Error(`Cannot repair internal session key because ${base} already exists`);
    }
    let candidate = base;
    let suffix = 1;
    while (occupied.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    occupied.add(candidate);
    return { from: key, to: candidate };
  });
}

function applyReservedIncognitoKeyRenames(
  database: DatabaseSync,
  renames: readonly ReservedKeyRename[],
): void {
  if (renames.length === 0) {
    return;
  }
  // Board widget foreign keys are immediate; defer them so every key-bearing row renames atomically.
  database.exec("PRAGMA defer_foreign_keys = ON;"); // sqlite-allow-raw -- transaction-local FK deferral.
  for (const rename of renames) {
    updateSessionKeyColumns(database, rename);
  }
  rewriteSessionEntryJsonReferences(database, new Map(renames.map((item) => [item.from, item.to])));
}

function legacyIncognitoSessionKey(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || !isIncognitoSessionKey(sessionKey)) {
    throw new Error(`Cannot rename non-incognito session key: ${sessionKey}`);
  }
  return `agent:${parsed.agentId}:${parsed.rest.replace(":incognito-", ":legacy-incognito-")}`;
}

function listReservedIncognitoKeys(database: DatabaseSync): string[] {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const keys = new Set<string>();
  for (const row of executeSqliteQuerySync(
    database,
    db.selectFrom("session_nodes").select("session_key"),
  ).rows) {
    keys.add(row.session_key);
  }
  for (const row of executeSqliteQuerySync(
    database,
    db.selectFrom("session_windows").select("session_key"),
  ).rows) {
    keys.add(row.session_key);
  }
  return [...keys].filter(isIncognitoSessionKey).toSorted();
}

function collectOccupiedSessionKeys(database: DatabaseSync): Set<string> {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const keys = new Set<string>();
  const collect = (values: Array<string | null>) => {
    for (const value of values) {
      if (value) {
        keys.add(value);
      }
    }
  };
  collect(
    executeSqliteQuerySync(
      database,
      db.selectFrom("session_windows").select(["session_key", "parent_session_key", "spawned_by"]),
    ).rows.flatMap((row) => [row.session_key, row.parent_session_key, row.spawned_by]),
  );
  collect(
    executeSqliteQuerySync(
      database,
      db
        .selectFrom("session_nodes")
        .select(["session_key", "parent_session_key", "spawned_by", "fork_source_session_key"]),
    ).rows.flatMap((row) => [
      row.session_key,
      row.parent_session_key,
      row.spawned_by,
      row.fork_source_session_key,
    ]),
  );
  collect(
    executeSqliteQuerySync(
      database,
      db.selectFrom("conversation_deliveries").select("source_session_key"),
    ).rows.map((row) => row.source_session_key),
  );
  for (const row of executeSqliteQuerySync(
    database,
    db.selectFrom("session_nodes").select("entry_json"),
  ).rows) {
    try {
      collectSessionEntryKeyFields(JSON.parse(row.entry_json), keys);
    } catch {
      // Canonical rows are valid JSON; a malformed row is reported by the existing integrity pass.
    }
  }
  collect(
    executeSqliteQuerySync(database, db.selectFrom("board_tabs").select("session_key")).rows.map(
      (row) => row.session_key,
    ),
  );
  collect(
    executeSqliteQuerySync(database, db.selectFrom("board_widgets").select("session_key")).rows.map(
      (row) => row.session_key,
    ),
  );
  collect(
    executeSqliteQuerySync(
      database,
      db.selectFrom("heartbeat_outcomes").select(["session_key", "run_session_key"]),
    ).rows.flatMap((row) => [row.session_key, row.run_session_key]),
  );
  return keys;
}

function updateSessionKeyColumns(database: DatabaseSync, rename: ReservedKeyRename): void {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const update = (query: Parameters<typeof executeSqliteQuerySync>[1]) =>
    executeSqliteQuerySync(database, query);
  update(
    db
      .updateTable("session_windows")
      .set({ session_key: rename.to })
      .where("session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("session_windows")
      .set({ parent_session_key: rename.to })
      .where("parent_session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("session_windows")
      .set({ spawned_by: rename.to })
      .where("spawned_by", "=", rename.from),
  );
  update(
    db
      .updateTable("session_nodes")
      .set({ session_key: rename.to })
      .where("session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("session_nodes")
      .set({ parent_session_key: rename.to })
      .where("parent_session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("session_nodes")
      .set({ spawned_by: rename.to })
      .where("spawned_by", "=", rename.from),
  );
  update(
    db
      .updateTable("session_nodes")
      .set({ fork_source_session_key: rename.to })
      .where("fork_source_session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("conversation_deliveries")
      .set({ source_session_key: rename.to })
      .where("source_session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("session_members")
      .set({ session_key: rename.to })
      .where("session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("board_tabs")
      .set({ session_key: rename.to })
      .where("session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("board_widgets")
      .set({ session_key: rename.to })
      .where("session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("heartbeat_outcomes")
      .set({ session_key: rename.to })
      .where("session_key", "=", rename.from),
  );
  update(
    db
      .updateTable("heartbeat_outcomes")
      .set({ run_session_key: rename.to })
      .where("run_session_key", "=", rename.from),
  );
}

function rewriteSessionEntryJsonReferences(
  database: DatabaseSync,
  renames: ReadonlyMap<string, string>,
): void {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db.selectFrom("session_nodes").select(["session_key", "entry_json"]),
  ).rows;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.entry_json);
    } catch {
      continue;
    }
    const rewritten = rewriteSessionEntryKeyFields(parsed, renames);
    const entryJson = JSON.stringify(rewritten);
    if (entryJson === row.entry_json) {
      continue;
    }
    executeSqliteQuerySync(
      database,
      db
        .updateTable("session_nodes")
        .set({ entry_json: entryJson })
        .where("session_key", "=", row.session_key),
    );
  }
}

function rewriteSessionEntryKeyFields(
  value: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  visitSessionEntryKeyFields(value, (record, key) => {
    const current = record[key];
    if (typeof current === "string") {
      record[key] = renames.get(current) ?? current;
    }
  });
  return value;
}

function collectSessionEntryKeyFields(value: unknown, keys: Set<string>): void {
  visitSessionEntryKeyFields(value, (record, key) => {
    const current = record[key];
    if (typeof current === "string") {
      keys.add(current);
    }
  });
}

function visitSessionEntryKeyFields(
  value: unknown,
  visit: (record: Record<string, unknown>, key: string) => void,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const entry = value as Record<string, unknown>;
  for (const key of [
    "heartbeatIsolatedBaseSessionKey",
    "spawnedBy",
    "completionOwnerSessionKey",
    "parentSessionKey",
  ]) {
    visit(entry, key);
  }
  if (
    entry.forkSource &&
    typeof entry.forkSource === "object" &&
    !Array.isArray(entry.forkSource)
  ) {
    const forkSource = entry.forkSource as Record<string, unknown>;
    visit(forkSource, "sessionKey");
  }
  if (Array.isArray(entry.compactionCheckpoints)) {
    for (const checkpoint of entry.compactionCheckpoints) {
      if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
        continue;
      }
      const record = checkpoint as Record<string, unknown>;
      visit(record, "sessionKey");
    }
  }
  if (
    entry.systemPromptReport &&
    typeof entry.systemPromptReport === "object" &&
    !Array.isArray(entry.systemPromptReport)
  ) {
    const report = entry.systemPromptReport as Record<string, unknown>;
    visit(report, "sessionKey");
  }
}
