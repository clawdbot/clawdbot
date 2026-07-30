/** Best-effort durable signal log for session state changes. */
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { DmScope } from "../config/types.base.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildAgentMainSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
  SESSION_WATCH_PROVENANCE_EXPLICIT,
  type SessionWatchCursorProvenance,
} from "../state/session-watch-cursor-provenance.js";
import { classifySessionKind } from "./classify-session-kind.js";
import type { InputProvenance } from "./input-provenance.js";
import {
  NOTIFY_BY_SESSION_STATE_EVENT_KIND as NOTIFY_BY_KIND,
  type SessionStateActorType,
  type SessionStateEventKind,
} from "./session-state-event-kinds.js";
import { enqueueSessionStateNotice, isNotifiableWatcherKey } from "./session-state-notices.js";
import { deleteSessionUpstreamLink } from "./session-upstream-links.js";

export type { SessionStateActorType } from "./session-state-event-kinds.js";

type SessionStateEventInput = {
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  dedupeKey?: string;
  summary: string;
  payload?: Record<string, unknown>;
  occurredAt?: number;
  watcherSessionKeys?: readonly string[];
};

type SessionStateEventRecord = {
  sequence: number;
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  occurredAt: number;
  summary: string;
  payload?: Record<string, unknown>;
};

type SessionStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "session_state_events" | "session_state_heads" | "session_watch_cursors"
>;
type SessionStateEventsTable = OpenClawStateKyselyDatabase["session_state_events"];
type SessionStateEventRow = Selectable<SessionStateEventsTable>;
type SessionWatchCursorRow = Selectable<OpenClawStateKyselyDatabase["session_watch_cursors"]>;

const SESSION_STATE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SESSION_STATE_MAX_ROWS = 50_000;
const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 60_000;
const log = createSubsystemLogger("sessions/state-events");
let lastPruneAt = 0;

function getSessionStateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionStateDatabase>(db);
}

function normalizeOptionalSqliteNumber(
  value: number | bigint | null | undefined,
): number | undefined {
  return value === undefined ? undefined : normalizeSqliteNumber(value);
}

function parsePayload(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToSessionStateEvent(row: SessionStateEventRow): SessionStateEventRecord {
  const payload = parsePayload(row.payload_json);
  return {
    sequence: normalizeSqliteNumber(row.sequence) ?? 0,
    sessionKey: row.session_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    agentId: row.agent_id,
    kind: row.kind as SessionStateEventKind,
    actorType: row.actor_type as SessionStateActorType,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    summary: row.summary,
    ...(payload ? { payload } : {}),
  };
}

function bindSessionStateEvent(
  input: SessionStateEventInput,
  occurredAt: number,
): Insertable<SessionStateEventsTable> {
  return {
    dedupe_key: input.dedupeKey ?? null,
    session_key: input.sessionKey,
    session_id: input.sessionId ?? null,
    agent_id: input.agentId,
    kind: input.kind,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    run_id: input.runId ?? null,
    occurred_at: occurredAt,
    summary: input.summary,
    payload_json: input.payload ? JSON.stringify(input.payload) : null,
  };
}

function readCursor(
  db: DatabaseSync,
  watcherSessionKey: string,
  targetSessionKey: string,
): SessionWatchCursorRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getSessionStateKysely(db)
      .selectFrom("session_watch_cursors")
      .selectAll()
      .where("watcher_session_key", "=", watcherSessionKey)
      .where("target_session_key", "=", targetSessionKey),
  );
}

function isAmbientGroupWatchCursor(row: SessionWatchCursorRow | undefined): boolean {
  return row?.provenance === SESSION_WATCH_PROVENANCE_AMBIENT_GROUP;
}

function upsertSeedCursor(params: {
  db: DatabaseSync;
  watcherSessionKey: string;
  targetSessionKey: string;
  sequence: number;
  now: number;
  provenance?: SessionWatchCursorProvenance;
}): void {
  executeSqliteQuerySync(
    params.db,
    getSessionStateKysely(params.db)
      .insertInto("session_watch_cursors")
      .values({
        watcher_session_key: params.watcherSessionKey,
        target_session_key: params.targetSessionKey,
        last_seen_sequence: params.sequence,
        notified_sequence: params.sequence,
        material_sequence: params.sequence,
        provenance: params.provenance ?? SESSION_WATCH_PROVENANCE_EXPLICIT,
        updated_at: params.now,
      })
      .onConflict((conflict) =>
        conflict.columns(["watcher_session_key", "target_session_key"]).doUpdateSet({
          last_seen_sequence: params.sequence,
          notified_sequence: params.sequence,
          material_sequence: params.sequence,
          updated_at: params.now,
        }),
      ),
  );
}

function updateMaterialCursor(params: {
  db: DatabaseSync;
  watcherSessionKey: string;
  targetSessionKey: string;
  sequence: number;
  now: number;
}): { lastSeenSequence: number; queueOnly: boolean } {
  const current = readCursor(params.db, params.watcherSessionKey, params.targetSessionKey);
  const lastSeen = normalizeOptionalSqliteNumber(current?.last_seen_sequence) ?? 0;
  const notified = normalizeOptionalSqliteNumber(current?.notified_sequence) ?? 0;
  const frozenNotified = notified === lastSeen ? params.sequence : notified;
  executeSqliteQuerySync(
    params.db,
    getSessionStateKysely(params.db)
      .insertInto("session_watch_cursors")
      .values({
        watcher_session_key: params.watcherSessionKey,
        target_session_key: params.targetSessionKey,
        last_seen_sequence: lastSeen,
        notified_sequence: frozenNotified,
        material_sequence: params.sequence,
        provenance: SESSION_WATCH_PROVENANCE_EXPLICIT,
        updated_at: params.now,
      })
      .onConflict((conflict) =>
        conflict.columns(["watcher_session_key", "target_session_key"]).doUpdateSet({
          notified_sequence: frozenNotified,
          material_sequence: params.sequence,
          updated_at: params.now,
        }),
      ),
  );
  return { lastSeenSequence: lastSeen, queueOnly: isAmbientGroupWatchCursor(current) };
}

/** Classify the actor once at producer boundaries; missing provenance is interactive human input. */
export function classifySessionStateActor(opts: {
  inputProvenance?: InputProvenance;
  internalEvents?: readonly unknown[];
  sessionEffects?: "visible" | "internal";
  humanActorId?: string;
}): { actorType: SessionStateActorType; actorId?: string } {
  if (opts.inputProvenance?.kind === "inter_session") {
    return {
      actorType: "agent",
      ...(opts.inputProvenance.sourceSessionKey
        ? { actorId: opts.inputProvenance.sourceSessionKey }
        : {}),
    };
  }
  if (
    opts.inputProvenance?.kind === "internal_system" ||
    (opts.internalEvents?.length ?? 0) > 0 ||
    opts.sessionEffects === "internal"
  ) {
    return { actorType: "system" };
  }
  return { actorType: "human", ...(opts.humanActorId ? { actorId: opts.humanActorId } : {}) };
}

/** Append a signal-log event without allowing signaling failure to fail the originating action. */
const SESSION_STATE_OCCURRED_AT_MAX_SKEW_MS = 24 * 60 * 60_000;

// Upstream-sourced event times are display/history truth only. Bookkeeping clocks
// (heads, cursors, prune scheduling) must use local time, or one skewed upstream
// timestamp could age-out watch cursors instantly; the clamp bounds retention skew.
function clampSessionStateOccurredAt(value: number | undefined, now: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return now;
  }
  return Math.min(Math.max(value, now - SESSION_STATE_OCCURRED_AT_MAX_SKEW_MS), now);
}

export function recordSessionStateEvent(
  input: SessionStateEventInput,
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): SessionStateEventRecord | undefined {
  const now = options.now ?? Date.now();
  const occurredAt = clampSessionStateOccurredAt(input.occurredAt, now);
  const notices: Array<{
    watcherSessionKey: string;
    targetSessionKey: string;
    lastSeenSequence: number;
    queueOnly: boolean;
  }> = [];
  try {
    const event = runOpenClawStateWriteTransaction(({ db }) => {
      const insert = executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .insertInto("session_state_events")
          .values(bindSessionStateEvent(input, occurredAt))
          .onConflict((conflict) => conflict.column("dedupe_key").doNothing()),
      );
      const insertedSequence = insert.insertId ? Number(insert.insertId) : undefined;
      if (insertedSequence === undefined) {
        if (!input.dedupeKey) {
          return undefined;
        }
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          getSessionStateKysely(db)
            .selectFrom("session_state_events")
            .selectAll()
            .where("dedupe_key", "=", input.dedupeKey),
        );
        return existing ? rowToSessionStateEvent(existing) : undefined;
      }

      executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .insertInto("session_state_heads")
          .values({
            session_key: input.sessionKey,
            agent_id: input.agentId,
            last_sequence: insertedSequence,
            updated_at: now,
          })
          .onConflict((conflict) =>
            // (session_key, agent_id) composite identity: under session.scope="global"
            // every agent owns a session-store row keyed "global"; a key-only head
            // would let agents overwrite each other's version heads.
            conflict.columns(["session_key", "agent_id"]).doUpdateSet({
              last_sequence: insertedSequence,
              updated_at: now,
            }),
          ),
      );

      // Explicit watch registrations (registerSessionStateWatch) live as cursor rows;
      // union them with producer-passed watchers so sessions_send coordinators get
      // notices without every producer knowing about registration.
      const registeredWatcherKeys = NOTIFY_BY_KIND[input.kind]
        ? executeSqliteQuerySync(
            db,
            getSessionStateKysely(db)
              .selectFrom("session_watch_cursors")
              .select("watcher_session_key")
              .where("target_session_key", "=", input.sessionKey),
          ).rows.map((row) => row.watcher_session_key)
        : [];
      const watcherSessionKeys = [
        ...new Set([...(input.watcherSessionKeys ?? []), ...registeredWatcherKeys]),
      ].filter((key) => Boolean(key) && isNotifiableWatcherKey(key));
      for (const watcherSessionKey of watcherSessionKeys) {
        if (input.kind === "child_spawned") {
          upsertSeedCursor({
            db,
            watcherSessionKey,
            targetSessionKey: input.sessionKey,
            sequence: insertedSequence,
            now,
          });
          continue;
        }
        if (!NOTIFY_BY_KIND[input.kind] || input.actorId === watcherSessionKey) {
          continue;
        }
        const materialCursor = updateMaterialCursor({
          db,
          watcherSessionKey,
          targetSessionKey: input.sessionKey,
          sequence: insertedSequence,
          now,
        });
        notices.push({
          watcherSessionKey,
          targetSessionKey: input.sessionKey,
          lastSeenSequence: materialCursor.lastSeenSequence,
          queueOnly: materialCursor.queueOnly,
        });
      }

      const row = executeSqliteQueryTakeFirstSync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_events")
          .selectAll()
          .where("sequence", "=", insertedSequence),
      );
      return row ? rowToSessionStateEvent(row) : undefined;
    }, options);

    for (const notice of notices) {
      enqueueSessionStateNotice(notice);
    }
    if (now - lastPruneAt > SESSION_STATE_PRUNE_INTERVAL_MS) {
      pruneSessionStateEvents({ ...options, now });
    }
    return event;
  } catch (error) {
    log.warn(`failed to record session state event: ${String(error)}`);
    return undefined;
  }
}

/** Return the durable signal-log head for one session; degrades to 0 on read failure. */
export function getSessionStateVersion(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): number {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_state_heads")
        .select("last_sequence")
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    );
    return normalizeOptionalSqliteNumber(row?.last_sequence) ?? 0;
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to read session state version: ${String(error)}`);
    return 0;
  }
}

/** Batch durable signal-log heads for session-list enrichment, keyed agent → session key. */
export function getSessionStateVersions(
  refs: ReadonlyArray<{ sessionKey: string; agentId: string }>,
  options: OpenClawStateDatabaseOptions = {},
): Record<string, Record<string, number>> {
  const keys = [...new Set(refs.map((ref) => ref.sessionKey).filter(Boolean))];
  if (keys.length === 0) {
    return {};
  }
  const byAgent: Record<string, Record<string, number>> = {};
  try {
    const { db } = openOpenClawStateDatabase(options);
    // Chunk IN() binds: sessions_list accepts arbitrary limits and SQLite caps
    // host parameters per statement.
    for (let offset = 0; offset < keys.length; offset += 500) {
      const rows = executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select(["session_key", "agent_id", "last_sequence"])
          .where("session_key", "in", keys.slice(offset, offset + 500)),
      ).rows;
      for (const row of rows) {
        (byAgent[row.agent_id] ??= {})[row.session_key] =
          normalizeSqliteNumber(row.last_sequence) ?? 0;
      }
    }
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to read session state versions: ${String(error)}`);
  }
  return byAgent;
}

/** List retained signal-log events after a version without advancing watcher cursors. */
export function listSessionStateEventsSince(
  sessionKey: string,
  agentId: string,
  afterSequence: number,
  limit = 200,
  options: OpenClawStateDatabaseOptions = {},
): {
  events: SessionStateEventRecord[];
  truncated: boolean;
  earliestAvailableSequence: number;
  historyGap: boolean;
} {
  try {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const { db } = openOpenClawStateDatabase(options);
    const kysely = getSessionStateKysely(db);
    const rows = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("session_state_events")
        .selectAll()
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId)
        .where("sequence", ">", afterSequence)
        .orderBy("sequence", "asc")
        .limit(boundedLimit + 1),
    ).rows;
    const earliest = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_state_events")
        .select((eb) => eb.fn.min<number>("sequence").as("sequence"))
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    );
    const headRow = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_state_heads")
        .select(["last_sequence", "pruned_max_sequence"])
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    );
    const head = normalizeOptionalSqliteNumber(headRow?.last_sequence) ?? 0;
    const prunedMax = normalizeOptionalSqliteNumber(headRow?.pruned_max_sequence) ?? 0;
    const earliestAvailableSequence =
      normalizeOptionalSqliteNumber(earliest?.sequence) ?? (head > 0 ? head + 1 : 0);
    return {
      events: rows.slice(0, boundedLimit).map(rowToSessionStateEvent),
      truncated: rows.length > boundedLimit,
      earliestAvailableSequence,
      // Sequences are globally sparse, so distance from earliest retained proves nothing.
      // Only the per-session pruned watermark stamped by pruneSessionStateEvents can say
      // whether events this cursor never saw were actually removed.
      historyGap: afterSequence < prunedMax,
    };
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to list session state events: ${String(error)}`);
    return { events: [], truncated: false, earliestAvailableSequence: 0, historyGap: false };
  }
}

/** Ack only the frozen notice watermark; advancing to head would lose an interleaved event. */
export function acknowledgeSessionStateNotices(
  watcherSessionKey: string,
  targetSessionKeys: readonly string[],
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const followups: Array<{
    watcherSessionKey: string;
    targetSessionKey: string;
    lastSeenSequence: number;
    queueOnly: boolean;
  }> = [];
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      for (const targetSessionKey of new Set(targetSessionKeys)) {
        const row = readCursor(db, watcherSessionKey, targetSessionKey);
        if (!row) {
          continue;
        }
        const notified = normalizeSqliteNumber(row.notified_sequence) ?? 0;
        const material = normalizeSqliteNumber(row.material_sequence) ?? 0;
        const nextNotified = material > notified ? material : notified;
        executeSqliteQuerySync(
          db,
          getSessionStateKysely(db)
            .updateTable("session_watch_cursors")
            .set({
              last_seen_sequence: notified,
              notified_sequence: nextNotified,
              updated_at: now,
            })
            .where("watcher_session_key", "=", watcherSessionKey)
            .where("target_session_key", "=", targetSessionKey),
        );
        if (material > notified) {
          followups.push({
            watcherSessionKey,
            targetSessionKey,
            lastSeenSequence: notified,
            queueOnly: isAmbientGroupWatchCursor(row),
          });
        }
      }
    }, options);
    for (const followup of followups) {
      enqueueSessionStateNotice(followup);
    }
  } catch (error) {
    log.warn(`failed to acknowledge session state notices: ${String(error)}`);
  }
}

/** Reset parent-side assumptions while retaining target history across session incarnations. */
export function handleSessionStateSessionReset(
  sessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .deleteFrom("session_watch_cursors")
          .where("watcher_session_key", "=", sessionKey),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to reset session state cursors: ${String(error)}`);
  }
}

/** Delete all signal-log and cursor state owned by a deleted session key. */
export function handleSessionStateSessionDeleted(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  deleteSessionUpstreamLink(sessionKey, agentId, options);
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getSessionStateKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_state_events")
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_state_heads")
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_watch_cursors")
          .where((eb) =>
            eb.or([
              eb("watcher_session_key", "=", sessionKey),
              eb("target_session_key", "=", sessionKey),
            ]),
          ),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to delete session state history: ${String(error)}`);
  }
}

function sessionExists(sessionKey: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    return Boolean(loadSessionEntryReadOnly({ sessionKey, clone: false, env }));
  } catch {
    return false;
  }
}

/** Re-materialize pending notices after the in-memory queue is lost on restart. */
export function sweepSessionStateWatchNotices(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    const { db } = openOpenClawStateDatabase(options);
    const pendingRows = executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .selectAll()
        .whereRef("material_sequence", ">", "last_seen_sequence"),
    ).rows.filter((row) => sessionExists(row.watcher_session_key, options.env));
    runOpenClawStateWriteTransaction(({ db: writeDb }) => {
      for (const row of pendingRows) {
        executeSqliteQuerySync(
          writeDb,
          getSessionStateKysely(writeDb)
            .updateTable("session_watch_cursors")
            .set({ notified_sequence: row.material_sequence, updated_at: now })
            .where("watcher_session_key", "=", row.watcher_session_key)
            .where("target_session_key", "=", row.target_session_key),
        );
      }
    }, options);
    for (const row of pendingRows) {
      enqueueSessionStateNotice({
        watcherSessionKey: row.watcher_session_key,
        targetSessionKey: row.target_session_key,
        lastSeenSequence: normalizeSqliteNumber(row.last_seen_sequence) ?? 0,
        queueOnly: isAmbientGroupWatchCursor(row),
      });
    }
    pruneSessionStateEvents({ ...options, now });
  } catch (error) {
    log.warn(`failed to sweep session state notices: ${String(error)}`);
  }
}

/** Enforce bounded retained history without regressing durable per-session heads. */
function pruneSessionStateEvents(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getSessionStateKysely(db);
      // Stamp per-session pruned watermarks BEFORE deleting: historyGap can only be
      // answered from what pruning actually removed for that session, never inferred
      // from globally sparse sequence arithmetic.
      const stampPrunedWatermarks = (predicate: {
        occurredBefore?: number;
        sequenceAtOrBelow?: number;
      }) => {
        let query = kysely
          .selectFrom("session_state_events")
          .select(["session_key", "agent_id"])
          .select((eb) => eb.fn.max<number>("sequence").as("max_sequence"))
          .groupBy(["session_key", "agent_id"]);
        if (predicate.occurredBefore !== undefined) {
          query = query.where("occurred_at", "<", predicate.occurredBefore);
        }
        if (predicate.sequenceAtOrBelow !== undefined) {
          query = query.where("sequence", "<=", predicate.sequenceAtOrBelow);
        }
        for (const row of executeSqliteQuerySync(db, query).rows) {
          const maxSequence = normalizeSqliteNumber(row.max_sequence) ?? 0;
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("session_state_heads")
              .set({ pruned_max_sequence: maxSequence, updated_at: now })
              .where("session_key", "=", row.session_key)
              .where("agent_id", "=", row.agent_id)
              .where("pruned_max_sequence", "<", maxSequence),
          );
        }
      };
      const retentionCutoff = now - SESSION_STATE_RETENTION_MS;
      stampPrunedWatermarks({ occurredBefore: retentionCutoff });
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("session_state_events").where("occurred_at", "<", retentionCutoff),
      );
      const overflowRow = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_state_events")
          .select("sequence")
          .orderBy("sequence", "desc")
          .offset(SESSION_STATE_MAX_ROWS)
          .limit(1),
      );
      const sequenceCutoff = normalizeOptionalSqliteNumber(overflowRow?.sequence);
      if (sequenceCutoff !== undefined) {
        stampPrunedWatermarks({ sequenceAtOrBelow: sequenceCutoff });
        executeSqliteQuerySync(
          db,
          kysely.deleteFrom("session_state_events").where("sequence", "<=", sequenceCutoff),
        );
      }
      const cursorCutoff = now - SESSION_STATE_RETENTION_MS;
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("session_watch_cursors").where("updated_at", "<", cursorCutoff),
      );
    }, options);
    lastPruneAt = now;
  } catch (error) {
    log.warn(`failed to prune session state history: ${String(error)}`);
  }
}

/** Record one successful compaction from the two concrete v1 owners. */
export function recordSessionCompacted(params: {
  sessionKey?: string;
  operationId: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
}): void {
  if (!params.sessionKey) {
    return;
  }
  // Native-harness-only compaction remains log-incomplete in v1; this signal is reconciliation aid.
  recordSessionStateEvent({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    kind: "compacted",
    actorType: "system",
    runId: params.runId,
    dedupeKey: `compacted:${params.operationId}`,
    summary: "session compacted",
  });
}

/** Record a persisted goal mutation using lineage already available at the session-store seam. */
export function recordSessionGoalChanged(params: {
  sessionKey: string;
  entry: SessionEntry;
  actor?: { type: SessionStateActorType; id?: string };
  agentId?: string;
  summary: string;
}): void {
  const watcherSessionKey = params.entry.spawnedBy ?? params.entry.parentSessionKey;
  // Callers that own an explicit store agent must pass it: bare "global" keys
  // parse to the default agent and would misattribute the event.
  recordSessionStateEvent({
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    kind: "goal_changed",
    actorType: params.actor?.type ?? "system",
    ...(params.actor?.id ? { actorId: params.actor.id } : {}),
    summary: params.summary,
    ...(watcherSessionKey ? { watcherSessionKeys: [watcherSessionKey] } : {}),
  });
}

/** Record the child's own creation fact when its durable stamp identifies an actor. */
export function recordSessionCreated(params: {
  sessionKey: string;
  entry: SessionEntry;
  agentId?: string;
}): void {
  const actor = params.entry.createdActor;
  if (!actor) {
    return;
  }
  recordSessionStateEvent({
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    kind: "created",
    actorType: actor.type,
    ...(actor.id ? { actorId: actor.id } : {}),
    dedupeKey: `created:${params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey)}:${params.sessionKey}:${params.entry.sessionId}`,
    summary: "session created",
  });
}

/** True when any seeded or explicitly registered watcher cursor targets this session. */
function hasSessionStateWatchers(
  targetSessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .select("watcher_session_key")
        .where("target_session_key", "=", targetSessionKey)
        .limit(1),
    );
    return row !== undefined;
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to probe session state watchers: ${String(error)}`);
    return false;
  }
}

/** List durable ambient-group targets owned by one watcher; failures grant nothing. */
export function listAmbientGroupWatchTargets(
  watcherSessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): Set<string> {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const rows = executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .select("target_session_key")
        .where("watcher_session_key", "=", watcherSessionKey)
        .where("provenance", "=", SESSION_WATCH_PROVENANCE_AMBIENT_GROUP),
    ).rows;
    return new Set(rows.map((row) => row.target_session_key));
  } catch (error) {
    log.warn(`failed to list ambient group watch targets: ${String(error)}`);
    return new Set();
  }
}

/** Register an explicit watcher (e.g. a sessions_send coordinator) for a target session. */
export function registerSessionStateWatch(
  params: { watcherSessionKey: string; targetSessionKey: string; targetAgentId?: string },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): boolean {
  if (
    params.watcherSessionKey === params.targetSessionKey ||
    !isNotifiableWatcherKey(params.watcherSessionKey)
  ) {
    return false;
  }
  const now = options.now ?? Date.now();
  try {
    let registered = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      // Re-watching must not clobber pending-notice cursor state.
      const existing = readCursor(db, params.watcherSessionKey, params.targetSessionKey);
      if (existing) {
        if (existing.provenance !== SESSION_WATCH_PROVENANCE_EXPLICIT) {
          executeSqliteQuerySync(
            db,
            getSessionStateKysely(db)
              .updateTable("session_watch_cursors")
              .set({ provenance: SESSION_WATCH_PROVENANCE_EXPLICIT })
              .where("watcher_session_key", "=", params.watcherSessionKey)
              .where("target_session_key", "=", params.targetSessionKey),
          );
        }
        registered = true;
        return;
      }
      const agentId = params.targetAgentId ?? resolveAgentIdFromSessionKey(params.targetSessionKey);
      const head = executeSqliteQueryTakeFirstSync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select("last_sequence")
          .where("session_key", "=", params.targetSessionKey)
          .where("agent_id", "=", agentId),
      );
      // Seed at the current head: the watcher is synced now; only future changes notify.
      upsertSeedCursor({
        db,
        watcherSessionKey: params.watcherSessionKey,
        targetSessionKey: params.targetSessionKey,
        sequence: normalizeOptionalSqliteNumber(head?.last_sequence) ?? 0,
        now,
      });
      registered = true;
    }, options);
    return registered;
  } catch (error) {
    log.warn(`failed to register session state watch: ${String(error)}`);
    return false;
  }
}

/** Register the personal agent's main session to observe one routed group session. */
export function registerMainSessionGroupWatch(
  params: {
    sessionKey: string;
    agentId: string;
    entry?: SessionEntry;
    dmScope: DmScope;
  },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): boolean {
  if (classifySessionKind(params.sessionKey, params.entry) !== "group") {
    return false;
  }
  const watcherSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
  });
  const now = options.now ?? Date.now();
  try {
    const { db: readDb } = openOpenClawStateDatabase(options);
    if (params.dmScope !== "main") {
      if (!isAmbientGroupWatchCursor(readCursor(readDb, watcherSessionKey, params.sessionKey))) {
        return false;
      }
      runOpenClawStateWriteTransaction(({ db }) => {
        // Recheck provenance in the write transaction: an explicit registration
        // may have promoted this pair after the read-only preflight.
        if (!isAmbientGroupWatchCursor(readCursor(db, watcherSessionKey, params.sessionKey))) {
          return;
        }
        executeSqliteQuerySync(
          db,
          getSessionStateKysely(db)
            .deleteFrom("session_watch_cursors")
            .where("target_session_key", "=", params.sessionKey)
            .where("watcher_session_key", "=", watcherSessionKey)
            .where("provenance", "=", SESSION_WATCH_PROVENANCE_AMBIENT_GROUP),
        );
      }, options);
      return false;
    }
    // This runs on every human group turn. Keep the steady-state path read-only;
    // the transaction below is only for first registration and its race recheck.
    if (readCursor(readDb, watcherSessionKey, params.sessionKey)) {
      return true;
    }
    let registered = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      const existing = readCursor(db, watcherSessionKey, params.sessionKey);
      if (existing) {
        // An explicit watch already owns this pair. Do not downgrade it when
        // later human group turns revisit registration.
        registered = true;
        return;
      }
      const head = executeSqliteQueryTakeFirstSync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select("last_sequence")
          .where("session_key", "=", params.sessionKey)
          .where("agent_id", "=", params.agentId),
      );
      const sequence = normalizeOptionalSqliteNumber(head?.last_sequence) ?? 0;
      upsertSeedCursor({
        db,
        watcherSessionKey,
        targetSessionKey: params.sessionKey,
        sequence,
        now,
        provenance: SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
      });
      registered = true;
    }, options);
    return registered;
  } catch (error) {
    log.warn(`failed to register ambient group watch: ${String(error)}`);
    return false;
  }
}

export function recordSessionHumanDirectMessage(
  params: {
    sessionKey: string;
    entry?: SessionEntry;
    agentId?: string;
    actor: { actorType: SessionStateActorType; actorId?: string };
    channel?: string;
    runId?: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
    occurredAt?: number;
  },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): SessionStateEventRecord | undefined {
  const watcherSessionKey = params.entry?.spawnedBy ?? params.entry?.parentSessionKey;
  if (params.actor.actorType !== "human") {
    return undefined;
  }
  // One indexed watcher probe keeps ordinary un-watched human turns write-free.
  if (!watcherSessionKey && !hasSessionStateWatchers(params.sessionKey, options)) {
    return undefined;
  }
  return recordSessionStateEvent(
    {
      sessionKey: params.sessionKey,
      sessionId: params.entry?.sessionId,
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      kind: "human_direct_message",
      actorType: "human",
      ...(params.actor.actorId ? { actorId: params.actor.actorId } : {}),
      runId: params.runId,
      ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
      summary: `human message via ${params.channel?.trim() || "unknown"}`,
      payload: params.payload,
      ...(params.occurredAt === undefined ? {} : { occurredAt: params.occurredAt }),
      ...(watcherSessionKey ? { watcherSessionKeys: [watcherSessionKey] } : {}),
    },
    options,
  );
}

/** Seed the parent cursor at the child-spawn version. */
export function recordSubagentSpawned(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  agentId: string;
}): void {
  recordSessionStateEvent({
    sessionKey: params.childSessionKey,
    agentId: params.agentId,
    kind: "child_spawned",
    actorType: "agent",
    actorId: params.requesterSessionKey,
    runId: params.childRunId,
    dedupeKey: `child-spawned:${params.childRunId}`,
    summary: "child session spawned",
    watcherSessionKeys: [params.requesterSessionKey],
  });
}

type SubagentTerminalStatus = "ok" | "error" | "timeout" | "cancelled";

const SUBAGENT_TERMINAL_SUMMARY: Record<SubagentTerminalStatus, string> = {
  ok: "child run completed",
  error: "child run failed",
  timeout: "child run timed out",
  cancelled: "child run cancelled",
};

/** Project an already-normalized subagent terminal outcome into the signal log. */
export function recordSubagentTerminalState(params: {
  childSessionKey: string;
  runId: string;
  requesterSessionKey: string;
  outcomeStatus: SubagentTerminalStatus;
}): void {
  // Non-ok statuses share kind run_failed: the closed kind union mirrors the sibling
  // SubagentRunOutcome status projection, which also folds cancel/timeout into error
  // status. The precise outcome survives in payload for changesSince consumers.
  recordSessionStateEvent({
    sessionKey: params.childSessionKey,
    agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
    kind: params.outcomeStatus === "ok" ? "run_completed" : "run_failed",
    actorType: "system",
    runId: params.runId,
    dedupeKey: `run-terminal:${params.runId}`,
    summary: SUBAGENT_TERMINAL_SUMMARY[params.outcomeStatus],
    ...(params.outcomeStatus === "ok" ? {} : { payload: { outcome: params.outcomeStatus } }),
    watcherSessionKeys: [params.requesterSessionKey],
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
