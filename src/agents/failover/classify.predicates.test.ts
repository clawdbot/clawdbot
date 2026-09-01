// Covers message predicates whose truth values intentionally differ from the central outcome.
import { describe, expect, it } from "vitest";
import { isTransientHttpError } from "./classification-rules.js";
import {
  classifyFailoverReason,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isContextOverflowError,
  isFailoverErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { isAuthPermanentErrorMessage } from "./message-patterns.js";

const PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE = "Proxy notice: Status: Internal Server Error";
const MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE = `${PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE}; upstream connect error`;
const INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE = `${PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE}; code:500`;
function expectMessageMatches(
  matcher: (message: string) => boolean,
  samples: readonly string[],
  expected: boolean,
) {
  // Keep table cases terse while still showing the sample that failed.
  for (const sample of samples) {
    expect(matcher(sample), sample).toBe(expected);
  }
}

function expectTimeoutFailoverSamples(samples: readonly string[]) {
  // Timeout samples must agree across the raw matcher, failover classifier, and
  // broader failover predicate.
  for (const sample of samples) {
    expect(isTimeoutErrorMessage(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBe("timeout");
    expect(isFailoverErrorMessage(sample)).toBe(true);
  }
}

function expectNotFailoverSample(sample: string) {
  expect(isTimeoutErrorMessage(sample)).toBe(false);
  expect(classifyFailoverReason(sample)).toBeNull();
  expect(isFailoverErrorMessage(sample)).toBe(false);
}

describe("isAuthPermanentErrorMessage", () => {
  it.each([
    {
      name: "matches permanent auth failure patterns",
      samples: [
        "api key revoked",
        "api key deactivated",
        "key has been disabled",
        "key has been revoked",
        "account has been deactivated",
        "OAuth authentication is currently not allowed for this organization",
        "API_KEY_REVOKED",
        "api_key_deleted",
        "deactivated_workspace",
        "deactivated workspace",
      ],
      expected: true,
    },
    {
      name: "does not match transient auth errors",
      samples: [
        "invalid_api_key",
        "permission_error",
        "unauthorized",
        "invalid token",
        "authentication failed",
        "forbidden",
        "access denied",
        "token has expired",
      ],
      expected: false,
    },
  ])("$name", ({ samples, expected }) => {
    expectMessageMatches(isAuthPermanentErrorMessage, samples, expected);
  });
});

describe("isAuthErrorMessage", () => {
  it.each([
    'No credentials found for profile "anthropic:default".',
    "No API key found for profile openai.",
    "invalid_api_key",
    "permission_error",
    "OAuth token refresh failed for anthropic: Failed to refresh OAuth token for anthropic. Please try again or re-authenticate.",
    "Please re-authenticate to continue.",
    "could not authenticate api key",
    "could not validate credentials",
    "Failed to extract accountId from token",
  ])("matches auth errors for %j", (sample) => {
    expect(isAuthErrorMessage(sample)).toBe(true);
  });
});

describe("isBillingErrorMessage", () => {
  it.each([
    {
      name: "matches credit and payment failures",
      samples: [
        "Your credit balance is too low to access the Anthropic API.",
        "insufficient credits",
        "Payment Required",
        "HTTP 402 Payment Required",
        "plans & billing",
        "Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits.",
        "This model requires more credits to use",
        "This endpoint require more credits",
        "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
        "Extra usage is required for long context requests.",
      ],
      expected: true,
    },
    {
      name: "does not false-positive on issue ids and numeric references",
      samples: [
        "Fixed issue CHE-402 in the latest release",
        "See ticket #402 for details",
        "ISSUE-402 has been resolved",
        "Room 402 is available",
        "Error code 403 was returned, not 402-related",
        "The building at 402 Main Street",
        "processed 402 records",
        "402 items found in the database",
        "port 402 is open",
        "Use a 402 stainless bolt",
        "Book a 402 room",
        "There is a 402 near me",
      ],
      expected: false,
    },
    {
      name: "still matches real HTTP 402 billing errors",
      samples: [
        "HTTP 402 Payment Required",
        "status: 402",
        "error code 402",
        "http 402",
        "status=402 payment required",
        "got a 402 from the API",
        "returned 402",
        "received a 402 response",
        '{"status":402,"type":"error"}',
        '{"code":402,"message":"payment required"}',
        '{"error":{"code":402,"message":"billing hard limit reached"}}',
      ],
      expected: true,
    },
  ])("$name", ({ samples, expected }) => {
    expectMessageMatches(isBillingErrorMessage, samples, expected);
  });

  it("does not false-positive on long assistant responses mentioning billing keywords", () => {
    // Simulate a multi-paragraph assistant response that mentions billing terms.
    const longResponse =
      "Sure! Here's how to set up billing for your SaaS application.\n\n" +
      "## Payment Integration\n\n" +
      "First, you'll need to configure your payment gateway. Most providers offer " +
      "a dashboard where you can manage credits, view invoices, and upgrade your plan. " +
      "The billing page typically shows your current balance and payment history.\n\n" +
      "## Managing Credits\n\n" +
      "Users can purchase credits through the billing portal. When their credit balance " +
      "runs low, send them a notification to upgrade their plan or add more credits. " +
      "You should also handle insufficient balance cases gracefully.\n\n" +
      "## Subscription Plans\n\n" +
      "Offer multiple plan tiers with different features. Allow users to upgrade or " +
      "downgrade their plan at any time. Make sure the billing cycle is clear.\n\n" +
      "Let me know if you need more details on any of these topics!";
    expect(longResponse.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(longResponse)).toBe(false);
  });
  it("does not false-positive on short non-billing text that mentions insufficient and balance", () => {
    const sample = "The evidence is insufficient to reconcile the final balance after compaction.";
    expect(isBillingErrorMessage(sample)).toBe(false);
    expect(classifyFailoverReason(sample)).toBeNull();
  });
  it("matches insufficient_balance snake_case error codes (#74079)", () => {
    expect(isBillingErrorMessage("insufficient_balance")).toBe(true);
    expect(classifyFailoverReason("insufficient_balance")).toBe("billing");
  });
  it("matches 'Insufficient MBT balance' with intervening words (#74079)", () => {
    const msg = "Insufficient MBT balance. Top up or upgrade your subscription to continue.";
    expect(isBillingErrorMessage(msg)).toBe(true);
    expect(classifyFailoverReason(msg)).toBe("billing");
  });
  it("matches provider spending-limit exhaustion messages", () => {
    // Provider wording often omits HTTP 402 while still describing a billing
    // exhaustion state that should route to billing copy/failover.
    const msg =
      "Your team has either used all available credits or reached its monthly spending limit.";
    expect(isBillingErrorMessage(msg)).toBe(true);
    expect(classifyFailoverReason(msg)).toBe("billing");
  });
  it("classifies flat JSON billing payloads with string error code (#74079)", () => {
    const raw =
      '{"error":"insufficient_balance","message":"Insufficient MBT balance. Top up or upgrade your subscription to continue.","upgradeUrl":"/settings/billing"}';
    expect(isBillingErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("billing");
  });
  it("still matches explicit 402 markers in long payloads", () => {
    const longStructuredError =
      '{"error":{"code":402,"message":"payment required","details":"' + "x".repeat(700) + '"}}';
    expect(longStructuredError.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(longStructuredError)).toBe(true);
  });
  it("does not match long numeric text that is not a billing error", () => {
    const longNonError =
      "Quarterly report summary: subsystem A returned 402 records after retry. " +
      "This is an analytics count, not an HTTP/API billing failure. " +
      "Notes: " +
      "x".repeat(700);
    expect(longNonError.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(longNonError)).toBe(false);
  });

  it("prefers billing when API-key and 402 hints both appear", () => {
    const sample =
      "402 Payment Required: The account associated with this API key has reached its maximum allowed monthly spending limit.";
    expect(isBillingErrorMessage(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBe("billing");
  });

  it("classifies Anthropic extra-usage exhaustion variants as billing", () => {
    const samples = [
      "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      "Extra usage is required for long context requests.",
      "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.",
      '{"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
      '{"type":"error","error":{"type":"invalid_request_error","message":"Extra usage is required for long context requests."}}',
    ];

    for (const sample of samples) {
      expect(isBillingErrorMessage(sample)).toBe(true);
      expect(classifyFailoverReason(sample, { provider: "anthropic" })).toBe("billing");
    }
  });
});

describe("isCloudCodeAssistFormatError", () => {
  it("matches format errors", () => {
    expectMessageMatches(
      isCloudCodeAssistFormatError,
      [
        "INVALID_REQUEST_ERROR: string should match pattern",
        "messages.1.content.1.tool_use.id",
        "tool_use.id should match pattern",
        "invalid request format",
      ],
      true,
    );
  });
});

describe("error classifiers", () => {
  it("ignore unrelated errors", () => {
    const checks: Array<{
      matcher: (message: string) => boolean;
      samples: string[];
    }> = [
      {
        matcher: isAuthErrorMessage,
        samples: ["rate limit exceeded", "billing issue detected"],
      },
      {
        matcher: isBillingErrorMessage,
        samples: ["rate limit exceeded", "invalid api key", "context length exceeded"],
      },
      {
        matcher: isCloudCodeAssistFormatError,
        samples: [
          "rate limit exceeded",
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
        ],
      },
      {
        matcher: isContextOverflowError,
        samples: [
          "rate limit exceeded",
          "request size exceeds upload limit",
          "model not found",
          "authentication failed",
        ],
      },
    ];

    for (const check of checks) {
      for (const sample of check.samples) {
        expect(check.matcher(sample)).toBe(false);
      }
    }
  });
});

describe("isTransientHttpError", () => {
  it("returns true for retryable 5xx status codes", () => {
    expect(isTransientHttpError("499 Client Closed Request")).toBe(true);
    expect(isTransientHttpError("500 Internal Server Error")).toBe(true);
    expect(isTransientHttpError("502 Bad Gateway")).toBe(true);
    expect(isTransientHttpError("503 Service Unavailable")).toBe(true);
    expect(isTransientHttpError("504 Gateway Timeout")).toBe(true);
    expect(isTransientHttpError("521 <!DOCTYPE html><html></html>")).toBe(true);
    expect(isTransientHttpError("529 Overloaded")).toBe(true);
  });

  it("returns false for non-retryable or non-http text", () => {
    expect(isTransientHttpError("429 Too Many Requests")).toBe(false);
    expect(isTransientHttpError("network timeout")).toBe(false);
  });
});

describe("isFailoverErrorMessage", () => {
  it("matches auth/rate/billing/timeout", () => {
    const samples = [
      "invalid api key",
      "429 rate limit exceeded",
      "Your credit balance is too low",
      "request timed out",
      "Connection error.",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });

  it("matches abort stop-reason timeout variants", () => {
    // Bare `error` stop reasons are provider-completed failures (#109218), not hangs.
    expectTimeoutFailoverSamples([
      "Unhandled stop reason: abort",
      "stop reason: abort",
      "reason: abort",
    ]);
  });

  it("matches AbortError / stream-abort messages as timeout (#58315)", () => {
    expectTimeoutFailoverSamples([
      "The operation was aborted",
      "This operation was aborted",
      "the operation was aborted",
      "stream closed",
      "stream was closed",
      "stream aborted",
      "stream was aborted",
    ]);
  });

  it("matches Gemini MALFORMED_RESPONSE stop reason as timeout (#42149)", () => {
    expectTimeoutFailoverSamples([
      "Unhandled stop reason: MALFORMED_RESPONSE",
      "Unhandled stop reason: malformed_response",
      "stop reason: MALFORMED_RESPONSE",
    ]);
  });

  it("matches network errno codes in serialized error messages", () => {
    expectTimeoutFailoverSamples([
      "Error: connect ETIMEDOUT 10.0.0.1:443",
      "Error: connect ESOCKETTIMEDOUT 10.0.0.1:443",
      "Error: connect EHOSTUNREACH 10.0.0.1:443",
      "Error: connect ENETUNREACH 10.0.0.1:443",
      "Error: write EPIPE",
      "Error: read ENETRESET",
      "Error: connect EHOSTDOWN 192.168.1.1:443",
    ]);
  });

  it("matches z.ai network_error stop reason as timeout", () => {
    expectTimeoutFailoverSamples([
      "Unhandled stop reason: network_error",
      "stop reason: network_error",
      "reason: network_error",
    ]);
  });

  it("matches Provider finish_reason: network_error as timeout (#61281)", () => {
    expectTimeoutFailoverSamples([
      "Provider finish_reason: network_error",
      "Provider finish_reason: abort",
      "Provider finish_reason: malformed_response",
    ]);
  });

  it("classifies Provider finish_reason: error as server_error, not timeout (#109218)", () => {
    // OpenRouter/Google can complete quickly with finish_reason:error; that is a
    // provider-completed failure, not a hung request. Fallback must remain eligible.
    const samples = [
      "Provider finish_reason: error",
      "finish_reason: error",
      "stop reason: error",
      "Unhandled stop reason: error",
    ];
    for (const sample of samples) {
      expect(isTimeoutErrorMessage(sample)).toBe(false);
      expect(classifyFailoverReason(sample)).toBe("server_error");
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });

  it("does not classify MALFORMED_FUNCTION_CALL as timeout", () => {
    const sample = "Unhandled stop reason: MALFORMED_FUNCTION_CALL";
    expect(isTimeoutErrorMessage(sample)).toBe(false);
    expect(classifyFailoverReason(sample)).toBe(null);
    expect(isFailoverErrorMessage(sample)).toBe(false);
  });

  it("matches google INTERNAL status errors as timeout", () => {
    const sample =
      "provider=google model=gemini-3.1-flash-lite-preview got status: INTERNAL upstream failure code:500";
    expect(isTimeoutErrorMessage(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBe("timeout");
    expect(isFailoverErrorMessage(sample)).toBe(true);
  });

  it("does not treat plain status text with internal-server-error wording as timeout", () => {
    expectNotFailoverSample(PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE);
  });

  it("keeps mixed upstream server errors retryable when they also mention status prose", () => {
    expect(isTimeoutErrorMessage(MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe(false);
    expect(classifyFailoverReason(MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe("timeout");
    expect(isFailoverErrorMessage(MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe(true);
  });

  it("keeps status prose retryable when it is explicitly paired with code 500", () => {
    expect(isTimeoutErrorMessage(INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE)).toBe(false);
    expect(classifyFailoverReason(INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE)).toBe("timeout");
    expect(isFailoverErrorMessage(INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE)).toBe(true);
  });

  it("matches bare undici transport failures as timeout (#69368)", () => {
    expectTimeoutFailoverSamples([
      "terminated",
      "Terminated",
      "  terminated  ",
      "stream_read_error",
      "  stream_read_error  ",
      "UND_ERR_SOCKET",
      "Error: UND_ERR_SOCKET other side closed",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_ABORTED",
      "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    ]);
  });

  it("matches shared model runtime openai bare transport failures as timeout (#69368)", () => {
    expectTimeoutFailoverSamples([
      "Request failed",
      "request failed",
      "  Request failed  ",
      "Request failed after repeated internal retries.",
    ]);
  });

  it("does not classify unrelated 'terminated' prose as timeout", () => {
    expectNotFailoverSample("The user terminated the session manually.");
  });
});
