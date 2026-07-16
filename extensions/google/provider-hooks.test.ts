import { describe, expect, it } from "vitest";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";

describe("GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason", () => {
  it.each([
    { provider: "google", code: "UNAVAILABLE", expected: "overloaded" },
    { provider: "google-vertex", code: "DEADLINE_EXCEEDED", expected: "timeout" },
    { provider: "google-antigravity", code: "INTERNAL", expected: "server_error" },
    { provider: "google-gemini-cli", code: "UNAVAILABLE", expected: "overloaded" },
  ] as const)("classifies $provider $code as $expected", ({ provider, code, expected }) => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({
        provider,
        errorMessage: "",
        code,
      }),
    ).toBe(expected);
  });

  it("leaves unknown codes for generic classification", () => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({
        provider: "google-vertex",
        errorMessage: "",
        code: "INSUFFICIENT_QUOTA",
      }),
    ).toBeUndefined();
  });
});
