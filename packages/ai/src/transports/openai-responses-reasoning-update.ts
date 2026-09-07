import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponsesContinuationRequest,
  ResponsesSteeringContinuationMode,
} from "./openai-responses-continuation.js";

// Public Responses input item; the installed SDK predates configuration updates.
export type ResponsesConfigurationUpdate = {
  type: "configuration_update";
  reasoning: { effort: string };
};

export function isConfigurationUpdate(value: unknown): value is ResponsesConfigurationUpdate {
  return (
    isRecord(value) &&
    value.type === "configuration_update" &&
    isRecord(value.reasoning) &&
    typeof value.reasoning.effort === "string"
  );
}

function isResponsesReasoningUpdateCompatible(request: ResponsesContinuationRequest): boolean {
  const mode = isRecord(request.reasoning) ? request.reasoning.mode : undefined;
  return (
    request.model === "gpt-6-astra" &&
    (mode === undefined || mode === "standard") &&
    (!isRecord(request.multi_agent) || request.multi_agent.enabled !== true) &&
    request.truncation !== "auto" &&
    (!Array.isArray(request.context_management) ||
      !request.context_management.some((item) => isRecord(item) && item.type === "compaction"))
  );
}

export function supportsResponsesReasoningUpdate(request: ResponsesContinuationRequest): boolean {
  return (
    isResponsesReasoningUpdateCompatible(request) &&
    isRecord(request.reasoning) &&
    typeof request.reasoning.effort === "string"
  );
}

export function canReferenceResponsesReasoningHistory(
  previous: ResponsesContinuationRequest,
  request: ResponsesContinuationRequest,
): boolean {
  return (
    !previous.input?.some(isConfigurationUpdate) || isResponsesReasoningUpdateCompatible(request)
  );
}

/** Rehydrate input controls only provisionally; continuation must validate the full prefix. */
export function replayResponsesReasoningUpdates(
  previous: ResponsesContinuationRequest,
  request: ResponsesContinuationRequest,
  previousOutputLength: number,
  steering?: ResponsesSteeringContinuationMode,
): ResponsesContinuationRequest {
  if (
    (steering !== "required-input" &&
      (!supportsResponsesReasoningUpdate(previous) ||
        !supportsResponsesReasoningUpdate(request))) ||
    !Array.isArray(previous.input) ||
    !Array.isArray(request.input) ||
    request.input.some(isConfigurationUpdate)
  ) {
    return request;
  }
  const input = [...request.input];
  let activeEffort = isRecord(previous.reasoning) ? previous.reasoning.effort : undefined;
  for (const [index, item] of previous.input.entries()) {
    if (isConfigurationUpdate(item)) {
      input.splice(index, 0, item);
      activeEffort = item.reasoning.effort;
    }
  }
  if (steering === "required-input") {
    // The explicit create owns its settings. Only restore historical controls;
    // a new control here would follow the user already queued on the server.
    return input.length === request.input.length ? request : { ...request, input };
  }
  if (
    !isRecord(previous.reasoning) ||
    !isRecord(request.reasoning) ||
    typeof request.reasoning.effort !== "string"
  ) {
    return request;
  }
  if (activeEffort !== request.reasoning.effort && steering !== "automatic") {
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
