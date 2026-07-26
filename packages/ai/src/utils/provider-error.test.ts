import { describe, expect, it } from "vitest";
import { formatProviderError } from "./provider-error.js";

describe("formatProviderError", () => {
  it.each([
    {
      name: "JSON body",
      error: Object.assign(new Error("403 status code (no body)"), {
        status: 403,
        error: { message: "blocked by gateway" },
      }),
      expected: '403: {"message":"blocked by gateway"}',
    },
    {
      name: "text body",
      error: Object.assign(new Error("502 status code (no body)"), {
        status: 502,
        body: "proxy unavailable",
      }),
      expected: "502: proxy unavailable",
    },
    {
      name: "no body",
      error: Object.assign(new Error("503 status code (no body)"), { status: 503 }),
      expected: "503 status code (no body)",
    },
  ])("formats an HTTP error with $name", ({ error, expected }) => {
    expect(formatProviderError(error)).toBe(expected);
  });

  it("preserves an SDK message that already contains the response body", () => {
    const body = '{"error":{"message":"permission denied"}}';
    const error = Object.assign(new Error(body), { status: 403, body });

    expect(formatProviderError(error)).toBe(body);
  });

  it("does not split surrogate pairs when truncating response bodies", () => {
    const body = `${"x".repeat(3999)}😀tail`;
    const error = Object.assign(new Error("502 status code (no body)"), { status: 502, body });

    expect(formatProviderError(error)).toBe(`502: ${"x".repeat(3999)}... [truncated]`);
  });
});
