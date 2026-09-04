import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponsesContinuationRequest } from "./openai-responses-continuation.js";

// Public Responses input item; the installed SDK predates configuration updates.
export type ResponsesConfigurationUpdate = {
  type: "configuration_update";
  reasoning: { effort: string };
};

function isConfigurationUpdate(value: unknown): value is ResponsesConfigurationUpdate {
  return (
    isRecord(value) &&
    value.type === "configuration_update" &&
    isRecord(value.reasoning) &&
    typeof value.reasoning.effort === "string"
  );
}

export function supportsResponsesReasoningUpdate(request: ResponsesContinuationRequest): boolean {
  return (
    request.model === "gpt-6-astra" &&
    isRecord(request.reasoning) &&
    typeof request.reasoning.effort === "string" &&
    (request.reasoning.mode === undefined || request.reasoning.mode === "standard") &&
    (!isRecord(request.multi_agent) || request.multi_agent.enabled !== true) &&
    request.truncation !== "auto" &&
    (!Array.isArray(request.context_management) ||
      !request.context_management.some((item) => isRecord(item) && item.type === "compaction"))
  );
}

/** Rehydrate input controls only provisionally; continuation must validate the full prefix. */
export function replayResponsesReasoningUpdates(
  previous: ResponsesContinuationRequest,
  request: ResponsesContinuationRequest,
  previousOutputLength: number,
  options?: { allowNewReasoningUpdate?: boolean },
): ResponsesContinuationRequest {
  if (
    !supportsResponsesReasoningUpdate(previous) ||
    !supportsResponsesReasoningUpdate(request) ||
    !isRecord(previous.reasoning) ||
    !isRecord(request.reasoning) ||
    typeof request.reasoning.effort !== "string" ||
    !Array.isArray(previous.input) ||
    !Array.isArray(request.input) ||
    request.input.some(isConfigurationUpdate)
  ) {
    return request;
  }
  const input = [...request.input];
  let activeEffort = previous.reasoning.effort;
  for (const [index, item] of previous.input.entries()) {
    if (isConfigurationUpdate(item)) {
      input.splice(index, 0, item);
      activeEffort = item.reasoning.effort;
    }
  }
  if (activeEffort !== request.reasoning.effort && options?.allowNewReasoningUpdate !== false) {
    const baselineLength = previous.input.length + previousOutputLength;
    const nextUser = input.findIndex(
      (item, index) => index >= baselineLength && "role" in item && item.role === "user",
    );
    if (nextUser === -1) {
      // An update belongs before a new user turn, never retroactively before a tool result.
      return request;
    }
    input.splice(nextUser, 0, {
      type: "configuration_update",
      reasoning: { effort: request.reasoning.effort },
    });
  }
  if (input.length === request.input.length && activeEffort === request.reasoning.effort) {
    return request;
  }
  return {
    ...request,
    reasoning: { ...request.reasoning, effort: previous.reasoning.effort },
    input,
  };
}
