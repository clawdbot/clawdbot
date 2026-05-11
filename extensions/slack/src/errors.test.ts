import { describe, expect, it } from "vitest";
import { formatSlackError } from "./errors.js";

describe("formatSlackError", () => {
  it("formats missing and unserializable values with fallback text", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatSlackError(undefined)).toBe("no error detail");
    expect(formatSlackError(null)).toBe("no error detail");
    expect(formatSlackError("")).toBe("no error detail");
    expect(formatSlackError(new Error(""))).toBe("Error");
    expect(formatSlackError(circular)).toBe('{"self":"[Circular]"}');
  });

  it("includes Slack platform error fields and response metadata", () => {
    const err = Object.assign(new Error("An API error occurred: missing_scope"), {
      code: "slack_webapi_platform_error",
      data: {
        error: "missing_scope",
        needed: "channels:write",
        provided: "chat:write,app_mentions:read",
        response_metadata: {
          scopes: ["chat:write", "app_mentions:read"],
          acceptedScopes: ["channels:write", "groups:write"],
          messages: ["[ERROR] missing required scope"],
        },
      },
    });

    expect(formatSlackError(err)).toBe(
      "An API error occurred: missing_scope; code: slack_webapi_platform_error; slack error: missing_scope; needed: channels:write; provided: chat:write,app_mentions:read; scopes: chat:write, app_mentions:read; accepted: channels:write, groups:write; slack message: [ERROR] missing required scope",
    );
  });

  it("uses the Slack SDK top-level retryAfter field for rate limit errors", () => {
    const err = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_rate_limited_error",
      retryAfter: 30,
    });

    expect(formatSlackError(err)).toBe(
      "rate limited; code: slack_webapi_rate_limited_error; retryAfter: 30",
    );
  });

  it("includes HTTP status details", () => {
    const err = Object.assign(new Error("http failed"), {
      code: "slack_webapi_http_error",
      statusCode: 429,
      statusMessage: "Too Many Requests",
      body: "slow down",
    });

    expect(formatSlackError(err)).toBe(
      "http failed; code: slack_webapi_http_error; statusCode: 429; statusMessage: Too Many Requests; body: slow down",
    );
  });

  it("redacts token-shaped values before returning", () => {
    const token = "xoxb-1234567890abcdef";
    const err = Object.assign(new Error(`Authorization: Bearer ${token}`), {
      code: "slack_webapi_platform_error",
      data: {
        error: "missing_scope",
        response_metadata: {
          messages: [`token ${token} lacked scope`],
        },
      },
    });

    const formatted = formatSlackError(err);
    expect(formatted).not.toContain(token);
    expect(formatted).toContain("Authorization: Bearer xoxb-1…cdef");
    expect(formatted).toContain("token xoxb-1…cdef lacked scope");
  });
});
