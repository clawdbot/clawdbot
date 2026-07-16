import { describe, expect, it } from "vitest";
import { isFeishuBackoffError, getBackoffCodeFromResponse, FeishuBackoffError } from "./typing.js";

describe("isFeishuBackoffError", () => {
  it("returns true for HTTP 429 (AxiosError shape)", () => {
    const err = { response: { status: 429, data: {} } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for Feishu quota exceeded code 99991403", () => {
    const err = { response: { status: 200, data: { code: 99991403 } } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for Feishu rate limit code 99991400", () => {
    const err = { response: { status: 200, data: { code: 99991400 } } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for SDK error with code 429", () => {
    const err = { code: 429, message: "too many requests" };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for SDK error with top-level code 99991403", () => {
    const err = { code: 99991403, message: "quota exceeded" };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns false for other HTTP errors (e.g. 500)", () => {
    const err = { response: { status: 500, data: {} } };
    expect(isFeishuBackoffError(err)).toBe(false);
  });

  it("returns false for non-rate-limit Feishu codes", () => {
    const err = { response: { status: 200, data: { code: 99991401 } } };
    expect(isFeishuBackoffError(err)).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isFeishuBackoffError(new Error("network timeout"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFeishuBackoffError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFeishuBackoffError(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isFeishuBackoffError("429")).toBe(false);
  });

  it("returns true for 429 even without data", () => {
    const err = { response: { status: 429 } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });
});

describe("getBackoffCodeFromResponse", () => {
  it("returns backoff code for response with quota exceeded code", () => {
    const response = { code: 99991403, msg: "quota exceeded", data: null };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns backoff code for response with rate limit code", () => {
    const response = { code: 99991400, msg: "rate limit", data: null };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns backoff code for response with code 429", () => {
    const response = { code: 429, msg: "too many requests", data: null };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns undefined for successful response (code 0)", () => {
    const response = { code: 0, msg: "success", data: { reaction_id: "r1" } };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });

  it("returns undefined for other error codes", () => {
    const response = { code: 99991401, msg: "other error", data: null };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(getBackoffCodeFromResponse(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getBackoffCodeFromResponse(undefined)).toBeUndefined();
  });

  it("returns undefined for response without code field", () => {
    const response = { data: { reaction_id: "r1" } };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });
});

describe("FeishuBackoffError", () => {
  it("is detected by isFeishuBackoffError via .code property", () => {
    const err = new FeishuBackoffError(99991403);
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("is detected for rate limit code 99991400", () => {
    const err = new FeishuBackoffError(99991400);
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("has correct name and message", () => {
    const err = new FeishuBackoffError(99991403);
    expect(err.name).toBe("FeishuBackoffError");
    expect(err.message).toBe("Feishu API backoff: code 99991403");
    expect(err.code).toBe(99991403);
  });

  it("is an instance of Error", () => {
    const err = new FeishuBackoffError(99991403);
    expect(err instanceof Error).toBe(true);
  });

  it("survives catch-and-rethrow pattern", () => {
    // Simulates the exact pattern in addTypingIndicator/removeTypingIndicator:
    // thrown inside try, caught by catch, isFeishuBackoffError must match
    let caught: unknown;
    try {
      try {
        throw new FeishuBackoffError(99991403);
      } catch (err) {
        if (isFeishuBackoffError(err)) {
          throw err; // re-thrown — this is the fix
        }
        // would be silently swallowed with plain Error
        caught = "swallowed";
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FeishuBackoffError);
  });
});
