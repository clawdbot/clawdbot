// Retry hint tests cover user-facing guidance for failed cron retry timing.
import { describe, expect, it } from "vitest";
import { resolveCronExecutionRetryHint } from "./retry-hint.js";

describe("resolveCronExecutionRetryHint", () => {
  it("matches classified transient errors", () => {
    expect(resolveCronExecutionRetryHint("HTTP 529", ["overloaded"])).toEqual({
      retryable: true,
      category: "overloaded",
    });
    expect(resolveCronExecutionRetryHint("429 rate limit exceeded", ["rate_limit"])).toEqual({
      retryable: true,
      category: "rate_limit",
    });
  });

  it("treats common network error codes as network when retryOn only includes network", () => {
    for (const code of [
      "EAI_AGAIN",
      "ENETDOWN",
      "EHOSTUNREACH",
      "EHOSTDOWN",
      "ENETRESET",
      "ENETUNREACH",
      "EPIPE",
    ]) {
      expect(resolveCronExecutionRetryHint(`temporary DNS failure: ${code}`, ["network"])).toEqual({
        retryable: true,
        category: "network",
      });
    }
  });

  it("does not retry permanent errors", () => {
    expect(resolveCronExecutionRetryHint("invalid API key", ["network"])).toEqual({
      retryable: false,
    });
  });

  it("does not classify bare 5xx-looking numbers as server_error", () => {
    for (const message of [
      "context limit 512 exceeded",
      "process exited with 503 lines of output",
      "ENOENT: no such file '/var/run/app-540.sock'",
      "killed worker pid 511 after deadline",
      "assertion failed: expected 500 got 0",
      "error 500 got 0",
      "process exited with code 500",
    ]) {
      expect(resolveCronExecutionRetryHint(message, ["server_error"])).toEqual({
        retryable: false,
      });
    }
  });

  it("classifies genuine HTTP 5xx errors as server_error", () => {
    for (const message of [
      "HTTP 503 Service Unavailable",
      "received status 500 from upstream",
      "500 Internal Server Error",
      "502 Bad Gateway",
      "upstream returned 5xx",
      "response code: 502",
      "503",
      "500",
    ]) {
      expect(resolveCronExecutionRetryHint(message, ["server_error"])).toEqual({
        retryable: true,
        category: "server_error",
      });
    }
  });
});
