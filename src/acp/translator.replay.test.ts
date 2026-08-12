/** Tests transcript replay conversion into ACP session update chunks. */
import { describe, expect, it } from "vitest";
import { extractReplayChunks } from "./translator.replay.js";

describe("ACP translator replay helpers", () => {
  it("maps plain user and assistant text into replay chunks", () => {
    expect(extractReplayChunks({ role: "user", content: "Question" })).toEqual([
      { sessionUpdate: "user_message_chunk", text: "Question" },
    ]);
    expect(extractReplayChunks({ role: "assistant", content: "Answer" })).toEqual([
      { sessionUpdate: "agent_message_chunk", text: "Answer" },
    ]);
  });

  it("preserves assistant thinking as hidden thought chunks", () => {
    expect(
      extractReplayChunks({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Internal reasoning" },
          { type: "text", text: "Visible answer" },
        ],
      }),
    ).toEqual([
      { sessionUpdate: "agent_thought_chunk", text: "Internal reasoning" },
      { sessionUpdate: "agent_message_chunk", text: "Visible answer" },
    ]);
  });

  it("reconstructs transcript tool calls and results between assistant text segments", () => {
    expect(
      extractReplayChunks({
        role: "assistant",
        content: [
          { type: "text", text: "Before tool" },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "src/app.ts", line: 12 },
          },
        ],
      }),
    ).toEqual([
      { sessionUpdate: "agent_message_chunk", text: "Before tool" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "read: path: src/app.ts, line: 12",
        status: "in_progress",
        rawInput: { path: "src/app.ts", line: 12 },
        kind: "read",
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    ]);
    expect(
      extractReplayChunks({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "FILE:src/app.ts" }],
        details: { path: "src/app.ts" },
        isError: false,
      }),
    ).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: {
          content: [{ type: "text", text: "FILE:src/app.ts" }],
          details: { path: "src/app.ts" },
        },
        content: [
          {
            type: "content",
            content: { type: "text", text: "FILE:src/app.ts" },
          },
        ],
        locations: [{ path: "src/app.ts" }],
      },
    ]);
  });

  it("preserves string-valued transcript tool output", () => {
    expect(
      extractReplayChunks({
        role: "toolResult",
        toolCallId: "call-string",
        content: "plain tool output",
      }),
    ).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-string",
        status: "completed",
        rawOutput: { content: "plain tool output" },
        content: [
          {
            type: "content",
            content: { type: "text", text: "plain tool output" },
          },
        ],
        locations: undefined,
      },
    ]);
  });

  it("drops unsupported roles, empty text, and non-text content", () => {
    expect(extractReplayChunks({ role: "system", content: "ignore" })).toEqual([]);
    expect(extractReplayChunks({ role: "assistant", content: "" })).toEqual([]);
    expect(
      extractReplayChunks({
        role: "assistant",
        content: [{ type: "image", image: "skip" }, null, []],
      }),
    ).toEqual([]);
  });
});
