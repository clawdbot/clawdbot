import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import {
  applySessionGoalOperation,
  readSessionGoalOperationReceipt,
  writeSessionGoalOperationReceipt,
} from "./goals-operations.js";
import type {
  SessionTranscriptTurnMutation,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type {
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction } from "./session-accessor.sqlite-deletion.js";
import {
  collectSessionEntryLookupKeys,
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  cloneSessionEntry,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { rememberCommittedTranscriptMessageSequencesInTransaction } from "./session-accessor.sqlite-transcript-sequences.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import {
  buildExpectedTranscriptTurnSessionPatch,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

type SqliteExpectedSessionTranscriptTurnResult = {
  sessionTurnMutationResult?: SessionTranscriptTurnMutationResult;
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: {
    atomicGroup?: boolean;
    config?: import("../types.openclaw.js").OpenClawConfig;
    cwd?: string;
    expectedLifecycleRevision?: string;
    expectedWriterRunId?: SessionTranscriptTurnExpectedState["expectedWriterRunId"];
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
    messages: readonly SessionTranscriptTurnMessageAppend[];
    sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
    sessionTurnMutation?: SessionTranscriptTurnMutation;
    sessionFile: string;
    touchSessionEntry?: boolean;
  },
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const resolved = resolveSqliteTranscriptScope({
    ...scope,
    sessionId: options.expectedSessionId,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const mutation = options.sessionTurnMutation;
    mutation?.assertCurrent?.();
    const preparedDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    if (mutation) {
      ensureSessionGoalOperationsSchema(preparedDatabase.db);
    }
    // openclaw-agent-db.ts cache rule: LRU can close idle handles during shouldAppend awaits.
    const preparedEntry = readSessionEntryRow(preparedDatabase, resolved.sessionKey);
    const preparedReplay = mutation
      ? readSessionGoalOperationReceipt(
          preparedDatabase.db,
          resolved.sessionKey,
          options.expectedSessionId,
          mutation.operation,
        )
      : undefined;
    if (preparedReplay && preparedEntry?.entry.sessionId === options.expectedSessionId) {
      return {
        appendedMessages: [],
        sessionEntry: preparedEntry.entry,
        sessionFile: options.sessionFile,
        sessionTurnMutationResult: { result: preparedReplay, replayed: true },
      };
    }
    if (!sessionMatchesExpectedTranscriptTurn(preparedEntry, options)) {
      return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
    }
    const messages = await selectAppendableSqliteTranscriptTurnMessages(
      {
        agentId: resolved.agentId,
        sessionId: options.expectedSessionId,
        sessionKey: resolved.sessionKey,
        ...(scope.storePath ? { storePath: scope.storePath } : {}),
      },
      options.messages,
    );
    let result: SqliteExpectedSessionTranscriptTurnResult = sqliteSessionTranscriptTurnRebound(
      preparedEntry,
      options.sessionFile,
    );
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((transactionDb) => {
      mutation?.assertCurrent?.();
      const fresh = readSessionEntryRow(transactionDb, resolved.sessionKey);
      const replay = mutation
        ? readSessionGoalOperationReceipt(
            transactionDb.db,
            resolved.sessionKey,
            options.expectedSessionId,
            mutation.operation,
          )
        : undefined;
      if (replay && fresh?.entry.sessionId === options.expectedSessionId) {
        result = {
          appendedMessages: [],
          sessionEntry: fresh.entry,
          sessionFile: options.sessionFile,
          sessionTurnMutationResult: { result: replay, replayed: true },
        };
        return;
      }
      if (!sessionMatchesExpectedTranscriptTurn(fresh, options)) {
        result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
        return;
      }
      const goal = mutation
        ? applySessionGoalOperation(fresh.entry, mutation.operation, Date.now())
        : undefined;
      const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
      for (const append of messages) {
        const { shouldAppend: _shouldAppend, ...appendOptions } = append;
        let message = appendOptions.message;
        if (mutation && goal && isRecord(message) && message.role === "user") {
          message = {
            ...message,
            __openclaw: {
              ...(isRecord(message["__openclaw"]) ? message["__openclaw"] : {}),
              intent: {
                kind:
                  mutation.operation.action === "start"
                    ? "session-goal-start"
                    : "session-goal-resume",
                version: 1,
                goalId: goal.id,
                operationId: mutation.operation.operationId,
              },
            },
          };
        }
        const appended = appendTranscriptMessageInTransaction(transactionDb, resolved, {
          ...appendOptions,
          message,
          messageAlreadyRedacted: options.atomicGroup === true,
          ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
          ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        });
        if (appended) {
          appendedMessages.push(appended);
        }
      }
      if (
        options.atomicGroup &&
        (appendedMessages.length !== messages.length ||
          appendedMessages.some((message) => message.appended) !==
            appendedMessages.every((message) => message.appended))
      ) {
        throw new Error("SQLite transcript batch was not wholly inserted or replayed");
      }

      if (
        mutation &&
        (appendedMessages.length === 0 ||
          appendedMessages.length !== messages.length ||
          appendedMessages.some((message) => !message.appended))
      ) {
        throw new Error("Goal admission requires a new transcript turn in the same transaction.");
      }

      // Later explicit parents can abandon earlier rows. Capture every cursor
      // from the final active projection before this atomic transaction commits.
      rememberCommittedTranscriptMessageSequencesInTransaction(
        transactionDb,
        resolved.sessionId,
        appendedMessages,
      );

      const sessionPatch = buildExpectedTranscriptTurnSessionPatch({
        appendedMessages,
        currentEntry: fresh.entry,
        expectedSessionState: options.expectedSessionState,
        sessionFile: options.sessionFile,
        sessionLifecyclePatch: options.sessionLifecyclePatch,
        touchSessionEntry: options.touchSessionEntry,
      });
      if (mutation) {
        sessionPatch.goal = goal;
      }
      const next =
        Object.keys(sessionPatch).length > 0
          ? mergeSessionEntry(fresh.entry, sessionPatch)
          : fresh.entry;
      if (next !== fresh.entry) {
        const identityKeys = collectSessionEntryLookupKeys(transactionDb, resolved.sessionKey);
        previousIdentity = readSessionIdentitySnapshot(transactionDb, identityKeys);
        writeSessionEntry(transactionDb, resolved.sessionKey, next);
        currentIdentity = readSessionIdentitySnapshot(transactionDb, identityKeys);
      }
      const sessionTurnMutationResult = mutation
        ? {
            result: writeSessionGoalOperationReceipt(
              transactionDb.db,
              resolved.sessionKey,
              options.expectedSessionId,
              mutation.operation,
              goal,
              mutation.runId,
            ),
            replayed: false,
          }
        : undefined;
      result = {
        sessionTurnMutationResult,
        appendedMessages,
        sessionEntry: cloneSessionEntry(next),
        sessionFile: options.sessionFile,
      };
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result;
  });
}

function sqliteSessionTranscriptTurnRebound(
  selected: ResolvedSessionEntryRow | undefined,
  sessionFile: string,
): SqliteExpectedSessionTranscriptTurnResult {
  return {
    appendedMessages: [],
    rejectedReason: "session-rebound",
    sessionEntry: selected?.entry,
    sessionFile,
  };
}

async function selectAppendableSqliteTranscriptTurnMessages(
  context: SessionTranscriptTurnWriteContext,
  messages: readonly SessionTranscriptTurnMessageAppend[],
): Promise<SessionTranscriptTurnMessageAppend[]> {
  const selected: SessionTranscriptTurnMessageAppend[] = [];
  for (const append of messages) {
    const shouldAppend = append.shouldAppend ? await append.shouldAppend(context) : true;
    if (shouldAppend) {
      selected.push(append);
    }
  }
  return selected;
}
