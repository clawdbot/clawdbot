import { isDeepStrictEqual } from "node:util";
import type { Insertable } from "kysely";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  type AcpSessionEntryBinding,
  type AcpSessionRow,
  type AcpSessionsTable,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  legacyAcpDatabaseSessionKeys,
  selectAcpSessionRow,
} from "./session-meta-keys.js";
import { rowToAcpSessionMeta } from "./session-meta.js";

export function readAcpSessionMetaForOwnerMigration(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry: AcpSessionEntryBinding;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}) {
  const keys = [
    buildAcpDatabaseSessionKey(params.sessionKey, params.agentId),
    ...legacyAcpDatabaseSessionKeys(params.sessionKey, params.agentId, params.cfg),
    params.sessionKey,
  ];
  const row = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      keys
        .map((key) => selectAcpSessionRow(db, key))
        .find(
          (candidate) =>
            candidate?.agent === params.agentId &&
            acpSessionRowMatchesEntry(candidate, params.entry),
        ),
    { env: params.env, path: params.databasePath },
  );
  return row ? rowToAcpSessionMeta(row) : undefined;
}

export type AcpOwnerMigrationClaimResult = "claimed" | "already-claimed" | "conflict" | "missing";

/** Doctor-only claim that consumes one legacy ACP identity before session state is rehomed. */
export function claimAcpSessionMetaForOwnerMigration(params: {
  cfg: OpenClawConfig;
  sourceAgentId: string;
  sourceSessionKey: string;
  targetAgentId: string;
  targetSessionKey: string;
  expectedAgent: string;
  entry: AcpSessionEntryBinding;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
}): AcpOwnerMigrationClaimResult {
  const sourceDatabaseKeys = [
    buildAcpDatabaseSessionKey(params.sourceSessionKey, params.sourceAgentId),
    ...legacyAcpDatabaseSessionKeys(params.sourceSessionKey, params.sourceAgentId, params.cfg),
    params.sourceSessionKey,
  ];
  const targetDatabaseKey = buildAcpDatabaseSessionKey(
    params.targetSessionKey,
    params.targetAgentId,
  );
  const targetDatabaseKeys = [
    targetDatabaseKey,
    ...legacyAcpDatabaseSessionKeys(params.targetSessionKey, params.targetAgentId, params.cfg),
  ];
  let result: AcpOwnerMigrationClaimResult = "missing";
  runOpenClawStateWriteTransaction(
    (database) => {
      const sourceRows = [...new Set(sourceDatabaseKeys)].flatMap((key) => {
        const row = selectAcpSessionRow(database.db, key);
        return row ? [row] : [];
      });
      const targetMatches = [...new Set(targetDatabaseKeys)].flatMap((key) => {
        const row = selectAcpSessionRow(database.db, key);
        return row ? [{ key, row }] : [];
      });
      const targetMatch = targetMatches[0];
      if (targetMatch?.row) {
        const targetRow = targetMatch.row;
        if (
          targetRow.agent !== params.expectedAgent ||
          !acpSessionRowMatchesEntry(targetRow, params.entry)
        ) {
          result = "conflict";
          return;
        }
        const divergentTarget = targetMatches.find(
          ({ row }) =>
            row.agent !== params.expectedAgent ||
            !acpSessionRowMatchesEntry(row, params.entry) ||
            !sameAcpSessionMetadata(row, targetRow),
        );
        if (divergentTarget) {
          result = "conflict";
          return;
        }
        const divergentSource = sourceRows.find(
          (row) =>
            row.agent !== params.expectedAgent ||
            !acpSessionRowMatchesEntry(row, params.entry) ||
            !sameAcpSessionMetadata(row, targetRow),
        );
        if (divergentSource) {
          result = "conflict";
          return;
        }
        if (targetMatch.key !== targetDatabaseKey) {
          insertRow(database.db, {
            ...targetRow,
            session_key: targetDatabaseKey,
            updated_at: params.now?.() ?? Date.now(),
          });
          deleteMatchingRows({
            db: database.db,
            entry: params.entry,
            except: targetDatabaseKey,
            expectedAgent: params.expectedAgent,
            keys: targetDatabaseKeys,
          });
        }
        deleteMatchingRows({
          db: database.db,
          entry: params.entry,
          except: targetRow.session_key,
          expectedAgent: params.expectedAgent,
          keys: sourceDatabaseKeys,
        });
        result = "already-claimed";
        return;
      }
      const sourceRow = sourceRows.find(
        (row) => row.agent === params.expectedAgent && acpSessionRowMatchesEntry(row, params.entry),
      );
      if (!sourceRow) {
        return;
      }
      const divergentSource = sourceRows.find(
        (row) =>
          row.agent !== params.expectedAgent ||
          !acpSessionRowMatchesEntry(row, params.entry) ||
          !sameAcpSessionMetadata(row, sourceRow),
      );
      if (divergentSource) {
        result = "conflict";
        return;
      }
      insertRow(database.db, {
        ...sourceRow,
        session_key: targetDatabaseKey,
        updated_at: params.now?.() ?? Date.now(),
      });
      deleteMatchingRows({
        db: database.db,
        entry: params.entry,
        except: targetDatabaseKey,
        expectedAgent: params.expectedAgent,
        keys: sourceDatabaseKeys,
      });
      result = "claimed";
    },
    { env: params.env, path: params.databasePath },
  );
  return result;
}

function sameAcpSessionMetadata(left: AcpSessionRow, right: AcpSessionRow): boolean {
  return isDeepStrictEqual(rowToAcpSessionMeta(left), rowToAcpSessionMeta(right));
}

function deleteMatchingRows(params: {
  db: Parameters<typeof getAcpSessionKysely>[0];
  entry: AcpSessionEntryBinding;
  except: string;
  expectedAgent: string;
  keys: string[];
}) {
  for (const key of new Set(params.keys)) {
    if (key === params.except) {
      continue;
    }
    const row = selectAcpSessionRow(params.db, key);
    if (
      !row ||
      row.agent !== params.expectedAgent ||
      !acpSessionRowMatchesEntry(row, params.entry)
    ) {
      continue;
    }
    executeSqliteQuerySync(
      params.db,
      getAcpSessionKysely(params.db).deleteFrom("acp_sessions").where("session_key", "=", key),
    );
  }
}

function insertRow(
  db: Parameters<typeof getAcpSessionKysely>[0],
  row: Insertable<AcpSessionsTable>,
): void {
  executeSqliteQuerySync(db, getAcpSessionKysely(db).insertInto("acp_sessions").values(row));
}
