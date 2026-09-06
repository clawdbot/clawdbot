import { describe, expect, it } from "vitest";
import {
  isProgressOnlyCompletionText,
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("isProgressOnlyCompletionText", () => {
  // Genuine narration with no deliverable must stay classified as progress-only
  // so required completions still block on it.
  it.each([
    ["pure progress", "Let me run the tests"],
    ["narration that promises a later report", "I'll analyze the logs and report back"],
    ["future-tense verification", "I'm going to verify the fix"],
    ["conditional on whether tests pass", "I'll check whether the tests pass before continuing"],
    ["bare progress verb", "Investigating the gateway logs"],
  ])("treats %s as progress-only", (_label, text) => {
    expect(isProgressOnlyCompletionText(text)).toBe(true);
  });

  // A real final summary can open with progress narration but still carry a
  // result/report/verification marker; those must not be misclassified.
  it.each([
    [
      "single-sentence narration that lands a result",
      "Investigating the gateway logs revealed the crash and I patched the handler, tests passed",
    ],
    [
      "narration followed by a Verification marker",
      "I'll verify the fix. Verification: all 62 tests passed, 2 files changed.",
    ],
    [
      "progress-worded sentence carrying a result marker",
      "Verifying complete: all tests passed and lint passed.",
    ],
    [
      "explicit completion with section headers",
      "Done. Files changed: handler.js. Backup at /tmp. Rollback script created.",
    ],
    [
      "narration followed by a Result: header",
      "I'll start running the suite. Result: 3 files changed, all checks passed.",
    ],
  ])("does not treat %s as progress-only", (_label, text) => {
    expect(isProgressOnlyCompletionText(text)).toBe(false);
  });
});

describe("resolveRequiredCompletionTerminalResult", () => {
  it("blocks an empty required completion", () => {
    expect(resolveRequiredCompletionTerminalResult("")).toEqual({
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });
  });

  it("blocks a progress-only required completion", () => {
    expect(resolveRequiredCompletionTerminalResult("I'm going to verify the fix")).toEqual({
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
  });

  it("accepts a narration-prefixed completion that carries a result marker", () => {
    expect(
      resolveRequiredCompletionTerminalResult(
        "I'll verify the fix. Verification: all 62 tests passed, 2 files changed.",
      ),
    ).toEqual({});
  });
});

describe("task completion delivery failures", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );

    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
    expect(result.terminalSummary).not.toContain("\uD83D");
  });
});
