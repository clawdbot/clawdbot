import { describe, expect, it } from "vitest";
import {
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  extractProviderWrappedHttpStatus,
  formatProviderRefusalText,
  formatRawAssistantErrorForUi,
  parseApiErrorInfo,
} from "./assistant-error-format.js";

describe("formatProviderRefusalText", () => {
  it.each(["bio", "cyber"])("formats a sanitized %s refusal", (category) => {
    expect(
      formatProviderRefusalText({
        diagnostics: [{ type: "provider_refusal", details: { category } }],
      }),
    ).toBe(
      `The provider refused this request (category: ${category}). Revise the request and try again.`,
    );
  });
});

describe("extractLeadingHttpStatus", () => {
  it("accepts status codes in the valid HTTP range 100-599", () => {
    expect(extractLeadingHttpStatus("100 everything is fine")).toEqual({
      code: 100,
      rest: "everything is fine",
    });
    expect(extractLeadingHttpStatus("500 internal error")).toEqual({
      code: 500,
      rest: "internal error",
    });
    expect(extractLeadingHttpStatus("599 something rest")).toEqual({
      code: 599,
      rest: "something rest",
    });
  });

  it("rejects 3-digit sequences outside the HTTP status code range", () => {
    // 000 / 099 / 999 / 600 — the regex would capture these as 3-digit
    // numbers, but they are not valid HTTP statuses and should not be
    // surfaced as "HTTP <code>" in user-visible messages or in retry
    // classification.
    expect(extractLeadingHttpStatus("000 something")).toBeNull();
    expect(extractLeadingHttpStatus("099 something")).toBeNull();
    expect(extractLeadingHttpStatus("600 something")).toBeNull();
    expect(extractLeadingHttpStatus("999 something")).toBeNull();
  });

  it("rejects strings that do not start with a 3-digit HTTP status", () => {
    expect(extractLeadingHttpStatus("no status here")).toBeNull();
    expect(extractLeadingHttpStatus("")).toBeNull();
  });
});

describe("extractProviderWrappedHttpStatus", () => {
  it("accepts provider-wrapped statuses inside the valid HTTP range", () => {
    expect(extractProviderWrappedHttpStatus("OpenAI API error (503): service down")).toEqual({
      code: 503,
      rest: "service down",
    });
    expect(extractProviderWrappedHttpStatus("API error (429): rate limited")).toEqual({
      code: 429,
      rest: "rate limited",
    });
  });

  it("rejects provider-wrapped statuses outside the valid HTTP range", () => {
    expect(extractProviderWrappedHttpStatus("API error (000): something")).toBeNull();
    expect(extractProviderWrappedHttpStatus("API error (999): something")).toBeNull();
    expect(extractProviderWrappedHttpStatus("API error (600): something")).toBeNull();
  });
});

describe("extractErrorHttpStatus", () => {
  it.each([
    ["HTTP 429 too many requests", 429],
    ["OpenAI API error (500): upstream failed", 500],
    ["error, status code: 400, message: invalid request", 400],
    ["unexpected status 503 from upstream", 503],
    ["Error: HTTP status: 504, gateway timeout", 504],
  ])("extracts guarded status from %s", (message, code) => {
    expect(extractErrorHttpStatus(message)?.code).toBe(code);
  });

  it.each([
    "request id req-4291 failed",
    "input length 14295 tokens exceeds the model limit",
    "model model-x-500-preview not found",
    "Image width 500 exceeds the maximum allowed size",
  ])("rejects embedded numeric text: %s", (message) => {
    expect(extractErrorHttpStatus(message)).toBeNull();
  });
});

describe("HTTP status consumers", () => {
  it("does not return raw HTML after an HTTP reason phrase", () => {
    const raw = [
      "HTTP 502 Bad Gateway",
      "",
      "<!doctype html><html><body><h1>502</h1></body></html>",
    ].join("\n");

    expect(formatRawAssistantErrorForUi(raw)).toBe(
      "The AI service is temporarily unavailable (HTTP 502). Please try again in a moment.",
    );
  });

  it("formats only status lines inside the HTTP range", () => {
    expect(formatRawAssistantErrorForUi("100 Continue")).toBe("HTTP 100: Continue");
    expect(formatRawAssistantErrorForUi("599 Provider Error")).toBe("HTTP 599: Provider Error");
    expect(formatRawAssistantErrorForUi("000 Invalid")).toBe("000 Invalid");
    expect(formatRawAssistantErrorForUi("600 Invalid")).toBe("600 Invalid");
    expect(formatRawAssistantErrorForUi("999 Invalid")).toBe("999 Invalid");
  });

  it("does not attach invalid status prefixes to API payloads", () => {
    const payload = '{"type":"error","error":{"type":"server_error","message":"Provider failed."}}';

    expect(parseApiErrorInfo(`599 ${payload}`)).toMatchObject({
      httpCode: "599",
      type: "server_error",
      message: "Provider failed.",
    });
    expect(formatRawAssistantErrorForUi(`599 ${payload}`)).toBe(
      "HTTP 599 server_error: Provider failed.",
    );

    for (const code of ["000", "600", "999"]) {
      expect(parseApiErrorInfo(`${code} ${payload}`)).toBeNull();
      expect(formatRawAssistantErrorForUi(`${code} ${payload}`)).toBe(`${code} ${payload}`);
    }
  });
});
