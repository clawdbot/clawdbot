import { describe, expect, it } from "vitest";
import { isLikelyContextOverflowError } from "./classify.js";

describe("isLikelyContextOverflowError", () => {
  it("detects Codex promptError wording for a full context window", () => {
    expect(
      isLikelyContextOverflowError(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
    ).toBe(true);
  });

  it("does not mistake LM Studio prompt-template override guidance for overflow", () => {
    expect(
      isLikelyContextOverflowError(
        'Error rendering prompt with jinja template: "Cannot apply filter upper to type UndefinedValue". You can override the prompt template in model settings.',
      ),
    ).toBe(false);
  });
});
