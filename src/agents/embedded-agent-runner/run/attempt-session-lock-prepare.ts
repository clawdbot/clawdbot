/** Acquires and publishes the session-write ownership used by one attempt. */
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { resolveAgentRunSessionTarget } from "../../run-session-target.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockTargetKey,
} from "../../session-write-lock.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { resolveEmbeddedAttemptSessionWriteLockOptions } from "./attempt.run-decisions.js";
import {
  acquireEmbeddedAttemptSessionFileOwner,
  type EmbeddedAttemptSessionFileOwner,
  createEmbeddedAttemptSessionLockController,
} from "./attempt.session-lock.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSessionLockController = Awaited<
  ReturnType<typeof createEmbeddedAttemptSessionLockController>
>;
type OwnedTranscriptWriteContext = Parameters<typeof withOwnedSessionTranscriptWrites>[0];
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

export async function prepareEmbeddedAttemptSessionLock(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "abortSignal" | "config" | "sessionFile" | "sessionId" | "sessionKey" | "sessionTarget"
  >;
  externalAbortController: {
    arm: () => void;
    throwIfFiredAfterPrepCleanup: () => Promise<void>;
  };
  getSessionManager: () => ReturnType<typeof guardSessionManager> | undefined;
  onSessionFileOwnerAcquired: (owner: EmbeddedAttemptSessionFileOwner) => void;
  onSessionLockReleaseReady: (release: () => Promise<void>) => void;
}): Promise<{
  compactionTimeoutMs: number;
  ownedTranscriptWriteContext: OwnedTranscriptWriteContext;
  sessionLockController: AttemptSessionLockController;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
}> {
  const { attempt, externalAbortController } = input;
  const compactionTimeoutMs = resolveCompactionTimeoutMs(attempt.config);
  const sessionWriteLockOptions = resolveEmbeddedAttemptSessionWriteLockOptions({
    config: attempt.config,
    compactionTimeoutMs,
  });
  const sessionTarget = await resolveAgentRunSessionTarget({
    agentId: attempt.sessionTarget?.agentId,
    config: attempt.config,
    missingSessionKey: "resolve-existing",
    sessionFile: attempt.sessionFile,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
  });

  await externalAbortController.throwIfFiredAfterPrepCleanup();
  const sessionFileOwner = await acquireEmbeddedAttemptSessionFileOwner({
    sessionFile: attempt.sessionFile,
    timeoutMs: sessionWriteLockOptions.maxHoldMs,
    signal: attempt.abortSignal,
  });
  // Publish ownership immediately so outer teardown can release it if later
  // controller setup or the post-arm abort fence fails.
  input.onSessionFileOwnerAcquired(sessionFileOwner);

  const getSessionManager = (operation: "entry merge" | "file reload") => {
    const sessionManager = input.getSessionManager();
    if (!sessionManager) {
      throw new Error(`session manager unavailable during prompt-released ${operation}`);
    }
    return sessionManager;
  };
  const sessionLockController = await createEmbeddedAttemptSessionLockController({
    acquireSessionWriteLock,
    initialAcquireSignal: attempt.abortSignal,
    lockOptions: {
      sessionFile: resolveSessionWriteLockTargetKey(sessionTarget),
      targetKind: "session-key",
      ...sessionWriteLockOptions,
    },
    mergePromptReleasedSessionEntries: (entries) =>
      getSessionManager("entry merge").mergePromptReleasedSessionEntries(entries, {
        persistLeaf: true,
      }),
    reloadPromptReleasedSessionFile: () => {
      getSessionManager("file reload").reloadPersistedTranscript();
    },
  });
  input.onSessionLockReleaseReady(() => sessionLockController.dispose());

  const ownedTranscriptWriteContext: OwnedTranscriptWriteContext = {
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
    canAdvanceSessionEntryCache: (snapshot) =>
      sessionLockController.canAdvanceSessionEntryCache(snapshot),
    publishSessionFileSnapshot: (snapshot) =>
      sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
    withSessionWriteLock: (operation, options) =>
      sessionLockController.withSessionWriteLock(operation, options),
  };
  const withOwnedSessionWriteLock: WithOwnedSessionWriteLock = (operation) =>
    withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
      sessionLockController.withSessionWriteLock(operation),
    );

  externalAbortController.arm();
  // The signal can fire while the eager lock is acquired. Recheck after arming
  // so a stopped run never reaches session creation or provider prompt.
  await externalAbortController.throwIfFiredAfterPrepCleanup();

  return {
    compactionTimeoutMs,
    ownedTranscriptWriteContext,
    sessionLockController,
    withOwnedSessionWriteLock,
  };
}
