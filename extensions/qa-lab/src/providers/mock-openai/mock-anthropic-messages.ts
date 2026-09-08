// QA Lab Anthropic Messages wire adapter.
import {
  buildAnthropicFailureResponse,
  buildAnthropicMessageResponse,
  buildAnthropicMessageStreamEvents,
  buildAnthropicThinkingErrorResponse,
  buildAnthropicThinkingErrorStreamEvents,
  convertAnthropicMessagesToResponsesInput,
  extractAssistantOutputFromEvents,
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
  status: number;
  responseBody: Record<string, unknown>;
  // HTTP failures stay JSON errors even when streaming was requested.
  streamEvents?: AnthropicStreamEvent[];
} {
  if (dispatched.failure?.presentation === "anthropic-thinking") {
    return {
      status: dispatched.failure.status,
      responseBody: buildAnthropicThinkingErrorResponse({ model: dispatched.model }),
      streamEvents: buildAnthropicThinkingErrorStreamEvents({ model: dispatched.model }),
    };
  }
  if (dispatched.failure) {
    return {
      status: dispatched.failure.status,
      responseBody: buildAnthropicFailureResponse(dispatched.failure),
    };
  }
  const failed = dispatched.events.find((event) => event.type === "response.failed");
  const failure = failed
    ? {
        status: 500,
        type: "api_error",
        code: failed.response.error?.code,
        message: failed.response.error?.message ?? "mock completion failed",
      }
    : undefined;
  const message = buildAnthropicMessageResponse({
    model: dispatched.model,
    extracted: extractAssistantOutputFromEvents(dispatched.events),
  });
  return {
    status: failure?.status ?? 200,
    responseBody: failure ? buildAnthropicFailureResponse(failure) : message,
    streamEvents: buildAnthropicMessageStreamEvents(message, failure),
  };
}
