/**
 * Estimates prompt pressure and decides pre-prompt compaction routing.
 */
import { resolveCompactionReplayPressure } from "@openclaw/ai/transports";
import type { Model } from "@openclaw/llm-core";
import type { SessionContextBudgetStatus } from "../../../config/sessions.js";
import { resolveEffectiveCompactionReserveTokens } from "../../agent-compaction-constants.js";
import { SAFETY_MARGIN } from "../../compaction-planning.js";
import type { AgentMessage } from "../../runtime/index.js";
import { calculateContextTokens, IMAGE_BLOCK_TOKENS } from "../../runtime/index.js";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  estimateStringTokenPressure,
  estimateJsonPayloadTokenPressure,
  estimateMessageTokenPressure,
  estimateRenderedPromptTokens,
} from "../../sessions/context-token-pressure.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

type CompactionPressureDecision = {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  pressureSource?: string;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Diagnostic maximum plus the independently selected outgoing checkpoint's budget. */
export type PreemptiveCompactionDecision = CompactionPressureDecision & {
  compactionReplay?: CompactionPressureDecision;
};

export type CompactionReplayPressureContext = {
  model: Model;
  sessionId?: string;
  authProfileId?: string;
  enabled?: boolean;
};

/** Token pressure reported by the rendered provider-boundary prompt when available. */
export type LlmBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  renderedChars?: number;
};

type TranscriptBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: "provider_context_usage" | "transcript_estimate" | "provider_compaction_estimate";
  messages: AgentMessage[];
  hasCompactionReplay: boolean;
};

function isProviderContextUsageBarrier(message: AgentMessage): boolean {
  if (message.role !== "assistant" || !message.usage) {
    return false;
  }
  // Zero unavailable and legacy CLI records describe a newer context without
  // provider provenance; scanning past them can undercount the active transcript.
  return (
    (message.api === "cli" && message.usage.contextUsage === undefined) ||
    (message.usage.contextUsage?.state === "unavailable" &&
      calculateContextTokens(message.usage) === 0)
  );
}

function resolveProviderContextBoundary(
  messages: AgentMessage[],
): { index: number; totalTokens: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isProviderContextUsageBarrier(message)) {
      return undefined;
    }
    const contextUsage = message?.role === "assistant" ? message.usage?.contextUsage : undefined;
    if (
      contextUsage?.state === "available" &&
      Number.isFinite(contextUsage.totalTokens) &&
      contextUsage.totalTokens > 0
    ) {
      return { index, totalTokens: Math.ceil(contextUsage.totalTokens) };
    }
  }
  return undefined;
}

function estimateTranscriptBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  replay?: CompactionReplayPressureContext;
}): TranscriptBoundaryTokenPressure {
  const replay = params.replay
    ? resolveCompactionReplayPressure(params.messages, params.replay.model, params.replay, {
        text: estimateStringTokenPressure,
        image: () => IMAGE_BLOCK_TOKENS,
        json: estimateJsonPayloadTokenPressure,
      })
    : undefined;
  const messages = replay?.messages ?? params.messages;
  const boundary = resolveProviderContextBoundary(messages);
  // The provider total owns transcript items through its assistant record. It has
  // no system-prompt provenance, so the current rendered prompt stays local too.
  const messagesForPressure = boundary ? messages.slice(boundary.index + 1) : messages;
  const locallyEstimatedTokens = messagesForPressure.reduce(
    (sum, message) => sum + estimateMessageTokenPressure(message),
    estimateRenderedPromptTokens(params) + (boundary ? 0 : (replay?.prefixTokens ?? 0)),
  );
  return {
    estimatedPromptTokens:
      (boundary?.totalTokens ?? 0) + Math.ceil(locallyEstimatedTokens * SAFETY_MARGIN),
    source: boundary
      ? "provider_context_usage"
      : replay
        ? "provider_compaction_estimate"
        : "transcript_estimate",
    messages,
    hasCompactionReplay: Boolean(replay),
  };
}

export function estimateLlmBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  replay?: CompactionReplayPressureContext;
}): number {
  return estimateTranscriptBoundaryTokenPressure(params).estimatedPromptTokens;
}

/** Estimates only the rendered prompt/system portion when history has already been accounted for. */
export function estimateRenderedLlmBoundaryTokenPressure(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  return Math.max(0, Math.ceil(estimateRenderedPromptTokens(params) * SAFETY_MARGIN));
}

function normalizeLlmBoundaryTokenPressure(
  pressure: LlmBoundaryTokenPressure | undefined,
): LlmBoundaryTokenPressure | undefined {
  if (!pressure || !Number.isFinite(pressure.estimatedPromptTokens)) {
    return undefined;
  }
  const estimatedPromptTokens = Math.max(0, Math.ceil(pressure.estimatedPromptTokens));
  return {
    estimatedPromptTokens,
    source: pressure.source.trim() || "rendered_llm_boundary",
    ...(typeof pressure.renderedChars === "number" && Number.isFinite(pressure.renderedChars)
      ? { renderedChars: Math.max(0, Math.ceil(pressure.renderedChars)) }
      : {}),
  };
}

/**
 * Decides whether a run should compact before submitting the prompt, and
 * whether reducible tool results can avoid or follow compaction. Rendered LLM
 * boundary pressure wins over local transcript estimates when supplied.
 */
export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  llmBoundaryTokenPressure?: LlmBoundaryTokenPressure;
  replay?: CompactionReplayPressureContext;
}): PreemptiveCompactionDecision {
  const llmBoundaryTokenPressure = normalizeLlmBoundaryTokenPressure(
    params.llmBoundaryTokenPressure,
  );
  const transcriptTokenPressure =
    llmBoundaryTokenPressure && !params.replay
      ? undefined
      : estimateTranscriptBoundaryTokenPressure({
          messages: params.messages,
          systemPrompt: params.systemPrompt,
          prompt: params.prompt,
          replay: params.replay,
        });
  // The selected provider window owns its covered prefix, including when a
  // context engine supplied an estimate of the raw transcript instead.
  const boundaryPressure = transcriptTokenPressure?.hasCompactionReplay
    ? undefined
    : llmBoundaryTokenPressure;
  const outgoingDecision = resolveCompactionPressureDecision(
    {
      messages: transcriptTokenPressure?.messages ?? params.messages,
      estimatedPromptTokens:
        boundaryPressure?.estimatedPromptTokens ??
        transcriptTokenPressure?.estimatedPromptTokens ??
        0,
      source: boundaryPressure?.source ?? transcriptTokenPressure?.source ?? "transcript_estimate",
    },
    params,
  );
  let diagnosticDecision = outgoingDecision;
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedTokenPressure = estimateTranscriptBoundaryTokenPressure({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    // Unwindowed history is diagnostic: neither its checkpoints nor its larger
    // raw estimate may authorize recovery of a different outgoing window.
    if (unwindowedTokenPressure.estimatedPromptTokens > outgoingDecision.estimatedPromptTokens) {
      diagnosticDecision = resolveCompactionPressureDecision(
        {
          ...unwindowedTokenPressure,
          source: `unwindowed_${unwindowedTokenPressure.source}`,
        },
        params,
      );
    }
  }
  return {
    ...diagnosticDecision,
    ...(transcriptTokenPressure?.hasCompactionReplay ? { compactionReplay: outgoingDecision } : {}),
  };
}

function resolveCompactionPressureDecision(
  pressure: Pick<TranscriptBoundaryTokenPressure, "messages" | "estimatedPromptTokens"> & {
    source: string;
  },
  params: { contextTokenBudget: number; reserveTokens: number; toolResultMaxChars?: number },
): CompactionPressureDecision {
  const { estimatedPromptTokens } = pressure;
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const effectiveReserveTokens = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget,
    reserveTokens: params.reserveTokens,
  });
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: pressure.messages,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    // Choose truncate-only only when available reduction comfortably exceeds the overflow.
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    pressureSource: pressure.source,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}

/** Formats the compact operator log line for one pre-prompt budget check. */
export function formatPrePromptPrecheckLog(params: {
  result: PreemptiveCompactionDecision;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionFile?: string;
}): string {
  const { result } = params;
  return (
    `[context-overflow-precheck] pre-prompt check ` +
    `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"} ` +
    `provider=${params.provider}/${params.modelId} ` +
    `route=${result.route} ` +
    `estimatedPromptTokens=${result.estimatedPromptTokens} ` +
    `pressureSource=${result.pressureSource ?? "unknown"} ` +
    `promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve} ` +
    `overflowTokens=${result.overflowTokens} ` +
    `toolResultReducibleChars=${result.toolResultReducibleChars} ` +
    `reserveTokens=${params.reserveTokens} ` +
    `effectiveReserveTokens=${result.effectiveReserveTokens} ` +
    `contextTokenBudget=${params.contextTokenBudget} ` +
    `messages=${params.messageCount} ` +
    `unwindowedMessages=${params.unwindowedMessageCount ?? params.messageCount} ` +
    `sessionFile=${params.sessionFile}`
  );
}

/** Converts the pre-prompt decision into the persisted session context-budget status record. */
export function buildPrePromptContextBudgetStatus(params: {
  result: PreemptiveCompactionDecision;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionId?: string;
  now?: number;
}): SessionContextBudgetStatus {
  const { result } = params;
  const remainingPromptBudgetTokens = Math.max(
    0,
    result.promptBudgetBeforeReserve - result.estimatedPromptTokens,
  );
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: params.now ?? Date.now(),
    provider: params.provider,
    model: params.modelId,
    route: result.route,
    shouldCompact: result.shouldCompact,
    estimatedPromptTokens: result.estimatedPromptTokens,
    contextTokenBudget: Math.max(1, Math.floor(params.contextTokenBudget)),
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    reserveTokens: Math.max(0, Math.floor(params.reserveTokens)),
    effectiveReserveTokens: result.effectiveReserveTokens,
    remainingPromptBudgetTokens,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    messageCount: Math.max(0, Math.floor(params.messageCount)),
    unwindowedMessageCount: Math.max(
      0,
      Math.floor(params.unwindowedMessageCount ?? params.messageCount),
    ),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
}
