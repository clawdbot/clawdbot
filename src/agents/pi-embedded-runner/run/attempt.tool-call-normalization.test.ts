import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeReplayToolCallIdsForStream } from "./attempt.tool-call-normalization.js";

describe("sanitizeReplayToolCallIdsForStream", () => {
  it("drops orphaned tool results after strict id sanitization", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_function_av7cbkigmk7x1",
        toolUseId: "call_function_av7cbkigmk7x1",
        toolName: "read",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      } as never,
    ];

    expect(
      sanitizeReplayToolCallIdsForStream({
        messages,
        mode: "strict",
        repairToolUseResultPairing: true,
      }),
    ).toEqual([]);
  });

  it("keeps matched assistant and tool-result ids aligned", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawId,
        toolUseId: rawId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeReplayToolCallIdsForStream({
      messages,
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" }],
      },
      {
        role: "toolResult",
        toolCallId: "callfunctionav7cbkigmk7x1",
        toolUseId: "callfunctionav7cbkigmk7x1",
        toolName: "read",
      },
    ]);
  });

  it("keeps real tool results for aborted assistant spans", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "partial" }],
          isError: false,
        } as never,
        {
          role: "user",
          content: [{ type: "text", text: "retry" }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" }],
      },
      {
        role: "toolResult",
        toolCallId: "callfunctionav7cbkigmk7x1",
        toolUseId: "callfunctionav7cbkigmk7x1",
        toolName: "read",
      },
      {
        role: "user",
      },
    ]);
  });
});
