// Memory Host SDK tests cover batch error utils behavior.
import { describe, expect, it } from "vitest";
import { extractBatchErrorMessage, formatUnavailableBatchError } from "../engine-embeddings.js";

describe("extractBatchErrorMessage", () => {
  it("returns the first top-level error message", () => {
    expect(
      extractBatchErrorMessage([
        { response: { body: { error: { message: "nested" } } } },
        { error: { message: "top-level" } },
      ]),
    ).toBe("nested");
  });

  it("falls back to nested response error message", () => {
    expect(
      extractBatchErrorMessage([{ response: { body: { error: { message: "nested-only" } } } }, {}]),
    ).toBe("nested-only");
  });

  it("accepts plain string response bodies", () => {
    expect(extractBatchErrorMessage([{ response: { body: "provider plain-text error" } }])).toBe(
      "provider plain-text error",
    );
  });
});

describe("formatUnavailableBatchError", () => {
  it("formats errors and non-error values", () => {
    expect(formatUnavailableBatchError(new Error("boom"))).toBe("error file unavailable: boom");
    expect(formatUnavailableBatchError("unreachable")).toBe("error file unavailable: unreachable");
  });

  it.each([
    {
      boundary: "leading",
      secret: `abcde😀${"x".repeat(9)}wxyz`,
      expected: "abcde...wxyz",
    },
    {
      boundary: "trailing",
      secret: `abcdef${"x".repeat(9)}😀abc`,
      expected: "abcdef...abc",
    },
    {
      boundary: "intact pairs",
      secret: `abcd😀${"x".repeat(9)}😀ab`,
      expected: "abcd😀...😀ab",
    },
    {
      boundary: "ASCII",
      secret: "abcdef1234567890ghij",
      expected: "abcdef...ghij",
    },
  ])("keeps exported $boundary token hints UTF-16 safe", ({ secret, expected }) => {
    const serialized = JSON.stringify({
      error: formatUnavailableBatchError(new Error(`API_TOKEN=${secret}`)),
    });
    const parsed = JSON.parse(serialized) as { error: string };

    expect(parsed.error).toBe(`error file unavailable: API_TOKEN=${expected}`);
    expect(parsed.error).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(serialized).not.toContain(secret);
  });
});
