import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { SessionsGoalMutationResultSchema } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  ensureSessionGoalOperationsSchema,
  SESSION_GOAL_OPERATIONS_TABLE,
} from "../../state/openclaw-agent-goal-operations-schema.js";
import type {
  SessionGoalOperation,
  SessionGoalOperationResult,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import {
  SessionGoalTransitionError,
  buildCreatedSessionGoal,
  buildUpdatedSessionGoalObjective,
  buildUpdatedSessionGoalStatus,
} from "./goals-transitions.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  collectSessionEntryLookupKeys,
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { mergeSessionEntry, type SessionEntry, type SessionGoal } from "./types.js";

export type { SessionGoalOperation, SessionGoalOperationResult } from "./goals-operations.types.js";

const validateReceipt = lazyCompile<SessionGoalOperationResult>(SessionsGoalMutationResultSchema);

const OPERATION_VALIDITY_MS = 24 * 60 * 60 * 1000;
const OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SESSION_RECEIPTS = 4096;

type GoalOperationScope = SessionAccessScope & { expectedSessionId: string };
type OperationErrorCode =
  | "expired"
  | "operation-conflict"
  | "session-rebound"
  | "goal-rebound"
  | "capacity"
  | "invalid";

export class SessionGoalOperationError extends Error {
  constructor(
    readonly code: OperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionGoalOperationError";
  }
}

function assertOperationTime(operation: SessionGoalOperation, now: number): void {
  if (
    !Number.isSafeInteger(operation.issuedAtMs) ||
    operation.issuedAtMs > now + OPERATION_FUTURE_SKEW_MS
  ) {
    throw new SessionGoalOperationError(
      "invalid",
      "Goal operation time is invalid; refresh and try again.",
    );
  }
  // Reject the original timestamp even after pruning its receipt: an expired retry must never
  // recreate a cleared Goal. Clients retain the operation identity unchanged on retry.
  if (operation.issuedAtMs + OPERATION_VALIDITY_MS <= now) {
    throw new SessionGoalOperationError(
      "expired",
      "Goal operation expired; review the current Goal before trying again.",
    );
  }
}

function operationFingerprint(operation: SessionGoalOperation): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        operation.issuedAtMs,
        operation.requestFingerprint,
        operation.action,
        "goalId" in operation ? operation.goalId : null,
        "objective" in operation ? operation.objective : null,
        "tokenBudget" in operation ? operation.tokenBudget : null,
        "note" in operation ? operation.note : null,
      ]),
    )
    .digest("hex");
}

/** Read a durable receipt before transient chat dedupe or busy checks, without creating tables. */
export function lookupSessionGoalOperation(
  options: GoalOperationScope & { operation: SessionGoalOperation },
): SessionGoalOperationResult | undefined {
  assertOperationTime(options.operation, Date.now());
  const resolved = resolveSqliteScope(options);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const { db } = database;
    const table = executeSqliteQueryTakeFirstSync(
      db,
      getSessionKysely(db)
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "=", SESSION_GOAL_OPERATIONS_TABLE),
    );
    if (!table) {
      return undefined;
    }
    const receipt = readSessionGoalOperationReceipt(
      db,
      resolved.sessionKey,
      options.expectedSessionId,
      options.operation,
    );
    if (
      receipt &&
      readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !==
        options.expectedSessionId
    ) {
      throw new SessionGoalOperationError(
        "session-rebound",
        "Session changed after this Goal operation; refresh before trying again.",
      );
    }
    return receipt;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : undefined;
}

/** The caller has installed the schema before BEGIN; this read participates in its transaction. */
export function readSessionGoalOperationReceipt(
  db: DatabaseSync,
  sessionKey: string,
  sessionId: string,
  operation: SessionGoalOperation,
): SessionGoalOperationResult | undefined {
  assertOperationTime(operation, Date.now());
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSessionKysely(db)
      .selectFrom(SESSION_GOAL_OPERATIONS_TABLE)
      .selectAll()
      .where("session_key", "=", sessionKey)
      .where("operation_id", "=", operation.operationId),
  );
  if (!row) {
    return undefined;
  }
  if (row.request_fingerprint !== operationFingerprint(operation)) {
    throw new SessionGoalOperationError(
      "operation-conflict",
      "Goal operation ID was already used for a different request.",
    );
  }
  if (row.session_id !== sessionId) {
    throw new SessionGoalOperationError(
      "session-rebound",
      "Session changed after this Goal operation; refresh before trying again.",
    );
  }
  const result = safeParseJson(row.result_json);
  if (
    !validateReceipt(result) ||
    result.operationId !== operation.operationId ||
    result.action !== operation.action ||
    result.sessionId !== sessionId ||
    ("goalId" in operation && result.goalId !== operation.goalId) ||
    (result.goal !== undefined && result.goal.id !== result.goalId)
  ) {
    throw new SessionGoalOperationError(
      "invalid",
      "Stored Goal operation receipt is invalid; inspect the session before retrying.",
    );
  }
  return result;
}

/** Apply the same policy used by text commands to the fresh row inside the commit section. */
export function applySessionGoalOperation(
  entry: SessionEntry,
  operation: SessionGoalOperation,
  now: number,
): SessionGoal | undefined {
  try {
    if (operation.action === "start") {
      return buildCreatedSessionGoal(entry, operation, now);
    }
    if (!entry.goal || entry.goal.id !== operation.goalId) {
      throw new SessionGoalOperationError(
        "goal-rebound",
        "Goal changed or was cleared; refresh before trying again.",
      );
    }
    if (operation.action === "clear") {
      return undefined;
    }
    if (operation.action === "edit") {
      return buildUpdatedSessionGoalObjective(entry, operation.objective, now);
    }
    return buildUpdatedSessionGoalStatus(
      entry,
      {
        status:
          operation.action === "resume"
            ? "active"
            : operation.action === "pause"
              ? "paused"
              : operation.action === "block"
                ? "blocked"
                : "complete",
        note: operation.note,
      },
      now,
    );
  } catch (error) {
    if (error instanceof SessionGoalTransitionError) {
      throw new SessionGoalOperationError("invalid", error.message);
    }
    throw error;
  }
}

/** Called only after every Goal/turn/lifecycle write succeeds, in that same transaction. */
export function writeSessionGoalOperationReceipt(
  db: DatabaseSync,
  sessionKey: string,
  sessionId: string,
  operation: SessionGoalOperation,
  goal: SessionGoal | undefined,
  runId?: string,
): SessionGoalOperationResult {
  const now = Date.now();
  assertOperationTime(operation, now);
  const kysely = getSessionKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom(SESSION_GOAL_OPERATIONS_TABLE).where("expires_at", "<=", now),
  );
  const count =
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom(SESSION_GOAL_OPERATIONS_TABLE)
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("session_key", "=", sessionKey),
    )?.count ?? 0;
  if (count >= MAX_SESSION_RECEIPTS) {
    // Evicting a still-valid receipt would turn a retry into a second operation.
    throw new SessionGoalOperationError(
      "capacity",
      "Too many recent Goal operations; wait for older requests to expire before trying again.",
    );
  }
  const goalId = goal?.id ?? ("goalId" in operation ? operation.goalId : undefined);
  if (!goalId) {
    throw new Error("Goal creation did not produce a Goal identity.");
  }
  const result: SessionGoalOperationResult = {
    operationId: operation.operationId,
    action: operation.action,
    sessionId,
    goalId,
    status: runId ? "started" : operation.action === "clear" ? "cleared" : "updated",
    ...(goal ? { goal } : {}),
    ...(runId ? { runId } : {}),
  };
  executeSqliteQuerySync(
    db,
    kysely.insertInto(SESSION_GOAL_OPERATIONS_TABLE).values({
      session_key: sessionKey,
      operation_id: operation.operationId,
      session_id: sessionId,
      request_fingerprint: operationFingerprint(operation),
      result_json: JSON.stringify(result),
      expires_at: operation.issuedAtMs + OPERATION_VALIDITY_MS,
    }),
  );
  return result;
}

/** Management-only Goal actions do not enter chat or fabricate user turns. */
export async function mutateSessionGoal(
  options: GoalOperationScope & {
    /** Revalidate the Gateway-owned authorization after waiting for the writer queue. */
    assertCurrent?: () => void;
    operation: Exclude<SessionGoalOperation, { action: "start" }> & {
      action: "edit" | "pause" | "block" | "complete" | "clear";
    };
  },
): Promise<SessionTranscriptTurnMutationResult & { sessionEntry?: SessionEntry }> {
  const resolved = resolveSqliteScope(options);
  const databaseOptions = toDatabaseOptions(resolved);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    ensureSessionGoalOperationsSchema(openOpenClawAgentDatabase(databaseOptions).db);
    const committed = runOpenClawAgentWriteTransaction((database) => {
      options.assertCurrent?.();
      const fresh = readSessionEntryRow(database, resolved.sessionKey);
      const replay = readSessionGoalOperationReceipt(
        database.db,
        resolved.sessionKey,
        options.expectedSessionId,
        options.operation,
      );
      if (replay && fresh?.entry.sessionId === options.expectedSessionId) {
        return { result: replay, replayed: true };
      }
      if (!fresh || fresh.entry.sessionId !== options.expectedSessionId) {
        throw new SessionGoalOperationError(
          "session-rebound",
          "Session changed; refresh before changing its Goal.",
        );
      }
      const goal = applySessionGoalOperation(fresh.entry, options.operation, Date.now());
      const next = mergeSessionEntry(fresh.entry, { goal });
      const identityKeys = collectSessionEntryLookupKeys(database, resolved.sessionKey);
      const previousIdentity = readSessionIdentitySnapshot(database, identityKeys);
      writeSessionEntry(database, resolved.sessionKey, next);
      const currentIdentity = readSessionIdentitySnapshot(database, identityKeys);
      const result = writeSessionGoalOperationReceipt(
        database.db,
        resolved.sessionKey,
        options.expectedSessionId,
        options.operation,
        goal,
      );
      return { result, replayed: false, previousIdentity, currentIdentity, next };
    }, databaseOptions);
    if (committed.next) {
      emitCommittedSessionIdentityDiff(
        resolved.agentId,
        committed.previousIdentity,
        committed.currentIdentity,
      );
    }
    return { result: committed.result, replayed: committed.replayed, sessionEntry: committed.next };
  });
}
