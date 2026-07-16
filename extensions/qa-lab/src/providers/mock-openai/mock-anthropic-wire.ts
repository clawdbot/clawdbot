// QA Lab Anthropic Messages wire conversion and response events.
import {
  type ResponsesInputItem,
  type StreamEvent,
  type AnthropicMessageContentBlock,
  type AnthropicMessage,
  type AnthropicMessagesRequest,
  type AnthropicStreamEvent,
  countApproxTokens,
} from "./mock-openai-contracts.js";

// Anthropic Messages conversion preserves role and tool ordering while reusing
// the shared Responses scenario dispatcher for provider parity.

function normalizeAnthropicSystemToString(
  system: AnthropicMessagesRequest["system"],
): string | undefined {
  if (typeof system === "string") {
    return system.trim() || undefined;
  }
  if (Array.isArray(system)) {
    const joined = system
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

function stringifyToolResultContent(
  content: Extract<AnthropicMessageContentBlock, { type: "tool_result" }>["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function convertAnthropicMessagesToResponsesInput(params: {
  system?: AnthropicMessagesRequest["system"];
  messages: AnthropicMessage[];
}): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const systemText = normalizeAnthropicSystemToString(params.system);
  if (systemText) {
    items.push({
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });
  }
  for (const message of params.messages) {
    const content = message.content;
    if (typeof content === "string") {
      items.push({
        role: message.role,
        content: [
          message.role === "assistant"
            ? { type: "output_text", text: content }
            : { type: "input_text", text: content },
        ],
      });
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    // Buffer each block type so we can push in OpenAI-Responses order instead
    // of the order they appear in the Anthropic content array. The parent
    // role message must precede any function_call_output items from the same
    // turn, otherwise extractToolOutput() (which scans for
    // function_call_output AFTER the last user-role index) will not see the
    // output and the downstream scenario dispatcher will behave as if no
    // tool output was returned. Similarly, assistant tool_use blocks become
    // function_call items that must follow the assistant text message they
    // narrate.
    const textPieces: Array<{ type: "input_text" | "output_text"; text: string }> = [];
    const imagePieces: Array<{ type: "input_image"; image_url: string }> = [];
    const toolResultItems: ResponsesInputItem[] = [];
    const toolUseItems: ResponsesInputItem[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text") {
        textPieces.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: block.text ?? "",
        });
        continue;
      }
      if (block.type === "image") {
        // Mock only needs to count image inputs; a placeholder URL is fine.
        imagePieces.push({ type: "input_image", image_url: "anthropic-mock:image" });
        continue;
      }
      if (block.type === "tool_result") {
        const output = stringifyToolResultContent(block.content);
        if (output.trim()) {
          toolResultItems.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output,
            ...(block.is_error === true ? { is_error: true } : {}),
          });
        }
        continue;
      }
      if (block.type === "tool_use") {
        // Mirror OpenAI's function_call output_item shape so downstream
        // prompt extraction still sees "the assistant just emitted a tool
        // call". The scenario dispatcher looks for tool_output on the next
        // user turn, not the assistant's prior tool_use, so a minimal
        // placeholder is enough.
        toolUseItems.push({
          type: "function_call",
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          call_id: block.id,
        });
        continue;
      }
    }
    if (textPieces.length > 0 || imagePieces.length > 0) {
      const combinedContent: Array<Record<string, unknown>> = [...textPieces, ...imagePieces];
      items.push({ role: message.role, content: combinedContent });
    }
    // Emit tool_use (assistant prior calls) and tool_result (user-side
    // returns) AFTER the parent role message so extractLastUserText and
    // extractToolOutput walk the array in the order they expect. For a
    // tool_result-only user turn with no text/image blocks, the parent
    // message is intentionally omitted — the function_call_output itself
    // represents the user's "return the tool output" turn.
    for (const toolUse of toolUseItems) {
      items.push(toolUse);
    }
    for (const toolResult of toolResultItems) {
      items.push(toolResult);
    }
  }
  return items;
}

export type ExtractedAssistantOutput = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
};

export function extractFinalAssistantOutputFromEvents(
  events: StreamEvent[],
): ExtractedAssistantOutput {
  const toolCalls: ExtractedAssistantOutput["toolCalls"] = [];
  let text = "";
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as {
      type?: unknown;
      name?: unknown;
      call_id?: unknown;
      id?: unknown;
      arguments?: unknown;
      content?: unknown;
    };
    if (item.type === "function_call" && typeof item.name === "string") {
      let input: Record<string, unknown> = {};
      if (typeof item.arguments === "string" && item.arguments.trim()) {
        try {
          const parsed = JSON.parse(item.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // keep empty input on malformed args — mock dispatcher owns arg shape
        }
      }
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `toolu_mock_${toolCalls.length + 1}`,
        name: item.name,
        input,
      });
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const piece of item.content as Array<{ type?: unknown; text?: unknown }>) {
        if (piece?.type === "output_text" && typeof piece.text === "string") {
          text = piece.text;
        }
      }
    }
  }
  return { text, toolCalls };
}

export function buildAnthropicMessageResponse(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (params.extracted.text) {
    content.push({ type: "text", text: params.extracted.text });
  }
  for (const call of params.extracted.toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  const stopReason = params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn";
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  return {
    id: `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`,
    type: "message",
    role: "assistant",
    model: params.model || "claude-opus-4-8",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  };
}

const QA_ANTHROPIC_THINKING_ERROR_TEXT =
  "QA replay-safe read completed, but the provider stream failed after signed thinking.";
const QA_ANTHROPIC_THINKING_ERROR_SIGNATURE = "qa_signed_thinking_block_91953";
const QA_ANTHROPIC_THINKING_ERROR_MESSAGE = "QA injected provider stream failure";

export function buildAnthropicThinkingErrorResponse(params: {
  model: string;
}): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: QA_ANTHROPIC_THINKING_ERROR_MESSAGE,
    },
    model: params.model || "claude-opus-4-8",
  };
}

export function buildAnthropicThinkingErrorStreamEvents(params: {
  model: string;
}): AnthropicStreamEvent[] {
  const messageId = `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`;
  return [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: params.model || "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 64,
          output_tokens: 0,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "",
        signature: "",
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: QA_ANTHROPIC_THINKING_ERROR_TEXT,
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: QA_ANTHROPIC_THINKING_ERROR_SIGNATURE,
      },
    },
    {
      type: "content_block_stop",
      index: 0,
    },
    {
      type: "message_delta",
      delta: {},
      usage: {
        input_tokens: 64,
        output_tokens: 1120,
      },
    },
    {
      type: "error",
      error: {
        type: "api_error",
        message: QA_ANTHROPIC_THINKING_ERROR_MESSAGE,
      },
    },
  ];
}

export function buildAnthropicMessageStreamEvents(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}): AnthropicStreamEvent[] {
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  const messageId = `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`;
  const events: AnthropicStreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: params.model || "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: approxInputTokens,
          output_tokens: 0,
        },
      },
    },
  ];
  let index = 0;
  if (params.extracted.text || params.extracted.toolCalls.length === 0) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
      },
    });
    if (params.extracted.text) {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: params.extracted.text,
        },
      });
    }
    events.push({
      type: "content_block_stop",
      index,
    });
    index += 1;
  }
  for (const call of params.extracted.toolCalls) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: {},
      },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.input ?? {}),
      },
    });
    events.push({
      type: "content_block_stop",
      index,
    });
    index += 1;
  }
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn",
    },
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  });
  events.push({
    type: "message_stop",
  });
  return events;
}
