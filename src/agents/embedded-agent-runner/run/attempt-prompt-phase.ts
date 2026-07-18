/** Runs prompt assembly, admission, submission, and prompt-local recovery. */
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  buildHeartbeatOutcomeContext,
  claimHeartbeatOutcomeForRun,
} from "../../../infra/heartbeat-outcome-store.js";
import { releasePendingAgentSteeringItems } from "../../subagent-registry.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { log } from "../logger.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-assembly.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-context.js";
import { dispatchEmbeddedAttemptPrompt } from "./attempt-prompt-dispatch.js";
import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-error.js";
import { handleEmbeddedAttemptMidTurnPrecheck } from "./attempt-prompt-preflight.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { PREEMPTIVE_OVERFLOW_ERROR_TEXT } from "./preemptive-compaction.js";

type PromptAssemblyInput = Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0];
type PromptAssemblyResult = Awaited<ReturnType<typeof prepareEmbeddedAttemptPromptAssembly>>;
type PromptContextInput = Parameters<typeof prepareEmbeddedAttemptPromptContext>[0];
type PromptContextResult = ReturnType<typeof prepareEmbeddedAttemptPromptContext>;
type PromptDispatchInput = Parameters<typeof dispatchEmbeddedAttemptPrompt>[0];
type PromptErrorInput = Parameters<typeof handleEmbeddedAttemptPromptError>[0];
type BeforeAgentRunOutcome = NonNullable<
  Awaited<ReturnType<typeof runEmbeddedAttemptBeforeAgentRun>>
>;
type PromptPhaseState = Omit<PromptDispatchInput["state"], "skipPromptSubmission">;

type PromptAssemblyPhaseInput = Omit<
  PromptAssemblyInput,
  "attempt" | "activeSession" | "sessionManager" | "setLeasedSteering"
>;
type PromptContextPhaseInput = Omit<
  PromptContextInput,
  "attempt" | "messages" | "prompt" | "replaceSessionMessages"
>;
type PromptExecutionPhaseInput = Omit<PromptDispatchInput["execution"], "sessionLockController">;
type PromptObservationPhaseInput = Omit<PromptDispatchInput["observation"], "transcriptLeafId">;
type PromptPreflightPhaseInput = Omit<
  PromptDispatchInput["preflight"],
  "sessionManager" | "withOwnedSessionWriteLock"
> & {
  activeContextEngine?: PromptDispatchInput["activeContextEngine"];
};
type PromptSubmissionPhaseInput = Pick<
  PromptDispatchInput["submission"],
  | "promptActiveSession"
  | "sessionPromptState"
  | "toolResultPromptProjectionState"
  | "trajectoryRecorder"
>;

export async function runEmbeddedAttemptPromptPhase(input: {
  attempt: PromptAssemblyInput["attempt"];
  activeSession: PromptAssemblyInput["activeSession"];
  sessionManager: PromptAssemblyInput["sessionManager"];
  sessionLockController: PromptDispatchInput["execution"]["sessionLockController"];
  withOwnedSessionWriteLock: PromptDispatchInput["preflight"]["withOwnedSessionWriteLock"];
  getCompactionReserveTokens: () => number;
  emptyExplicitToolAllowlistError?: Error;
  assembly: PromptAssemblyPhaseInput;
  context: PromptContextPhaseInput;
  execution: PromptExecutionPhaseInput;
  googlePromptCache: {
    extraParams: Parameters<typeof prepareGooglePromptCacheStreamFn>[0]["extraParams"];
    signal: AbortSignal;
  };
  observation: PromptObservationPhaseInput;
  preflight: PromptPreflightPhaseInput;
  submission: PromptSubmissionPhaseInput;
  lifecycle: {
    readState: () => PromptPhaseState;
    writeState: (state: PromptPhaseState) => void;
    getPrePromptMessageCount: () => number;
    setPrePromptMessageCount: (count: number) => void;
    setCurrentUserTimestampOverride: (
      override: PromptContextResult["currentUserTimestampOverride"],
    ) => void;
    setPromptCacheChangesForTurn: (
      changes: PromptAssemblyResult["promptCacheChangesForTurn"],
    ) => void;
    setFinalPromptText: (prompt: string) => void;
    markBeforeAgentRunBlocked: (outcome: BeforeAgentRunOutcome) => void;
    markYieldAborted: () => void;
    readYieldState: () => Pick<
      PromptErrorInput,
      "yieldAbortSettled" | "yieldDetected" | "yieldMessage"
    >;
    stopAcceptingSteerMessages: () => void;
    takePendingMidTurnPrecheckRequest: () => MidTurnPrecheckRequest | null | undefined;
  };
}): Promise<{ promptStartedAt: number }> {
  const { activeSession, attempt, sessionManager } = input;
  let skipPromptSubmission = false;
  let leasedSteering: PromptAssemblyResult["leasedSteering"];

  const patchState = (patch: Partial<PromptPhaseState>) => {
    input.lifecycle.writeState({ ...input.lifecycle.readState(), ...patch });
  };
  const publishDispatchState = (state: PromptDispatchInput["state"]) => {
    const { skipPromptSubmission: nextSkipPromptSubmission, ...phaseState } = state;
    skipPromptSubmission = nextSkipPromptSubmission;
    input.lifecycle.writeState(phaseState);
  };
  const releaseLeasedSteering = (error?: unknown) => {
    if (!leasedSteering) {
      return;
    }
    releasePendingAgentSteeringItems({
      runIds: leasedSteering.runIds,
      leaseId: leasedSteering.leaseId,
      error: error ? formatErrorMessage(error) : undefined,
    });
    leasedSteering = undefined;
  };
  const handleMidTurnPrecheckRequest = (request: MidTurnPrecheckRequest) => {
    const outcome = handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request,
      sessionAgentId: input.context.sessionAgentId,
      sessionManager,
      prePromptMessageCount: input.lifecycle.getPrePromptMessageCount(),
      replaceSessionMessages: (messages) => {
        activeSession.agent.state.messages = messages;
      },
    });
    patchState({
      preflightRecovery: outcome.preflightRecovery,
      ...(outcome.promptError
        ? { promptError: outcome.promptError, promptErrorSource: "precheck" }
        : {}),
    });
  };

  const promptStartedAt = Date.now();
  if (input.emptyExplicitToolAllowlistError) {
    patchState({
      promptError: input.emptyExplicitToolAllowlistError,
      promptErrorSource: "precheck",
    });
    skipPromptSubmission = true;
    log.warn(`[tools] ${input.emptyExplicitToolAllowlistError.message}`);
  }

  const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession,
    sessionManager,
    ...input.assembly,
    setLeasedSteering: (lease) => {
      leasedSteering = lease;
    },
  });
  const { hookCtx, promptBuildPrependContext, promptBuildAppendContext, transcriptLeafId } =
    promptAssembly;
  leasedSteering = promptAssembly.leasedSteering ?? leasedSteering;
  input.lifecycle.setPromptCacheChangesForTurn(promptAssembly.promptCacheChangesForTurn);

  try {
    const heartbeatOutcomeContext =
      attempt.trigger === "user" && attempt.sessionKey
        ? buildHeartbeatOutcomeContext(
            claimHeartbeatOutcomeForRun({
              agentId: input.context.sessionAgentId,
              sessionKey: attempt.sessionKey,
              runId: attempt.runId,
            }),
          )
        : undefined;
    const promptContext = prepareEmbeddedAttemptPromptContext({
      attempt,
      ...(heartbeatOutcomeContext ? { heartbeatOutcomeContext } : {}),
      messages: activeSession.messages,
      prompt: promptAssembly,
      replaceSessionMessages: (messages) => {
        activeSession.agent.state.messages = messages;
      },
      ...input.context,
    });
    const {
      aggregatePressureEngaged,
      hookMessagesForCurrentPrompt,
      promptForModel,
      systemPromptForHook,
    } = promptContext;
    input.lifecycle.setPrePromptMessageCount(promptContext.prePromptMessageCount);
    input.lifecycle.setCurrentUserTimestampOverride(promptContext.currentUserTimestampOverride);
    if (aggregatePressureEngaged) {
      // Compaction and aggregate truncation both target about half the window;
      // compact-then-truncate prevents re-hitting the same cap on the next turn.
      patchState({
        preflightRecovery: { route: "compact_then_truncate" },
        promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
        promptErrorSource: "precheck",
      });
      skipPromptSubmission = true;
    }

    const beforeAgentRunOutcome = await runEmbeddedAttemptBeforeAgentRun({
      attempt,
      activeSession,
      hookContext: hookCtx,
      hookMessages: hookMessagesForCurrentPrompt,
      hookRunner: input.assembly.hookRunner,
      modelPrompt: promptForModel,
      sessionManager,
      systemPrompt: systemPromptForHook,
      withOwnedSessionWriteLock: input.withOwnedSessionWriteLock,
    });
    if (beforeAgentRunOutcome) {
      input.lifecycle.markBeforeAgentRunBlocked(beforeAgentRunOutcome);
      patchState({
        promptError: beforeAgentRunOutcome.promptError,
        promptErrorSource: "hook:before_agent_run",
      });
      skipPromptSubmission = true;
    }

    if (!skipPromptSubmission) {
      const { resolvedApiKey } = attempt;
      const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
        apiKey: await resolveEmbeddedAgentApiKey({
          provider: attempt.provider,
          resolvedApiKey,
          authStorage: attempt.authStorage,
        }),
        extraParams: input.googlePromptCache.extraParams,
        model: attempt.model,
        modelId: attempt.modelId,
        provider: attempt.provider,
        sessionManager: {
          appendCustomEntry: async (customType, data) => {
            await input.withOwnedSessionWriteLock(() => {
              sessionManager.appendCustomEntry(customType, data);
            });
          },
          getEntries: () => sessionManager.getEntries(),
        },
        signal: input.googlePromptCache.signal,
        streamFn: activeSession.agent.streamFn,
        systemPrompt: input.assembly.systemPromptText,
      });
      if (googlePromptCacheStreamFn) {
        activeSession.agent.streamFn = googlePromptCacheStreamFn;
      }
    }

    const { activeContextEngine, ...preflight } = input.preflight;
    const dispatchState = await dispatchEmbeddedAttemptPrompt({
      attempt,
      ...(activeContextEngine ? { activeContextEngine } : {}),
      activeSession,
      promptContext,
      getCompactionReserveTokens: input.getCompactionReserveTokens,
      publishState: publishDispatchState,
      releaseLeasedSteering,
      state: {
        ...input.lifecycle.readState(),
        skipPromptSubmission,
      },
      execution: {
        ...input.execution,
        sessionLockController: input.sessionLockController,
      },
      observation: {
        ...input.observation,
        transcriptLeafId,
      },
      preflight: {
        ...preflight,
        sessionManager,
        withOwnedSessionWriteLock: input.withOwnedSessionWriteLock,
      },
      submission: {
        ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
        ...(leasedSteering ? { leasedSteering } : {}),
        onFinalPromptText: input.lifecycle.setFinalPromptText,
        onSteeringAcknowledged: () => {
          leasedSteering = undefined;
        },
        ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
        transcriptLeafId,
        ...input.submission,
      },
    });
    publishDispatchState(dispatchState);
  } catch (error) {
    const promptErrorOutcome = await handleEmbeddedAttemptPromptError({
      activeSession,
      attempt,
      error,
      handleMidTurnPrecheckRequest,
      markYieldAborted: input.lifecycle.markYieldAborted,
      releaseLeasedSteering,
      sessionLockController: input.sessionLockController,
      withOwnedSessionWriteLock: input.withOwnedSessionWriteLock,
      ...input.lifecycle.readYieldState(),
    });
    if (promptErrorOutcome.promptFailure) {
      patchState({
        promptError: promptErrorOutcome.promptFailure.error,
        promptErrorSource: promptErrorOutcome.promptFailure.source,
      });
    }
  } finally {
    input.lifecycle.stopAcceptingSteerMessages();
    log.debug(
      `embedded run prompt end: runId=${attempt.runId} sessionId=${attempt.sessionId} durationMs=${Date.now() - promptStartedAt}`,
    );
  }

  const pendingMidTurnPrecheckRequest = input.lifecycle.takePendingMidTurnPrecheckRequest();
  if (pendingMidTurnPrecheckRequest) {
    await input.sessionLockController.waitForSessionEvents(activeSession);
    await input.withOwnedSessionWriteLock(() => {
      removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
      const state = input.lifecycle.readState();
      if (!state.preflightRecovery && state.promptErrorSource !== "precheck") {
        patchState({ promptError: null, promptErrorSource: null });
        handleMidTurnPrecheckRequest(pendingMidTurnPrecheckRequest);
      }
    });
  }

  return { promptStartedAt };
}
