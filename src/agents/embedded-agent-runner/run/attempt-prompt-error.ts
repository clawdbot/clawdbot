/** Classifies prompt failures and performs yield or mid-turn recovery. */
import type { AgentSession } from "../../sessions/index.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import {
  isSessionsYieldAbortError,
  persistSessionsYieldContextMessage,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt.sessions-yield.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptErrorAttempt = Pick<EmbeddedRunAttemptParams, "runId" | "sessionId">;
type PromptErrorSessionLockController = Pick<
  EmbeddedAttemptSessionLockController,
  "releaseHeldLockForAbort" | "waitForSessionEvents"
>;
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type EmbeddedAttemptPromptErrorOutcome = {
  promptFailure?: {
    error: unknown;
    source: "prompt";
  };
};

export async function handleEmbeddedAttemptPromptError(input: {
  activeSession: AgentSession;
  attempt: PromptErrorAttempt;
  error: unknown;
  handleMidTurnPrecheckRequest: (request: MidTurnPrecheckRequest) => void;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  sessionLockController: PromptErrorSessionLockController;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
}): Promise<EmbeddedAttemptPromptErrorOutcome> {
  input.releaseLeasedSteering(input.error);
  const yieldAborted = input.yieldDetected && isSessionsYieldAbortError(input.error);
  if (yieldAborted) {
    // Publish terminal state before fallible recovery so outer cleanup still recognizes the yield.
    input.markYieldAborted();
    await waitForSessionsYieldAbortSettle({
      settlePromise: input.yieldAbortSettled,
      runId: input.attempt.runId,
      sessionId: input.attempt.sessionId,
    });
    await input.sessionLockController.releaseHeldLockForAbort();
    await input.sessionLockController.waitForSessionEvents(input.activeSession);
    await input.withOwnedSessionWriteLock(async () => {
      stripSessionsYieldArtifacts(input.activeSession);
      if (input.yieldMessage) {
        await persistSessionsYieldContextMessage(input.activeSession, input.yieldMessage);
      }
    });
    return {};
  }

  if (isMidTurnPrecheckSignal(input.error)) {
    const request = input.error.request;
    await input.sessionLockController.waitForSessionEvents(input.activeSession);
    await input.withOwnedSessionWriteLock(() => {
      input.handleMidTurnPrecheckRequest(request);
    });
    return {};
  }

  return {
    promptFailure: {
      error: input.error,
      source: "prompt",
    },
  };
}
