// Tests shared subagent command text extraction and assistant marker cleanup.
import { describe, expect, it } from "vitest";
import { extractMessageText } from "./commands-subagents-text.js";

describe("extractMessageText", () => {
  it("preserves user markers and sanitizes assistant markers", () => {
    const cases = [
      {
        message: { role: "user", content: "Here [Tool Call: foo (ID: 1)] ok" },
        expectedText: "Here [Tool Call: foo (ID: 1)] ok",
      },
      {
        message: { role: "assistant", content: "Here [Tool Call: foo (ID: 1)] ok" },
        expectedText: "Here ok",
      },
    ] as const;

    for (const testCase of cases) {
      const result = extractMessageText(testCase.message);
      expect(result?.text).toBe(testCase.expectedText);
    }
  });
});
