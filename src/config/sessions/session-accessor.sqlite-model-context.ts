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
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import {
  readTranscriptContextVersionInTransaction,
  type SessionTranscriptContextVersion,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
} from "./session-model-context-projection.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-transcript-state.js";

type ContextEntry = SessionTreeEntry & { seq: number };
type ModelContextRequest = { entry: ContextEntry; omitCheckpoint: boolean };
type TranscriptContextSnapshot = {
  header: TranscriptEvent;
  entries: ContextEntry[];
  version: SessionTranscriptContextVersion;
  readEntry: (entry: ContextEntry) => SessionTreeEntry;
  readModelEntries: (
    requests: readonly ModelContextRequest[],
  ) => Map<ContextEntry, SessionTreeEntry>;
};

const MODEL_CONTEXT_PAYLOAD_BATCH_SIZE = 400;

function assertContextAnchor(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  through: TranscriptEntryAnchor,
): void {
  if (
    resolved.agentId !== through.agentId ||
    resolved.sessionId !== through.sessionId ||
    resolved.sessionKey !== through.sessionKey ||
    database.path !== through.storePath
  ) {
    throw new SessionTranscriptReadFenceError(
      "Completed-turn anchor belongs to another transcript",
    );
  }
  const current = readActiveTranscriptEntryAnchorInTransaction({
    database,
    resolved: { ...resolved, sessionKey: through.sessionKey },
    entryId: through.entryId,
  });
  if (
    !current ||
    (["generation", "rawSeq", "effectiveParentId", "activeMessagePosition"] as const).some(
      (field) => current[field] !== through[field],
    )
  ) {
    throw new SessionTranscriptReadFenceError("Completed-turn transcript anchor changed");
  }
}

/** Later appends are allowed; rewriting or removing the accepted turn is not. */
export function validateSessionTranscriptContextAnchor(
  scope: SessionTranscriptReadScope,
  through: TranscriptEntryAnchor,
): void {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => assertContextAnchor(database, resolved, through),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  if (!result.found) {
    throw new SessionTranscriptReadFenceError("Completed-turn transcript no longer exists");
  }
}

/** Unadmitted context must still describe this session when an async read returns. */
export function validateSessionTranscriptContextVersion(
  scope: SessionTranscriptReadScope,
  version: SessionTranscriptContextVersion | undefined,
): void {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readTranscriptContextVersionInTransaction(database, resolved.sessionId),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  const current = result.found ? result.value : undefined;
  if (
    current?.generation !== version?.generation ||
    current?.rawSeq !== version?.rawSeq ||
    current?.updatedAt !== version?.updatedAt
  ) {
    throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
  }
}

/** Revalidate admission after an asynchronous read before accepting its detached result. */
export function validateSessionTranscriptContextAdmission(
  scope: SessionTranscriptReadScope,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
): void {
  if (!admission) {
    return;
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = runWithSessionTranscriptReadFence(admission, () =>
    withOpenClawAgentDatabaseReadOnly(
      (database) => resolveSqliteSessionTranscriptReadFence({ database, ...resolved }),
      toDatabaseOptions(resolved),
      { throwOnMissingTable: true },
    ),
  );
  if (!result.found || !result.value) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission is no longer readable",
    );
  }
}

/** Read a transient context without opening the writer lifecycle or copying native evidence. */
export function readSessionTranscriptModelContext(
  scope: SessionTranscriptReadScope,
  through?: TranscriptEntryAnchor,
): {
  events: TranscriptEvent[];
  version?: SessionTranscriptContextVersion;
} {
  const result = withTranscriptContextSnapshot(
    scope,
    ({ header, entries, readModelEntries, version }) => {
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
      return {
        events: [
          ...(header ? [header] : []),
          ...entries.map((entry) => payloads.get(entry) ?? entry),
        ],
        version,
      };
    },
    through,
  );
  return result.found ? result.value : { events: [] };
}

/** Consume full-fidelity context lazily inside one read snapshot, never retaining raw history. */
export function readSessionTranscriptContextMessages<T>(
  scope: SessionTranscriptReadScope,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
): T {
  const result = withTranscriptContextSnapshot(scope, ({ header, entries, readEntry, version }) => {
    const messages = iterateSessionContextMessages(entries, readEntry);
    try {
      return read(messages, header, version);
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
  through?: TranscriptEntryAnchor,
): { found: true; value: T } | { found: false } {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const db = getSessionKysely(database.db);
          const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
          const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
          if (through) {
            assertContextAnchor(database, resolved, through);
          }
          const base = db
            .selectFrom("transcript_events")
            .where("session_id", "=", resolved.sessionId)
            .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq))
            .$if(through !== undefined, (query) => query.where("seq", "<=", through!.rawSeq));
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
          if (through && !tree.byId.has(through.entryId)) {
            throw new SessionTranscriptReadFenceError(
              "Completed-turn anchor is outside the admitted context",
            );
          }
          const entries = selectSessionTranscriptTreePathNodes(
            tree,
            through?.entryId ?? tree.leafId,
          ).map(({ entry, parentId }) => {
            entry.parentId = parentId;
            return entry;
          });
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
            version,
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
