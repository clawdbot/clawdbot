import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function toolCall(id = "call-1"): AgentMessage {
  return message({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id, name: "message", arguments: { action: "send" } },
    ],
  });
}

function toolResult(
  id = "call-1",
  content: unknown = [{ type: "text", text: "Message sent." }],
): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId: id,
    toolName: "message",
    content,
  });
}

describe("projectSettledCodexMessages", () => {
  it("projects a canonical completed tool exchange without exposing reasoning", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "Send the update." }),
        message({
          role: "assistant",
          content: [{ type: "text", text: "I’ll send it now." }],
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Send the update." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll send it now." }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "message",
        arguments: '{"action":"send"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Message sent.",
      },
    ]);
  });

  it("accepts Codex's enriched mirrored tool-result block", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          {
            type: "toolResult",
            toolCallId: "call-1",
            content: "Telegram delivery complete.",
          },
        ]),
      ]),
    ).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Telegram delivery complete.",
      },
    ]);
  });

  it("preserves failed tool-result status in the projected output", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [{ type: "text", text: "Delivery failed." }],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nDelivery failed.",
    });
  });

  it("preserves an empty failed tool result as failure evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nTool failed without textual output.",
    });
  });

  it("does not charge the synthetic failure marker against the source text limit", () => {
    const resultText = "x".repeat(64 * 1024);
    const output = projectSettledCodexMessages([
      toolCall(),
      message({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "message",
        isError: true,
        content: [{ type: "text", text: resultText }],
      }),
    ]).at(-1) as { output?: string };

    expect(output.output).toBe(`[Tool result status: error]\n${resultText}`);
  });

  it("preserves exact whitespace in projected transcript text", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "  user input\n" }),
        message({ role: "assistant", content: [{ type: "text", text: "\tassistant output\n" }] }),
        toolCall(),
        toolResult("call-1", [{ type: "text", text: "  tool output\n" }]),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "  user input\n" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "\tassistant output\n" }],
      },
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "  tool output\n",
      },
    ]);
  });

  it("rejects an oversized item count instead of dropping earlier context", () => {
    const oldMessages = Array.from({ length: 205 }, (_, index) =>
      message({ role: "user", content: `old-${index}` }),
    );
    expect(() => projectSettledCodexMessages([...oldMessages, toolCall(), toolResult()])).toThrow(
      "exceeds the item limit",
    );
  });

  it("prefers the undecorated upstream user text", () => {
    expect(
      projectSettledCodexMessages([
        message({
          role: "user",
          content: "[Telegram metadata] decorated prompt",
          __openclaw: { upstreamUserText: "Send the Aurora notice to Erin." },
        }),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Send the Aurora notice to Erin." }],
    });
  });

  it("does not let provenance hide non-text user content", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "user",
          content: [
            { type: "text", text: "Send the notice." },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          __openclaw: { upstreamUserText: "Send the notice." },
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("does not support user content image");
  });

  it.each([
    { name: "orphan result", messages: [toolResult()] },
    { name: "missing result", messages: [toolCall()] },
    { name: "duplicate call id", messages: [toolCall(), toolCall(), toolResult()] },
    {
      name: "tool-name mismatch",
      messages: [
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "different",
          content: [{ type: "text", text: "done" }],
        }),
      ],
    },
  ])("fails closed for $name", ({ messages }) => {
    expect(() => projectSettledCodexMessages(messages)).toThrow(/Codex settled-turn projection/u);
  });

  it("preserves valid image tool results as bounded non-vision evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          { type: "text", text: "Generated the requested asset." },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "Generated the requested asset.\n[Image tool result: image/png]",
    });
  });

  it("rejects oversized text instead of truncating it", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({ role: "user", content: "x".repeat(64 * 1024 + 1) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("oversized user message");
  });

  it("rejects a complete transcript above the aggregate byte limit", () => {
    const messages = Array.from({ length: 9 }, () =>
      message({ role: "user", content: "x".repeat(60 * 1024) }),
    );
    expect(() => projectSettledCodexMessages([...messages, toolCall(), toolResult()])).toThrow(
      "exceeds the byte limit",
    );
  });
});
