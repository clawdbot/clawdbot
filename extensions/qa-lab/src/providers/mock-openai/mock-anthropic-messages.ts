// QA Lab Anthropic Messages wire adapter.
import {
  buildAnthropicFailureResponse,
  buildAnthropicMessageResponse,
  buildAnthropicMessageStreamEvents,
  buildAnthropicThinkingErrorResponse,
  buildAnthropicThinkingErrorStreamEvents,
  convertAnthropicMessagesToResponsesInput,
  extractFinalAssistantOutputFromEvents,
  normalizeAnthropicSystemToString,
} from "./mock-anthropic-wire.js";
import type {
  AnthropicMessagesRequest,
  AnthropicStreamEvent,
  QaMockProviderDispatchResult,
  ResponsesInputItem,
} from "./mock-openai-contracts.js";

export function normalizeAnthropicMessagesRequest(body: AnthropicMessagesRequest): {
  body: Record<string, unknown>;
  input: ResponsesInputItem[];
  model: string;
} {
  const model =
    typeof body.model === "string" && body.model.trim() !== "" ? body.model : "claude-opus-4-8";
  const input = convertAnthropicMessagesToResponsesInput({
    messages: Array.isArray(body.messages) ? body.messages : [],
  });
  const instructions = normalizeAnthropicSystemToString(body.system);
  return {
    body: {
      input,
      model,
      stream: false,
      ...(instructions ? { instructions } : {}),
      ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    },
    input,
    model,
  };
}

export function buildMessagesPayload(dispatched: QaMockProviderDispatchResult): {
  responseBody: Record<string, unknown>;
  streamEvents: AnthropicStreamEvent[];
} {
  if (dispatched.failure?.presentation === "anthropic-thinking") {
    return {
      responseBody: buildAnthropicThinkingErrorResponse({ model: dispatched.model }),
      streamEvents: buildAnthropicThinkingErrorStreamEvents({ model: dispatched.model }),
    };
  }
  if (dispatched.failure) {
    return {
      responseBody: buildAnthropicFailureResponse(dispatched.failure),
      streamEvents: [],
    };
  }
  const extracted = extractFinalAssistantOutputFromEvents(dispatched.events);
  return {
    responseBody: buildAnthropicMessageResponse({
      model: dispatched.model,
      extracted,
    }),
    streamEvents: buildAnthropicMessageStreamEvents({
      model: dispatched.model,
      extracted,
    }),
  };
}
