import {
  mergeRestartRecoveryTerminalRunIds,
  sameRestartRecoveryTerminalRunIds,
} from "./restart-recovery-state.js";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

// Metadata timestamps do not fence recovery; writer and lifecycle checks are separate.
// Keep absent recovery fields explicit so a newly introduced claim fails the commit check.
export function buildRestartRecoveryExpectedState(
  entry: SessionEntry,
  mainRestartRecovery?: { cycleId: string; revision: number },
): SessionTranscriptTurnExpectedState {
  const expectedMainRestartRecovery = mainRestartRecovery ?? entry.mainRestartRecovery;
  return {
    abortedLastRun: entry.abortedLastRun,
    mainRestartRecoveryCycleId: expectedMainRestartRecovery?.cycleId,
    mainRestartRecoveryRevision: expectedMainRestartRecovery?.revision,
    restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
    restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
    restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
    restartRecoveryDeliveryRequestFingerprint: entry.restartRecoveryDeliveryRequestFingerprint,
    restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    restartRecoveryRequesterAccountId: entry.restartRecoveryRequesterAccountId,
    restartRecoveryRequesterSenderId: entry.restartRecoveryRequesterSenderId,
    restartRecoverySameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired,
    restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
    restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
    restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
    status: entry.status,
  };
}

export function sessionMatchesExpectedTranscriptTurn<T extends { entry: SessionEntry }>(
  selected: T | undefined,
  expected: {
    expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
    expectedWriterRunId?: SessionTranscriptTurnExpectedState["expectedWriterRunId"];
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
  },
): selected is T {
  const expectedState = expected.expectedSessionState;
  return Boolean(
    selected &&
    selected.entry.sessionId === expected.expectedSessionId &&
    (expected.expectedLifecycleRevision === undefined ||
      selected.entry.lifecycleRevision === (expected.expectedLifecycleRevision ?? undefined)) &&
    (expected.expectedWriterRunId === undefined ||
      selected.entry.activeWriterRunId === expected.expectedWriterRunId) &&
    (expectedState === undefined ||
      (selected.entry.abortedLastRun === expectedState.abortedLastRun &&
        selected.entry.mainRestartRecovery?.cycleId === expectedState.mainRestartRecoveryCycleId &&
        selected.entry.mainRestartRecovery?.revision ===
          expectedState.mainRestartRecoveryRevision &&
        selected.entry.restartRecoveryBeforeAgentReplyState ===
          expectedState.restartRecoveryBeforeAgentReplyState &&
        selected.entry.restartRecoveryDeliveryReceiptState ===
          expectedState.restartRecoveryDeliveryReceiptState &&
        selected.entry.restartRecoveryDeliveryToolCallId ===
          expectedState.restartRecoveryDeliveryToolCallId &&
        selected.entry.restartRecoveryDeliveryRequestFingerprint ===
          expectedState.restartRecoveryDeliveryRequestFingerprint &&
        selected.entry.restartRecoveryDeliveryRunId ===
          expectedState.restartRecoveryDeliveryRunId &&
        selected.entry.restartRecoveryDeliverySourceRunId ===
          expectedState.restartRecoveryDeliverySourceRunId &&
        selected.entry.restartRecoveryRequesterAccountId ===
          expectedState.restartRecoveryRequesterAccountId &&
        selected.entry.restartRecoveryRequesterSenderId ===
          expectedState.restartRecoveryRequesterSenderId &&
        selected.entry.restartRecoverySameChannelThreadRequired ===
          expectedState.restartRecoverySameChannelThreadRequired &&
        selected.entry.restartRecoverySourceIngress ===
          expectedState.restartRecoverySourceIngress &&
        selected.entry.restartRecoverySourceReplyDeliveryMode ===
          expectedState.restartRecoverySourceReplyDeliveryMode &&
        sameRestartRecoveryTerminalRunIds(
          selected.entry.restartRecoveryTerminalRunIds,
          expectedState.restartRecoveryTerminalRunIds,
        ) &&
        selected.entry.status === expectedState.status)),
  );
}

export function buildExpectedTranscriptTurnSessionPatch(params: {
  appendedMessages: readonly { appended: boolean }[];
  currentEntry: SessionEntry;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionFile: string;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  touchSessionEntry?: boolean;
}): Partial<SessionEntry> {
  const appendedCount = params.appendedMessages.filter((message) => message.appended).length;
  const acceptedMessage =
    appendedCount > 0 ||
    (params.expectedSessionState !== undefined &&
      params.appendedMessages.some((message) => !message.appended));
  const touchUpdatedAt = params.touchSessionEntry === true && appendedCount > 0 ? Date.now() : 0;
  const restartRecoveryTerminalRunIds = params.sessionLifecyclePatch?.restartRecoveryTerminalRunIds
    ? mergeRestartRecoveryTerminalRunIds(
        params.currentEntry.restartRecoveryTerminalRunIds,
        params.sessionLifecyclePatch.restartRecoveryTerminalRunIds,
      )
    : undefined;
  return {
    ...(acceptedMessage ? params.sessionLifecyclePatch : undefined),
    ...(acceptedMessage && restartRecoveryTerminalRunIds ? { restartRecoveryTerminalRunIds } : {}),
    ...(touchUpdatedAt > 0
      ? {
          updatedAt: Math.max(
            params.currentEntry.updatedAt ?? 0,
            params.sessionLifecyclePatch?.updatedAt ?? 0,
            touchUpdatedAt,
          ),
        }
      : {}),
  };
}
