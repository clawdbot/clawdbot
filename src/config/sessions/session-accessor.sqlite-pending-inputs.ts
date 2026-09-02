import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionPendingInputs } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionPendingInputsSchema,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";

export type SessionPendingInputState = "queued" | "interrupted" | "cancelled";
export type SessionPendingInput = {
  id: string;
  runId: string;
  message: PersistedUserTurnMessage;
  acceptedAt: number;
  state: SessionPendingInputState;
};
export type SessionPendingInputPage = {
  items: SessionPendingInput[];
  total: number;
  nextBefore?: number;
};
export type SessionPendingInputRow = Selectable<SessionPendingInputs>;
type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

export type SessionPendingInputOwner = {
  inputId: string;
  sessionId: string;
  sessionKey: string;
  databasePath: string;
  idempotencyKey: string;
  lifecycleGeneration: string;
  messageJson: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  /** Aggregate authority is the exact source closures, never persisted source identifiers. */
  sources?: readonly SessionPendingInputOwner[];
};

const owners = resolveGlobalSingleton(Symbol.for("openclaw.sessionPendingInputOwners"), () => ({
  live: new Map<string, SessionPendingInputOwner>(),
  current: new AsyncLocalStorage<SessionPendingInputOwner>(),
}));

registerAgentEventLifecycleRotationHandler("session-pending-inputs", () => {
  const failures: unknown[] = [];
  for (const owner of owners.live.values()) {
    try {
      owner.finish("interrupted");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Failed to record interrupted pending inputs");
  }
});

export function registerSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.has(owner.inputId)) {
    throw new Error("Pending input already has a live owner");
  }
  owners.live.set(owner.inputId, owner);
}

export function releaseSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.get(owner.inputId) === owner) {
    owners.live.delete(owner.inputId);
  }
}

function assertPendingInputOwnerCurrent(owner: SessionPendingInputOwner): void {
  if (owner.sources) {
    for (const source of owner.sources) {
      assertPendingInputOwnerCurrent(source);
    }
    return;
  }
  if (
    owners.live.get(owner.inputId) !== owner ||
    !isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
  ) {
    throw new Error("Pending input ownership ended; submit a new turn to continue");
  }
  owner.assertCurrent();
}

export function runWithSessionPendingInput<T>(owner: SessionPendingInputOwner, run: () => T): T {
  assertPendingInputOwnerCurrent(owner);
  return owners.current.run(owner, run);
}

/** Persistence alone may mirror a closed turn; the append owner proves exact committed bytes. */
export function runWithSessionPendingInputPersistence<T>(
  owner: SessionPendingInputOwner,
  persist: () => T,
): T {
  return owners.current.run(owner, persist);
}

/** Registration owns disposition; execution and promotion check the private operational predicates. */
export function readSessionPendingInputOwnerIds(
  database: PendingInputDatabase,
  rows: readonly SessionPendingInputRow[],
): Set<string> {
  const candidates = rows.filter((row) => {
    const owner = owners.live.get(row.input_id);
    return (
      owner?.databasePath === database.path &&
      owner.sessionId === row.session_id &&
      owner.sessionKey === row.session_key &&
      owner.lifecycleGeneration === row.lifecycle_generation &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
    );
  });
  if (!candidates.length) {
    return new Set();
  }
  const sessions = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id"])
      .where("session_key", "in", [...new Set(candidates.map((row) => row.session_key))]),
  ).rows;
  const current = new Map(sessions.map((row) => [row.session_key, row.current_session_id]));
  return new Set(
    candidates
      .filter((row) => current.get(row.session_key) === row.session_id)
      .map((row) => row.input_id),
  );
}

export function parseSessionPendingInputMessage(messageJson: string): PersistedUserTurnMessage {
  const value: unknown = JSON.parse(messageJson);
  if (asOptionalRecord(value)?.role !== "user") {
    throw new Error("Pending input has an invalid persisted user message");
  }
  // SAFETY: only typed admission writes this JSON; parsing preserves its canonical message shape.
  return value as PersistedUserTurnMessage;
}

export function projectSessionPendingInput(row: SessionPendingInputRow): SessionPendingInput {
  if (row.state !== "queued" && row.state !== "interrupted" && row.state !== "cancelled") {
    throw new Error("Pending input has an invalid disposition");
  }
  return {
    id: row.input_id,
    runId: row.run_id,
    message: parseSessionPendingInputMessage(row.message_json),
    acceptedAt: row.accepted_at,
    state: row.state,
  };
}

/** Query only the exact physical transcript; copied keys cannot adopt another generation. */
export function readSessionPendingInputByKey(
  database: PendingInputDatabase,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  idempotencyKey: string,
): SessionPendingInputRow | undefined {
  if (!hasSessionPendingInputsSchema(database.db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_id", "=", scope.sessionId)
      .where("session_key", "=", scope.sessionKey)
      .where("idempotency_key", "=", idempotencyKey),
  );
}

export type SessionPendingInputAppend = {
  inputId: string;
  message: PersistedUserTurnMessage;
  alreadyPromoted: boolean;
  sourceInputIds?: readonly string[];
};

/** The private call-path owner, not a copied id or durable row, permits promotion. */
export function resolveSessionPendingInputAppend(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope,
  message: unknown,
): SessionPendingInputAppend | undefined {
  const record = asOptionalRecord(message);
  if (record?.role !== "user" || typeof record.idempotencyKey !== "string") {
    return undefined;
  }
  const idempotencyKey = record.idempotencyKey.trim();
  const row = readSessionPendingInputByKey(database, scope, idempotencyKey);
  const owner = owners.current.getStore();
  const ownsInput = owner?.idempotencyKey === idempotencyKey;
  if (!row && !ownsInput) {
    return undefined;
  }
  if (
    !owner ||
    !ownsInput ||
    owner.databasePath !== database.path ||
    owner.sessionId !== scope.sessionId ||
    owner.sessionKey !== scope.sessionKey ||
    (row &&
      (row.input_id !== owner.inputId ||
        row.consumed_event_id != null ||
        row.state !== "queued" ||
        row.lifecycle_generation !== owner.lifecycleGeneration))
  ) {
    throw new Error("Pending input cannot be appended outside its admitted turn");
  }
  if (owner.sources) {
    const acceptedByKey = new Map(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .selectAll()
          .where("session_id", "=", scope.sessionId)
          .where("session_key", "=", scope.sessionKey)
          .where(
            "idempotency_key",
            "in",
            owner.sources.map((source) => source.idempotencyKey),
          ),
      ).rows.map((sourceRow) => [sourceRow.idempotency_key, sourceRow]),
    );
    const sources = owner.sources.map((source) => {
      const accepted = acceptedByKey.get(source.idempotencyKey);
      if (
        !accepted ||
        accepted.input_id !== source.inputId ||
        accepted.lifecycle_generation !== source.lifecycleGeneration ||
        accepted.message_json !== source.messageJson
      ) {
        throw new Error("Collected input custody changed before transcript promotion");
      }
      return accepted;
    });
    const alreadyPromoted = sources.every((source) => source.consumed_event_id === owner.inputId);
    if (!alreadyPromoted) {
      if (sources.some((source) => source.consumed_event_id != null || source.state !== "queued")) {
        throw new Error("Collected input custody ended before transcript promotion");
      }
      assertPendingInputOwnerCurrent(owner);
    }
    return {
      inputId: owner.inputId,
      message: parseSessionPendingInputMessage(owner.messageJson),
      alreadyPromoted,
      sourceInputIds: sources.map((source) => source.input_id),
    };
  }
  // Terminal mirroring may replay a consumed input after cancellation. The caller
  // must prove the existing message; this never permits a new append.
  if (row) {
    assertPendingInputOwnerCurrent(owner);
  }
  return {
    inputId: owner.inputId,
    message: parseSessionPendingInputMessage(row?.message_json ?? owner.messageJson),
    alreadyPromoted: !row,
  };
}

export function consumeSessionPendingInput(
  database: PendingInputDatabase,
  pending: SessionPendingInputAppend,
): void {
  if (!pending.alreadyPromoted) {
    if (pending.sourceInputIds) {
      const updated = executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .updateTable("session_pending_inputs")
          .set({ consumed_event_id: pending.inputId })
          .where("input_id", "in", [...pending.sourceInputIds])
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      );
      if (updated.numAffectedRows !== BigInt(pending.sourceInputIds.length)) {
        throw new Error("Collected input custody changed during transcript promotion");
      }
      return;
    }
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("input_id", "=", pending.inputId)
        .where("state", "=", "queued"),
    );
  }
}

/** Logical deletion also clears custody when transcript windows are retained. */
export function deleteSessionPendingInputs(
  database: PendingInputDatabase,
  sessionKey: string,
): void {
  if (hasSessionPendingInputsSchema(database.db)) {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", sessionKey),
    );
  }
}

/** Canonical repair preserves accepted text without transferring its old execution authority. */
export function copySessionPendingInputsForRepair(
  source: PendingInputDatabase,
  destination: PendingInputDatabase,
  sourceKeys: readonly string[],
  canonicalKey: string,
): void {
  if (!hasSessionPendingInputsSchema(source.db)) {
    return;
  }
  const rows = executeSqliteQuerySync(
    source.db,
    getSessionKysely(source.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_key", "in", sourceKeys)
      .orderBy("seq", "asc"),
  ).rows;
  if (!rows.length) {
    return;
  }
  ensureSessionPendingInputsSchema(destination.db);
  const db = getSessionKysely(destination.db);
  for (const row of rows) {
    if (source.db === destination.db) {
      executeSqliteQuerySync(
        destination.db,
        db
          .updateTable("session_pending_inputs")
          .set({
            session_key: canonicalKey,
            state: row.state === "cancelled" ? "cancelled" : "interrupted",
          })
          .where("input_id", "=", row.input_id),
      );
      continue;
    }
    const existing = readSessionPendingInputByKey(
      destination,
      { sessionKey: canonicalKey, sessionId: row.session_id },
      row.idempotency_key,
    );
    if (existing) {
      if (
        existing.request_hash !== row.request_hash ||
        existing.message_json !== row.message_json ||
        existing.run_id !== row.run_id ||
        (existing.consumed_event_id != null &&
          row.consumed_event_id != null &&
          existing.consumed_event_id !== row.consumed_event_id)
      ) {
        throw new Error("Canonical repair found conflicting accepted inputs");
      }
      executeSqliteQuerySync(
        destination.db,
        db
          .updateTable("session_pending_inputs")
          .set({
            consumed_event_id: existing.consumed_event_id ?? row.consumed_event_id ?? null,
            state:
              existing.state === "cancelled" || row.state === "cancelled"
                ? "cancelled"
                : "interrupted",
          })
          .where("input_id", "=", existing.input_id),
      );
      continue;
    }
    const { seq: _seq, ...record } = row;
    executeSqliteQuerySync(
      destination.db,
      db.insertInto("session_pending_inputs").values({
        ...record,
        session_key: canonicalKey,
        state: row.state === "cancelled" ? "cancelled" : "interrupted",
      }),
    );
  }
}
