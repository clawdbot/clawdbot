import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../utils/delivery-context.shared.js";
import type { DoctorSessionScanScope } from "./session-accessor.sqlite-canonical-inventory.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { stripRuntimeOnlySessionSkillsFields } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

const DOCTOR_SESSION_REWRITE_BATCH_SIZE = 64;

export function iterateDoctorSessionKeyBatches(sessionKeys: readonly string[]): string[][] {
  return chunkItems(uniqueStrings(sessionKeys).toSorted(), DOCTOR_SESSION_REWRITE_BATCH_SIZE);
}

/** Rewrites bounded entry batches after rereading each authoritative row inside its commit. */
export function rewriteDoctorSessionEntries(params: {
  scope: DoctorSessionScanScope;
  sessionKeys: readonly string[];
  transform: (entry: SessionEntry, sessionKey: string) => SessionEntry;
  updateDeliveryProjection?: boolean;
}): number {
  const resolved = resolveSqliteScope({ ...params.scope, sessionKey: "" });
  let rewritten = 0;
  for (const batch of iterateDoctorSessionKeyBatches(params.sessionKeys)) {
    rewritten += runOpenClawAgentWriteTransaction(
      (database) => {
        const db = getSessionKysely(database.db);
        let batchRewritten = 0;
        for (const sessionKey of batch) {
          const row = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_nodes")
              .select(["session_key", "current_session_id", "entry_json", "updated_at"])
              .where("session_key", "=", sessionKey),
          ).rows[0];
          if (!row) {
            continue;
          }
          const entry = parseSqliteSessionEntryRecord(row);
          if (!entry) {
            continue;
          }
          const transformedEntry = params.transform(entry, sessionKey);
          const transformedJson = JSON.stringify(transformedEntry);
          // Incognito repair scans unrelated rows; only its changed entries may be rewritten.
          if (transformedJson === row.entry_json) {
            continue;
          }
          const nextEntry = stripRuntimeOnlySessionSkillsFields(transformedEntry);
          const entryJson =
            nextEntry === transformedEntry ? transformedJson : JSON.stringify(nextEntry);
          if (!parseSqliteSessionEntryRecord({ ...row, entry_json: entryJson })) {
            continue;
          }
          const writeGeneration = trackSessionEntryCacheWrite(database, () => {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("session_nodes")
                .set({ entry_json: entryJson })
                .where("session_key", "=", sessionKey),
            );
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("session_nodes")
                .set({ entry_valid: 1 })
                .where("session_key", "=", sessionKey),
            );
            if (params.updateDeliveryProjection) {
              executeSqliteQuerySync(
                database.db,
                db
                  .updateTable("session_windows")
                  .set({
                    account_id: deliveryContextFromSession(nextEntry)?.accountId ?? null,
                    channel: sessionDeliveryChannel(nextEntry) ?? null,
                  })
                  .where("session_id", "=", row.current_session_id),
              );
            }
          });
          publishSessionEntryCacheInvalidation(
            database,
            { ...row, entry_json: entryJson },
            writeGeneration,
          );
          batchRewritten += 1;
        }
        return batchRewritten;
      },
      toDatabaseOptions(resolved),
      { operationLabel: "doctor.rewrite-session-entries" },
    );
  }
  return rewritten;
}
