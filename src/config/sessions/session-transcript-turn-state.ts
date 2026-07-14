import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { SessionEntry } from "./types.js";

export function sessionMatchesExpectedTranscriptTurn<T extends { entry: SessionEntry }>(
  selected: T | undefined,
  expected: {
    expectedLifecycleRevision?: string;
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
  },
): selected is T {
  const expectedState = expected.expectedSessionState;
  return Boolean(
    selected &&
    selected.entry.sessionId === expected.expectedSessionId &&
    (expected.expectedLifecycleRevision === undefined ||
      selected.entry.lifecycleRevision === expected.expectedLifecycleRevision) &&
    (expectedState === undefined ||
      (selected.entry.abortedLastRun === expectedState.abortedLastRun &&
        selected.entry.restartRecoveryDeliveryRequestFingerprint ===
          expectedState.restartRecoveryDeliveryRequestFingerprint &&
        selected.entry.restartRecoveryDeliveryRunId ===
          expectedState.restartRecoveryDeliveryRunId &&
        selected.entry.restartRecoveryDeliverySourceRunId ===
          expectedState.restartRecoveryDeliverySourceRunId &&
        selected.entry.status === expectedState.status &&
        selected.entry.updatedAt === expectedState.updatedAt)),
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
    ...(params.currentEntry.sessionFile === params.sessionFile
      ? {}
      : { sessionFile: params.sessionFile }),
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
