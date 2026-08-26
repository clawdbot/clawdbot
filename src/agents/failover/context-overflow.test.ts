import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isContextOverflowError,
  isLikelyContextOverflowError,
} from "./classify.js";

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

// Groq states both numbers in the refusal, so the two shapes are separable by wording alone.
const GROQ_OVERSIZED_REQUEST_413 =
  "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
  "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
  "please reduce your message size and try again.";
const GROQ_THROTTLED_REQUEST_429 =
  "429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` " +
  "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7500, " +
  "Requested 1000, please try again in 3.5s.";

describe("provider request-size ceilings worded as TPM limits", () => {
  it("treats a request larger than the whole token limit as overflow", () => {
    expect(isContextOverflowError(GROQ_OVERSIZED_REQUEST_413)).toBe(true);
    expect(isLikelyContextOverflowError(GROQ_OVERSIZED_REQUEST_413)).toBe(true);
    expect(classifyFailoverReason(GROQ_OVERSIZED_REQUEST_413)).toBe("context_overflow");
  });

  it("keeps ordinary TPM throttling a rate limit when the request fits the limit", () => {
    expect(isContextOverflowError(GROQ_THROTTLED_REQUEST_429)).toBe(false);
    expect(isLikelyContextOverflowError(GROQ_THROTTLED_REQUEST_429)).toBe(false);
    expect(classifyFailoverReason(GROQ_THROTTLED_REQUEST_429)).toBe("rate_limit");
  });

  it.each([
    ["states neither size", "413 request too large: 203557 tokens per minute (TPM)"],
    [
      "states a limit but no requested size",
      "413 Request too large on tokens per minute (TPM): Limit 8000, please reduce your message size.",
    ],
  ])("keeps a TPM refusal that %s a rate limit", (_name, message) => {
    expect(isContextOverflowError(message)).toBe(false);
    expect(isLikelyContextOverflowError(message)).toBe(false);
    expect(classifyFailoverReason(message)).toBe("rate_limit");
  });
});
