// Memory Host SDK tests cover batch error utils behavior.
import { describe, expect, it } from "vitest";
import { extractBatchErrorMessage, formatUnavailableBatchError } from "./batch-error-utils.js";

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
});
