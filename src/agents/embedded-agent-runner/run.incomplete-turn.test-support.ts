import { vi } from "vitest";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { isStrictAgenticSupportedProviderModel } from "../execution-contract.js";
import type { FailoverReason } from "../failover/signal.js";
import type { AgentHarness } from "../harness/types.js";
import { buildEmbeddedRunBlockedResult } from "./run/blocked-run-result.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import {
  resolveReplayInvalidFlag,
  shouldRetrySilentErrorAssistantTurn,
} from "./run/incomplete-turn.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import { normalizeEmbeddedRunAttemptResult } from "./run/run-attempt-result.js";
import { prepareTerminalWithSettledTurnFinalization } from "./run/settled-turn-finalization.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "./run/terminal-resolution.js";
import { createEmbeddedRunTerminalRetryState } from "./run/terminal-retry-state.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import {
  createUsageAccumulator,
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
} from "./usage-accumulator.js";

const hoisted = vi.hoisted(() => ({
  buildPayloads: vi.fn(() => [] as Array<{ text?: string; isError?: boolean }>),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    isEnabled: vi.fn(() => false),
  },
}));

vi.mock("./run/payloads.js", () => ({
  buildEmbeddedRunPayloads: hoisted.buildPayloads,
}));

vi.mock("./logger.js", () => ({ log: hoisted.log }));

let registeredHarnesses = new Map<string, AgentHarness>();

type MockResolvedModel = {
  id: string;
  provider: string;
  contextWindow: number;
  api: string;
  baseUrl?: string;
};

function createResolvedModel(
  provider = "anthropic",
  modelId = "test-model",
): {
  model: MockResolvedModel;
  error: null;
  authStorage: { setRuntimeApiKey: ReturnType<typeof vi.fn> };
  modelRegistry: Record<string, never>;
} {
  const openAiCompatible = provider === "openai" || provider === "codex";
  return {
    model: {
      id: modelId,
      provider,
      contextWindow: 200_000,
      api: openAiCompatible ? "openai-responses" : "messages",
      ...(openAiCompatible ? { baseUrl: "https://api.openai.com/v1" } : {}),
    },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  };
}

export const mockedBuildEmbeddedRunPayloads = hoisted.buildPayloads;
export const mockedLog = hoisted.log;
export const mockedClassifyFailoverReason = vi.fn<(raw: string) => FailoverReason | null>(
  () => null,
);
export const mockedIsFailoverAssistantError = vi.fn(
  (_assistant?: { errorMessage?: string }) => false,
);
export const mockedIsRateLimitAssistantError = vi.fn(
  (_assistant?: { errorMessage?: string }) => false,
);
export const mockedRunEmbeddedAttempt =
  vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
export const mockedResolveModelAsync = vi.fn(async (provider?: string, modelId?: string) =>
  createResolvedModel(provider, modelId),
);
export const mockedSleepWithAbort = vi.fn(
  async (_ms: number, _abortSignal?: AbortSignal) => undefined,
);
export const overflowBaseRunParams = {
  agentId: "main",
  sessionId: "test-session",
  sessionKey: "agent:main:test-key",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} as const;

function registerDefaultHarness(): void {
  const harness: AgentHarness = {
    id: "codex",
    label: "Codex",
    supports: () => ({ supported: true, priority: 100 }),
    runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
    finalizeSettledTurn: async ({ attempt }) => {
      const result = await mockedRunEmbeddedAttempt({ ...attempt, disableTools: true });
      const assistant =
        result.currentAttemptCompletedAssistant ??
        result.currentAttemptAssistant ??
        result.lastAssistant;
      if (!assistant) {
        throw new Error("mocked settled-turn finalization returned no assistant message");
      }
      return {
        assistant: assistant as AssistantMessage,
        ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
      };
    },
  };
  registeredHarnesses.set(harness.id, harness);
}

export function registerAgentHarness(harness: AgentHarness): void {
  registeredHarnesses.set(harness.id, harness);
}

export function resetRunIncompleteTurnOwnerMocks(): void {
  vi.unstubAllEnvs();
  registeredHarnesses = new Map();
  registerDefaultHarness();
  mockedBuildEmbeddedRunPayloads.mockReset();
  mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
  mockedLog.debug.mockReset();
  mockedLog.info.mockReset();
  mockedLog.warn.mockReset();
  mockedLog.error.mockReset();
  mockedLog.isEnabled.mockReset();
  mockedLog.isEnabled.mockReturnValue(false);
  mockedClassifyFailoverReason.mockReset();
  mockedClassifyFailoverReason.mockReturnValue(null);
  mockedIsFailoverAssistantError.mockReset();
  mockedIsFailoverAssistantError.mockReturnValue(false);
  mockedIsRateLimitAssistantError.mockReset();
  mockedIsRateLimitAssistantError.mockReturnValue(false);
  mockedRunEmbeddedAttempt.mockReset();
  mockedResolveModelAsync.mockReset();
  mockedResolveModelAsync.mockImplementation(async (provider?: string, modelId?: string) =>
    createResolvedModel(provider, modelId),
  );
  mockedSleepWithAbort.mockReset();
  mockedSleepWithAbort.mockResolvedValue(undefined);
}

type OwnerHarnessParams = Omit<
  RunEmbeddedAgentParams,
  "admittedRunContext" | "preparedRunAdmission"
> & {
  authProfileStateMode?: "read-write" | "read-only";
};

function terminalLifecycleSetter(
  attempt: EmbeddedRunAttemptResult,
  terminalState: ReturnType<typeof resolveEmbeddedRunAttemptTerminalState>,
) {
  return (
    meta: Parameters<NonNullable<EmbeddedRunAttemptResult["setTerminalLifecycleMeta"]>>[0],
  ) => {
    const interrupted = terminalState.outcome.reason;
    attempt.setTerminalLifecycleMeta?.({
      ...meta,
      aborted: interrupted === "aborted" || interrupted === "cancelled",
      ...(interrupted === "hard_timeout" || interrupted === "timed_out"
        ? { stopReason: "timeout" as const }
        : interrupted === "aborted" || interrupted === "cancelled"
          ? { stopReason: "aborted" as const }
          : {}),
    });
  };
}

/**
 * Exercises the production incomplete-turn owners without importing the full
 * runner, plugin registry, session store, or prepared-runtime graph.
 */
async function runIncompleteTurnOwnerHarnessWithContext(
  params: RunEmbeddedAgentParams & {
    authProfileStateMode?: "read-write" | "read-only";
  },
) {
  const usageAccumulator = createUsageAccumulator();
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  const retryState = createEmbeddedRunTerminalRetryState();
  const traceAttempts: Array<{
    provider: string;
    model: string;
    result: "same_model_rate_limit";
    reason: "rate_limit";
    stage: "assistant";
  }> = [];
  let activePrompt = params.prompt;
  let activePromptPersisted = false;
  let suppressNextUserMessagePersistence = false;
  let skipPreparedUserTurnMessage = false;
  let pendingUserPersistence: Promise<unknown> | undefined;
  let terminalToolPresentation: string | undefined;
  let terminalToolPresentationOrdinal = -1;
  let replayInvalid = false;
  let hadPotentialSideEffects = false;
  let attemptCompactionCount = 0;
  let sameModelRateLimitRetries = 0;

  for (let attemptIndex = 0; attemptIndex < 8; attemptIndex += 1) {
    const attemptParams = {
      ...params,
      prompt: activePrompt,
      suppressNextUserMessagePersistence,
      skipPreparedUserTurnMessage,
      onUserMessagePersisted: (_message: { role: "user"; content: string }) => {
        activePromptPersisted = true;
        if (params.userTurnTranscriptRecorder && !pendingUserPersistence) {
          pendingUserPersistence = params.userTurnTranscriptRecorder.persistApproved();
          params.userTurnTranscriptRecorder.markRuntimePersistencePending(
            pendingUserPersistence.then(() => undefined),
          );
        }
      },
      onToolOutcome: (observation: { toolCallOrdinal?: number; terminalPresentation?: string }) => {
        const ordinal = observation.toolCallOrdinal ?? terminalToolPresentationOrdinal + 1;
        if (observation.terminalPresentation && ordinal >= terminalToolPresentationOrdinal) {
          terminalToolPresentationOrdinal = ordinal;
          terminalToolPresentation = observation.terminalPresentation;
        }
      },
    };
    suppressNextUserMessagePersistence = false;
    const attempt = normalizeEmbeddedRunAttemptResult(
      await mockedRunEmbeddedAttempt(attemptParams as never),
    );
    mergeUsageIntoAccumulator(usageAccumulator, attempt.attemptUsage);
    mergeAttemptRunStatsIntoAccumulator(usageAccumulator, attempt);
    replayInvalid ||= !attempt.replayMetadata.replaySafe;
    hadPotentialSideEffects ||= attempt.replayMetadata.hadPotentialSideEffects ?? false;
    const assistant = attempt.currentAttemptAssistant ?? attempt.lastAssistant;
    const terminalAssistant = attempt.currentAttemptAssistant;
    const errorMessage = assistant?.errorMessage ?? "";
    const failoverReason = errorMessage ? mockedClassifyFailoverReason(errorMessage) : null;
    if (
      !params.abortSignal?.aborted &&
      sameModelRateLimitRetries < 1 &&
      failoverReason === "rate_limit" &&
      mockedIsFailoverAssistantError(assistant) &&
      mockedIsRateLimitAssistantError(assistant)
    ) {
      sameModelRateLimitRetries += 1;
      await mockedSleepWithAbort(30_000, params.abortSignal);
      traceAttempts.push({
        provider: params.provider ?? assistant?.provider ?? "anthropic",
        model: params.model ?? assistant?.model ?? "test-model",
        result: "same_model_rate_limit",
        reason: "rate_limit",
        stage: "assistant",
      });
      continue;
    }
    if (
      shouldRetrySilentErrorAssistantTurn({ attempt, assistant }) &&
      !params.abortSignal?.aborted
    ) {
      continue;
    }

    const resolvedModel = await mockedResolveModelAsync(
      params.provider ?? assistant?.provider,
      params.model ?? assistant?.model,
    );
    const provider = params.provider ?? resolvedModel.model.provider;
    const modelId = params.model ?? resolvedModel.model.id;
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: terminalAssistant,
      abortSignal: params.abortSignal,
    });
    const setTerminalLifecycleMeta = terminalLifecycleSetter(attempt, terminalState);
    const agentMeta = {
      sessionId: attempt.sessionIdUsed,
      provider,
      model: modelId,
    };

    const projectedTerminal = attempt.terminal.kind === "failed" ? attempt.terminal : undefined;
    if (
      projectedTerminal?.source === "hook:before_agent_run" &&
      terminalState.outcome.reason !== "aborted" &&
      terminalState.outcome.reason !== "cancelled" &&
      terminalState.outcome.reason !== "hard_timeout" &&
      terminalState.outcome.reason !== "timed_out"
    ) {
      const text = formatErrorMessage(projectedTerminal.error);
      setTerminalLifecycleMeta({ replayInvalid, livenessState: "blocked" });
      return buildEmbeddedRunBlockedResult({
        text,
        errorKind: "hook_block",
        errorMessage: text,
        durationMs: 0,
        agentMeta,
        attempt,
        replayInvalid,
      });
    }

    const terminalBase = {
      runParams: { ...params, authProfileStateMode: "read-only" as const },
      provider,
      model: modelId,
      activeErrorContext: { provider, model: modelId },
      authProfileStore: { version: 1 as const, profiles: {} },
      outerContextTokenMeta: {},
      usageAccumulator,
      contextRecoveryState,
      resolvedToolResultFormat: "markdown" as const,
    };
    const selectedHarness =
      registeredHarnesses.get(params.agentHarnessId ?? "codex") ?? registeredHarnesses.get("codex");
    if (!selectedHarness) {
      throw new Error(`No test harness registered for ${params.agentHarnessId ?? "codex"}`);
    }
    const finalized = await prepareTerminalWithSettledTurnFinalization({
      initial: {
        attempt,
        attemptAssistant: assistant,
        currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
        sessionIdUsed: attempt.sessionIdUsed,
        sessionFileUsed: attempt.sessionFileUsed,
        terminalState,
        attemptCompactionCount,
      },
      terminalBase,
      lastRunPromptUsage: attempt.attemptUsage,
      finalization: {
        preparedAttempt: attemptParams as never,
        harness: selectedHarness,
        modelApi: resolvedModel.model.api,
        executionContract: isStrictAgenticSupportedProviderModel({ provider, modelId })
          ? "strict-agentic"
          : "default",
        hasTerminalToolPresentation: terminalToolPresentation !== undefined,
        noteLaneTaskProgress: () => {},
      },
    });
    const prepared = finalized.prepared;
    const terminalTimeout = resolveEmbeddedRunTerminalTimeout({
      timedOutDuringPrompt: prepared.timedOutDuringPrompt,
      hasSuccessfulFinalAssistantAfterPromptTimeout:
        prepared.hasSuccessfulFinalAssistantAfterPromptTimeout,
      shouldSurfaceCodexCompletionTimeout: false,
      attempt: finalized.attempt,
      hasPartialAssistantTextAfterPromptTimeout: prepared.hasPartialAssistantTextAfterPromptTimeout,
      payloads: prepared.payloads,
      payloadsWithToolMedia: prepared.payloadsWithToolMedia,
      terminalState: finalized.terminalState,
      resolveReplayInvalid: (text) =>
        replayInvalid ||
        resolveReplayInvalidFlag({ attempt: finalized.attempt, incompleteTurnText: text }),
      setTerminalLifecycleMeta,
      startedAtMs: Date.now(),
      agentMeta: prepared.agentMeta,
      finalAssistantVisibleText: prepared.finalAssistantVisibleText,
      finalAssistantRawText: prepared.finalAssistantRawText,
      attemptToolSummary: prepared.attemptToolSummary,
      failureSignal: prepared.failureSignal,
    });
    if (terminalTimeout) {
      return terminalTimeout;
    }

    let nextPrompt = activePrompt;
    let nextPromptPersisted: boolean = activePromptPersisted;
    const resolution = await resolveEmbeddedRunTerminal({
      runParams: { ...params, authProfileStateMode: "read-only" },
      retryState,
      attempt: finalized.attempt,
      attemptAssistant: finalized.attemptAssistant,
      activeErrorContext: { provider, model: modelId },
      modelApi: resolvedModel.model.api,
      executionContract: isStrictAgenticSupportedProviderModel({ provider, modelId })
        ? "strict-agentic"
        : "default",
      terminalState: finalized.terminalState,
      payloadsWithToolMedia: prepared.payloadsWithToolMedia,
      recoveredFinalAssistantPayloadsAfterPromptTimeout:
        prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout,
      finalAssistantVisibleText: prepared.finalAssistantVisibleText,
      finalAssistantRawText: prepared.finalAssistantRawText,
      agentMeta: prepared.agentMeta,
      attemptToolSummary: prepared.attemptToolSummary,
      failureSignal: prepared.failureSignal,
      maxReasoningOnlyRetryAttempts: 2,
      maxEmptyResponseRetryAttempts: 1,
      attemptCompactionCount: finalized.attemptCompactionCount,
      replayState: { replayInvalid, hadPotentialSideEffects },
      activePromptPersisted,
      activateInternalPrompt: (prompt, persisted) => {
        nextPrompt = prompt;
        nextPromptPersisted = persisted;
        skipPreparedUserTurnMessage = true;
      },
      setSuppressNextUserMessagePersistence: (value) => {
        suppressNextUserMessagePersistence = value;
      },
      armPostCompactionGuard: () => {
        attemptCompactionCount += 1;
      },
      readTerminalToolPresentation: () => terminalToolPresentation,
      resolveReplayInvalid: (text) =>
        replayInvalid ||
        resolveReplayInvalidFlag({ attempt: finalized.attempt, incompleteTurnText: text }),
      setTerminalLifecycleMeta,
      maybeMarkAuthProfileFailure: async () => {},
      startedAtMs: Date.now(),
      provider,
      modelId,
      modelTransportId: resolvedModel.model.id,
      modelTransportApi: resolvedModel.model.api,
      profileFailureStore: { version: 1, profiles: {} },
      attemptAuthProfileStore: { version: 1, profiles: {} },
      apiKeyInfo: null,
      agentHarnessId: selectedHarness.id,
      settledTurnFinalizationOutcome: finalized.finalizationOutcome,
      pluginHarnessOwnsTransport: false,
      pluginHarnessOwnsAuthBootstrap: false,
      reportedModelRef: prepared.reportedModelRef,
      traceAttempts,
      traceAttemptUsesFallback: () => false,
      thinkLevel: params.thinkLevel,
      contextRecoveryState,
    });
    if (resolution.action === "complete") {
      return resolution.result;
    }
    if (pendingUserPersistence) {
      await params.userTurnTranscriptRecorder?.waitForRuntimePersistence();
      await pendingUserPersistence;
      pendingUserPersistence = undefined;
    }
    activePrompt = nextPrompt;
    activePromptPersisted = nextPromptPersisted;
  }
  throw new Error("Focused incomplete-turn owner harness exhausted its retry budget");
}

export async function runIncompleteTurnOwnerHarness(inputParams: OwnerHarnessParams) {
  const agentId = inputParams.agentId ?? "main";
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: inputParams.config ?? {},
    operationalRunInstance: createOperationalRunInstanceRef(inputParams.runId),
    facts: {
      runId: inputParams.runId,
      agentId,
      ingress: {
        kind: "system",
        boundary: "run-incomplete-turn-owner-harness",
        state: "present",
      },
    },
  });
  try {
    const admittedRunContext = await preparedRunAdmission.admit("embedded");
    return await runIncompleteTurnOwnerHarnessWithContext({
      ...inputParams,
      admittedRunContext,
      agentId,
    });
  } finally {
    preparedRunAdmission.close();
  }
}

resetRunIncompleteTurnOwnerMocks();
