import { describe, expect, it } from "vitest";
import {
  createToolValidationErrorSummary,
  readToolValidationErrorSummary,
  summarizeToolValidationError,
} from "./tool-error-summary.js";

describe("createToolValidationErrorSummary", () => {
  it("builds a static summary without validator details", () => {
    expect(createToolValidationErrorSummary("edit")).toBe(
      "edit tool validation failed: invalid arguments",
    );
    expect(createToolValidationErrorSummary(" custom   tool ")).toBe(
      "custom tool tool validation failed: invalid arguments",
    );
  });

  it("rejects unsafe or oversized tool names", () => {
    expect(createToolValidationErrorSummary("edit\nsecret")).toBeUndefined();
    expect(createToolValidationErrorSummary("x".repeat(200))).toBeUndefined();
  });
});

describe("summarizeToolValidationError", () => {
  it("accepts only a boundary-prepared summary", () => {
    expect(
      summarizeToolValidationError({
        toolName: "edit",
        validationErrorSummary: "edit tool validation failed: invalid arguments",
        error:
          'Validation failed for tool "edit":\n  - secret-field: rejected-secret\n\nReceived arguments:\n{}',
      }),
    ).toBe("edit tool validation failed: invalid arguments");
    expect(
      summarizeToolValidationError({
        toolName: "edit",
        error:
          'Validation failed for tool "edit":\n  - secret-field: rejected-secret\n\nReceived arguments:\n{}',
      }),
    ).toBeUndefined();
  });
});

describe("readToolValidationErrorSummary", () => {
  it("accepts generated summaries and rejects unsafe boundary values", () => {
    expect(readToolValidationErrorSummary("edit tool validation failed: path: invalid")).toBe(
      "edit tool validation failed: path: invalid",
    );
    expect(readToolValidationErrorSummary("edit failed\nsecret")).toBeUndefined();
    expect(readToolValidationErrorSummary(`edit failed: ${"x".repeat(200)}`)).toBeUndefined();
  });
});
