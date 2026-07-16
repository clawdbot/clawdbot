import {
  convertAnthropicMessagesToResponsesInput,
  type ExtractedAssistantOutput,
  extractFinalAssistantOutputFromEvents,
  buildAnthropicMessageResponse,
  buildAnthropicThinkingErrorResponse,
  buildAnthropicThinkingErrorStreamEvents,
  buildAnthropicMessageStreamEvents,
} from "./mock-anthropic-wire.js";
// QA Lab Anthropic Messages request dispatcher.
import {
  type ResponsesInputItem,
  type StreamEvent,
  type AnthropicMessagesRequest,
  QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE,
  type MockScenarioState,
  type AnthropicStreamEvent,
} from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { extractToolOutput, extractAllRequestTexts } from "./mock-openai-input.js";
import { buildToolCallEventsWithArgs } from "./mock-openai-tooling.js";

export async function buildMessagesPayload(
  body: AnthropicMessagesRequest,
  scenarioState: MockScenarioState,
  dispatchResponses: (
    body: Record<string, unknown>,
    scenarioState: MockScenarioState,
  ) => Promise<StreamEvent[]>,
): Promise<{
  events: StreamEvent[];
  input: ResponsesInputItem[];
  extracted: ExtractedAssistantOutput;
  responseBody: Record<string, unknown>;
  streamEvents: AnthropicStreamEvent[];
  model: string;
}> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = convertAnthropicMessagesToResponsesInput({
    system: body.system,
    messages,
  });
  // Treat empty-string model the same as absent. A bare typeof check lets
  // `""` leak through to `responseBody.model` and `lastRequest.model`,
  // which then confuses parity consumers that assume the mock always
  // echoes the real provider label. Normalize once and reuse everywhere.
  const normalizedModel =
    typeof body.model === "string" && body.model.trim() !== "" ? body.model : "claude-opus-4-8";
  // Dispatch through the same scenario logic the /v1/responses route uses.
  // Preserve declared tools so route-specific adapters mirror what the
  // real provider request made available to the model.
  const dispatchBody: Record<string, unknown> = {
    input,
    model: normalizedModel,
    stream: false,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
  };
  const allInputText = extractAllRequestTexts(input, dispatchBody);
  if (QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE.test(allInputText)) {
    const toolOutput = extractToolOutput(input);
    const shouldEmitThinkingError =
      toolOutput.length > 0 && scenarioState.anthropicThinkingErrorPhase === 0;
    const events =
      toolOutput.length === 0
        ? buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" })
        : shouldEmitThinkingError
          ? (() => {
              scenarioState.anthropicThinkingErrorPhase = 1;
              return buildAssistantEvents("");
            })()
          : buildAssistantEvents("ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
    const extracted = extractFinalAssistantOutputFromEvents(events);
    const responseBody = shouldEmitThinkingError
      ? buildAnthropicThinkingErrorResponse({ model: normalizedModel })
      : buildAnthropicMessageResponse({
          model: normalizedModel,
          extracted,
        });
    const streamEvents = shouldEmitThinkingError
      ? buildAnthropicThinkingErrorStreamEvents({ model: normalizedModel })
      : buildAnthropicMessageStreamEvents({
          model: normalizedModel,
          extracted,
        });
    return { events, input, extracted, responseBody, streamEvents, model: normalizedModel };
  }
  const events = await dispatchResponses(dispatchBody, scenarioState);
  const extracted = extractFinalAssistantOutputFromEvents(events);
  const responseBody = buildAnthropicMessageResponse({
    model: normalizedModel,
    extracted,
  });
  const streamEvents = buildAnthropicMessageStreamEvents({
    model: normalizedModel,
    extracted,
  });
  return { events, input, extracted, responseBody, streamEvents, model: normalizedModel };
}
