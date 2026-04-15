import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../pi-compaction-constants.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({
      role: "system",
      content: systemPrompt,
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);

  const estimated =
    estimateMessagesTokens(messages) +
    syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
} {
  const estimatedPromptTokens = estimatePrePromptTokens(params);
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: params.messages,
    contextWindowTokens: params.contextTokenBudget,
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
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}
