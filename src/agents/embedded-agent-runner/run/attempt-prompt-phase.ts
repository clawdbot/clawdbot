/** Runs prompt assembly, admission, submission, and prompt-local recovery. */
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  buildHeartbeatOutcomeContext,
  claimHeartbeatOutcomeForRun,
} from "../../../infra/heartbeat-outcome-store.js";
import { releasePendingAgentSteeringItems } from "../../subagents/registry/subagent-registry.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { log } from "../logger.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import {
  handleEmbeddedAttemptPromptError,
  prepareEmbeddedAttemptPromptExecution,
  submitEmbeddedAttemptPrompt,
} from "./attempt-prompt-submit.js";
import {
  applyPromptBuildToolsAllow,
  observeEmbeddedAttemptPrompt,
} from "./attempt-prompt-support.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";

type PromptAssemblyInput = Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0];
type PromptAssemblyResult = Awaited<ReturnType<typeof prepareEmbeddedAttemptPromptAssembly>>;
type PromptContextInput = Parameters<typeof prepareEmbeddedAttemptPromptContext>[0];
type PromptContextResult = ReturnType<typeof prepareEmbeddedAttemptPromptContext>;
type PromptErrorInput = Parameters<typeof handleEmbeddedAttemptPromptError>[0];
type PromptExecutionInput = Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0];
type PromptObservationInput = Parameters<typeof observeEmbeddedAttemptPrompt>[0];
type PromptPreflightInput = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0];
type PromptSubmissionInput = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
type BeforeAgentRunOutcome = NonNullable<
  Awaited<ReturnType<typeof runEmbeddedAttemptBeforeAgentRun>>
>;
type PromptPhaseState = Omit<PromptPreflightInput["state"], "skipPromptSubmission">;

type PromptAssemblyPhaseInput = Omit<
  PromptAssemblyInput,
  | "attempt"
  | "activeSession"
  | "sessionManager"
  | "applyPromptBuildToolsAllow"
  | "setLeasedSteering"
>;
type PromptContextPhaseInput = Omit<
  PromptContextInput,
  "attempt" | "messages" | "prompt" | "replaceSessionMessages"
>;
type PromptExecutionPhaseInput = Omit<
  PromptExecutionInput,
  "attempt" | "prompt" | "skipPromptSubmission"
>;
type PromptObservationPhaseInput = Omit<
  PromptObservationInput,
  | "attempt"
  | "contextTokenBudget"
  | "effectivePrompt"
  | "hookMessagesForCurrentPrompt"
  | "imageCount"
  | "llmBoundaryPromptForPrecheck"
  | "promptForModel"
  | "promptSubmissionRuntimeOnly"
  | "reserveTokens"
  | "sessionMessages"
  | "skipPromptSubmission"
  | "systemPromptForHook"
  | "transcriptLeafId"
>;
type PromptToolSurface = ReturnType<typeof applyPromptBuildToolsAllow>;
type PromptPreflightPhaseInput = Omit<
  PromptPreflightInput,
  | "attempt"
  | "activeContextEngine"
  | "contextTokenBudget"
  | "hookMessagesForCurrentPrompt"
  | "promptForPrecheck"
  | "reserveTokens"
  | "sessionMessageCount"
  | "state"
  | "systemPrompt"
  | "toolResultMaxChars"
> & {
  activeContextEngine?: PromptPreflightInput["activeContextEngine"];
};
type PromptSubmissionPhaseInput = Pick<
  PromptSubmissionInput,
  | "promptActiveSession"
  | "sessionPromptState"
  | "toolResultPromptProjectionState"
  | "trajectoryRecorder"
>;
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

export async function runEmbeddedAttemptPromptPhase(input: {
  attempt: PromptAssemblyInput["attempt"];
  activeSession: PromptAssemblyInput["activeSession"];
  sessionManager: PromptAssemblyInput["sessionManager"];
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
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
  toolPolicy: {
    baseline: Parameters<typeof applyPromptBuildToolsAllow>[0]["baseline"];
    effectiveTools: Array<{ name: string }>;
    uncompactedEffectiveTools: Array<{ name: string }>;
    tools: Array<{ name: string }>;
    toolSearchCatalogRef?: Parameters<typeof applyPromptBuildToolsAllow>[0]["catalogRef"];
    codeModeControlsEnabled: boolean;
    coreReadAuthorized: boolean;
    forceToolNames?: readonly string[];
  };
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
    setCodeModeReconciliationReadAuthorized: (value: boolean) => void;
    setFinalPromptText: (prompt: string) => void;
    markBeforeAgentRunBlocked: (outcome: BeforeAgentRunOutcome) => void;
    markYieldAborted: () => void;
    isRunBudgetTimeoutAbort: (error: unknown) => boolean;
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
  const publishDispatchState = (state: PromptPreflightInput["state"]) => {
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

  let promptToolSurface: PromptToolSurface | undefined;
  const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession,
    sessionManager,
    ...input.assembly,
    applyPromptBuildToolsAllow: (toolsAllow) => {
      promptToolSurface = applyPromptBuildToolsAllow({
        session: activeSession,
        toolsAllow,
        baseline: input.toolPolicy.baseline,
        effectiveTools: input.toolPolicy.effectiveTools,
        uncompactedEffectiveTools: input.toolPolicy.uncompactedEffectiveTools,
        tools: input.toolPolicy.tools,
        catalogRef: input.toolPolicy.toolSearchCatalogRef,
        codeModeControlsEnabled: input.toolPolicy.codeModeControlsEnabled,
        coreReadAuthorized: input.toolPolicy.coreReadAuthorized,
        forceToolNames: input.toolPolicy.forceToolNames,
      });
      input.lifecycle.setCodeModeReconciliationReadAuthorized(promptToolSurface.coreReadAuthorized);
      return promptToolSurface.activeToolNames;
    },
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
              storePath: attempt.sessionTarget?.storePath,
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
    const { hookMessagesForCurrentPrompt, promptForModel, systemPromptForHook } = promptContext;
    input.lifecycle.setPrePromptMessageCount(promptContext.prePromptMessageCount);
    input.lifecycle.setCurrentUserTimestampOverride(promptContext.currentUserTimestampOverride);
    const beforeAgentRunOutcome =
      attempt.operation === "settled-tool-finalization"
        ? undefined
        : await runEmbeddedAttemptBeforeAgentRun({
            attempt,
            activeSession,
            hookContext: hookCtx,
            hookMessages: hookMessagesForCurrentPrompt,
            hookRunner: input.assembly.hookRunner,
            modelPrompt: promptForModel,
            sessionManager,
            systemPrompt: systemPromptForHook,
            withOwnedTranscriptWrite: input.withOwnedTranscriptWrite,
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
            await input.withOwnedTranscriptWrite(() => {
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

    const imageResult = await prepareEmbeddedAttemptPromptExecution({
      ...input.execution,
      attempt,
      prompt: promptContext.promptSubmission.prompt,
      skipPromptSubmission,
    });
    const reserveTokens = input.getCompactionReserveTokens();
    let state: PromptPreflightInput["state"] = {
      ...input.lifecycle.readState(),
      skipPromptSubmission: observeEmbeddedAttemptPrompt({
        ...input.observation,
        ...(promptToolSurface
          ? {
              effectiveTools: promptToolSurface.effectiveTools,
              tools: promptToolSurface.tools,
              uncompactedEffectiveTools: promptToolSurface.uncompactedEffectiveTools,
            }
          : {}),
        attempt,
        contextTokenBudget: promptContext.contextTokenBudget,
        effectivePrompt: promptContext.effectivePrompt,
        hookMessagesForCurrentPrompt: promptContext.hookMessagesForCurrentPrompt,
        imageCount: imageResult.images.length,
        llmBoundaryPromptForPrecheck: promptContext.llmBoundaryPromptForPrecheck,
        promptForModel: promptContext.promptForModel,
        promptSubmissionRuntimeOnly: promptContext.promptSubmission.runtimeOnly,
        reserveTokens,
        sessionMessages: activeSession.messages,
        skipPromptSubmission,
        systemPromptForHook: promptContext.systemPromptForHook,
        transcriptLeafId,
      }).skipPromptSubmission,
    };
    // Publish each admission transition before the next fallible phase so outer cleanup sees it.
    publishDispatchState(state);

    const { activeContextEngine, ...preflight } = input.preflight;
    state = await prepareEmbeddedAttemptPromptPreflight({
      ...preflight,
      attempt,
      ...(activeContextEngine ? { activeContextEngine } : {}),
      contextTokenBudget: promptContext.contextTokenBudget,
      hookMessagesForCurrentPrompt: promptContext.hookMessagesForCurrentPrompt,
      promptForPrecheck: promptContext.llmBoundaryPromptForPrecheck,
      reserveTokens,
      sessionMessageCount: activeSession.messages.length,
      state,
      systemPrompt: promptContext.systemPromptForHook,
      toolResultMaxChars: promptContext.promptToolResultMaxChars,
    });
    publishDispatchState(state);

    if (!state.skipPromptSubmission) {
      await submitEmbeddedAttemptPrompt({
        ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
        attempt,
        activeSession,
        contextTokenBudget: promptContext.contextTokenBudget,
        images: imageResult.images,
        ...(leasedSteering ? { leasedSteering } : {}),
        modelPrompt: promptContext.promptForModel,
        onFinalPromptText: input.lifecycle.setFinalPromptText,
        onSteeringAcknowledged: () => {
          leasedSteering = undefined;
        },
        ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
        ...(promptContext.runtimeContextMessageForCurrentTurn
          ? { runtimeContextMessage: promptContext.runtimeContextMessageForCurrentTurn }
          : {}),
        runtimeOnly: promptContext.promptSubmission.runtimeOnly === true,
        systemPrompt: promptContext.systemPromptForHook,
        toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
        toolResultMaxChars: promptContext.promptToolResultMaxChars,
        transcriptLeafId,
        transcriptPrompt: promptContext.promptForSession,
        ...input.submission,
      });
    } else {
      releaseLeasedSteering(state.promptError ?? "prompt submission skipped");
    }
    publishDispatchState(state);
  } catch (error) {
    const promptErrorOutcome = await handleEmbeddedAttemptPromptError({
      activeSession,
      attempt,
      error,
      handleMidTurnPrecheckRequest,
      markYieldAborted: input.lifecycle.markYieldAborted,
      releaseLeasedSteering,
      withOwnedTranscriptWrite: input.withOwnedTranscriptWrite,
      ...input.lifecycle.readYieldState(),
    });
    // The timeout owner records its terminal before aborting the prompt. That
    // abort is not a provider failure and must leave timeout salvage eligible.
    if (
      promptErrorOutcome.promptFailure &&
      !input.lifecycle.isRunBudgetTimeoutAbort(promptErrorOutcome.promptFailure.error)
    ) {
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
    await input.withOwnedTranscriptWrite(() => {
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
