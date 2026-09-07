/**
 * Reports prompt pressure and owns explicit mid-turn recovery routing.
 */
import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import type { AssembleResult } from "../../../context-engine/types.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionManager } from "../../sessions/index.js";
import { log } from "../logger.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { resolveAttemptStreamAuthProfileId } from "./attempt-run-decisions.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  buildPrePromptContextBudgetStatus,
  formatPrePromptPrecheckLog,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type AttemptPromptPreflightParams = Pick<
  EmbeddedRunAttemptParams,
  "config" | "modelId" | "provider" | "sessionFile" | "sessionId" | "sessionKey"
>;

type AttemptPromptPreflightState = {
  contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
  preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  skipPromptSubmission: boolean;
};

type PreflightRecoveryBudgetSnapshot = Pick<
  MidTurnPrecheckRequest,
  "estimatedPromptTokens" | "promptBudgetBeforeReserve" | "overflowTokens"
>;

// Carries the measured prompt budget into the outer recovery loop. The synthetic
// precheck error is only a routing signal, so compaction engines need these
// fields to compact against the prompt OpenClaw actually rendered.
function buildPreflightRecoveryBudgetSnapshot(snapshot: PreflightRecoveryBudgetSnapshot) {
  return {
    estimatedPromptTokens: snapshot.estimatedPromptTokens,
    promptBudgetBeforeReserve: snapshot.promptBudgetBeforeReserve,
    overflowTokens: snapshot.overflowTokens,
  };
}

export function handleEmbeddedAttemptMidTurnPrecheck(input: {
  attempt: AttemptPromptPreflightParams & Pick<EmbeddedRunAttemptParams, "contextTokenBudget">;
  request: MidTurnPrecheckRequest;
  sessionAgentId: string;
  sessionManager: SessionManager;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
  prePromptMessageCount: number;
  replaceSessionMessages: (messages: AgentMessage[]) => void;
}): {
  preflightRecovery: NonNullable<EmbeddedRunAttemptResult["preflightRecovery"]>;
  promptError?: Error;
} {
  const { attempt, request } = input;
  const logMidTurnPrecheck = (route: string, extra?: string) => {
    log.warn(
      `[context-overflow-midturn-precheck] sessionKey=${attempt.sessionKey ?? attempt.sessionId} ` +
        `provider=${attempt.provider}/${attempt.modelId} route=${route} ` +
        `estimatedPromptTokens=${request.estimatedPromptTokens} ` +
        `promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} ` +
        `overflowTokens=${request.overflowTokens} ` +
        `toolResultReducibleChars=${request.toolResultReducibleChars} ` +
        `effectiveReserveTokens=${request.effectiveReserveTokens} ` +
        `prePromptMessageCount=${input.prePromptMessageCount} ` +
        (extra ? `${extra} ` : "") +
        `sessionFile=${attempt.sessionFile}`,
    );
  };

  if (request.route === "truncate_tool_results_only") {
    const contextTokenBudget = attempt.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
    const toolResultMaxChars = resolveLiveToolResultMaxChars({
      contextWindowTokens: contextTokenBudget,
    });
    const truncationResult = truncateOversizedToolResultsInSessionManager({
      sessionManager: input.sessionManager,
      projectionState: input.toolResultPromptProjectionState,
      contextWindowTokens: contextTokenBudget,
      maxCharsOverride: toolResultMaxChars,
      sessionFile: attempt.sessionFile,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      agentId: input.sessionAgentId,
    });
    if (truncationResult.truncated) {
      const preflightRecovery = {
        route: "truncate_tool_results_only" as const,
        source: "mid-turn" as const,
        ...buildPreflightRecoveryBudgetSnapshot(request),
        handled: true as const,
        truncatedCount: truncationResult.truncatedCount,
      };
      input.replaceSessionMessages(
        sanitizeCompactionReplayMessages(input.sessionManager.buildSessionContext().messages),
      );
      logMidTurnPrecheck(
        request.route,
        `handled=true truncatedCount=${truncationResult.truncatedCount}`,
      );
      return { preflightRecovery };
    }

    if (truncationResult.reason === "no oversized or aggregate tool results") {
      const preflightRecovery = {
        route: "truncate_tool_results_only" as const,
        source: "mid-turn" as const,
        ...buildPreflightRecoveryBudgetSnapshot(request),
        handled: true as const,
        truncatedCount: 0,
      };
      // The mid-turn estimate sees the in-memory prompt view, while persisted
      // recovery may already have capped the same tool results. Retry without
      // manufacturing compaction when the persisted branch has nothing to trim.
      logMidTurnPrecheck(
        request.route,
        `handled=true truncatedCount=0 truncateSkippedReason=${truncationResult.reason}`,
      );
      return { preflightRecovery };
    }

    const preflightRecovery = {
      route: "compact_only" as const,
      source: "mid-turn" as const,
      ...buildPreflightRecoveryBudgetSnapshot(request),
    };
    logMidTurnPrecheck(
      "compact_only",
      `truncateFallbackReason=${truncationResult.reason ?? "unknown"}`,
    );
    return {
      preflightRecovery,
      promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
    };
  }

  const preflightRecovery = {
    route: request.route,
    source: "mid-turn" as const,
    ...buildPreflightRecoveryBudgetSnapshot(request),
  };
  logMidTurnPrecheck(request.route);
  return {
    preflightRecovery,
    promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
  };
}

export async function prepareEmbeddedAttemptPromptPreflight(input: {
  appendOnlyRuntimeContext?: boolean;
  attempt: AttemptPromptPreflightParams &
    Pick<EmbeddedRunAttemptParams, "model" | "runtimePlan" | "authProfileId">;
  activeContextEngine?: Pick<AttemptContextEngine, "info">;
  compactionReplayEnabled: boolean;
  contextEngineAssemblySucceeded: boolean;
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  /** Engine-assembly token estimate; keeps the host precheck active when it exceeds the attempt budget. */
  contextEngineEstimatedTokens?: number;
  contextTokenBudget: number;
  hookMessagesForCurrentPrompt: AgentMessage[];
  includeBoundaryTimestamp: boolean;
  promptForPrecheck: string;
  reserveTokens: number;
  sessionMessageCount: number;
  state: AttemptPromptPreflightState;
  systemPrompt: string;
  timezone?: string;
  toolResultMaxChars: number;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
}): Promise<AttemptPromptPreflightState> {
  const { attempt } = input;
  let contextBudgetStatus = input.state.contextBudgetStatus;
  const { skipPromptSubmission } = input.state;
  const boundaryOptions = {
    appendOnlyRuntimeContext: input.appendOnlyRuntimeContext,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
  };
  const unwindowedLlmBoundaryMessagesForPrecheck =
    input.contextEnginePromptAuthority === "preassembly_may_overflow" &&
    input.unwindowedContextEngineMessagesForPrecheck
      ? normalizeMessagesForLlmBoundary(
          input.unwindowedContextEngineMessagesForPrecheck,
          boundaryOptions,
        )
      : undefined;
  let preemptiveCompaction: ReturnType<typeof shouldPreemptivelyCompactBeforePrompt> | null = null;
  if (!skipPromptSubmission) {
    try {
      preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
        messages: input.hookMessagesForCurrentPrompt,
        unwindowedMessages: unwindowedLlmBoundaryMessagesForPrecheck,
        systemPrompt: input.systemPrompt,
        prompt: input.promptForPrecheck,
        contextTokenBudget: input.contextTokenBudget,
        reserveTokens: input.reserveTokens,
        toolResultMaxChars: input.toolResultMaxChars,
        replay: {
          model: attempt.model,
          sessionId: attempt.sessionId,
          authProfileId: resolveAttemptStreamAuthProfileId(attempt),
          enabled: input.compactionReplayEnabled,
        },
      });
    } catch (error) {
      if (!(error instanceof CompactionReplayRefreshRequiredError)) {
        throw error;
      }
      return {
        ...input.state,
        promptError: error,
        promptErrorSource: "precheck",
        skipPromptSubmission: true,
      };
    }
  }
  // Even when the context engine owns compaction, its own assembly estimate can
  // exceed the CURRENT attempt's per-model budget (e.g. a fallback chain moved
  // the run to a smaller-context model). Shipping that prompt is a guaranteed
  // billed terminal overflow, so the host precheck stays active in that case.
  const contextEngineEstimateExceedsBudget =
    typeof input.contextEngineEstimatedTokens === "number" &&
    Number.isFinite(input.contextEngineEstimatedTokens) &&
    input.contextEngineEstimatedTokens > 0 &&
    input.contextTokenBudget > 0 &&
    input.contextEngineEstimatedTokens > input.contextTokenBudget;
  if (contextEngineEstimateExceedsBudget) {
    log.warn(
      `[context-overflow-precheck] engine estimate ${input.contextEngineEstimatedTokens} exceeds ` +
        `attempt budget ${input.contextTokenBudget}; keeping host precheck active ` +
        `provider=${input.attempt.provider}/${input.attempt.modelId} ` +
        `sessionKey=${input.attempt.sessionKey ?? input.attempt.sessionId}`,
    );
  }
  const shouldSkipPrecheck =
    skipPromptSubmission ||
    (!contextEngineEstimateExceedsBudget &&
      input.contextEngineAssemblySucceeded &&
      input.activeContextEngine?.info.ownsCompaction &&
      input.contextEnginePromptAuthority !== "preassembly_may_overflow" &&
      !preemptiveCompaction?.compactionReplay);

  if (shouldSkipPrecheck && !skipPromptSubmission) {
    log.info(
      `[context-overflow-precheck] skipped: context engine "${input.activeContextEngine!.info.id}" owns compaction`,
    );
  }

  if (shouldSkipPrecheck) {
    preemptiveCompaction = null;
  }
  if (preemptiveCompaction) {
    contextBudgetStatus = buildPrePromptContextBudgetStatus({
      result: preemptiveCompaction,
      provider: attempt.provider,
      modelId: attempt.modelId,
      messageCount: input.sessionMessageCount,
      contextTokenBudget: input.contextTokenBudget,
      reserveTokens: input.reserveTokens,
      ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
      ...(input.contextEnginePromptAuthority === "preassembly_may_overflow" &&
      input.unwindowedContextEngineMessagesForPrecheck
        ? { unwindowedMessageCount: input.unwindowedContextEngineMessagesForPrecheck.length }
        : {}),
    });
    log.debug(
      formatPrePromptPrecheckLog({
        result: preemptiveCompaction,
        provider: attempt.provider,
        modelId: attempt.modelId,
        messageCount: input.sessionMessageCount,
        contextTokenBudget: input.contextTokenBudget,
        reserveTokens: input.reserveTokens,
        ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
        ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
        ...(input.contextEnginePromptAuthority === "preassembly_may_overflow" &&
        input.unwindowedContextEngineMessagesForPrecheck
          ? { unwindowedMessageCount: input.unwindowedContextEngineMessagesForPrecheck.length }
          : {}),
        ...(attempt.sessionFile ? { sessionFile: attempt.sessionFile } : {}),
      }),
    );
    const checkpointPressure = preemptiveCompaction.compactionReplay;
    if (checkpointPressure && checkpointPressure.route !== "fits") {
      // Only the actual canonical window can require recovery; the raw-history
      // maximum above remains diagnostic even when it exceeds this window.
      return {
        ...input.state,
        contextBudgetStatus,
        preflightRecovery: {
          route: checkpointPressure.route,
          ...buildPreflightRecoveryBudgetSnapshot(checkpointPressure),
        },
        promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
        promptErrorSource: "precheck",
        skipPromptSubmission: true,
      };
    }
    if (preemptiveCompaction.route !== "fits") {
      // This pressure estimate is diagnostic only; it never compacts or discards history.
      // Real compaction runs through explicit preflight or provider-overflow recovery.
      log.info(
        `[context-pressure-diagnostic] admitted provider attempt for ` +
          `${attempt.provider}/${attempt.modelId} route=${preemptiveCompaction.route} ` +
          `estimatedPromptTokens=${preemptiveCompaction.estimatedPromptTokens} ` +
          `promptBudgetBeforeReserve=${preemptiveCompaction.promptBudgetBeforeReserve}`,
      );
    }
  }

  return { ...input.state, contextBudgetStatus };
}
