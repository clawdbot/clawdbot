import { describe, expect, it } from "vitest";
import { classifyFailoverReason, classifyFailoverSignal } from "./classify.js";

describe("request validation behind gateway status codes", () => {
  it.each(["400 Your input exceeds the context window of this model", "413 status code (no body)"])(
    "preserves canonical assistant overflow evidence: %s",
    (message) => {
      expect(classifyFailoverSignal({ message })).toEqual({ kind: "context_overflow" });
    },
  );

  it.each([404, 500, 502])("preserves request-validation semantics for HTTP %s", (status) => {
    expect(
      classifyFailoverSignal({
        status,
        message: `${status} Unknown parameter: 'logprobs'`,
        errorType: "invalid_request_error",
        code: "unknown_parameter",
      }),
    ).toEqual({ kind: "reason", reason: "format" });
    expect(
      classifyFailoverReason(
        `${status} {"error":{"type":"invalid_request_error","message":"Unsupported parameter: logprobs"}}`,
      ),
    ).toBe("format");
  });

  it.each([
    "timeout",
    "overloaded",
    "server_error",
    "rate_limit",
    "authentication",
    "context_length_exceeded",
  ])("keeps an explicit rejection of %s ahead of message patterns", (parameter) => {
    const error = {
      type: "invalid_request_error",
      code: "unknown_parameter",
      message: `Unsupported parameter: ${parameter}`,
    };
    expect(
      classifyFailoverSignal({
        status: 500,
        message: `500 ${error.message}`,
        errorType: error.type,
        code: error.code,
        details: [JSON.stringify(error)],
      }),
    ).toEqual({ kind: "reason", reason: "format" });
    for (const separator of [" ", ": "]) {
      expect(classifyFailoverReason(`502${separator}${JSON.stringify({ error })}`)).toBe("format");
    }
  });

  it.each([
    { status: 401, reason: "auth" },
    { status: 402, reason: "billing" },
    { status: 429, reason: "rate_limit" },
    { status: 499, reason: "timeout" },
    { status: 529, reason: "overloaded" },
  ])("preserves HTTP $status policy for validation-coded errors", ({ status, reason }) => {
    expect(
      classifyFailoverSignal({
        status,
        message: `${status} Unknown parameter: 'logprobs'`,
        errorType: "invalid_request_error",
        code: "unknown_parameter",
      }),
    ).toEqual({ kind: "reason", reason });
  });
});

describe("Claude CLI logged-out failures", () => {
  const loggedOutMessage = "Not logged in · Please run /login";

  it("classifies the logged-out response as auth only for claude-cli", () => {
    expect(classifyFailoverReason(loggedOutMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(loggedOutMessage, { provider: "openai" })).toBeNull();
    expect(classifyFailoverReason(loggedOutMessage)).toBeNull();
  });
});

describe("OAuth session expiry", () => {
  const expiredMessage = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("classifies OAuth expiry as auth only for claude-cli", () => {
    expect(classifyFailoverReason(expiredMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(expiredMessage, { provider: "custom-cli" })).toBe(
      "session_expired",
    );
    expect(classifyFailoverReason(expiredMessage)).toBe("session_expired");
  });
});
