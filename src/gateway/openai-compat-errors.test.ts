// OpenAI-compatible failover error mapping keeps public responses sanitized.
import { describe, expect, it } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import { resolveOpenAiCompatError } from "./openai-compat-errors.js";

describe("resolveOpenAiCompatError", () => {
  it("renders sensitive-output failures with safe copy instead of raw provider text", () => {
    const mapped = resolveOpenAiCompatError(
      new FailoverError("LLM request failed: provider rejected sensitive output.", {
        reason: "sensitive_output",
        status: 400,
        rawError: "400 output new_sensitive: redacted provider payload",
      }),
    );

    expect(mapped).toEqual({
      status: 400,
      error: {
        message: "provider rejected sensitive output",
        type: "invalid_request_error",
      },
    });
  });
});
