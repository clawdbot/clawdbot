import { describe, expect, it } from "vitest";
import { createLlmCompleteError } from "./runtime-llm-error.js";

describe("createLlmCompleteError", () => {
  it("creates a plain Error with the stable completion error fields and cause", () => {
    const cause = new Error("provider failed");
    const error = createLlmCompleteError("LLM_COMPLETION_FAILED", "Completion failed.", cause);

    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toMatchObject({
      name: "LlmCompleteError",
      code: "LLM_COMPLETION_FAILED",
      message: "Completion failed.",
      cause,
    });
    expect(error.cause).toBe(cause);
  });

  it("omits the cause property when no cause is supplied", () => {
    const error = createLlmCompleteError("LLM_COMPLETION_ABORTED", "Completion aborted.");

    expect(Object.hasOwn(error, "cause")).toBe(false);
  });
});
