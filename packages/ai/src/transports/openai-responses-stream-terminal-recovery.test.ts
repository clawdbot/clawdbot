import { describe, expect, it } from "vitest";
import {
  completed,
  runFixture,
  type ParityFixture,
} from "./openai-responses-stream-parity.test-helpers.js";

const rejectedTerminalToolFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments: string;
  error: string;
}): ParityFixture => {
  const commentary = {
    id: "msg_before_rejected_tool",
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "commentary",
    content: [{ type: "output_text", text: "Checking...", annotations: [] }],
  };
  return {
    name: params.name,
    events: [
      { type: "response.output_item.done", output_index: 0, item: commentary },
      completed("resp_rejected_terminal_tool", [
        commentary,
        {
          id: "fc_rejected_terminal",
          call_id: "call_rejected_terminal",
          type: "function_call",
          name: "lookup",
          arguments: params.arguments,
          status: params.status,
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Checking..." },
      ],
      content: [{ type: "text", text: "Checking..." }],
      responseId: "resp_rejected_terminal_tool",
      stopReason: "stop",
      error: params.error,
    },
  };
};

const rejectedTerminalToolBatchFixture = (params: {
  name: string;
  status: "completed" | "incomplete";
  arguments: string;
  error: string;
  toolName?: string;
}): ParityFixture => ({
  name: params.name,
  events: [
    completed("resp_rejected_terminal_tool_batch", [
      {
        id: "fc_valid_before_rejection",
        call_id: "call_valid_before_rejection",
        type: "function_call",
        name: "lookup",
        arguments: '{"q":"valid"}',
        status: "completed",
      },
      {
        id: "fc_rejected_after_valid",
        call_id: "call_rejected_after_valid",
        type: "function_call",
        name: params.toolName ?? "lookup",
        arguments: params.arguments,
        status: params.status,
      },
    ]),
  ],
  canonical: {
    events: [],
    content: [],
    responseId: "resp_rejected_terminal_tool_batch",
    stopReason: "stop",
    error: params.error,
  },
});

const rejectedOutOfOrderTerminalFixture = (
  state: "completed" | "started" | "reasoning",
): ParityFixture => {
  const later =
    state === "reasoning"
      ? {
          id: "rs_later_already_streamed",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking..." }],
          content: [],
        }
      : {
          id: "msg_later_already_streamed",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Final answer", annotations: [] }],
        };
  const streamed =
    state === "completed" || state === "reasoning"
      ? [{ type: "response.output_item.done", output_index: 1, item: later }]
      : [
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { ...later, status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 1,
            item_id: later.id,
            content_index: 0,
            delta: "Final answer",
          },
        ];
  return {
    name: `terminal recovery rejects missing output before a ${state} item`,
    events: [
      ...streamed,
      completed("resp_out_of_order_recovery", [
        {
          id: "msg_earlier_missing",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working...", annotations: [] }],
        },
        later,
      ]),
    ],
    canonical: {
      events:
        state === "reasoning"
          ? [
              { type: "thinking_start", contentIndex: 0 },
              { type: "thinking_end", contentIndex: 0, content: "Thinking..." },
            ]
          : [
              { type: "text_start", contentIndex: 0 },
              ...(state === "completed"
                ? [{ type: "text_end", contentIndex: 0, content: "Final answer" }]
                : [{ type: "text_delta", contentIndex: 0, delta: "Final answer" }]),
            ],
      content:
        state === "reasoning"
          ? [{ type: "thinking", thinking: "Thinking...", encrypted: false }]
          : [{ type: "text", text: "Final answer" }],
      responseId: "resp_out_of_order_recovery",
      stopReason: "stop",
      error: "Responses stream omitted an output item before completed output",
    },
  };
};

const fixtures: ParityFixture[] = [
  {
    name: "terminal final answer recovery preserves streamed commentary",
    events: [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_streamed_commentary",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working on it...", annotations: [] }],
        },
      },
      completed("resp_commentary_terminal_answer", [
        {
          id: "msg_streamed_commentary",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working on it...", annotations: [] }],
        },
        {
          id: "msg_terminal_answer",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Final answer", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Working on it..." },
        { type: "text_start", contentIndex: 1 },
        { type: "text_end", contentIndex: 1, content: "Final answer" },
      ],
      content: [
        { type: "text", text: "Working on it..." },
        { type: "text", text: "Final answer" },
      ],
      responseId: "resp_commentary_terminal_answer",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal tool recovery preserves streamed commentary",
    events: [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_tool_commentary",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking...", annotations: [] }],
        },
      },
      completed("resp_commentary_terminal_tool", [
        {
          id: "msg_tool_commentary",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking...", annotations: [] }],
        },
        {
          id: "fc_after_commentary",
          call_id: "call_after_commentary",
          type: "function_call",
          name: "lookup",
          arguments: '{"q":"x"}',
          status: "completed",
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Checking..." },
        { type: "toolcall_start", contentIndex: 1 },
        { type: "toolcall_end", contentIndex: 1 },
      ],
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "toolCall",
          id: "call_after_commentary|fc_after_commentary",
          name: "lookup",
          arguments: { q: "x" },
          partialJson: false,
        },
      ],
      responseId: "resp_commentary_terminal_tool",
      stopReason: "toolUse",
      error: null,
    },
  },
  {
    name: "terminal snapshot does not duplicate streamed commentary or final answer",
    events: [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_complete_commentary",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking...", annotations: [] }],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "msg_complete_answer",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done.", annotations: [] }],
        },
      },
      completed("resp_complete_messages", [
        {
          id: "msg_complete_commentary",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking...", annotations: [] }],
        },
        {
          id: "msg_complete_answer",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done.", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Checking..." },
        { type: "text_start", contentIndex: 1 },
        { type: "text_end", contentIndex: 1, content: "Done." },
      ],
      content: [
        { type: "text", text: "Checking..." },
        { type: "text", text: "Done." },
      ],
      responseId: "resp_complete_messages",
      stopReason: "stop",
      error: null,
    },
  },
  rejectedTerminalToolFixture({
    name: "terminal incomplete tool snapshot after streamed commentary is rejected",
    status: "incomplete",
    arguments: '{"q":"x"}',
    error: "Responses stream completed with an incomplete terminal tool call",
  }),
  rejectedTerminalToolFixture({
    name: "terminal malformed tool arguments after streamed commentary are rejected",
    status: "completed",
    arguments: '{"q":',
    error: "Responses stream completed tool call with invalid JSON arguments",
  }),
  rejectedTerminalToolBatchFixture({
    name: "terminal tool batch rejects a later incomplete call before executing earlier calls",
    status: "incomplete",
    arguments: '{"q":"incomplete"}',
    error: "Responses stream completed with an incomplete terminal tool call",
  }),
  rejectedTerminalToolBatchFixture({
    name: "terminal tool batch rejects later malformed arguments before executing earlier calls",
    status: "completed",
    arguments: '{"q":',
    error: "Responses stream completed tool call with invalid JSON arguments",
  }),
  rejectedTerminalToolBatchFixture({
    name: "terminal tool batch rejects a later blank function name before executing earlier calls",
    status: "completed",
    arguments: '{"q":"x"}',
    toolName: "",
    error: "Responses stream completed tool call without a function name",
  }),
  {
    name: "terminal tool snapshots preserve optional SDK completion status",
    events: [
      completed("resp_terminal_tool_optional_status", [
        {
          id: "fc_optional_status",
          call_id: "call_optional_status",
          type: "function_call",
          name: "lookup",
          arguments: '{"q":"x"}',
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      content: [
        {
          type: "toolCall",
          id: "call_optional_status|fc_optional_status",
          name: "lookup",
          arguments: { q: "x" },
          partialJson: false,
        },
      ],
      responseId: "resp_terminal_tool_optional_status",
      stopReason: "toolUse",
      error: null,
    },
  },
  rejectedOutOfOrderTerminalFixture("completed"),
  rejectedOutOfOrderTerminalFixture("started"),
  rejectedOutOfOrderTerminalFixture("reasoning"),
  {
    name: "incomplete terminal recovery preserves completed tool-call ordering",
    events: [
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_completed_before_incomplete",
          call_id: "call_completed_before_incomplete",
          type: "function_call",
          name: "lookup",
          arguments: '{"q":"x"}',
          status: "completed",
        },
      },
      {
        type: "response.incomplete",
        response: {
          id: "resp_incomplete_out_of_order",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              id: "msg_earlier_missing_before_tool",
              type: "message",
              role: "assistant",
              status: "completed",
              phase: "commentary",
              content: [{ type: "output_text", text: "Working...", annotations: [] }],
            },
            {
              id: "fc_completed_before_incomplete",
              call_id: "call_completed_before_incomplete",
              type: "function_call",
              name: "lookup",
              arguments: '{"q":"x"}',
              status: "completed",
            },
          ],
        },
      },
    ],
    canonical: {
      events: [
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      content: [
        {
          type: "toolCall",
          id: "call_completed_before_incomplete|fc_completed_before_incomplete",
          name: "lookup",
          arguments: { q: "x" },
          partialJson: false,
        },
      ],
      responseId: "resp_incomplete_out_of_order",
      stopReason: "length",
      error: "Responses stream omitted an output item before completed output",
    },
  },
  {
    name: "terminal snapshot closes an already started empty message",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_started_empty",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      completed("resp_started_empty", [
        {
          id: "msg_started_empty",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "" },
      ],
      content: [{ type: "text", text: "" }],
      responseId: "resp_started_empty",
      stopReason: "stop",
      error: null,
    },
  },
  {
    name: "terminal snapshot completes an unfinished streamed message once",
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_unfinished_terminal",
          type: "message",
          role: "assistant",
          status: "in_progress",
          phase: "final_answer",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_unfinished_terminal",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_unfinished_terminal",
        content_index: 0,
        delta: "Partial",
      },
      completed("resp_unfinished_terminal_message", [
        {
          id: "msg_unfinished_terminal",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Partial answer", annotations: [] }],
        },
      ]),
    ],
    canonical: {
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Partial" },
        { type: "text_delta", contentIndex: 0, delta: " answer" },
        { type: "text_end", contentIndex: 0, content: "Partial answer" },
      ],
      content: [{ type: "text", text: "Partial answer" }],
      responseId: "resp_unfinished_terminal_message",
      stopReason: "stop",
      error: null,
    },
  },
];

describe("Responses terminal recovery fixtures", () => {
  it.each(fixtures)("$name", async (fixture) => {
    expect(await runFixture(fixture.events)).toEqual(fixture.canonical);
  });
});
