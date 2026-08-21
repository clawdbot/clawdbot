// Pins the no-visible-result gate to the typed fact on the completion event
// rather than to the placeholder wording rendered for the parent.
import { describe, expect, it } from "vitest";
import { createTaskCompletionEvent } from "../../subagent-test-fixtures.test-helpers.js";
import { hasFailedSubagentNoOutputCompletion } from "./subagent-announce-completion-delivery.js";

describe("hasFailedSubagentNoOutputCompletion", () => {
  it("reports a failed completion that recorded no visible result", () => {
    expect(
      hasFailedSubagentNoOutputCompletion([
        createTaskCompletionEvent({
          status: "error",
          statusLabel: "failed: all models failed",
          result: "(no output)",
          noVisibleResult: true,
        }),
      ]),
    ).toBe(true);
  });

  it("still reports it after the placeholder copy is reworded", () => {
    expect(
      hasFailedSubagentNoOutputCompletion([
        createTaskCompletionEvent({
          status: "error",
          statusLabel: "failed: all models failed",
          result: "(nothing to report)",
          noVisibleResult: true,
        }),
      ]),
    ).toBe(true);
  });

  it("does not report a failed completion whose result only reads like the placeholder", () => {
    expect(
      hasFailedSubagentNoOutputCompletion([
        createTaskCompletionEvent({
          status: "error",
          statusLabel: "failed: all models failed",
          result: "(no output)",
        }),
      ]),
    ).toBe(false);
  });

  it("ignores a successful completion that recorded no visible result", () => {
    expect(
      hasFailedSubagentNoOutputCompletion([
        createTaskCompletionEvent({ status: "ok", result: "(no output)", noVisibleResult: true }),
      ]),
    ).toBe(false);
  });

  it("ignores non-subagent sources that recorded no visible result", () => {
    expect(
      hasFailedSubagentNoOutputCompletion([
        createTaskCompletionEvent({
          source: "image_generation",
          status: "error",
          result: "(no output)",
          noVisibleResult: true,
        }),
      ]),
    ).toBe(false);
  });

  it("reports nothing for an absent or empty event list", () => {
    expect(hasFailedSubagentNoOutputCompletion(undefined)).toBe(false);
    expect(hasFailedSubagentNoOutputCompletion([])).toBe(false);
  });
});
