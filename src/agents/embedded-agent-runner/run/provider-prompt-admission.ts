/** Admits the exact provider context without mutating persisted conversation history. */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderPromptAccountingContext } from "../../../llm/providers/stream-wrappers/provider-prompt-accounting.js";
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
    }
  | {
      status: "recovery_required";
      request: MidTurnPrecheckRequest;
    };

function ready(
  context: ProviderContext,
  projectionState: ToolResultPromptProjectionState,
): ProviderPromptAdmission {
  return { status: "ready", context, projectionState };
}

function projectProviderContext(params: {
  context: ProviderContext;
  contextTokenBudget: number;
  toolResultMaxChars: number;
  toolResultAggregateMaxChars: number;
  projectionState: ToolResultPromptProjectionState;
  protectTrailingToolResults?: boolean;
}): ProviderContext {
  const messages = params.context.messages as AgentMessage[];
  const projected = truncateOversizedToolResultsInMessages(
    messages,
    params.contextTokenBudget,
    params.toolResultMaxChars,
    params.toolResultAggregateMaxChars,
    params.projectionState,
    params.protectTrailingToolResults,
  );
  return projected.messages === messages
    ? params.context
    : ({ ...params.context, messages: projected.messages } as ProviderContext);
}

function measureProviderContext(params: {
  context: ProviderContext;
  accountingContext?: ProviderPromptAccountingContext;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars: number;
}) {
  const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
    messages: params.context.messages as AgentMessage[],
    systemPrompt: params.accountingContext?.systemPrompt ?? params.context.systemPrompt,
    prompt: "",
    tools: params.accountingContext?.tools ?? params.context.tools,
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

function isProviderPressureIndependentOfTranscript(params: {
  context: ProviderContext;
  accountingContext?: ProviderPromptAccountingContext;
  promptBudgetBeforeReserve: number;
}): boolean {
  const transcriptIndependentTokens = estimateLlmBoundaryTokenPressure({
    messages: [],
    systemPrompt: params.accountingContext?.systemPrompt ?? params.context.systemPrompt,
    prompt: "",
    tools: params.accountingContext?.tools ?? params.context.tools,
  });
  return transcriptIndependentTokens > params.promptBudgetBeforeReserve;
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
    effectiveReserveTokens: result.effectiveReserveTokens,
  };
}

/**
 * Projects and measures the exact context passed to a provider. Projection state is returned as a
 * candidate and must only be adopted after the provider accepts that context.
 */
export function admitProviderPrompt(params: {
  context: ProviderContext;
  accountingContext?: ProviderPromptAccountingContext;
  contextTokenBudget: number;
  midTurnPrecheckEnabled: boolean;
  reserveTokens: number;
  toolResultAggregateMaxChars: number;
  toolResultMaxChars: number;
  projectionState: ToolResultPromptProjectionState;
}): ProviderPromptAdmission {
  const defaultProjectionState = cloneToolResultPromptProjectionState(params.projectionState);
  const defaultContext = projectProviderContext({
    context: params.context,
    contextTokenBudget: params.contextTokenBudget,
    toolResultMaxChars: params.toolResultMaxChars,
    toolResultAggregateMaxChars: params.toolResultAggregateMaxChars,
    projectionState: defaultProjectionState,
  });
  if (!params.midTurnPrecheckEnabled) {
    return ready(defaultContext, defaultProjectionState);
  }

  const defaultPressure = measureProviderContext({
    context: defaultContext,
    accountingContext: params.accountingContext,
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: params.reserveTokens,
    toolResultMaxChars: params.toolResultMaxChars,
  });
  if (defaultPressure.route === "fits") {
    return ready(defaultContext, defaultProjectionState);
  }

  const aggregateBudget = defaultPressure.toolResultAggregateBudgetChars;
  if (aggregateBudget === undefined || defaultPressure.toolResultReducibleChars <= 0) {
    // Compaction cannot reduce system instructions or tool schemas. Avoid a retry loop that cannot
    // change them; the final-payload guard still rejects a clear raw overage before transport.
    return isProviderPressureIndependentOfTranscript({
      context: defaultContext,
      accountingContext: params.accountingContext,
      promptBudgetBeforeReserve: defaultPressure.promptBudgetBeforeReserve,
    })
      ? ready(defaultContext, defaultProjectionState)
      : { status: "recovery_required", request: toRecoveryRequest(defaultPressure) };
  }

  // Reproject from the original state so a rejected candidate cannot affect the next attempt.
  const pressureProjectionState = cloneToolResultPromptProjectionState(params.projectionState);
  const pressureContext = projectProviderContext({
    context: params.context,
    contextTokenBudget: params.contextTokenBudget,
    toolResultMaxChars: params.toolResultMaxChars,
    toolResultAggregateMaxChars: Math.min(params.toolResultAggregateMaxChars, aggregateBudget),
    projectionState: pressureProjectionState,
    protectTrailingToolResults: false,
  });
  const projectedPressure = measureProviderContext({
    context: pressureContext,
    accountingContext: params.accountingContext,
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: params.reserveTokens,
    toolResultMaxChars: params.toolResultMaxChars,
  });
  if (
    projectedPressure.route === "fits" ||
    isProviderPressureIndependentOfTranscript({
      context: pressureContext,
      accountingContext: params.accountingContext,
      promptBudgetBeforeReserve: projectedPressure.promptBudgetBeforeReserve,
    })
  ) {
    return ready(pressureContext, pressureProjectionState);
  }
  return { status: "recovery_required", request: toRecoveryRequest(projectedPressure) };
}
