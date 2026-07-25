/**
 * Reports prompt pressure and owns explicit mid-turn recovery routing.
 */
import type { AssembleResult } from "../../../context-engine/types.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionManager } from "../../sessions/index.js";
import { log } from "../logger.js";
import {
  resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import type { AttemptContextEngine } from "./attempt.context-engine-helpers.js";
import { normalizeMessagesForLlmBoundary } from "./attempt.llm-boundary.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  buildPrePromptContextBudgetStatus,
  estimateLlmBoundaryTokenPressure,
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
      input.replaceSessionMessages(input.sessionManager.buildSessionContext().messages);
      logMidTurnPrecheck(
        request.route,
        `handled=true truncatedCount=${truncationResult.truncatedCount}`,
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
  attempt: AttemptPromptPreflightParams;
  activeContextEngine?: Pick<AttemptContextEngine, "info">;
  contextEngineAssemblySucceeded: boolean;
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
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
  const boundaryOptions =
    input.timezone || !input.includeBoundaryTimestamp
      ? {
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
        }
      : undefined;
  const unwindowedLlmBoundaryMessagesForPrecheck =
    input.contextEnginePromptAuthority === "preassembly_may_overflow" &&
    input.unwindowedContextEngineMessagesForPrecheck
      ? normalizeMessagesForLlmBoundary(
          input.unwindowedContextEngineMessagesForPrecheck,
          boundaryOptions,
        )
      : undefined;
  const llmBoundaryTokenPressure = estimateLlmBoundaryTokenPressure({
    messages: input.hookMessagesForCurrentPrompt,
    systemPrompt: input.systemPrompt,
    prompt: input.promptForPrecheck,
  });
  let preemptiveCompaction: ReturnType<typeof shouldPreemptivelyCompactBeforePrompt> | null = null;
  const shouldSkipPrecheck =
    skipPromptSubmission ||
    (input.contextEngineAssemblySucceeded &&
      input.activeContextEngine?.info.ownsCompaction &&
      input.contextEnginePromptAuthority !== "preassembly_may_overflow");

  if (shouldSkipPrecheck && !skipPromptSubmission) {
    log.info(
      `[context-overflow-precheck] skipped: context engine "${input.activeContextEngine!.info.id}" owns compaction`,
    );
  }

  if (!shouldSkipPrecheck) {
    preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
      messages: input.hookMessagesForCurrentPrompt,
      ...(unwindowedLlmBoundaryMessagesForPrecheck
        ? { unwindowedMessages: unwindowedLlmBoundaryMessagesForPrecheck }
        : {}),
      systemPrompt: input.systemPrompt,
      prompt: input.promptForPrecheck,
      contextTokenBudget: input.contextTokenBudget,
      reserveTokens: input.reserveTokens,
      toolResultMaxChars: input.toolResultMaxChars,
      llmBoundaryTokenPressure: {
        estimatedPromptTokens: llmBoundaryTokenPressure,
        source: "llm_boundary_normalized_prompt",
        renderedChars: input.promptForPrecheck.length,
      },
    });
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
    if (preemptiveCompaction.route !== "fits") {
      // Character pressure remains observable, but it is not authoritative enough to
      // discard history or manufacture an overflow before the provider sees the payload.
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
