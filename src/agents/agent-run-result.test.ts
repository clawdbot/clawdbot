import { describe, expect, it } from "vitest";
import { extractAgentRunTerminalError } from "./agent-run-result.js";

describe("agent run terminal error projection", () => {
  it.each([
    { name: "normal stop", meta: { stopReason: "stop" } },
    { name: "completed turn", meta: { stopReason: "completed" } },
    {
      name: "yielded turn",
      meta: { livenessState: "paused", yielded: true, stopReason: "end_turn" },
    },
  ])("accepts a healthy $name", ({ meta }) => {
    expect(
      extractAgentRunTerminalError({
        meta: { ...meta, finalAssistantVisibleText: "Done." },
      }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "CLI timeout",
      meta: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider" as const,
        providerStarted: true,
      },
      expected: "Inference timed out.",
    },
    {
      name: "CLI abort",
      meta: { aborted: true, stopReason: "aborted", providerStarted: true },
      expected: "agent run aborted",
    },
  ])("rejects a partial $name even without an error payload", ({ meta, expected }) => {
    expect(
      extractAgentRunTerminalError({
        payloads: [{ text: "I'll start checking." }],
        meta: { ...meta, finalAssistantVisibleText: "I'll start checking." },
      }),
    ).toBe(expected);
  });

  it("preserves the owner error before a secondary payload diagnostic", () => {
    expect(
      extractAgentRunTerminalError({
        payloads: [{ text: "Secondary failure", isError: true }],
        meta: { error: { kind: "incomplete_turn", message: "The owner failed." } },
      }),
    ).toBe("The owner failed.");
  });
});
