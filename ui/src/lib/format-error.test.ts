// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatUiError } from "./format-error.ts";

describe("formatUiError", () => {
  it("formats structured causes through the browser-safe redactor", () => {
    const cause = Object.assign(new Error("OPENAI_API_KEY=sk-1234567890abcdef"), {
      code: "AUTH_FAILED",
    });

    expect(formatUiError(new Error("request failed", { cause }))).toBe(
      "request failed | OPENAI_API_KEY=sk-123...cdef | AUTH_FAILED",
    );
  });

  it("uses the fallback only when formatting produces an empty message", () => {
    expect(formatUiError("", "Request failed")).toBe("Request failed");
    expect(formatUiError("")).toBe("");
    expect(formatUiError(undefined, "Request failed")).toBe("undefined");
  });
});
