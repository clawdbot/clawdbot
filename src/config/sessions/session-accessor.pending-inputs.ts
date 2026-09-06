import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { sql } from "kysely";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  ensureSessionPendingInputsSchema,
  hasPendingInputConsumptionColumn,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  parseSessionPendingInputMessage,
  projectSessionPendingInput,
  readSessionPendingInputByKey,
  readSessionPendingInputOwnerIds,
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
  withSessionPendingInputRelocation,
  type SessionPendingInput,
  type SessionPendingInputOwner,
  type SessionPendingInputPage,
  type SessionPendingInputRow,
  type SessionPendingInputState,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readMessageIdempotencyKey,
  readTranscriptMessageByScopedIdempotencyKey,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";

export { withSessionPendingInputRelocation };
export type { SessionPendingInput, SessionPendingInputPage };
type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };
export type SessionPendingInputReceipt = {
  state: "queued" | "consumed";
  inputId: string;
  message: PersistedUserTurnMessage;
  run: <T>(operation: () => T) => T;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
};
const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();

function ownerReceipt(owner: SessionPendingInputOwner): SessionPendingInputReceipt {
  const receipt: SessionPendingInputReceipt = {
    state: "queued",
    inputId: owner.inputId,
    message: parseSessionPendingInputMessage(owner.messageJson),
    run: (operation) => runWithSessionPendingInput(owner, operation),
    finish: owner.finish,
  };
  receiptOwners.set(receipt, owner);
  return receipt;
}

/** Install only a private receipt's persistence context; this does not reopen execution authority. */
export function withSessionPendingInputPersistence<T>(
  receipt: SessionPendingInputReceipt,
  persist: () => T,
): T {
  const owner = receiptOwners.get(receipt);
  return owner ? runWithSessionPendingInputPersistence(owner, persist) : receipt.run(persist);
}

/** Bind one collected message to its private admitted sources without creating another durable queue. */
export function bindSessionPendingInputSources(
  receipts: readonly SessionPendingInputReceipt[],
  message: PersistedUserTurnMessage,
): SessionPendingInputReceipt | undefined {
  const sources = [
    ...new Set(
      receipts.flatMap((receipt) => {
        if (receipt.state === "consumed") {
          throw new Error("Collected input has already been consumed");
        }
        const owner = receiptOwners.get(receipt);
        return owner ? (owner.sources ?? [owner]) : [];
      }),
    ),
  ];
  const first = sources[0];
  if (!first) {
    return undefined;
  }
  const idempotencyKey = readMessageIdempotencyKey(message);
  if (
    !idempotencyKey ||
    sources.some(
      (source) =>
        source.databasePath !== first.databasePath ||
        source.sessionId !== first.sessionId ||
        source.sessionKey !== first.sessionKey ||
        source.idempotencyKey === idempotencyKey,
    )
  ) {
    throw new Error("Collected input requires one exact session and a distinct aggregate identity");
  }
  // Collected framing still passes storage redaction; its staged sources have
  // already passed approval and must not run through another plugin hook.
  const messageJson = JSON.stringify(
    redactTranscriptMessageForStorage(message, { config: sources.at(-1)?.config }),
  );
  if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Collected input exceeds the Gateway payload limit");
  }
  const aggregateInputId = randomUUID();
  return ownerReceipt({
    ...first,
    inputId: aggregateInputId,
    transcriptInputId: aggregateInputId,
    idempotencyKey,
    messageJson,
    sources,
    finish: (disposition) => {
      const failures: unknown[] = [];
      for (const source of sources) {
        try {
          source.finish(disposition);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Failed to finish collected input custody");
      }
    },
  });
}

/** Accept durable input without changing the active transcript or scheduling execution. */
export async function stageSessionPendingInput(
  scope: PendingInputScope,
  options: {
    runId: string;
    message: PersistedUserTurnMessage;
    prepareMessageAfterIdempotencyCheck?: (
      message: PersistedUserTurnMessage,
    ) => PersistedUserTurnMessage | undefined;
    config?: OpenClawConfig;
    assertCurrent: () => void;
  },
): Promise<SessionPendingInputReceipt | undefined> {
  const resolved = resolveSqliteTranscriptScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (!idempotencyKey || !options.runId) {
    throw new Error("Pending input requires an exact run and message idempotency key");
  }
  const { timestamp: _timestamp, ...stableMessage } = options.message;
  if (Buffer.byteLength(JSON.stringify(stableMessage), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Pending input exceeds the Gateway payload limit");
  }
  const requestHash = createHash("sha256").update(stableStringify(stableMessage)).digest("hex");
  return runExclusiveSqliteSessionWrite(resolved, async () => {
    options.assertCurrent();
    const database = openOpenClawAgentDatabase(databaseOptions);
    if (readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !== scope.sessionId) {
      return undefined;
    }
    const existing = readSessionPendingInputByKey(database, resolved, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash || existing.run_id !== options.runId) {
        throw new Error("Pending input idempotency key conflicts with the accepted input");
      }
      if (existing.consumed_event_id != null) {
        return {
          state: "consumed",
          inputId: existing.input_id,
          message: parseSessionPendingInputMessage(existing.message_json),
          run: () => {
            throw new Error("Pending input has already been consumed");
          },
          finish: () => {},
        };
      }
      if (
        existing.state !== "queued" ||
        !readSessionPendingInputOwnerIds(database, [existing]).has(existing.input_id)
      ) {
        throw new Error("Pending input ownership ended; submit a new turn to continue");
      }
      throw new Error("Pending input is already admitted; wait for its current turn");
    }
    const committed = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      "scan",
    );
    if (committed) {
      // Committed transcript replay keeps its existing contract and never creates new custody.
      return {
        state: "queued",
        inputId: committed.messageId,
        message: parseSessionPendingInputMessage(JSON.stringify(committed.message)),
        run: (operation) => operation(),
        finish: () => {},
      };
    }
    const prepared = options.prepareMessageAfterIdempotencyCheck
      ? options.prepareMessageAfterIdempotencyCheck(options.message)
      : options.message;
    if (!prepared) {
      return undefined;
    }
    const message = redactTranscriptMessageForStorage(prepared, { config: options.config });
    const messageJson = JSON.stringify(message);
    if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error("Approved pending input exceeds the Gateway payload limit");
    }
    const inputId = randomUUID();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    ensureSessionPendingInputsSchema(database.db);
    const inserted = runOpenClawAgentWriteTransaction((current) => {
      options.assertCurrent();
      if (readSessionEntryRow(current, resolved.sessionKey)?.entry.sessionId !== scope.sessionId) {
        return false;
      }
      executeSqliteQuerySync(
        current.db,
        getSessionKysely(current.db).insertInto("session_pending_inputs").values({
          input_id: inputId,
          session_key: resolved.sessionKey,
          session_id: scope.sessionId,
          idempotency_key: idempotencyKey,
          run_id: options.runId,
          request_hash: requestHash,
          message_json: messageJson,
          lifecycle_generation: lifecycleGeneration,
          state: "queued",
          accepted_at: Date.now(),
        }),
      );
      return true;
    }, databaseOptions);
    if (!inserted) {
      return undefined;
    }
    let finished = false;
    const owner: SessionPendingInputOwner = {
      inputId,
      transcriptInputId: inputId,
      sessionId: scope.sessionId,
      sessionKey: resolved.sessionKey,
      databasePath: database.path,
      idempotencyKey,
      lifecycleGeneration,
      messageJson,
      config: options.config,
      assertCurrent: options.assertCurrent,
      finish: (disposition) => {
        if (finished) {
          return;
        }
        finished = true;
        // Release authority even if recording the terminal disposition fails.
        releaseSessionPendingInputOwner(owner);
        runOpenClawAgentWriteTransaction((current) => {
          executeSqliteQuerySync(
            current.db,
            getSessionKysely(current.db)
              .updateTable("session_pending_inputs")
              .set({ state: disposition })
              .where("input_id", "=", inputId)
              .where("state", "=", "queued")
              .where("consumed_event_id", "is", null),
          );
        }, databaseOptions);
      },
    };
    registerSessionPendingInputOwner(owner);
    return ownerReceipt(owner);
  });
}

/** Record lost custody at its read boundary without resuming a pre-restart execution. */
function readPendingInputRows(
  scope: PendingInputScope,
  options: { limit?: number; before?: number; id?: string },
): { rows: SessionPendingInputRow[]; total: number; nextBefore?: number } {
  const resolved = resolveSqliteTranscriptScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 20)));
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (!hasSessionPendingInputsSchema(database.db)) {
      return { rows: [], total: 0, staleIds: [], nextBefore: undefined };
    }
    const db = getSessionKysely(database.db);
    let base = db
      .selectFrom("session_pending_inputs")
      .where("session_key", "=", resolved.sessionKey)
      .where("session_id", "=", scope.sessionId);
    if (hasPendingInputConsumptionColumn(database.db)) {
      base = base.where("consumed_event_id", "is", null);
    }
    const total =
      executeSqliteQueryTakeFirstSync(
        database.db,
        base.select(db.fn.count<number>("input_id").as("total")),
      )?.total ?? 0;
    let query = base.orderBy("seq", "desc").limit(limit + 1);
    if (options.before !== undefined) {
      query = query.where("seq", "<", options.before);
    }
    if (options.id !== undefined) {
      query = query.where("input_id", "=", options.id);
    }
    const metadata = executeSqliteQuerySync(
      database.db,
      query.select([
        "seq",
        /* kysely-allow-raw: Bound the page before fetching accepted message JSON. */
        sql<number>`OCTET_LENGTH(message_json)`.as("serialized_bytes"),
      ]),
    ).rows;
    const selected: number[] = [];
    let bytes = 0;
    for (const row of metadata) {
      if (selected.length === limit || bytes + row.serialized_bytes > MAX_PAYLOAD_BYTES) {
        break;
      }
      selected.push(row.seq);
      bytes += row.serialized_bytes;
    }
    if (metadata.length && !selected.length) {
      throw new Error("Stored pending input exceeds the Gateway payload limit");
    }
    const rows = selected.length
      ? executeSqliteQuerySync(
          database.db,
          base.selectAll().where("seq", "in", selected).orderBy("seq", "desc"),
        ).rows
      : [];
    // An aborted but registered owner still owns the terminal disposition. Reads
    // must not race its finish(cancelled) by recording an inferred interruption.
    const ownedIds = readSessionPendingInputOwnerIds(database, rows);
    const staleIds = rows
      .filter((row) => row.state === "queued" && !ownedIds.has(row.input_id))
      .map((row) => row.input_id);
    return {
      rows,
      total,
      staleIds,
      nextBefore: selected.length < metadata.length ? selected.at(-1) : undefined,
    };
  }, databaseOptions);
  if (!result.found) {
    return { rows: [], total: 0 };
  }
  const snapshot = result.value;
  if (snapshot.staleIds.length) {
    const interrupted = runOpenClawAgentWriteTransaction((database) => {
      const db = getSessionKysely(database.db);
      const candidates = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_pending_inputs")
          .selectAll()
          .where("input_id", "in", snapshot.staleIds)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      ).rows;
      const ownedIds = readSessionPendingInputOwnerIds(database, candidates);
      const ids = candidates.flatMap((row) => (ownedIds.has(row.input_id) ? [] : [row.input_id]));
      if (ids.length) {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_pending_inputs")
            .set({ state: "interrupted" })
            .where("input_id", "in", ids)
            .where("consumed_event_id", "is", null),
        );
      }
      return new Set(ids);
    }, databaseOptions);
    for (const row of snapshot.rows) {
      if (interrupted.has(row.input_id)) {
        row.state = "interrupted";
      }
    }
  }
  return { rows: snapshot.rows, total: snapshot.total, nextBefore: snapshot.nextBefore };
}

export function listSessionPendingInputs(
  scope: PendingInputScope,
  options: { limit?: number; before?: number } = {},
): SessionPendingInputPage {
  const { rows, total, nextBefore } = readPendingInputRows(scope, options);
  return {
    items: rows.toReversed().map(projectSessionPendingInput),
    total,
    ...(nextBefore !== undefined ? { nextBefore } : {}),
  };
}

export function readSessionPendingInput(
  scope: PendingInputScope,
  id: string,
): SessionPendingInput | undefined {
  const row = readPendingInputRows(scope, { id, limit: 1 }).rows[0];
  return row ? projectSessionPendingInput(row) : undefined;
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): PersistedUserTurnMessage | undefined {
  try {
    const resolved = resolveSqliteTranscriptScope(scope);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const db = getSessionKysely(database.db);
          const session = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("session_nodes")
              .innerJoin(
                "session_windows",
                "session_windows.session_id",
                "session_nodes.current_session_id",
              )
              .select("current_session_id")
              .where("session_nodes.session_key", "=", resolved.sessionKey)
              .where("session_windows.session_key", "=", resolved.sessionKey),
          );
          if (session?.current_session_id !== resolved.sessionId) {
            return undefined;
          }
          // Collected sources survive consumption; their text is not the aggregate transcript.
          // Check byte metadata before either reader materializes stored JSON.
          const pending = hasSessionPendingInputsSchema(database.db)
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_pending_inputs")
                  .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
                  .where("session_key", "=", resolved.sessionKey)
                  .where("session_id", "=", resolved.sessionId)
                  .where("idempotency_key", "=", idempotencyKey),
              )
            : undefined;
          let messageJson: string | undefined;
          if (pending) {
            if (pending.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            messageJson = readSessionPendingInputByKey(
              database,
              resolved,
              idempotencyKey,
            )?.message_json;
          } else {
            // Stale projections cannot establish retry identity. Their owning writer repairs them.
            if (sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) {
              return undefined;
            }
            const transcript = executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("transcript_event_identities as identity")
                .innerJoin("transcript_events as event", (join) =>
                  join
                    .onRef("event.session_id", "=", "identity.session_id")
                    .onRef("event.seq", "=", "identity.seq"),
                )
                .select((eb) => eb.fn<number>("octet_length", ["event.event_json"]).as("bytes"))
                .where("identity.session_id", "=", resolved.sessionId)
                .where("identity.message_idempotency_key", "=", idempotencyKey)
                .orderBy("identity.seq", "desc")
                .limit(1),
            );
            if (!transcript || transcript.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            const committed = readTranscriptMessageByScopedIdempotencyKey(
              database,
              resolved,
              idempotencyKey,
              "scan",
            );
            messageJson = committed ? JSON.stringify(committed.message) : undefined;
          }
          if (!messageJson) {
            return undefined;
          }
          const message = parseSessionPendingInputMessage(messageJson);
          return readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
        }),
      toDatabaseOptions(resolved),
    );
    return result.found ? result.value : undefined;
  } catch {
    // Unavailable or corrupt storage supplies no proof of the original submitted bytes.
    return undefined;
  }
}

/** Bounded display reconciliation; these durable correlations never authorize replay. */
export function listSessionPendingInputReceipts(
  scope: PendingInputScope,
  options: { runIds: readonly string[] },
): Array<
  | { runId: string; state: "pending" }
  | { runId: string; state: "consumed"; consumedByEventId: string }
> {
  if (options.runIds.length > 50) {
    throw new Error("Pending input receipt lookup accepts at most 50 run IDs");
  }
  const runIds = [...new Set(options.runIds)];
  if (!runIds.length) {
    return [];
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (
      !hasSessionPendingInputsSchema(database.db) ||
      !hasPendingInputConsumptionColumn(database.db)
    ) {
      return [];
    }
    const rows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_pending_inputs")
        .select(["run_id", "consumed_event_id"])
        .where("session_key", "=", resolved.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("run_id", "in", runIds)
        .orderBy("seq", "asc")
        .limit(51),
    ).rows;
    // A run ID is correlation, not unique authority. Never retire an ambiguous
    // provisional message when another source with that run is still pending.
    if (rows.length > 50 || new Set(rows.map((row) => row.run_id)).size !== rows.length) {
      throw new Error("Pending input receipt lookup has ambiguous source run IDs");
    }
    return rows.map((row) =>
      row.consumed_event_id == null
        ? { runId: row.run_id, state: "pending" as const }
        : {
            runId: row.run_id,
            state: "consumed" as const,
            consumedByEventId: row.consumed_event_id,
          },
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}
