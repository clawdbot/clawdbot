import { describe, expect, it } from "vitest";
import {
  classifyProviderRuntimeFailureKind,
  classifyFailoverReason,
  classifyFailoverReasonFromHttpStatus,
  extractObservedOverflowTokenCount,
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isCloudflareOrHtmlErrorPage,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverErrorMessage,
  isImageDimensionErrorMessage,
  isLikelyContextOverflowError,
  isTimeoutErrorMessage,
  isTransientHttpError,
  parseImageDimensionError,
  parseImageSizeError,
} from "./pi-embedded-helpers.js";

// OpenAI 429 example shape: https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors
const OPENAI_RATE_LIMIT_MESSAGE =
  "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.";
// Gemini RESOURCE_EXHAUSTED troubleshooting example: https://ai.google.dev/gemini-api/docs/troubleshooting
const GEMINI_RESOURCE_EXHAUSTED_MESSAGE =
  "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).";
// Anthropic overloaded_error example shape: https://docs.anthropic.com/en/api/errors
const ANTHROPIC_OVERLOADED_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}';
// OpenRouter 402 billing example: https://openrouter.ai/docs/api-reference/errors
const OPENROUTER_CREDITS_MESSAGE = "Payment Required: insufficient credits";
// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}'; // pragma: allowlist secret
// Together AI error code examples: https://docs.together.ai/docs/error-codes
const TOGETHER_PAYMENT_REQUIRED_MESSAGE =
  "402 Payment Required: The account associated with this API key has reached its maximum allowed monthly spending limit.";
const TOGETHER_ENGINE_OVERLOADED_MESSAGE =
  "503 Engine Overloaded: The server is experiencing a high volume of requests and is temporarily overloaded.";
// Groq error code examples: https://console.groq.com/docs/errors
const GROQ_TOO_MANY_REQUESTS_MESSAGE =
  "429 Too Many Requests: Too many requests were sent in a given timeframe.";
const GROQ_SERVICE_UNAVAILABLE_MESSAGE =
  "503 Service Unavailable: The server is temporarily unable to handle the request due to overloading or maintenance."; // pragma: allowlist secret

function expectMessageMatches(
  matcher: (message: string) => boolean,
  samples: readonly string[],
  expected: boolean,
) {
  for (const sample of samples) {
    expect(matcher(sample), sample).toBe(expected);
  }
}

function expectTimeoutFailoverSamples(samples: readonly string[]) {
  for (const sample of samples) {
    expect(isTimeoutErrorMessage(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBe("timeout");
    expect(isFailoverErrorMessage(sample)).toBe(true);
  }
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
    // Simulate a multi-paragraph assistant response that mentions billing terms
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

describe("isCloudflareOrHtmlErrorPage", () => {
  it("detects Cloudflare 521 HTML pages", () => {
    const htmlError = `521 <!DOCTYPE html>
<html lang="en-US">
  <head><title>Web server is down | example.com | Cloudflare</title></head>
  <body><h1>Web server is down</h1></body>
</html>`;

    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("detects generic 5xx HTML pages", () => {
    const htmlError = `503 <html><head><title>Service Unavailable</title></head><body>down</body></html>`;
    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("does not flag non-HTML status lines", () => {
    expect(isCloudflareOrHtmlErrorPage("500 Internal Server Error")).toBe(false);
    expect(isCloudflareOrHtmlErrorPage("429 Too Many Requests")).toBe(false);
  });

  it("does not flag quoted HTML without a closing html tag", () => {
    const plainTextWithHtmlPrefix = "500 <!DOCTYPE html> upstream responded with partial HTML text";
    expect(isCloudflareOrHtmlErrorPage(plainTextWithHtmlPrefix)).toBe(false);
  });
});

describe("isCompactionFailureError", () => {
  it.each([
    {
      name: "matches compaction overflow failures",
      samples: [
        'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        "auto-compaction failed due to context overflow",
        "Compaction failed: prompt is too long",
        "Summarization failed: context window exceeded for this request",
      ],
      expected: true,
    },
    {
      name: "ignores non-compaction overflow errors",
      samples: ["Context overflow: prompt too large", "rate limit exceeded"],
      expected: false,
    },
  ])("$name", ({ samples, expected }) => {
    expectMessageMatches(isCompactionFailureError, samples, expected);
  });
});

describe("isContextOverflowError", () => {
  it("matches known overflow hints", () => {
    const samples = [
      "request_too_large",
      "Request exceeds the maximum size",
      "context length exceeded",
      "Maximum context length",
      "prompt is too long: 208423 tokens > 200000 maximum",
      "Context overflow: Summarization failed",
      "413 Request Entity Too Large",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches 'exceeds model context window' in various formats", () => {
    const samples = [
      // Anthropic returns this JSON payload when prompt exceeds model context window.
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "Request size exceeds model context window",
      "request size exceeds model context window",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "The request size exceeds model context window limit",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches Kimi 'model token limit' context overflow errors", () => {
    const samples = [
      "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      "Your request exceeded model token limit",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches exceed/context/max_tokens overflow variants", () => {
    const samples = [
      "input length and max_tokens exceed context limit (i.e 156321 + 48384 > 200000)",
      "This request exceeds the model's maximum context length",
      "LLM request rejected: max_tokens would exceed context window",
      "input length would exceed context budget for this model",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches model_context_window_exceeded stop reason surfaced by pi-ai", () => {
    // Anthropic API (and some OpenAI-compatible providers like ZhipuAI/GLM) return
    // stop_reason: "model_context_window_exceeded" when the context window is hit.
    // The pi-ai library surfaces this as "Unhandled stop reason: model_context_window_exceeded".
    const samples = [
      "Unhandled stop reason: model_context_window_exceeded",
      "model_context_window_exceeded",
      "context_window_exceeded",
      "Unhandled stop reason: context_window_exceeded",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches Chinese context overflow error messages from proxy providers", () => {
    const samples = [
      "上下文过长",
      "错误：上下文过长，请减少输入",
      "上下文超出限制",
      "上下文长度超出模型最大限制",
      "超出最大上下文长度",
      "请压缩上下文后重试",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("ignores normal conversation text mentioning context overflow", () => {
    // These are legitimate conversation snippets, not error messages
    expect(isContextOverflowError("Let's investigate the context overflow bug")).toBe(false);
    expect(isContextOverflowError("The mystery context overflow errors are strange")).toBe(false);
    expect(isContextOverflowError("We're debugging context overflow issues")).toBe(false);
    expect(isContextOverflowError("Something is causing context overflow messages")).toBe(false);
  });

  it("excludes reasoning-required invalid-request errors", () => {
    const samples = [
      "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
      '{"type":"error","error":{"type":"invalid_request_error","message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}',
      "This model requires reasoning to be enabled",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(false);
    }
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

describe("isLikelyContextOverflowError", () => {
  it("matches context overflow hints", () => {
    const samples = [
      "Model context window is 128k tokens, you requested 256k tokens",
      "Context window exceeded: requested 12000 tokens",
      "Prompt too large for this model",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
  });

  it("excludes context window too small errors", () => {
    const samples = [
      "Model context window too small (minimum is 128k tokens)",
      "Context window too small: minimum is 1000 tokens",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("excludes rate limit errors that match the broad hint regex", () => {
    const samples = [
      "request reached organization TPD rate limit, current: 1506556, limit: 1500000",
      "rate limit exceeded",
      "too many requests",
      "429 Too Many Requests",
      "exceeded your current quota",
      "This request would exceed your account's rate limit",
      "429 Too Many Requests: request exceeds rate limit",
      "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("keeps too-many-tokens-per-request context overflow errors out of the rate-limit lane", () => {
    const sample = "Context window exceeded: too many tokens per request.";
    expect(isLikelyContextOverflowError(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBeNull();
  });

  it("excludes reasoning-required invalid-request errors", () => {
    const samples = [
      "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
      '{"type":"error","error":{"type":"invalid_request_error","message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}',
      "This endpoint requires reasoning",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("excludes billing errors even when text matches context overflow patterns", () => {
    const samples = [
      "402 Payment Required: request token limit exceeded for this billing plan",
      "insufficient credits: request size exceeds your current plan limits",
      "Your credit balance is too low. Maximum request token limit exceeded.",
    ];
    for (const sample of samples) {
      expect(isBillingErrorMessage(sample)).toBe(true);
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });
});

describe("extractObservedOverflowTokenCount", () => {
  it("extracts provider-reported prompt token counts", () => {
    expect(
      extractObservedOverflowTokenCount(
        '400 {"type":"error","error":{"message":"prompt is too long: 277403 tokens > 200000 maximum"}}',
      ),
    ).toBe(277403);
    expect(
      extractObservedOverflowTokenCount("Context window exceeded: requested 12000 tokens"),
    ).toBe(12000);
    expect(
      extractObservedOverflowTokenCount(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens.",
      ),
    ).toBe(145000);
  });

  it("returns undefined when overflow counts are not present", () => {
    expect(extractObservedOverflowTokenCount("Prompt too large for this model")).toBeUndefined();
    expect(extractObservedOverflowTokenCount("rate limit exceeded")).toBeUndefined();
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

describe("classifyFailoverReasonFromHttpStatus", () => {
  it("treats HTTP 401 invalid_api_key as ambiguous auth", () => {
    expect(classifyFailoverReasonFromHttpStatus(401, "invalid_api_key")).toBe("auth");
  });

  it("treats HTTP 422 as format error", () => {
    expect(classifyFailoverReasonFromHttpStatus(422)).toBe("format");
    expect(classifyFailoverReasonFromHttpStatus(422, "check open ai req parameter error")).toBe(
      "format",
    );
    expect(classifyFailoverReasonFromHttpStatus(422, "Unprocessable Entity")).toBe("format");
  });

  it("treats 422 with billing message as billing instead of format", () => {
    expect(classifyFailoverReasonFromHttpStatus(422, "insufficient credits")).toBe("billing");
  });

  it("treats HTTP 400 insufficient-quota payloads as billing instead of format", () => {
    expect(classifyFailoverReasonFromHttpStatus(400, INSUFFICIENT_QUOTA_PAYLOAD)).toBe("billing");
  });

  it("keeps HTTP 400 provider-specific rate limits out of the generic format bucket", () => {
    expect(
      classifyFailoverReasonFromHttpStatus(
        400,
        "ThrottlingException: Too many concurrent requests",
      ),
    ).toBe("rate_limit");
  });

  it("does not force HTTP 400 context-overflow payloads into format", () => {
    expect(
      classifyFailoverReasonFromHttpStatus(
        400,
        "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
      ),
    ).toBeNull();
  });

  it("lets OpenRouter billing-classified HTTP 401 responses bypass generic auth", () => {
    expect(
      classifyFailoverReasonFromHttpStatus(401, "401 Key limit exceeded (monthly limit)", {
        provider: "openrouter",
      }),
    ).toBe("billing");
  });

  it("keeps generic HTTP 401 key-limit text on the auth path without provider context", () => {
    expect(
      classifyFailoverReasonFromHttpStatus(401, "401 Key limit exceeded (monthly limit)"),
    ).toBe("auth");
  });

  it("treats HTTP 499 as transient for structured errors", () => {
    expect(classifyFailoverReasonFromHttpStatus(499)).toBe("timeout");
    expect(classifyFailoverReasonFromHttpStatus(499, "499 Client Closed Request")).toBe("timeout");
    expect(
      classifyFailoverReasonFromHttpStatus(
        499,
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe("overloaded");
  });

  it("treats generic HTTP 410 responses as retryable timeouts", () => {
    expect(classifyFailoverReasonFromHttpStatus(410)).toBe("timeout");
    expect(classifyFailoverReasonFromHttpStatus(410, "")).toBe("timeout");
    expect(classifyFailoverReasonFromHttpStatus(410, "No body response")).toBe("timeout");
  });

  it("treats session-specific HTTP 410 responses as session_expired", () => {
    expect(classifyFailoverReasonFromHttpStatus(410, "session not found")).toBe("session_expired");
    expect(classifyFailoverReasonFromHttpStatus(410, "conversation expired")).toBe(
      "session_expired",
    );
  });

  it("preserves explicit billing and auth signals on HTTP 410", () => {
    expect(classifyFailoverReasonFromHttpStatus(410, "invalid_api_key")).toBe("auth");
    expect(classifyFailoverReasonFromHttpStatus(410, "authentication failed")).toBe("auth");
    expect(classifyFailoverReasonFromHttpStatus(410, "insufficient credits")).toBe("billing");
  });
});

describe("classifyFailoverReason", () => {
  it("treats generic 410 text as retryable timeout", () => {
    expect(classifyFailoverReason("410")).toBe("timeout");
    expect(classifyFailoverReason("HTTP 410")).toBe("timeout");
    expect(classifyFailoverReason("410 Gone")).toBe("timeout");
    expect(classifyFailoverReason("410: No body")).toBe("timeout");
    expect(classifyFailoverReason("HTTP 410: No body")).toBe("timeout");
    expect(classifyFailoverReason("HTTP 410 Gone")).toBe("timeout");
  });

  it("keeps session-specific 410 text mapped to session_expired", () => {
    expect(classifyFailoverReason("HTTP 410: session not found")).toBe("session_expired");
    expect(classifyFailoverReason("410 conversation expired")).toBe("session_expired");
  });

  it("classifies 'No conversation found' from Claude CLI as session_expired", () => {
    expect(classifyFailoverReason("No conversation found with session ID: abc123")).toBe(
      "session_expired",
    );
  });

  it("keeps explicit billing and auth signals on 410 text", () => {
    expect(classifyFailoverReason("HTTP 410: invalid_api_key")).toBe("auth");
    expect(classifyFailoverReason("HTTP 410: authentication failed")).toBe("auth");
    expect(classifyFailoverReason("HTTP 410: insufficient credits")).toBe("billing");
  });

  it("classifies HTTP 404 assistant errors as model_not_found so model fallback can continue", () => {
    expect(classifyFailoverReason("404 status code (no body)")).toBe("model_not_found");
    expect(classifyFailoverReason("HTTP 404: No body")).toBe("model_not_found");
  });

  it("preserves session and auth billing signals on HTTP 404 text", () => {
    expect(classifyFailoverReason("HTTP 404: session not found")).toBe("session_expired");
    expect(classifyFailoverReason("HTTP 404: invalid_api_key")).toBe("auth");
    expect(classifyFailoverReason("HTTP 404: insufficient credits")).toBe("billing");
  });

  it("does not map HTTP 404 plus context-overflow text to model_not_found", () => {
    expect(
      classifyFailoverReason(
        "HTTP 404: INVALID_ARGUMENT: input exceeds the maximum number of tokens",
      ),
    ).toBeNull();
  });

  it("keeps raw HTTP 400 wrappers aligned with structured provider classification", () => {
    expect(
      classifyFailoverReason("HTTP 400: ThrottlingException: Too many concurrent requests"),
    ).toBe("rate_limit");
    expect(
      classifyFailoverReason(
        "HTTP 400: INVALID_ARGUMENT: input exceeds the maximum number of tokens",
      ),
    ).toBeNull();
  });

  it("classifies OpenAI Responses unknown-no-details message as unknown", () => {
    const message = "Unknown error (no error details in response)";
    expect(classifyFailoverReason(message)).toBe("unknown");
    expect(isFailoverErrorMessage(message)).toBe(true);
  });

  it("classifies provider-scoped generic upstream messages", () => {
    expect(classifyFailoverReason("An unknown error occurred", { provider: "anthropic" })).toBe(
      "timeout",
    );
    expect(classifyFailoverReason("Provider returned error", { provider: "openrouter" })).toBe(
      "timeout",
    );
    expect(classifyFailoverReason("Key limit exceeded", { provider: "openrouter" })).toBe(
      "billing",
    );
  });

  it("does not classify provider-scoped generic upstream messages without provider context", () => {
    expect(classifyFailoverReason("An unknown error occurred")).toBeNull();
    expect(
      classifyFailoverReason("An unknown error occurred", { provider: "openrouter" }),
    ).toBeNull();
    expect(classifyFailoverReason("Provider returned error")).toBeNull();
    expect(classifyFailoverReason("Provider returned error", { provider: "anthropic" })).toBeNull();
    expect(classifyFailoverReason("Key limit exceeded")).toBeNull();
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
    expectTimeoutFailoverSamples([
      "Unhandled stop reason: abort",
      "Unhandled stop reason: error",
      "stop reason: abort",
      "stop reason: error",
      "reason: abort",
      "reason: error",
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

  it("does not classify MALFORMED_FUNCTION_CALL as timeout", () => {
    const sample = "Unhandled stop reason: MALFORMED_FUNCTION_CALL";
    expect(isTimeoutErrorMessage(sample)).toBe(false);
    expect(classifyFailoverReason(sample)).toBe(null);
    expect(isFailoverErrorMessage(sample)).toBe(false);
  });
});

describe("parseImageSizeError", () => {
  it("parses max MB values from error text", () => {
    expect(parseImageSizeError("image exceeds 5 MB maximum")?.maxMb).toBe(5);
    expect(parseImageSizeError("Image exceeds 5.5 MB limit")?.maxMb).toBe(5.5);
  });

  it("returns null for unrelated errors", () => {
    expect(parseImageSizeError("context overflow")).toBeNull();
  });
});

describe("image dimension errors", () => {
  it("parses anthropic image dimension errors", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}';
    const parsed = parseImageDimensionError(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.maxDimensionPx).toBe(2000);
    expect(parsed?.messageIndex).toBe(84);
    expect(parsed?.contentIndex).toBe(1);
    expect(isImageDimensionErrorMessage(raw)).toBe(true);
  });
});

describe("classifyFailoverReasonFromHttpStatus – 402 temporary limits", () => {
  it("reclassifies periodic usage limits as rate_limit", () => {
    const samples = [
      "Monthly spend limit reached.",
      "Weekly usage limit exhausted.",
      "Daily limit reached, resets tomorrow.",
    ];
    for (const sample of samples) {
      expect(classifyFailoverReasonFromHttpStatus(402, sample)).toBe("rate_limit");
    }
  });

  it("reclassifies org/workspace spend limits as rate_limit", () => {
    const samples = [
      "Organization spending limit exceeded.",
      "Workspace spend limit reached.",
      "Organization limit exceeded for this billing period.",
    ];
    for (const sample of samples) {
      expect(classifyFailoverReasonFromHttpStatus(402, sample)).toBe("rate_limit");
    }
  });

  it("keeps 402 as billing when explicit billing signals are present", () => {
    expect(
      classifyFailoverReasonFromHttpStatus(
        402,
        "Your credit balance is too low. Monthly limit exceeded.",
      ),
    ).toBe("billing");
    expect(
      classifyFailoverReasonFromHttpStatus(
        402,
        "Insufficient credits. Organization limit reached.",
      ),
    ).toBe("billing");
    expect(
      classifyFailoverReasonFromHttpStatus(
        402,
        "The account associated with this API key has reached its maximum allowed monthly spending limit.",
      ),
    ).toBe("billing");
  });

  it("keeps long 402 payloads with explicit billing text as billing", () => {
    const longBillingPayload = `${"x".repeat(520)} insufficient credits. Monthly spend limit reached.`;
    expect(classifyFailoverReasonFromHttpStatus(402, longBillingPayload)).toBe("billing");
  });

  it("keeps 402 as billing without message or with generic message", () => {
    expect(classifyFailoverReasonFromHttpStatus(402, undefined)).toBe("billing");
    expect(classifyFailoverReasonFromHttpStatus(402, "")).toBe("billing");
    expect(classifyFailoverReasonFromHttpStatus(402, "Payment required")).toBe("billing");
  });

  it("matches raw 402 wrappers and status-split payloads for the same message", () => {
    const transientMessage = "Monthly spend limit reached. Please visit your billing settings.";
    expect(classifyFailoverReason(`402 Payment Required: ${transientMessage}`)).toBe("rate_limit");
    expect(classifyFailoverReasonFromHttpStatus(402, transientMessage)).toBe("rate_limit");

    const billingMessage =
      "The account associated with this API key has reached its maximum allowed monthly spending limit.";
    expect(classifyFailoverReason(`402 Payment Required: ${billingMessage}`)).toBe("billing");
    expect(classifyFailoverReasonFromHttpStatus(402, billingMessage)).toBe("billing");
  });

  it("keeps explicit 402 rate-limit messages in the rate_limit lane", () => {
    const transientMessage = "rate limit exceeded";
    expect(classifyFailoverReason(`HTTP 402 Payment Required: ${transientMessage}`)).toBe(
      "rate_limit",
    );
    expect(classifyFailoverReasonFromHttpStatus(402, transientMessage)).toBe("rate_limit");
  });

  it("keeps plan-upgrade 402 limit messages in billing", () => {
    const billingMessage = "Your usage limit has been reached. Please upgrade your plan.";
    expect(classifyFailoverReason(`HTTP 402 Payment Required: ${billingMessage}`)).toBe("billing");
    expect(classifyFailoverReasonFromHttpStatus(402, billingMessage)).toBe("billing");
  });
});

describe("classifyFailoverReason", () => {
  it("classifies documented provider error messages", () => {
    expect(classifyFailoverReason(OPENAI_RATE_LIMIT_MESSAGE)).toBe("rate_limit");
    expect(classifyFailoverReason(GEMINI_RESOURCE_EXHAUSTED_MESSAGE)).toBe("rate_limit");
    expect(classifyFailoverReason(ANTHROPIC_OVERLOADED_PAYLOAD)).toBe("overloaded");
    expect(classifyFailoverReason(OPENROUTER_CREDITS_MESSAGE)).toBe("billing");
    expect(classifyFailoverReason(TOGETHER_PAYMENT_REQUIRED_MESSAGE)).toBe("billing");
    expect(classifyFailoverReason(TOGETHER_ENGINE_OVERLOADED_MESSAGE)).toBe("overloaded");
    expect(classifyFailoverReason(GROQ_TOO_MANY_REQUESTS_MESSAGE)).toBe("rate_limit");
    expect(classifyFailoverReason(GROQ_SERVICE_UNAVAILABLE_MESSAGE)).toBe("overloaded");
    // Venice 402 billing error with extra words between "insufficient" and "balance"
    expect(
      classifyFailoverReason(
        "Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits.",
      ),
    ).toBe("billing");
    // OpenRouter "requires more credits" billing text
    expect(classifyFailoverReason("This model requires more credits to use")).toBe("billing");
  });

  it("classifies internal and compatibility error messages", () => {
    expect(classifyFailoverReason("invalid api key")).toBe("auth");
    expect(classifyFailoverReason("no credentials found")).toBe("auth");
    expect(classifyFailoverReason("no api key found")).toBe("auth");
    expect(
      classifyFailoverReason(
        'No API key found for provider "openai". Auth store: /tmp/openclaw-agent-abc/auth-profiles.json (agentDir: /tmp/openclaw-agent-abc).',
      ),
    ).toBe("auth");
    expect(classifyFailoverReason("You have insufficient permissions for this operation.")).toBe(
      "auth",
    );
    expect(classifyFailoverReason("Missing scopes: model.request")).toBe("auth");
    expect(
      classifyFailoverReason("model_cooldown: All credentials for model gpt-5 are cooling down"),
    ).toBe("rate_limit");
    expect(classifyFailoverReason("all credentials for model x are cooling down")).toBeNull();
    expect(classifyFailoverReason("invalid request format")).toBe("format");
    expect(classifyFailoverReason("credit balance too low")).toBe("billing");
    // Billing with "limit exhausted" must stay billing, not rate_limit (avoids key-disable regression)
    expect(
      classifyFailoverReason("HTTP 402 payment required. Your limit exhausted for this plan."),
    ).toBe("billing");
    expect(classifyFailoverReason("402 Payment Required: Weekly/Monthly Limit Exhausted")).toBe(
      "billing",
    );
    // Poe returns 402 without "payment required"; must be recognized for fallback
    expect(
      classifyFailoverReason(
        "402 You've used up your points! Visit https://poe.com/api/keys to get more.",
      ),
    ).toBe("billing");
    expect(classifyFailoverReason(INSUFFICIENT_QUOTA_PAYLOAD)).toBe("billing");
    expect(classifyFailoverReason("deadline exceeded")).toBe("timeout");
    expect(classifyFailoverReason("request ended without sending any chunks")).toBe("timeout");
    expect(classifyFailoverReason("Connection error.")).toBe("timeout");
    expect(classifyFailoverReason("fetch failed")).toBe("timeout");
    expect(classifyFailoverReason("network error: ECONNREFUSED")).toBe("timeout");
    expect(
      classifyFailoverReason("dial tcp: lookup api.example.com: no such host (ENOTFOUND)"),
    ).toBe("timeout");
    expect(classifyFailoverReason("temporary dns failure EAI_AGAIN")).toBe("timeout");
    expect(
      classifyFailoverReason(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
    ).toBe("timeout");
    expect(
      classifyFailoverReason(
        'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
      ),
    ).toBe("timeout");
    expect(classifyFailoverReason("string should match pattern")).toBe("format");
    expect(classifyFailoverReason("bad request")).toBeNull();
    expect(
      classifyFailoverReason(
        "messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
      ),
    ).toBeNull();
    expect(classifyFailoverReason("image exceeds 5 MB maximum")).toBeNull();
  });
  it("classifies OpenAI usage limit errors as rate_limit", () => {
    expect(classifyFailoverReason("You have hit your ChatGPT usage limit (plus plan)")).toBe(
      "rate_limit",
    );
  });
  it("classifies AWS Bedrock too-many-tokens-per-day errors as rate_limit", () => {
    expect(
      classifyFailoverReason("AWS Bedrock: Too many tokens per day. Please try again tomorrow."),
    ).toBe("rate_limit");
  });
  it("classifies provider high-demand / service-unavailable messages as overloaded", () => {
    expect(
      classifyFailoverReason(
        "This model is currently experiencing high demand. Please try again later.",
      ),
    ).toBe("overloaded");
    // "service unavailable" combined with overload/capacity indicator → overloaded
    // (exercises the new regex — none of the standalone patterns match here)
    expect(classifyFailoverReason("service unavailable due to capacity limits")).toBe("overloaded");
    expect(
      classifyFailoverReason(
        '{"error":{"code":503,"message":"The model is overloaded. Please try later","status":"UNAVAILABLE"}}',
      ),
    ).toBe("overloaded");
  });
  it("classifies bare 'service unavailable' as timeout instead of rate_limit (#32828)", () => {
    // A generic "service unavailable" from a proxy/CDN should stay retryable,
    // but it should not be treated as provider overload / rate limit.
    expect(classifyFailoverReason("LLM error: service unavailable")).toBe("timeout");
    expect(classifyFailoverReason("503 Internal Database Error")).toBe("timeout");
    // Raw 529 text without explicit overload keywords still classifies as overloaded.
    expect(classifyFailoverReason("529 API is busy")).toBe("overloaded");
    expect(classifyFailoverReason("529 Please try again")).toBe("overloaded");
  });
  it("classifies zhipuai Weekly/Monthly Limit Exhausted as rate_limit (#33785)", () => {
    expect(
      classifyFailoverReason(
        "LLM error 1310: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06 22:19:54 (request_id: 20260303141547610b7f574d1b44cb)",
      ),
    ).toBe("rate_limit");
    // Independent coverage for broader periodic limit patterns.
    expect(classifyFailoverReason("LLM error: weekly/monthly limit reached")).toBe("rate_limit");
    expect(classifyFailoverReason("LLM error: monthly limit reached")).toBe("rate_limit");
    expect(classifyFailoverReason("LLM error: daily limit exceeded")).toBe("rate_limit");
  });
  it("keeps only high-confidence auth failures in auth_permanent", () => {
    expect(classifyFailoverReason("invalid_api_key")).toBe("auth");
    expect(classifyFailoverReason("permission_error")).toBe("auth");
    expect(classifyFailoverReason("Your api key has been revoked")).toBe("auth_permanent");
    expect(classifyFailoverReason("key has been disabled")).toBe("auth_permanent");
    expect(classifyFailoverReason("account has been deactivated")).toBe("auth_permanent");
    expect(
      classifyFailoverReason("OAuth authentication is currently not allowed for this organization"),
    ).toBe("auth_permanent");
  });
  it("classifies JSON api_error with transient signal as timeout", () => {
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      ),
    ).toBe("timeout");
    // MiniMax non-standard message
    expect(
      classifyFailoverReason('{"type":"api_error","message":"unknown error, 520 (1000)"}'),
    ).toBe("timeout");
    // Overloaded variant
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"Service temporarily unavailable"}}',
      ),
    ).toBe("timeout");
    // Anthropic "unexpected error" variant (#57010)
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"An unexpected error occurred while processing the response"}}',
      ),
    ).toBe("timeout");
  });
  it("does not classify non-transient api_error payloads as timeout", () => {
    // Context overflow - not transient
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"Request size exceeds model context window"}}',
      ),
    ).not.toBe("timeout");
    // Schema/validation error - not transient
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"messages.1.content.1.tool_use.id should match pattern"}}',
      ),
    ).not.toBe("timeout");
    // Generic unknown api_error without transient wording - should not be retried
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"invalid input format"}}',
      ),
    ).not.toBe("timeout");
  });
  it("does not shadow billing errors that carry api_error type", () => {
    // A provider may wrap a billing error in a JSON payload with "type":"api_error".
    // The billing classifier must win over the broad api_error transient match.
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"insufficient credits"}}',
      ),
    ).toBe("billing");
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"Payment required"}}',
      ),
    ).toBe("billing");
  });
  it("does not shadow auth errors that carry api_error type", () => {
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"invalid api key"}}',
      ),
    ).toBe("auth");
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"unauthorized"}}',
      ),
    ).toBe("auth");
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"permission_error"}}',
      ),
    ).toBe("auth");
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"permission_error: OAuth authentication is currently not allowed for this organization"}}',
      ),
    ).toBe("auth_permanent");
  });
});

describe("classifyProviderRuntimeFailureKind", () => {
  it("classifies missing scope failures", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai-codex",
        message:
          '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
      }),
    ).toBe("auth_scope");
  });

  it("classifies raw missing scope payloads without an HTTP prefix", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai-codex",
        message:
          '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"},"code":401}',
      }),
    ).toBe("auth_scope");
  });

  it("does not classify non-Codex permission errors as missing scope failures", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai",
        message:
          '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
      }),
    ).not.toBe("auth_scope");
  });

  it("does not treat generic Codex permission failures as missing scope failures", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai-codex",
        message:
          '403 {"type":"error","error":{"type":"permission_error","message":"Insufficient permissions for this organization"}}',
      }),
    ).not.toBe("auth_scope");
  });

  it("classifies OAuth refresh failures", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        "OAuth token refresh failed for openai-codex: invalid_grant. Please try again or re-authenticate.",
      ),
    ).toBe("auth_refresh");
  });

  it("classifies HTML 403 auth failures", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        "403 <!DOCTYPE html><html><body>Access denied</body></html>",
      ),
    ).toBe("auth_html_403");
  });

  it("classifies proxy, dns, timeout, schema, sandbox, and replay failures", () => {
    expect(classifyProviderRuntimeFailureKind("407 Proxy Authentication Required")).toBe("proxy");
    expect(
      classifyProviderRuntimeFailureKind("dial tcp: lookup api.example.com: no such host"),
    ).toBe("dns");
    expect(classifyProviderRuntimeFailureKind("socket hang up")).toBe("timeout");
    expect(
      classifyProviderRuntimeFailureKind("INVALID_REQUEST_ERROR: string should match pattern"),
    ).toBe("schema");
    expect(classifyProviderRuntimeFailureKind("exec denied (allowlist-miss):")).toBe(
      "sandbox_blocked",
    );
    expect(classifyProviderRuntimeFailureKind("tool_use.input: Field required")).toBe(
      "replay_invalid",
    );
    expect(
      classifyProviderRuntimeFailureKind("401 input item ID does not belong to this connection"),
    ).toBe("replay_invalid");
  });

  it("does not classify generic config errors that mention proxy settings as proxy failures", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
      ),
    ).not.toBe("proxy");
  });
});
