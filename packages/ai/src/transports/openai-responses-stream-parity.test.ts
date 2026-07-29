import type { AssistantMessage, AssistantMessageEvent, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  processResponsesStream as processTransportStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

type ProjectedEvent = {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
};

type ProjectedBlock =
  | { type: "thinking"; thinking: string; encrypted: boolean }
  | { type: "text"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: unknown;
      partialJson: boolean;
    };

type ProcessResult = {
  events: ProjectedEvent[];
  content: ProjectedBlock[];
  responseId: string | null;
  stopReason: string;
  error: string | null;
};

type ParityFixture = {
  name: string;
  events: Record<string, unknown>[];
  canonical: ProcessResult;
};

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

function projectEvent(event: AssistantMessageEvent): ProjectedEvent | undefined {
  if (
    event.type !== "thinking_start" &&
    event.type !== "thinking_delta" &&
    event.type !== "thinking_end" &&
    event.type !== "text_start" &&
    event.type !== "text_delta" &&
    event.type !== "text_end" &&
    event.type !== "toolcall_start" &&
    event.type !== "toolcall_delta" &&
    event.type !== "toolcall_end"
  ) {
    return undefined;
  }
  return {
    type: event.type,
    contentIndex: event.contentIndex,
    ...(event.type === "thinking_delta" ||
    event.type === "text_delta" ||
    event.type === "toolcall_delta"
      ? { delta: event.delta }
      : {}),
    ...(event.type === "thinking_end" || event.type === "text_end"
      ? { content: event.content }
      : {}),
  };
}

function projectBlock(block: AssistantMessage["content"][number]): ProjectedBlock {
  if (block.type === "thinking") {
    let encrypted = false;
    if (block.thinkingSignature) {
      try {
        const item = JSON.parse(block.thinkingSignature) as { encrypted_content?: unknown };
        encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
      } catch {
        encrypted = false;
      }
    }
    return { type: "thinking", thinking: block.thinking, encrypted };
  }
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  const toolCall = block as typeof block & { partialJson?: string };
  return {
    type: "toolCall",
    id: toolCall.id.replace(/^call_[a-f0-9]{24}/, "call_<generated>"),
    name: toolCall.name,
    arguments: toolCall.arguments,
    partialJson: "partialJson" in toolCall,
  };
}

async function runFixture(events: readonly Record<string, unknown>[]): Promise<ProcessResult> {
  const output = createOutput();
  const captured: AssistantMessageEvent[] = [];
  let error: string | null = null;
  try {
    await processTransportStream(
      eventStream(events),
      output,
      { push: (event) => captured.push(event as AssistantMessageEvent) },
      model,
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    events: captured.map(projectEvent).filter((event) => event !== undefined),
    content: output.content.map(projectBlock),
    responseId: output.responseId ?? null,
    stopReason: output.stopReason,
    error,
  };
}

const completed = (id: string, output: unknown[] = []) => ({
  type: "response.completed",
  sequence_number: 99,
  response: { id, status: "completed", output },
});

const fixtures: ParityFixture[] = [
  {
    name: "indexed interleaved reasoning items",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_0", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "rs_1", type: "reasoning", summary: [], content: [] },
      },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_0", delta: "A" },
      { type: "response.reasoning_text.delta", output_index: 1, item_id: "rs_1", delta: "B" },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { id: "rs_1", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "rs_0", type: "reasoning", summary: [], content: [] },
      },
      completed("resp_interleaved"),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_delta", contentIndex: 0, delta: "A" },
        { type: "thinking_delta", contentIndex: 1, delta: "B" },
        { type: "thinking_end", contentIndex: 1, content: "B" },
        { type: "thinking_end", contentIndex: 0, content: "A" },
      ],
      content: [
        { type: "thinking", thinking: "A", encrypted: false },
        { type: "thinking", thinking: "B", encrypted: false },
      ],
      responseId: "resp_interleaved",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "raw reasoning delta with empty summary",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_raw", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        item_id: "rs_raw",
        delta: "raw thought",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "rs_raw", type: "reasoning", summary: [], content: [] },
      },
      completed("resp_raw"),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "raw thought" },
        { type: "thinking_end", contentIndex: 0, content: "raw thought" },
      ],
      content: [{ type: "thinking", thinking: "raw thought", encrypted: false }],
      responseId: "resp_raw",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "stream close without terminal response",
    events: [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_early",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "early", annotations: [] }],
        },
      },
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "early" },
      ],
      content: [{ type: "text", text: "early" }],
      responseId: null,
      stopReason: "stop",
      error: "OpenAI Responses stream ended before a terminal response event",
    },
  },
  {
    name: "terminal encrypted reasoning backfill",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_backfill", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_backfill",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
      },
      completed("resp_backfill", [
        {
          id: "rs_backfill",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
          encrypted_content: "encrypted",
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
      ],
      content: [{ type: "thinking", thinking: "thought", encrypted: true }],
      responseId: "resp_backfill",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "null completed message content preserves streamed text",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_null",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_null",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_null",
        content_index: 0,
        delta: "kept",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_null",
          type: "message",
          role: "assistant",
          status: "completed",
          content: null,
        },
      },
      completed("resp_null"),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "kept" },
        { type: "text_end", contentIndex: 0, content: "kept" },
      ],
      content: [{ type: "text", text: "kept" }],
      responseId: "resp_null",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "finalized tool call drops streaming scratch",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_scratch",
          call_id: "call_scratch",
          type: "function_call",
          name: "lookup",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_scratch",
        delta: '{"q":"x"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "fc_scratch",
          call_id: "call_scratch",
          type: "function_call",
          name: "lookup",
          arguments: '{"q":"x"}',
          status: "completed",
        },
      },
      completed("resp_scratch"),
    ],
    canonical: {
      events: [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_delta", contentIndex: 0, delta: '{"q":"x"}' },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      content: [
        {
          type: "toolCall",
          id: "call_scratch|fc_scratch",
          name: "lookup",
          arguments: { q: "x" },
          partialJson: false,
        },
      ],
      responseId: "resp_scratch",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "reused indexed output slot fails closed",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_first", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_second", type: "reasoning", summary: [], content: [] },
      },
      completed("resp_reused"),
    ],
    canonical: {
      events: [{ type: "thinking_start", contentIndex: 0 }],
      content: [
        { type: "thinking", thinking: "", encrypted: false },
        { type: "thinking", thinking: "", encrypted: false },
      ],
      responseId: null,
      stopReason: "stop",
      error: "Responses stream reused active output index 0",
    },
  },
  {
    name: "deferred text materializes before an unindexed tool boundary",
    events: [
      {
        type: "response.output_item.done",
        item: {
          id: "msg_before_tool",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        },
      },
      {
        type: "response.output_item.added",
        item: {
          id: "msg_after_tool",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      { type: "response.output_text.delta", item_id: "msg_after_tool", delta: "Hello again" },
      {
        type: "response.output_item.done",
        item: {
          id: "fc_boundary",
          call_id: "call_boundary",
          type: "function_call",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
      },
      {
        type: "response.output_item.done",
        item: {
          id: "msg_after_tool",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello again", annotations: [] }],
        },
      },
      completed("resp_tool_boundary"),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Hello" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "Hello again" },
        { type: "toolcall_start", contentIndex: 2 },
        { type: "toolcall_end", contentIndex: 2 },
        { type: "text_end", contentIndex: 1, content: "Hello again" },
      ],
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "Hello again" },
        {
          type: "toolCall",
          id: "call_boundary|fc_boundary",
          name: "lookup",
          arguments: {},
          partialJson: false,
        },
      ],
      responseId: "resp_tool_boundary",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "normal output text lifecycle",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_text",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_text",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_text",
        content_index: 0,
        delta: "hello",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_text",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        },
      },
      completed("resp_text", [
        {
          id: "msg_text",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "hello" },
        { type: "text_end", contentIndex: 0, content: "hello" },
      ],
      content: [{ type: "text", text: "hello" }],
      responseId: "resp_text",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal-only completed message recovery",
    events: [
      completed("resp_terminal_text", [
        {
          id: "msg_terminal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "recovered", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "recovered" },
      ],
      content: [{ type: "text", text: "recovered" }],
      responseId: "resp_terminal_text",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal completed message recovery after streamed reasoning",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_before_terminal", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_before_terminal",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
      },
      completed("resp_reasoning_terminal_text", [
        {
          id: "rs_before_terminal",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
          encrypted_content: "encrypted",
        },
        {
          id: "msg_after_reasoning",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "recovered final answer", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_end", contentIndex: 1, content: "recovered final answer" },
      ],
      content: [
        { type: "thinking", thinking: "thought", encrypted: true },
        { type: "text", text: "recovered final answer" },
      ],
      responseId: "resp_reasoning_terminal_text",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal completed message recovery after multiple streamed reasoning blocks",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_before_multi_first", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_before_multi_first",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "first thought" }],
          content: [],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "rs_before_multi_second", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "rs_before_multi_second",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "second thought" }],
          content: [],
        },
      },
      completed("resp_multi_reasoning_terminal_text", [
        {
          id: "rs_before_multi_first",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "first thought" }],
          content: [],
        },
        {
          id: "rs_before_multi_second",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "second thought" }],
          content: [],
        },
        {
          id: "msg_after_multiple_reasoning",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "recovered final answer", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "first thought" },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_end", contentIndex: 1, content: "second thought" },
        { type: "text_start", contentIndex: 2 },
        { type: "text_end", contentIndex: 2, content: "recovered final answer" },
      ],
      content: [
        { type: "thinking", thinking: "first thought", encrypted: false },
        { type: "thinking", thinking: "second thought", encrypted: false },
        { type: "text", text: "recovered final answer" },
      ],
      responseId: "resp_multi_reasoning_terminal_text",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal completed refusal recovery after streamed reasoning",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_before_refusal", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_before_refusal",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
      },
      completed("resp_reasoning_terminal_refusal", [
        {
          id: "rs_before_refusal",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
        {
          id: "msg_after_reasoning_refusal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_end", contentIndex: 1, content: "I cannot help with that." },
      ],
      content: [
        { type: "thinking", thinking: "thought", encrypted: false },
        { type: "text", text: "I cannot help with that." },
      ],
      responseId: "resp_reasoning_terminal_refusal",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal null message after streamed reasoning is ignored",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_terminal_null", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_terminal_null",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
      },
      completed("resp_reasoning_terminal_null", [
        {
          id: "rs_terminal_null",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
        {
          id: "msg_after_reasoning_null",
          type: "message",
          role: "assistant",
          status: "completed",
          content: null,
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
      ],
      content: [{ type: "thinking", thinking: "thought", encrypted: false }],
      responseId: "resp_reasoning_terminal_null",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal-only completed tool call recovery after streamed reasoning",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_before_tool", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_before_tool",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
      },
      completed("resp_reasoning_terminal_tool", [
        {
          id: "rs_before_tool",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
        },
        {
          id: "fc_terminal",
          call_id: "call_terminal",
          type: "function_call",
          name: "lookup",
          arguments: '{"q":"x"}',
          status: "completed",
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 0, content: "thought" },
        { type: "toolcall_start", contentIndex: 1 },
        { type: "toolcall_end", contentIndex: 1 },
      ],
      content: [
        { type: "thinking", thinking: "thought", encrypted: false },
        {
          type: "toolCall",
          id: "call_terminal|fc_terminal",
          name: "lookup",
          arguments: { q: "x" },
          partialJson: false,
        },
      ],
      responseId: "resp_reasoning_terminal_tool",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "output text delta without content part",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_no_part",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_no_part",
        content_index: 0,
        delta: "compatible",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_no_part",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "compatible", annotations: [] }],
        },
      },
      completed("resp_no_part"),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "compatible" },
        { type: "text_end", contentIndex: 0, content: "compatible" },
      ],
      content: [{ type: "text", text: "compatible" }],
      responseId: "resp_no_part",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal-only null message content is ignored",
    events: [
      completed("resp_terminal_null", [
        {
          id: "msg_terminal_null",
          type: "message",
          role: "assistant",
          status: "completed",
          content: null,
        },
      ]),
    ],
    canonical: {
      events: [],
      content: [],
      responseId: "resp_terminal_null",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "detailed response failure is terminal",
    events: [
      {
        type: "response.failed",
        sequence_number: 1,
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "invalid_prompt", message: "rejected" },
        },
      },
    ],
    canonical: {
      events: [],
      content: [],
      responseId: "resp_failed",
      stopReason: "stop",
      error: "invalid_prompt: rejected",
    },
  },
];

describe("Responses stream processor parity fixtures", () => {
  it.each(fixtures)("$name", async (fixture) => {
    expect(await runFixture(fixture.events)).toEqual(fixture.canonical);
  });
});
