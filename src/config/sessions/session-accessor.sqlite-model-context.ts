import type { SessionTreeEntry } from "@openclaw/agent-core";
import { isCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { sql } from "kysely";
import { resolveSessionContextWindow } from "../../../packages/agent-core/src/harness/session/session.js";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
} from "./session-model-context-projection.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Read a transient context without opening the writer lifecycle or copying native evidence. */
export function readSessionTranscriptModelContext(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const db = getSessionKysely(database.db);
          const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
          const base = db
            .selectFrom("transcript_events")
            .where("session_id", "=", resolved.sessionId)
            .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq));
          const header = executeSqliteQueryTakeFirstSync(
            database.db,
            base
              .select("event_json")
              .where(
                /* kysely-allow-raw: the header discriminator is owned by the transcript codec. */
                sql<string>`json_extract(event_json, '$.type')`,
                "=",
                "session",
              )
              .orderBy("seq", "asc")
              .limit(1),
          );
          const tree = scanSessionTranscriptTree(
            (function* () {
              for (const row of iterateSqliteQuerySync(
                database.db,
                base
                  .select((eb) => [
                    "seq",
                    projectModelContextNavigationSql(eb.ref("event_json")).as("navigation_json"),
                  ])
                  .orderBy("seq", "asc"),
              )) {
                // The navigation projection preserves discriminants and state, with empty
                // bodies. Only selected model messages are subsequently hydrated.
                // SAFETY: SQL retains entry discriminants/state; the detached manager validates readability.
                yield { ...(JSON.parse(row.navigation_json) as SessionTreeEntry), seq: row.seq };
              }
            })(),
          );
          const selected = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
          const entries = selected.map((node) => node.entry);
          const window = resolveSessionContextWindow(entries);
          const boundary = entries[window.boundaryIndex];
          const kept = entries.slice(window.firstKeptIndex, window.boundaryIndex);
          const resetKept =
            boundary?.type === "reset" ? new Set(selectResetKeptEntries(kept)) : undefined;
          const readPayload = prepareSqliteQuerySync<
            { seq: number; omitCheckpoint: number },
            { event_json: string }
          >(database.db, (parameter) =>
            base
              .select((eb) =>
                projectModelContextEventSql(
                  eb.ref("event_json"),
                  parameter((row) => row.omitCheckpoint),
                ).as("event_json"),
              )
              .where(
                "seq",
                "=",
                parameter((row) => row.seq),
              ),
          );
          const events: TranscriptEvent[] = header ? [JSON.parse(header.event_json)] : [];
          for (const [index, node] of selected.entries()) {
            const entry = node.entry;
            const retained = index >= window.firstKeptIndex && index < window.boundaryIndex;
            const inContext =
              window.boundaryIndex < 0 ||
              index >= window.boundaryIndex ||
              (retained && (!resetKept || resetKept.has(entry)));
            const hasModelPayload =
              entry.type === "message" ||
              entry.type === "custom_message" ||
              entry.type === "branch_summary" ||
              index === window.boundaryIndex;
            // appendResetKeptMessage consumes explicit reset retention regardless of ordinary exclusion.
            const excluded =
              !resetKept?.has(entry) &&
              entry.type === "message" &&
              "excludeFromContext" in entry.message &&
              entry.message.excludeFromContext === true;
            const row =
              inContext && hasModelPayload && !excluded
                ? readPayload({
                    seq: node.entry.seq,
                    omitCheckpoint:
                      retained &&
                      entry.type === "message" &&
                      entry.message.role === "assistant" &&
                      isCompactionReplayCheckpoint(entry.message.providerReplay)
                        ? 1
                        : 0,
                  }).rows[0]
                : undefined;
            // SAFETY: Payload selection changes only storage-only message fields, not the persisted entry union.
            const projected = row ? (JSON.parse(row.event_json) as SessionTreeEntry) : entry;
            events.push({ ...projected, parentId: node.parentId });
          }
          return events;
        },
        { operationLabel: "session model-context read" },
      ),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : [];
}
