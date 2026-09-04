import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { isCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { sql } from "kysely";
import {
  iterateSessionContextEntries,
  iterateSessionContextMessages,
} from "../../../packages/agent-core/src/harness/session/session.js";
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

type ContextEntry = SessionTreeEntry & { seq: number };
type ModelContextRequest = { entry: ContextEntry; omitCheckpoint: boolean };
type TranscriptContextSnapshot = {
  header: TranscriptEvent;
  entries: ContextEntry[];
  readEntry: (entry: ContextEntry) => SessionTreeEntry;
  readModelEntries: (
    requests: readonly ModelContextRequest[],
  ) => Map<ContextEntry, SessionTreeEntry>;
};

const MODEL_CONTEXT_PAYLOAD_BATCH_SIZE = 400;

/** Read a transient context without opening the writer lifecycle or copying native evidence. */
export function readSessionTranscriptModelContext(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const result = withTranscriptContextSnapshot(scope, ({ header, entries, readModelEntries }) => {
    const requests: ModelContextRequest[] = [];
    for (const { entry, context } of iterateSessionContextEntries(entries)) {
      const omitCheckpoint =
        context !== "current" &&
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        isCompactionReplayCheckpoint(entry.message.providerReplay);
      requests.push({ entry, omitCheckpoint });
    }
    const payloads = readModelEntries(requests);
    return [...(header ? [header] : []), ...entries.map((entry) => payloads.get(entry) ?? entry)];
  });
  return result.found ? result.value : [];
}

/** Consume full-fidelity context lazily inside one read snapshot, never retaining raw history. */
export function readSessionTranscriptContextMessages<T>(
  scope: SessionTranscriptReadScope,
  read: (messages: Iterable<AgentMessage>, header: unknown) => T,
): T {
  const result = withTranscriptContextSnapshot(scope, ({ header, entries, readEntry }) => {
    const messages = iterateSessionContextMessages(entries, readEntry);
    try {
      return read(messages, header);
    } finally {
      // Retained iterators cannot read after the snapshot closes, including early rejection.
      messages.return(undefined);
    }
  });
  return result.found ? result.value : read([], undefined);
}

function withTranscriptContextSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (snapshot: TranscriptContextSnapshot) => T,
): { found: true; value: T } | { found: false } {
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
                // Only navigation crosses into JavaScript before the canonical context is selected.
                // SAFETY: SQL preserves entry discriminants and replaces payloads with readable empty bodies.
                yield { ...(JSON.parse(row.navigation_json) as SessionTreeEntry), seq: row.seq };
              }
            })(),
          );
          // Navigation entries belong to this snapshot; normalize ancestry without another copy.
          const entries = selectSessionTranscriptTreePathNodes(tree, tree.leafId).map(
            ({ entry, parentId }) => {
              entry.parentId = parentId;
              return entry;
            },
          );
          const readPayload = prepareSqliteQuerySync<ContextEntry, { event_json: string }>(
            database.db,
            (parameter) =>
              base.select("event_json").where(
                "seq",
                "=",
                parameter((row) => row.seq),
              ),
          );
          return read({
            header: header ? JSON.parse(header.event_json) : undefined,
            entries,
            readEntry: (entry) => {
              const row = readPayload(entry).rows[0];
              return {
                // SAFETY: The canonical payload is selected by its navigation row in this snapshot.
                ...(JSON.parse(row!.event_json) as SessionTreeEntry),
                parentId: entry.parentId,
              };
            },
            readModelEntries: (requests) => {
              const payloads = new Map<ContextEntry, SessionTreeEntry>();
              for (
                let offset = 0;
                offset < requests.length;
                offset += MODEL_CONTEXT_PAYLOAD_BATCH_SIZE
              ) {
                const batch = requests.slice(offset, offset + MODEL_CONTEXT_PAYLOAD_BATCH_SIZE);
                const bySeq = new Map(batch.map(({ entry }) => [entry.seq, entry]));
                const omitted = batch
                  .filter(({ omitCheckpoint }) => omitCheckpoint)
                  .map(({ entry }) => entry.seq);
                // Bound both IN lists while keeping payload selection inside the navigation snapshot.
                // SQL removes obsolete replay/private fields before they enter JavaScript.
                const query = base
                  .select((eb) => [
                    "seq",
                    projectModelContextEventSql(
                      eb.ref("event_json"),
                      omitted.length > 0
                        ? eb.case().when("seq", "in", omitted).then(1).else(0).end()
                        : eb.val(0),
                    ).as("event_json"),
                  ])
                  .where("seq", "in", [...bySeq.keys()]);
                for (const row of iterateSqliteQuerySync(database.db, query)) {
                  const entry = bySeq.get(row.seq)!;
                  payloads.set(entry, {
                    // SAFETY: This selected row uses the same event union as its navigation entry.
                    ...(JSON.parse(row.event_json) as SessionTreeEntry),
                    parentId: entry.parentId,
                  });
                }
              }
              return payloads;
            },
          });
        },
        { operationLabel: "session context snapshot read" },
      ),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  return result;
}
