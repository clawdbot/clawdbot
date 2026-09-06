/** Prepares the admitted writer context and teardown tracker for one attempt. */
import {
  getOwnedSessionTranscriptInitialWriter,
  type OwnedSessionTranscriptWriteContext,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../../run-session-target.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

export async function prepareEmbeddedAttemptTranscriptLifecycle(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "abortSignal"
    | "config"
    | "runId"
    | "sessionFile"
    | "sessionId"
    | "sessionKey"
    | "sessionManager"
    | "sessionTarget"
  > & { admittedRunContext?: EmbeddedRunAttemptParams["admittedRunContext"] };
  externalAbortController: {
    arm: () => void;
    throwIfFiredAfterPrepCleanup: () => Promise<void>;
  };
}): Promise<{
  compactionTimeoutMs: number;
  ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext;
  transcriptLifecycle: ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}> {
  const { attempt, externalAbortController } = input;
  const initialWriter = getOwnedSessionTranscriptInitialWriter({
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionManager?.getSessionTarget() ?? attempt.sessionTarget,
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
  initialWriter?.assertActive();

  const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({
    runId: attempt.runId,
    sessionId: attempt.sessionId,
  });
  const fencedSessionTarget = {
    ...sessionTarget,
    ...(attempt.sessionTarget?.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: attempt.sessionTarget.expectedLifecycleRevision }
      : {}),
    ...(attempt.sessionTarget?.expectedWriterRunId !== undefined
      ? { expectedWriterRunId: attempt.sessionTarget.expectedWriterRunId }
      : {}),
  };
  const assertAdmittedActive = attempt.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(attempt.admittedRunContext, attempt.abortSignal)
    : undefined;
  const ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext = {
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: fencedSessionTarget,
    ...(initialWriter ? { initialWriter } : {}),
    assertCommitAllowed: () => {
      attempt.abortSignal?.throwIfAborted();
      assertAdmittedActive?.();
    },
    withTranscriptWrite: (operation) => transcriptLifecycle.withTranscriptWrite(operation),
  };
  const withOwnedTranscriptWrite: WithOwnedTranscriptWrite = (operation) =>
    withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
      transcriptLifecycle.withTranscriptWrite(operation),
    );

  externalAbortController.arm();
  try {
    await externalAbortController.throwIfFiredAfterPrepCleanup();
  } catch (error) {
    await transcriptLifecycle.dispose();
    throw error;
  }

  return {
    compactionTimeoutMs: resolveCompactionTimeoutMs(attempt.config),
    ownedTranscriptWriteContext,
    transcriptLifecycle,
    withOwnedTranscriptWrite,
  };
}
