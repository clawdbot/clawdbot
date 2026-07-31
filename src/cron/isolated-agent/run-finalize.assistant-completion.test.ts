import { describe, expect, it } from "vitest";
import { buildCronAssistantCompletion } from "./assistant-completion.js";

function buildResult(params: {
  text?: string;
  stopReason?: string;
  calls?: number;
  failures?: number;
  pending?: number;
  isError?: boolean;
}) {
  return {
    payloads: params.text === undefined ? [] : [{ text: params.text, isError: params.isError }],
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: params.text,
      stopReason: params.stopReason,
      toolSummary: {
        calls: params.calls ?? 0,
        tools: params.calls ? ["exec"] : [],
        failures: params.failures ?? 0,
      },
      pendingToolCalls: Array.from({ length: params.pending ?? 0 }, (_, index) => ({
        id: `call-${index}`,
        name: "exec",
        arguments: "sensitive fixture argument",
      })),
    },
  };
}

describe("buildCronAssistantCompletion", () => {
  it("admits ordinary final assistant text without tool activity", () => {
    expect(
      buildCronAssistantCompletion(buildResult({ text: "Public summary", stopReason: "stop" })),
    ).toEqual({
      contractVersion: "openclaw.cron-assistant-completion.v1",
      toolCallDetected: false,
      toolResultAccepted: false,
      finalAssistantVisible: true,
      finalUserVisibleResult: true,
      toolCallCount: 0,
      toolFailureCount: 0,
    });
  });

  it("proves a completed tool result followed by final assistant text", () => {
    const completion = buildCronAssistantCompletion(
      buildResult({ text: "Final summary", stopReason: "stop", calls: 1 }),
    );
    expect(completion).toMatchObject({
      toolCallDetected: true,
      toolResultAccepted: true,
      finalAssistantVisible: true,
      finalUserVisibleResult: true,
      toolCallCount: 1,
      toolFailureCount: 0,
    });
  });

  it("rejects a failed tool even when a misleading non-empty text payload exists", () => {
    const completion = buildCronAssistantCompletion(
      buildResult({ text: "Misleading completion", stopReason: "stop", calls: 1, failures: 1 }),
    );
    expect(completion).toMatchObject({
      toolCallDetected: true,
      toolResultAccepted: false,
      finalAssistantVisible: true,
      finalUserVisibleResult: false,
      toolFailureCount: 1,
    });
  });

  it("rejects a pending tool call without a final continuation and emits no tool details", () => {
    const completion = buildCronAssistantCompletion(
      buildResult({ text: "intermediate", stopReason: "tool_calls", calls: 1, pending: 1 }),
    );
    expect(completion.finalUserVisibleResult).toBe(false);
    expect(completion.toolResultAccepted).toBe(false);
    expect(JSON.stringify(completion)).not.toContain("sensitive fixture argument");
    expect(JSON.stringify(completion)).not.toContain("call-0");
  });

  it("admits a final assistant turn after earlier completed tool activity", () => {
    const completion = buildCronAssistantCompletion(
      buildResult({ text: "Final user-visible answer", stopReason: "stop", calls: 2 }),
    );
    expect(completion.finalUserVisibleResult).toBe(true);
    expect(completion.toolResultAccepted).toBe(true);
    expect(completion.toolCallCount).toBe(2);
  });

  it("rejects structured error payloads without inspecting warning text", () => {
    const completion = buildCronAssistantCompletion(
      buildResult({ text: "ordinary-looking text", stopReason: "stop", calls: 1, isError: true }),
    );
    expect(completion.finalUserVisibleResult).toBe(false);
    expect(completion.toolResultAccepted).toBe(false);
  });
});
