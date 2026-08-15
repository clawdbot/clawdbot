import { describe, expect, it } from "vitest";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "./internal-events.js";

const MAX_CHILD_RESULT_CHARS = 6_000;
const CHILD_RESULT_TRUNCATION_NOTICE = "\n[child result truncated]";

function taskCompletionEvent(result: string): AgentInternalEvent {
  return {
    type: "task_completion",
    source: "subagent",
    childSessionKey: "agent:main:subagent:test",
    childSessionId: "child-session-id",
    announceType: "subagent task",
    taskLabel: "Inspect output",
    status: "ok",
    statusLabel: "completed; ready for parent review",
    result,
    replyInstruction: "Review the result.",
  };
}

function extractChildResult(prompt: string): string {
  const result = prompt.match(/<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/)?.[1];
  if (result === undefined) {
    throw new Error("Expected child result data block");
  }
  return result;
}

describe("agent internal events", () => {
  it("bounds protected and plain child-result projections after escaping", () => {
    const fullResult = `${"<".repeat(MAX_CHILD_RESULT_CHARS)}-unbounded-tail`;
    const event = taskCompletionEvent(fullResult);
    const protectedResult = extractChildResult(formatAgentInternalEventsForPrompt([event]));
    const plainResult = extractChildResult(formatAgentInternalEventsForPlainPrompt([event]));

    expect(protectedResult).toBe(plainResult);
    expect(protectedResult.length).toBeLessThanOrEqual(MAX_CHILD_RESULT_CHARS);
    expect(protectedResult.endsWith(CHILD_RESULT_TRUNCATION_NOTICE)).toBe(true);
    expect(protectedResult).not.toContain("unbounded-tail");
    expect(event.result).toBe(fullResult);
  });

  it("keeps ordinary child results unchanged", () => {
    const result = "small useful result";

    expect(
      extractChildResult(formatAgentInternalEventsForPrompt([taskCompletionEvent(result)])),
    ).toBe(result);
  });
});
