import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type {
  WorkerTranscriptCommitErrorReason,
  WorkerTranscriptCommitResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as StateDatabase,
  WorkerTranscriptCommitHeads,
  WorkerTranscriptCommits,
} from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";

type TranscriptCommitDb = Pick<
  StateDatabase,
  "worker_transcript_commit_heads" | "worker_transcript_commits"
>;
type HeadRow = Selectable<WorkerTranscriptCommitHeads>;
type HeadInsert = Insertable<WorkerTranscriptCommitHeads>;
type CommitRow = Selectable<WorkerTranscriptCommits>;
type CommitInsert = Insertable<WorkerTranscriptCommits>;

export type WorkerTranscriptCommitInput = {
  environmentId: string;
  sessionId: string;
  runEpoch: number;
  seq: number;
  requestHash: string;
};

export type WorkerTranscriptCommitOutcome =
  | { ok: true; result: WorkerTranscriptCommitResult }
  | { ok: false; reason: WorkerTranscriptCommitErrorReason };

export type WorkerTranscriptCommitBeginResult =
  | { kind: "claimed" }
  | { kind: "recover" }
  | { kind: "replay"; outcome: WorkerTranscriptCommitOutcome }
  | { kind: "rejected"; reason: "conflict" }
  | { kind: "rejected"; reason: "out-of-order"; expectedSeq: number };

type NormalizedCommitInput = WorkerTranscriptCommitInput & { nowMs: number };
type ExistingCommitResult = Extract<
  WorkerTranscriptCommitBeginResult,
  { kind: "recover" | "replay" | "rejected" }
>;

const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Worker transcript commit ${field} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Worker transcript commit ${field} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Worker transcript commit ${field} must be a positive integer`);
  }
  return value;
}

function normalizeRequestHash(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_HASH_PATTERN.test(value)) {
    throw new Error("Worker transcript commit request hash must be lowercase SHA-256 hex");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry: unknown) => typeof entry === "string" && entry.length > 0)
  );
}

function isCommitResult(value: unknown): value is WorkerTranscriptCommitResult {
  if (!isRecord(value) || !isNonEmptyStringArray(value.entryIds)) {
    return false;
  }
  return typeof value.newLeafId === "string" && value.newLeafId.length > 0;
}

function isCommitErrorReason(value: unknown): value is WorkerTranscriptCommitErrorReason {
  return (
    value === "stale-base-leaf" ||
    value === "epoch-mismatch" ||
    value === "invalid-batch" ||
    value === "session-not-attached"
  );
}

function parseOutcomeJson(value: string): WorkerTranscriptCommitOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Worker transcript commit cached outcome is invalid", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("Worker transcript commit cached outcome is invalid");
  }
  if (parsed.ok === true && isCommitResult(parsed.result)) {
    return { ok: true, result: parsed.result };
  }
  if (parsed.ok === false && isCommitErrorReason(parsed.reason)) {
    return { ok: false, reason: parsed.reason };
  }
  throw new Error("Worker transcript commit cached outcome is invalid");
}

function serializeOutcome(outcome: WorkerTranscriptCommitOutcome): string {
  const serialized = JSON.stringify(outcome);
  if (!serialized) {
    throw new Error("Worker transcript commit outcome is not serializable");
  }
  return serialized;
}

function normalizeInput(input: WorkerTranscriptCommitInput, nowMs: number): NormalizedCommitInput {
  return {
    environmentId: required(input.environmentId, "environment id"),
    sessionId: required(input.sessionId, "session id"),
    runEpoch: nonNegativeInteger(input.runEpoch, "run epoch"),
    seq: positiveInteger(input.seq, "sequence"),
    requestHash: normalizeRequestHash(input.requestHash),
    nowMs: nonNegativeInteger(nowMs, "timestamp"),
  };
}

const query = (db: DatabaseSync) => getNodeSqliteKysely<TranscriptCommitDb>(db);

function findHead(db: DatabaseSync, input: NormalizedCommitInput): HeadRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commit_heads")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch),
  );
}

function findCommit(db: DatabaseSync, input: NormalizedCommitInput): CommitRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commits")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch)
      .where("seq", "=", input.seq),
  );
}

function classifyExistingCommit(params: {
  head: HeadRow | undefined;
  commit: CommitRow | undefined;
  input: NormalizedCommitInput;
}): ExistingCommitResult | undefined {
  if (!params.commit) {
    return undefined;
  }
  if (!params.head) {
    throw new Error("Worker transcript commit row has no sequence head");
  }
  if (
    params.head.environment_id !== params.input.environmentId ||
    params.commit.request_hash !== params.input.requestHash
  ) {
    return { kind: "rejected", reason: "conflict" };
  }
  if (params.commit.state === "pending") {
    return { kind: "recover" };
  }
  if (params.commit.state === "terminal" && params.commit.result_json !== null) {
    return { kind: "replay", outcome: parseOutcomeJson(params.commit.result_json) };
  }
  throw new Error("Worker transcript commit row has invalid terminal state");
}

function insertHead(db: DatabaseSync, input: NormalizedCommitInput): void {
  const head: HeadInsert = {
    session_id: input.sessionId,
    run_epoch: input.runEpoch,
    environment_id: input.environmentId,
    next_seq: 1,
    updated_at_ms: input.nowMs,
  };
  executeSqliteQuerySync(db, query(db).insertInto("worker_transcript_commit_heads").values(head));
}

function insertPendingCommit(db: DatabaseSync, input: NormalizedCommitInput): void {
  const commit: CommitInsert = {
    session_id: input.sessionId,
    run_epoch: input.runEpoch,
    seq: input.seq,
    request_hash: input.requestHash,
    state: "pending",
    result_json: null,
    created_at_ms: input.nowMs,
    updated_at_ms: input.nowMs,
  };
  executeSqliteQuerySync(db, query(db).insertInto("worker_transcript_commits").values(commit));
}

export function createWorkerTranscriptCommitStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const path = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const write = <T>(operation: (db: DatabaseSync) => T): T =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db), { path });

  const begin = (rawInput: WorkerTranscriptCommitInput): WorkerTranscriptCommitBeginResult => {
    const input = normalizeInput(rawInput, now());
    return write<WorkerTranscriptCommitBeginResult>((db) => {
      const head = findHead(db, input);
      const existing = classifyExistingCommit({ head, commit: findCommit(db, input), input });
      if (existing) {
        return existing;
      }
      if (head && head.environment_id !== input.environmentId) {
        return { kind: "rejected", reason: "conflict" };
      }
      const expectedSeq = head?.next_seq ?? 1;
      if (input.seq !== expectedSeq) {
        return { kind: "rejected", reason: "out-of-order", expectedSeq };
      }
      if (!head) {
        insertHead(db, input);
      }
      insertPendingCommit(db, input);
      return { kind: "claimed" };
    });
  };

  const complete = (
    rawInput: WorkerTranscriptCommitInput & { outcome: WorkerTranscriptCommitOutcome },
  ): WorkerTranscriptCommitOutcome => {
    const input = normalizeInput(rawInput, now());
    const resultJson = serializeOutcome(rawInput.outcome);
    return write<WorkerTranscriptCommitOutcome>((db) => {
      const head = findHead(db, input);
      const commit = findCommit(db, input);
      const existing = classifyExistingCommit({ head, commit, input });
      if (!existing) {
        throw new Error("Worker transcript commit must begin before terminal completion");
      }
      if (existing.kind === "rejected") {
        throw new Error(
          `Worker transcript commit terminal completion rejected: ${existing.reason}`,
        );
      }
      if (existing.kind === "replay") {
        return existing.outcome;
      }
      if (!head) {
        throw new Error("Worker transcript commit row has no sequence head");
      }
      if (head.next_seq !== input.seq) {
        throw new Error(
          `Worker transcript commit terminal completion expected sequence ${head.next_seq}`,
        );
      }

      const commitUpdate = executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_transcript_commits")
          .set({ state: "terminal", result_json: resultJson, updated_at_ms: input.nowMs })
          .where("session_id", "=", input.sessionId)
          .where("run_epoch", "=", input.runEpoch)
          .where("seq", "=", input.seq)
          .where("request_hash", "=", input.requestHash)
          .where("state", "=", "pending"),
      );
      if (commitUpdate.numAffectedRows !== 1n) {
        throw new Error("Worker transcript commit changed during terminal completion");
      }
      const headUpdate = executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_transcript_commit_heads")
          .set({ next_seq: input.seq + 1, updated_at_ms: input.nowMs })
          .where("session_id", "=", input.sessionId)
          .where("run_epoch", "=", input.runEpoch)
          .where("environment_id", "=", input.environmentId)
          .where("next_seq", "=", input.seq),
      );
      if (headUpdate.numAffectedRows !== 1n) {
        throw new Error("Worker transcript commit sequence changed during terminal completion");
      }
      return rawInput.outcome;
    });
  };

  return { begin, complete };
}

export type WorkerTranscriptCommitStore = ReturnType<typeof createWorkerTranscriptCommitStore>;
