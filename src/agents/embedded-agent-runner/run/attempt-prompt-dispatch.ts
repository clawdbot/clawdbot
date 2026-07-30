/** Runs prompt-local image preparation, observability, preflight, and provider dispatch. */
import type { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-context.js";
import { prepareEmbeddedAttemptPromptExecution } from "./attempt-prompt-execution-prepare.js";
import { observeEmbeddedAttemptPrompt } from "./attempt-prompt-observability.js";
import { prepareEmbeddedAttemptPromptPreflight } from "./attempt-prompt-preflight.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptContext = ReturnType<typeof prepareEmbeddedAttemptPromptContext>;
type PromptExecutionInput = Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0];
type PromptObservationInput = Parameters<typeof observeEmbeddedAttemptPrompt>[0];
type PromptPreflightInput = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0];
type PromptSubmissionInput = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
type PromptDispatchState = PromptPreflightInput["state"];

export async function dispatchEmbeddedAttemptPrompt(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: PromptPreflightInput["activeContextEngine"];
  activeSession: PromptExecutionInput["session"] & PromptSubmissionInput["activeSession"];
  promptContext: PromptContext;
  getCompactionReserveTokens: () => number;
  publishState: (state: PromptDispatchState) => void;
  releaseLeasedSteering: (error?: unknown) => void;
  state: PromptDispatchState;
  execution: Omit<PromptExecutionInput, "attempt" | "prompt" | "session" | "skipPromptSubmission">;
  observation: Omit<
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
  >;
  preflight: Omit<
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
  >;
  submission: Omit<
    PromptSubmissionInput,
    | "attempt"
    | "activeSession"
    | "contextTokenBudget"
    | "images"
    | "modelPrompt"
    | "runtimeContextMessage"
    | "runtimeOnly"
    | "systemPrompt"
    | "toolResultAggregateMaxChars"
    | "toolResultMaxChars"
    | "transcriptPrompt"
  >;
}): Promise<PromptDispatchState> {
  const { activeSession, attempt, promptContext } = input;
  const imageResult = await prepareEmbeddedAttemptPromptExecution({
    ...input.execution,
    attempt,
    prompt: promptContext.promptSubmission.prompt,
    session: activeSession,
    skipPromptSubmission: input.state.skipPromptSubmission,
  });

  const reserveTokens = input.getCompactionReserveTokens();
  let state: PromptDispatchState = {
    ...input.state,
    skipPromptSubmission: observeEmbeddedAttemptPrompt({
      ...input.observation,
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
      skipPromptSubmission: input.state.skipPromptSubmission,
      systemPromptForHook: promptContext.systemPromptForHook,
    }).skipPromptSubmission,
  };
  // Publish each admission transition before the next fallible phase so outer cleanup sees it.
  input.publishState(state);

  state = await prepareEmbeddedAttemptPromptPreflight({
    ...input.preflight,
    attempt,
    ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
    contextTokenBudget: promptContext.contextTokenBudget,
    hookMessagesForCurrentPrompt: promptContext.hookMessagesForCurrentPrompt,
    promptForPrecheck: promptContext.llmBoundaryPromptForPrecheck,
    reserveTokens,
    sessionMessageCount: activeSession.messages.length,
    state,
    systemPrompt: promptContext.systemPromptForHook,
    toolResultMaxChars: promptContext.promptToolResultMaxChars,
  });
  input.publishState(state);

  if (!state.skipPromptSubmission) {
    await submitEmbeddedAttemptPrompt({
      ...input.submission,
      attempt,
      activeSession,
      contextTokenBudget: promptContext.contextTokenBudget,
      images: imageResult.images,
      modelPrompt: promptContext.promptForModel,
      ...(promptContext.runtimeContextMessageForCurrentTurn
        ? { runtimeContextMessage: promptContext.runtimeContextMessageForCurrentTurn }
        : {}),
      runtimeOnly: promptContext.promptSubmission.runtimeOnly === true,
      systemPrompt: promptContext.systemPromptForHook,
      toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
      toolResultMaxChars: promptContext.promptToolResultMaxChars,
      transcriptPrompt: promptContext.promptForSession,
    });
  } else {
    input.releaseLeasedSteering(state.promptError ?? "prompt submission skipped");
  }

  return state;
}
