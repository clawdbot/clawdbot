/** Admits the exact provider context without mutating persisted conversation history. */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AgentMessage } from "../../runtime/index.js";
import {
  cloneToolResultPromptProjectionState,
  type ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import { truncateOversizedToolResultsInMessages } from "../tool-result-truncation.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import {
  estimateLlmBoundaryTokenPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

type ProviderContext = Parameters<StreamFn>[1];

type ProviderPromptAdmission =
  | {
      status: "ready";
      context: ProviderContext;
      projectionState: ToolResultPromptProjectionState;
      truncatedCount: number;
    }
  | {
      status: "recovery_required";
      request: MidTurnPrecheckRequest;
    };

function projectProviderContext(params: {
  context: ProviderContext;
  contextTokenBudget: number;
  toolResultMaxChars: number;
  toolResultAggregateMaxChars: number;
  projectionState: ToolResultPromptProjectionState;
  protectTrailingToolResults?: boolean;
}) {
  const messages = params.context.messages as AgentMessage[];
  const projected = truncateOversizedToolResultsInMessages(
    messages,
    params.contextTokenBudget,
    params.toolResultMaxChars,
    params.toolResultAggregateMaxChars,
    params.projectionState,
    params.protectTrailingToolResults,
  );
  return {
    context:
      projected.messages === messages
        ? params.context
        : ({ ...params.context, messages: projected.messages } as ProviderContext),
    truncatedCount: projected.truncatedCount,
  };
}

function measureProviderContext(params: {
  context: ProviderContext;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars: number;
}) {
  const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
    messages: params.context.messages as AgentMessage[],
    systemPrompt: params.context.systemPrompt,
    prompt: "",
    tools: params.context.tools,
  });
  return shouldPreemptivelyCompactBeforePrompt({
    messages: params.context.messages as AgentMessage[],
    systemPrompt: params.context.systemPrompt,
    prompt: "",
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: params.reserveTokens,
    toolResultMaxChars: params.toolResultMaxChars,
    llmBoundaryTokenPressure: {
      estimatedPromptTokens,
      source: "provider_context",
    },
  });
}

function toRecoveryRequest(
  result: ReturnType<typeof measureProviderContext>,
): MidTurnPrecheckRequest {
  return {
    route: result.toolResultReducibleChars > 0 ? "compact_then_truncate" : "compact_only",
    estimatedPromptTokens: result.estimatedPromptTokens,
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    toolResultAggregateBudgetChars: result.toolResultAggregateBudgetChars,
    effectiveReserveTokens: result.effectiveReserveTokens,
  };
}

/**
 * Projects and measures the exact context passed to a provider. Projection state is returned as a
 * candidate and must only be adopted when the caller dispatches the admitted context.
 */
export function admitProviderPrompt(params: {
  context: ProviderContext;
  contextTokenBudget: number;
  midTurnPrecheckEnabled: boolean;
  reserveTokens: number;
  toolResultAggregateMaxChars: number;
  toolResultMaxChars: number;
  projectionState: ToolResultPromptProjectionState;
}): ProviderPromptAdmission {
  const defaultProjectionState = cloneToolResultPromptProjectionState(params.projectionState);
  const defaultProjection = projectProviderContext({
    context: params.context,
    contextTokenBudget: params.contextTokenBudget,
    toolResultMaxChars: params.toolResultMaxChars,
    toolResultAggregateMaxChars: params.toolResultAggregateMaxChars,
    projectionState: defaultProjectionState,
  });
  if (!params.midTurnPrecheckEnabled) {
    return {
      status: "ready",
      context: defaultProjection.context,
      projectionState: defaultProjectionState,
      truncatedCount: defaultProjection.truncatedCount,
    };
  }

  const defaultPressure = measureProviderContext({
    context: defaultProjection.context,
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: params.reserveTokens,
    toolResultMaxChars: params.toolResultMaxChars,
  });
  if (defaultPressure.route === "fits") {
    return {
      status: "ready",
      context: defaultProjection.context,
      projectionState: defaultProjectionState,
      truncatedCount: defaultProjection.truncatedCount,
    };
  }

  const aggregateBudget = defaultPressure.toolResultAggregateBudgetChars;
  if (aggregateBudget === undefined || defaultPressure.toolResultReducibleChars <= 0) {
    return { status: "recovery_required", request: toRecoveryRequest(defaultPressure) };
  }

  // Reproject from the original context and state. A rejected candidate must not poison the
  // session's prompt-cache projection state or become the input to the next candidate.
  const pressureProjectionState = cloneToolResultPromptProjectionState(params.projectionState);
  const pressureProjection = projectProviderContext({
    context: params.context,
    contextTokenBudget: params.contextTokenBudget,
    toolResultMaxChars: params.toolResultMaxChars,
    toolResultAggregateMaxChars: Math.min(params.toolResultAggregateMaxChars, aggregateBudget),
    projectionState: pressureProjectionState,
    protectTrailingToolResults: false,
  });
  const projectedPressure = measureProviderContext({
    context: pressureProjection.context,
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: params.reserveTokens,
    toolResultMaxChars: params.toolResultMaxChars,
  });
  if (projectedPressure.route === "fits") {
    return {
      status: "ready",
      context: pressureProjection.context,
      projectionState: pressureProjectionState,
      truncatedCount: pressureProjection.truncatedCount,
    };
  }
  return { status: "recovery_required", request: toRecoveryRequest(projectedPressure) };
}
