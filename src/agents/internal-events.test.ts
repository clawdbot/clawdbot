import { describe, expect, it } from "vitest";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "./internal-events.js";

const MAX_CHILD_RESULT_CHARS = 6_000;
const CHILD_RESULT_TRUNCATION_NOTICE = "\n[child result truncated]";
const MAX_STATUS_LABEL_CHARS = 500;
const STATUS_LABEL_TRUNCATION_MARKER = "…[truncated]";

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

function extractStatusLine(prompt: string): string {
  const status = prompt.match(/^status: (.*)$/m)?.[1];
  if (status === undefined) {
    throw new Error("Expected status line");
  }
  return status;
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

  it("bounds status labels carrying caller-supplied error text", () => {
    const event = {
      ...taskCompletionEvent("result"),
      status: "timeout",
      statusLabel: `timed out: ${"e".repeat(MAX_STATUS_LABEL_CHARS)}-unbounded-tail`,
    } satisfies AgentInternalEvent;
    const status = extractStatusLine(formatAgentInternalEventsForPrompt([event]));

    expect(status.length).toBeLessThanOrEqual(MAX_STATUS_LABEL_CHARS);
    expect(status.endsWith(STATUS_LABEL_TRUNCATION_MARKER)).toBe(true);
    expect(status).not.toContain("unbounded-tail");
    expect(status.startsWith("timed out: ")).toBe(true);
  });

  it("never splits a surrogate pair when truncating a status label", () => {
    // Land an astral character exactly on the truncation boundary.
    const marker = STATUS_LABEL_TRUNCATION_MARKER;
    const keep = MAX_STATUS_LABEL_CHARS - marker.length;
    const event = {
      ...taskCompletionEvent("result"),
      status: "timeout",
      statusLabel: `${"a".repeat(keep - 1)}\u{1F600}${"b".repeat(50)}`,
    } satisfies AgentInternalEvent;
    const status = extractStatusLine(formatAgentInternalEventsForPrompt([event]));

    expect(status.length).toBeLessThanOrEqual(MAX_STATUS_LABEL_CHARS);
    expect(status.endsWith(marker)).toBe(true);
    const truncated = status.slice(0, -marker.length);
    // A dangling high surrogate would make this false.
    expect(truncated).toBe(truncated.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ""));
    expect(truncated.includes("\uFFFD")).toBe(false);
  });

  it("keeps ordinary status labels unchanged", () => {
    const event = {
      ...taskCompletionEvent("result"),
      status: "error",
      statusLabel: "failed: model returned no output",
    } satisfies AgentInternalEvent;

    expect(extractStatusLine(formatAgentInternalEventsForPrompt([event]))).toBe(
      "failed: model returned no output",
    );
  });
});
