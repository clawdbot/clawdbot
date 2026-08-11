import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentScopedMemorySchema } from "../state/openclaw-agent-scoped-memory-schema.js";
import { AGENT_SESSION_MEMORY_SCHEMA_SQL } from "../state/openclaw-agent-session-memory-schema.js";

type MemoryCutoverDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  "memory_migrations" | "session_memory_subjects"
>;

export type MemoryIsolationMode = "legacy" | "shadow-read-only" | "cutover" | "unavailable";

const SHADOW_READ_ONLY_MIGRATION_ID = "memory-isolation-shadow-read-only-v1";
const SHADOW_READ_ONLY_SOURCE_KIND = "memory-isolation-shadow-read-only";
const SHADOW_READ_ONLY_SOURCE_HASH = "sha256:67d7363a5c0c72aae82474c9903b1444";
const SHADOW_READ_ONLY_CLASSIFICATION_VERSION = 2;
const PILOT_SUBJECT_KINDS = new Set(["user", "conversation", "service", "agent", "system"]);

type ShadowPilotSubject = Readonly<{
  kind: "user" | "conversation" | "service" | "agent" | "system";
  principalId: string;
}>;

type MemoryIsolationSnapshot = Readonly<{
  mode: MemoryIsolationMode;
  pilotSubject?: ShadowPilotSubject;
}>;

type MemoryIsolationMarker = Readonly<{
  migration_id: string;
  source_kind: string;
  source_hash: string;
  phase: string;
  classification_json: string;
  plan_hash: string;
  verified_at: number | null;
  cutover_at: number | null;
}>;

// The gateway reads one process-stable snapshot. Doctor mutations take effect after restart, so
// a transient authority-store failure can never reopen legacy filesystem memory in a live run.
const snapshotByAgentId = new Map<string, MemoryIsolationSnapshot>();

function isVerifiedCutoverMarker(
  marker: Pick<MemoryIsolationMarker, "phase" | "verified_at" | "cutover_at">,
): boolean {
  return (
    marker.phase === "cutover" &&
    typeof marker.verified_at === "number" &&
    Number.isSafeInteger(marker.verified_at) &&
    marker.verified_at > 0 &&
    typeof marker.cutover_at === "number" &&
    Number.isSafeInteger(marker.cutover_at) &&
    marker.cutover_at > 0
  );
}

function hashClassification(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseShadowPilotSubject(classificationJson: string): ShadowPilotSubject | undefined {
  try {
    const parsed = JSON.parse(classificationJson) as {
      mode?: unknown;
      version?: unknown;
      subject?: { kind?: unknown; principalId?: unknown };
    };
    if (
      parsed.mode !== "shadow-read-only" ||
      parsed.version !== SHADOW_READ_ONLY_CLASSIFICATION_VERSION ||
      !PILOT_SUBJECT_KINDS.has(String(parsed.subject?.kind)) ||
      typeof parsed.subject?.principalId !== "string" ||
      !parsed.subject.principalId.trim()
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: parsed.subject.kind as ShadowPilotSubject["kind"],
      principalId: parsed.subject.principalId.trim(),
    });
  } catch {
    return undefined;
  }
}

function createShadowClassification(subject: ShadowPilotSubject): string {
  return JSON.stringify({
    mode: "shadow-read-only",
    version: SHADOW_READ_ONLY_CLASSIFICATION_VERSION,
    subject,
  });
}

function isVerifiedShadowReadOnlyMarker(
  marker: MemoryIsolationMarker,
): ShadowPilotSubject | undefined {
  const pilotSubject = parseShadowPilotSubject(marker.classification_json);
  return marker.migration_id === SHADOW_READ_ONLY_MIGRATION_ID &&
    marker.source_kind === SHADOW_READ_ONLY_SOURCE_KIND &&
    marker.source_hash === SHADOW_READ_ONLY_SOURCE_HASH &&
    marker.phase === "verified" &&
    marker.plan_hash === hashClassification(marker.classification_json) &&
    typeof marker.verified_at === "number" &&
    Number.isSafeInteger(marker.verified_at) &&
    marker.verified_at > 0 &&
    marker.cutover_at === null &&
    pilotSubject
    ? pilotSubject
    : undefined;
}

function resolveMemoryIsolationSnapshotInDatabase(db: DatabaseSync): MemoryIsolationSnapshot {
  ensureOpenClawAgentScopedMemorySchema(db);
  db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const memoryDb = getNodeSqliteKysely<MemoryCutoverDatabase>(db);
  const cutover = executeSqliteQueryTakeFirstSync(
    db,
    memoryDb
      .selectFrom("memory_migrations")
      .select(["phase", "verified_at", "cutover_at"])
      .where("phase", "=", "cutover")
      .limit(1),
  );
  if (cutover) {
    return isVerifiedCutoverMarker(cutover) ? { mode: "cutover" } : { mode: "unavailable" };
  }
  const shadow = executeSqliteQueryTakeFirstSync(
    db,
    memoryDb
      .selectFrom("memory_migrations")
      .select([
        "migration_id",
        "source_kind",
        "source_hash",
        "phase",
        "classification_json",
        "plan_hash",
        "verified_at",
        "cutover_at",
      ])
      .where("source_kind", "=", SHADOW_READ_ONLY_SOURCE_KIND)
      .limit(1),
  );
  if (!shadow) {
    return { mode: "legacy" };
  }
  const pilotSubject = isVerifiedShadowReadOnlyMarker(shadow);
  return pilotSubject ? { mode: "shadow-read-only", pilotSubject } : { mode: "unavailable" };
}

function resolveMemoryIsolationSnapshotFromDatabase(params: {
  agentId: string;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationSnapshot {
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId: params.agentId,
  });
  return resolveMemoryIsolationSnapshotInDatabase(database.db);
}

function readMemoryIsolationSnapshot(
  agentIdInput: string,
  options?: OpenClawAgentDatabaseOptions,
): MemoryIsolationSnapshot {
  const agentId = agentIdInput.trim();
  if (!agentId) {
    return { mode: "unavailable" };
  }
  const cached = snapshotByAgentId.get(agentId);
  if (cached) {
    return cached;
  }
  try {
    const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options });
    snapshotByAgentId.set(agentId, snapshot);
    return snapshot;
  } catch {
    const unavailable = { mode: "unavailable" } as const;
    snapshotByAgentId.set(agentId, unavailable);
    return unavailable;
  }
}

function resolveSingleShadowPilotSubject(params: {
  database: ReturnType<typeof openOpenClawAgentDatabase>;
}): ShadowPilotSubject {
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_memory_subjects")
      .select(["subject_kind", "principal_id"])
      .where("principal_id", "is not", null)
      .distinct(),
  ).rows;
  const subjects = new Map<string, ShadowPilotSubject>();
  for (const row of rows) {
    if (!PILOT_SUBJECT_KINDS.has(row.subject_kind) || !row.principal_id?.trim()) {
      continue;
    }
    const subject = Object.freeze({
      kind: row.subject_kind as ShadowPilotSubject["kind"],
      principalId: row.principal_id.trim(),
    });
    subjects.set(`${subject.kind}\u0000${subject.principalId}`, subject);
  }
  if (subjects.size !== 1) {
    throw new Error(
      "memory isolation shadow-read-only requires exactly one persisted verified session subject",
    );
  }
  return subjects.values().next().value as ShadowPilotSubject;
}

/**
 * Read the durable P1C posture for one agent. A malformed or unreadable marker is unavailable,
 * not legacy, so no failure path can silently widen access.
 */
export function resolveMemoryIsolationMode(agentIdInput: string): MemoryIsolationMode {
  return readMemoryIsolationSnapshot(agentIdInput).mode;
}

/** Write Doctor's reversible P1C shadow-read-only marker; Phase 6's cutover marker is untouched. */
export function enableMemoryShadowReadOnlyMode(params: {
  agentId: string;
  nowMs?: number;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationMode {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("memory isolation agent id is required");
  }
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("memory isolation verification time is invalid");
  }
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId,
  });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(database.db);
  const cutover = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("memory_migrations")
      .select(["phase", "verified_at", "cutover_at"])
      .where("phase", "=", "cutover")
      .where("verified_at", "is not", null)
      .where("cutover_at", "is not", null)
      .limit(1),
  );
  if (cutover && isVerifiedCutoverMarker(cutover)) {
    throw new Error(
      "memory isolation has completed final cutover and cannot return to shadow mode",
    );
  }
  const pilotSubject = resolveSingleShadowPilotSubject({ database });
  const classificationJson = createShadowClassification(pilotSubject);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("memory_migrations")
      .values({
        migration_id: SHADOW_READ_ONLY_MIGRATION_ID,
        source_kind: SHADOW_READ_ONLY_SOURCE_KIND,
        source_hash: SHADOW_READ_ONLY_SOURCE_HASH,
        phase: "verified",
        classification_json: classificationJson,
        plan_hash: hashClassification(classificationJson),
        verified_at: nowMs,
        cutover_at: null,
        updated_at: nowMs,
      })
      .onConflict((conflict) => conflict.columns(["source_kind", "source_hash"]).doNothing()),
  );
  const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options: params.options });
  if (
    snapshot.mode !== "shadow-read-only" ||
    snapshot.pilotSubject?.kind !== pilotSubject.kind ||
    snapshot.pilotSubject?.principalId !== pilotSubject.principalId
  ) {
    throw new Error("memory isolation shadow-read-only marker did not verify");
  }
  // The request-time cache deliberately stays unchanged: Doctor runs out of process and a
  // gateway must restart before its enforcement snapshot changes. This direct verification is
  // only for the lifecycle command's durable-write acknowledgement.
  return snapshot.mode;
}

/** Remove only the reversible P1C marker. Final cutover remains a Phase 6-only lifecycle state. */
export function disableMemoryShadowReadOnlyMode(params: {
  agentId: string;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationMode {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("memory isolation agent id is required");
  }
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId,
  });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(database.db);
  const cutover = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("memory_migrations")
      .select(["phase", "verified_at", "cutover_at"])
      .where("phase", "=", "cutover")
      .where("verified_at", "is not", null)
      .where("cutover_at", "is not", null)
      .limit(1),
  );
  if (cutover && isVerifiedCutoverMarker(cutover)) {
    throw new Error("memory isolation has completed final cutover and cannot be disabled");
  }
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("memory_migrations")
      .where("source_kind", "=", SHADOW_READ_ONLY_SOURCE_KIND)
      .where("source_hash", "=", SHADOW_READ_ONLY_SOURCE_HASH),
  );
  const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options: params.options });
  if (snapshot.mode !== "legacy") {
    throw new Error("memory isolation shadow-read-only marker did not clear");
  }
  // Do not refresh a live gateway's cached posture from a lifecycle mutation; restart owns the
  // activation boundary. The direct database read above only proves Doctor removed its marker.
  return snapshot.mode;
}

/** The P1C pilot binds one durable subject; a different subject cannot mint a protected context. */
export function isMemoryIsolationSubjectAdmitted(params: {
  agentId: string;
  subject: Readonly<{ kind: string; principalId: string }>;
  options?: OpenClawAgentDatabaseOptions;
}): boolean {
  const snapshot = readMemoryIsolationSnapshot(params.agentId, params.options);
  if (snapshot.mode === "unavailable") {
    return false;
  }
  if (snapshot.mode !== "shadow-read-only") {
    return true;
  }
  return (
    snapshot.pilotSubject?.kind === params.subject.kind &&
    snapshot.pilotSubject.principalId === params.subject.principalId
  );
}

/**
 * True whenever Doctor's durable P1C shadow posture or final Phase 6 cutover disables legacy
 * memory. An unreadable authority store fails closed: selected-memory callers never use legacy.
 */
export function isMemoryIsolationCutoverAgent(agentIdInput: string): boolean {
  return resolveMemoryIsolationMode(agentIdInput) !== "legacy";
}

/**
 * Transcript companions are part of the same durable memory boundary as selected-memory reads.
 * A malformed marker fails closed, so shadow and final cutover never persist raw rows without one.
 */
export function isMemoryIsolationTranscriptPolicyEnforcedInDatabase(db: DatabaseSync): boolean {
  try {
    return resolveMemoryIsolationSnapshotInDatabase(db).mode !== "legacy";
  } catch {
    return true;
  }
}

export function resetMemoryIsolationCutoverForTest(): void {
  snapshotByAgentId.clear();
}
