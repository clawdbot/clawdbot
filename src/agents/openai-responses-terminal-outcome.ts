// Terminal-outcome recording for the agent-side Responses stream.
//
// `response.completed` and `response.incomplete` are both terminal and both carry usage, so they
// finalize through one path here. Splitting them is how incomplete turns silently recorded zero
// usage. The mapping itself is owned by `@openclaw/ai/internal/openai`, shared with the
// package-side processor; this module is the agent-specific adapter that adds reasoning-token
// accounting on top and works off raw records rather than typed SDK events.
import {
  mapResponsesTerminalUsage,
  readResponsesReasoningTokens,
  resolveResponsesTerminalStopReason,
  type ResponsesTerminalUsagePayload,
} from "@openclaw/ai/internal/openai";
import { calculateCost } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Model } from "../llm/types.js";
import type { MutableAssistantOutput } from "./openai-transport-shared.js";

function readIncompleteReason(response: Record<string, unknown> | undefined): string | undefined {
  const details = response?.incomplete_details;
  if (!isRecord(details)) {
    return undefined;
  }
  return typeof details.reason === "string" ? details.reason : undefined;
}

/** Record usage, cost and stop reason from a terminal Responses event onto the output. */
export function recordResponsesTerminalOutcome(params: {
  response: Record<string, unknown> | undefined;
  output: MutableAssistantOutput;
  model: Model;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  applyServiceTierPricing?: (
    usage: MutableAssistantOutput["usage"],
    serviceTier?: ResponseCreateParamsStreaming["service_tier"],
  ) => void;
}): void {
  const { response, output, model } = params;
  const usage = response?.usage as ResponsesTerminalUsagePayload | undefined;
  const mappedUsage = mapResponsesTerminalUsage(usage);
  if (mappedUsage) {
    const reasoningTokens = readResponsesReasoningTokens(usage);
    output.usage = {
      ...mappedUsage,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  calculateCost(model as never, output.usage as never);
  if (params.applyServiceTierPricing) {
    params.applyServiceTierPricing(
      output.usage,
      (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
        params.serviceTier,
    );
  }
  const terminal = resolveResponsesTerminalStopReason({
    status: response?.status as OpenAI.Responses.ResponseStatus | undefined,
    incompleteReason: readIncompleteReason(response),
    hasToolCall: output.content.some((block) => block.type === "toolCall"),
  });
  output.stopReason = terminal.stopReason;
  if (terminal.errorMessage) {
    output.errorMessage = terminal.errorMessage;
  }
}
