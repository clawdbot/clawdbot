import { describe, expect, it } from "vitest";
import {
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  isTimeoutError,
  resolveFailoverReasonFromError,
  resolveFailoverStatus,
} from "./failover-error.js";
import { classifyFailoverSignal } from "./pi-embedded-helpers/errors.js";
import { SessionWriteLockTimeoutError } from "./session-write-lock-error.js";

// OpenAI 429 example shape: https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors
const OPENAI_RATE_LIMIT_MESSAGE =
  "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.";
// Anthropic overloaded_error example shape: https://docs.anthropic.com/en/api/errors
const ANTHROPIC_OVERLOADED_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}';
// Gemini RESOURCE_EXHAUSTED troubleshooting example: https://ai.google.dev/gemini-api/docs/troubleshooting
const GEMINI_RESOURCE_EXHAUSTED_MESSAGE =
  "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).";
// OpenRouter 402 billing example: https://openrouter.ai/docs/api-reference/errors
const OPENROUTER_CREDITS_MESSAGE = "Payment Required: insufficient credits";
const OPENROUTER_MODEL_NOT_FOUND_PAYLOAD =
  '{"error":{"message":"Healer Alpha was a stealth model revealed on March 18th as an early testing version of MiMo-V2-Omni. Find it here: https://openrouter.ai/xiaomi/mimo-v2-omni","code":404},"user_id":"user_33GTyP8uDSYYbaeBO48AGHXyuMC"}';
const TOGETHER_MONTHLY_SPEND_CAP_MESSAGE =
  "The account associated with this API key has reached its maximum allowed monthly spending limit.";
// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';
// Issue-backed ZhipuAI/GLM quota-exhausted log from #33785:
// https://github.com/openclaw/openclaw/issues/33785
const ZHIPUAI_WEEKLY_MONTHLY_LIMIT_EXHAUSTED_MESSAGE =
  "LLM error 1310: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06 22:19:54 (request_id: 20260303141547610b7f574d1b44cb)";
// AWS Bedrock 429 ThrottlingException / 503 ServiceUnavailable:
// https://docs.aws.amazon.com/bedrock/latest/userguide/troubleshooting-api-error-codes.html
const BEDROCK_THROTTLING_EXCEPTION_MESSAGE =
  "ThrottlingException: Your request was denied due to exceeding the account quotas for Amazon Bedrock.";
const BEDROCK_SERVICE_UNAVAILABLE_MESSAGE =
  "ServiceUnavailable: The service is temporarily unable to handle the request.";
// Groq error codes examples: https://console.groq.com/docs/errors
const GROQ_TOO_MANY_REQUESTS_MESSAGE =
  "429 Too Many Requests: Too many requests were sent in a given timeframe.";
const GROQ_SERVICE_UNAVAILABLE_MESSAGE =
  "503 Service Unavailable: The server is temporarily unable to handle the request due to overloading or maintenance.";
// Structured OpenAI-compatible server_error payload shape seen in Codex/OpenAI runs.
const OPENAI_SERVER_ERROR_PAYLOAD =
  'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}';

describe("failover-error", () => {
  it("infers failover reason from HTTP status", () => {
    expect(resolveFailoverReasonFromError({ status: 402 })).toBe("billing");
    // Anthropic Claude Max plan surfaces rate limits as HTTP 402 (#30484)
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: "HTTP 402: request reached organization usage limit, try again later",
      }),
    ).toBe("rate_limit");
    // Explicit billing messages on 402 stay classified as billing
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: "insufficient credits — please top up your account",
      }),
    ).toBe("billing");
    // Ambiguous "quota exceeded" + billing signal → billing wins
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: "HTTP 402: You have exceeded your current quota. Please add more credits.",
      }),
    ).toBe("billing");
    expect(resolveFailoverReasonFromError({ statusCode: "429" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ status: 403 })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 408 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 410 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 499 })).toBe("timeout");
    // 400/422 with no body returns null — avoids triggering a compaction loop
    // when the provider returns an empty or wrapper-only 400/422 (e.g.
    // transient proxy issue).
    expect(resolveFailoverReasonFromError({ status: 400 })).toBeNull();
    expect(resolveFailoverReasonFromError({ status: 422 })).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "400 status code (no body)",
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "HTTP 422: No body",
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "HTTP 422: No response body",
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "Error: HTTP 422: No response body",
      }),
    ).toBeNull();
    expect(resolveFailoverReasonFromError({ message: "400 status code (no body)" })).toBeNull();
    expect(resolveFailoverReasonFromError({ message: "HTTP 422: No body" })).toBeNull();
    expect(resolveFailoverReasonFromError({ message: "HTTP 422: No response body" })).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        message: "outer wrapper",
        cause: {
          status: 422,
          message: "HTTP 422: No response body",
        },
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "check open ai req parameter error",
        cause: {
          status: 422,
          message: "HTTP 422: No response body",
        },
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "check open ai req parameter error",
        cause: new Error("No response body"),
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "Unprocessable Entity",
        error: {
          message: "HTTP 422: No response body",
        },
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "Unprocessable Entity",
        cause: {
          message: "Unprocessable Entity",
          error: {
            message: "HTTP 422: No response body",
          },
        },
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        error: {
          message: "missing required property",
        },
        cause: {},
      }),
    ).toBe("format");
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        error: {
          message: "missing required property",
        },
        cause: {
          message: "HTTP 422: No response body",
        },
      }),
    ).toBe("format");
    // Transient server errors (500/502/503/504) should trigger failover as timeout.
    expect(resolveFailoverReasonFromError({ status: 500 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 502 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 503 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 504 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 521 })).toBeNull();
    expect(resolveFailoverReasonFromError({ status: 522 })).toBeNull();
    expect(resolveFailoverReasonFromError({ status: 523 })).toBeNull();
    expect(resolveFailoverReasonFromError({ status: 524 })).toBeNull();
    expect(resolveFailoverReasonFromError({ status: 529 })).toBe("overloaded");
  });

  it("stops on cyclic cause chains", () => {
    const first: { cause?: unknown } = {};
    const second: { cause?: unknown } = { cause: first };
    first.cause = second;

    expect(resolveFailoverReasonFromError(first)).toBeNull();
  });

  it("treats session-specific HTTP 410s differently from generic 410s", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 410,
        message: "session not found",
      }),
    ).toBe("session_expired");
    expect(
      resolveFailoverReasonFromError({
        message: "HTTP 410: No body",
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        message: "HTTP 410: conversation expired",
      }),
    ).toBe("session_expired");
  });

  it("preserves explicit auth and billing signals on HTTP 410", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 410,
        message: "invalid_api_key",
      }),
    ).toBe("auth");
    expect(
      resolveFailoverReasonFromError({
        status: 410,
        message: "authentication failed",
      }),
    ).toBe("auth");
    expect(
      resolveFailoverReasonFromError({
        status: 410,
        message: "insufficient credits",
      }),
    ).toBe("billing");
  });

  it("classifies documented provider error shapes at the error boundary", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 429,
        message: OPENAI_RATE_LIMIT_MESSAGE,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 529,
        message: ANTHROPIC_OVERLOADED_PAYLOAD,
      }),
    ).toBe("overloaded");
    expect(
      resolveFailoverReasonFromError({
        status: 499,
        message: ANTHROPIC_OVERLOADED_PAYLOAD,
      }),
    ).toBe("overloaded");
    expect(
      resolveFailoverReasonFromError({
        status: 429,
        message: GEMINI_RESOURCE_EXHAUSTED_MESSAGE,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: OPENROUTER_CREDITS_MESSAGE,
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        status: 429,
        message: BEDROCK_THROTTLING_EXCEPTION_MESSAGE,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 503,
        message: BEDROCK_SERVICE_UNAVAILABLE_MESSAGE,
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        status: 429,
        message: GROQ_TOO_MANY_REQUESTS_MESSAGE,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 503,
        message: GROQ_SERVICE_UNAVAILABLE_MESSAGE,
      }),
    ).toBe("overloaded");
  });

  it("classifies OpenRouter no-endpoints 404s as model_not_found", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 404,
        message: "No endpoints found for deepseek/deepseek-r1:free.",
      }),
    ).toBe("model_not_found");
    expect(
      resolveFailoverReasonFromError({
        message: "404 No endpoints found for deepseek/deepseek-r1:free.",
      }),
    ).toBe("model_not_found");
  });

  it("classifies JSON-wrapped OpenRouter stealth-model 404s as model_not_found", () => {
    expect(
      resolveFailoverReasonFromError({
        message: OPENROUTER_MODEL_NOT_FOUND_PAYLOAD,
      }),
    ).toBe("model_not_found");
  });

  it("classifies generic model-does-not-exist messages as model_not_found", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "The model gpt-foo does not exist.",
      }),
    ).toBe("model_not_found");
  });

  it("does not classify generic access errors as model_not_found", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "The deployment does not exist or you do not have access.",
      }),
    ).toBeNull();
  });

  it("does not classify generic deprecation transition messages as model_not_found", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "The endpoint has been deprecated. Transition to v2 API for continued access.",
      }),
    ).toBeNull();
  });

  it("classifies model-scoped deprecation transition messages as model_not_found", () => {
    expect(
      resolveFailoverReasonFromError({
        message:
          "404 The free model has been deprecated. Transition to qwen/qwen3.6-plus for continued paid access.",
      }),
    ).toBe("model_not_found");
  });

  it("keeps status-only 503s conservative unless the payload is clearly overloaded", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 503,
        message: "Internal database error",
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        status: 503,
        message: '{"error":{"message":"The model is overloaded. Please try later"}}',
      }),
    ).toBe("overloaded");
  });

  it("does not classify session lock wait errors as model timeout failover", () => {
    const sessionLockError = new SessionWriteLockTimeoutError({
      timeoutMs: 10_000,
      owner: "pid=37121",
      lockPath: "/tmp/openclaw/session.jsonl.lock",
    });
    expect(resolveFailoverReasonFromError(sessionLockError)).toBeNull();
    expect(isTimeoutError(sessionLockError)).toBe(false);

    const wrappedLockError = Object.assign(new Error("operation timed out"), {
      name: "AbortError",
      cause: sessionLockError,
    });
    expect(resolveFailoverReasonFromError(wrappedLockError)).toBeNull();
    expect(isTimeoutError(wrappedLockError)).toBe(false);

    const abortWrappedLockError = Object.assign(new Error("request was aborted"), {
      name: "AbortError",
      cause: sessionLockError,
    });
    expect(resolveFailoverReasonFromError(abortWrappedLockError)).toBeNull();
    expect(isTimeoutError(abortWrappedLockError)).toBe(false);
  });

  it("keeps explicit provider failover metadata authoritative over nested session lock text", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 429,
        code: "RESOURCE_EXHAUSTED",
        message: "upstream quota pressure",
        cause: new SessionWriteLockTimeoutError({
          timeoutMs: 10_000,
          owner: "pid=37121",
          lockPath: "/tmp/openclaw/session.jsonl.lock",
        }),
      }),
    ).toBe("rate_limit");
  });

  it("keeps inferred HTTP failover metadata authoritative over nested session lock text", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "HTTP 429: upstream quota pressure",
        cause: new SessionWriteLockTimeoutError({
          timeoutMs: 10_000,
          owner: "pid=37121",
          lockPath: "/tmp/openclaw/session.jsonl.lock",
        }),
      }),
    ).toBe("rate_limit");
  });

  it("does not treat generic abort codes as explicit failover metadata over nested session lock text", () => {
    expect(
      resolveFailoverReasonFromError({
        name: "AbortError",
        code: "ABORT_ERR",
        message: "The operation was aborted",
        cause: new SessionWriteLockTimeoutError({
          timeoutMs: 10_000,
          owner: "pid=37121",
          lockPath: "/tmp/openclaw/session.jsonl.lock",
        }),
      }),
    ).toBeNull();
  });

  it("does not let cause-based failover classification bypass wrapper session lock suppression", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "wrapper",
        reason: new SessionWriteLockTimeoutError({
          timeoutMs: 10_000,
          owner: "pid=37121",
          lockPath: "/tmp/openclaw/session.jsonl.lock",
        }),
        cause: new Error("operation timed out"),
      }),
    ).toBeNull();
  });

  it("classifies bare pi-ai stream wrapper as timeout regardless of provider (#71620)", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "An unknown error occurred",
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        provider: "anthropic",
        message: "An unknown error occurred",
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        provider: "google",
        message: "An unknown error occurred",
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        provider: "openrouter",
        message: "An unknown error occurred",
      }),
    ).toBe("timeout");
  });

  it("classifies openrouter-scoped upstream errors for failover", () => {
    expect(
      resolveFailoverReasonFromError({
        provider: "openrouter",
        message: "Provider returned error",
      }),
    ).toBe("timeout");
  });

  it("does not classify openrouter-scoped upstream errors without the matching provider", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "Provider returned error",
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        provider: "anthropic",
        message: "Provider returned error",
      }),
    ).toBeNull();
  });

  it("treats 400 insufficient_quota payloads as billing instead of format", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: INSUFFICIENT_QUOTA_PAYLOAD,
      }),
    ).toBe("billing");
  });

  it("lets structured HTTP 400 payloads reuse provider-specific message classification", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "ThrottlingException: Too many concurrent requests",
      }),
    ).toBe("rate_limit");
  });

  it("does not misclassify structured HTTP 400 context overflow payloads as format", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
      }),
    ).toBeNull();
  });

  it("keeps context overflow first-class in the shared signal classifier", () => {
    expect(
      classifyFailoverSignal({
        status: 400,
        message: "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
      }),
    ).toEqual({ kind: "context_overflow" });
    expect(
      classifyFailoverSignal({
        message: "prompt is too long: 150000 tokens > 128000 maximum",
      }),
    ).toEqual({ kind: "context_overflow" });
  });

  it("treats invalid-model HTTP 400 payloads as model_not_found instead of format", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "openrouter/__invalid_test_model__ is not a valid model ID",
      }),
    ).toBe("model_not_found");
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "HTTP 400: openrouter/__invalid_test_model__ is not a valid model ID",
      }),
    ).toBe("model_not_found");
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "invalid model: openrouter/__invalid_test_model__",
      }),
    ).toBe("model_not_found");
  });

  it("treats HTTP 422 as format error", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "check open ai req parameter error",
      }),
    ).toBe("format");
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "Unprocessable Entity",
      }),
    ).toBe("format");
  });

  it("treats 422 with billing message as billing instead of format", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "insufficient credits",
      }),
    ).toBe("billing");
  });

  it("classifies OpenRouter 'requires more credits' text as billing", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "This model requires more credits to use",
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: "This model require more credits",
      }),
    ).toBe("billing");
  });

  it("treats zhipuai weekly/monthly limit exhausted as rate_limit", () => {
    expect(
      resolveFailoverReasonFromError({
        message: ZHIPUAI_WEEKLY_MONTHLY_LIMIT_EXHAUSTED_MESSAGE,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        message: "LLM error: monthly limit reached",
      }),
    ).toBe("rate_limit");
  });

  it("treats Chinese provider network/server errors as timeout for failover", () => {
    // ZhipuAI/GLM error code 1234: "网络错误" — real production error
    expect(
      resolveFailoverReasonFromError({
        message:
          "LLM error 1234: 网络错误，错误id：202603281427587491f4467f1c4712，请联系客服。 (request_id: 202603281427587491f4467f1c4712)",
      }),
    ).toBe("timeout");
    // JSON payload variant
    expect(
      resolveFailoverReasonFromError({
        message:
          '{"error":{"code":"1234","message":"网络错误，错误id：abc123，请联系客服。"},"request_id":"abc123"}',
      }),
    ).toBe("timeout");
    // Generic Chinese server errors
    expect(resolveFailoverReasonFromError({ message: "系统错误，请稍后重试" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "服务器内部错误" })).toBe("timeout");
  });

  it("treats Chinese provider auth errors as auth for failover", () => {
    // ZhipuAI/GLM 403: "您无权访问glm-5.1" — real production error
    expect(resolveFailoverReasonFromError({ message: "403 您无权访问glm-5.1。" })).toBe("auth");
    expect(resolveFailoverReasonFromError({ message: "认证失败" })).toBe("auth");
    expect(resolveFailoverReasonFromError({ message: "鉴权失败，请检查API Key" })).toBe("auth");
  });

  it("treats overloaded provider payloads as overloaded", () => {
    expect(
      resolveFailoverReasonFromError({
        message: ANTHROPIC_OVERLOADED_PAYLOAD,
      }),
    ).toBe("overloaded");
  });

  it("keeps raw-text 402 weekly/monthly limit errors in billing", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "402 Payment Required: Weekly/Monthly Limit Exhausted",
      }),
    ).toBe("billing");
  });

  it("keeps temporary 402 spend limits retryable without downgrading explicit billing", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: "Monthly spend limit reached. Please visit your billing settings.",
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: "Workspace spend limit reached. Contact your admin.",
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message:
          "You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access. Learn more: https://zenmux.ai/docs/guide/subscription.html",
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: `${"x".repeat(520)} insufficient credits. Monthly spend limit reached.`,
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message: TOGETHER_MONTHLY_SPEND_CAP_MESSAGE,
      }),
    ).toBe("billing");
  });

  it("keeps raw 402 wrappers aligned with status-split temporary spend limits", () => {
    const message = "Monthly spend limit reached. Please visit your billing settings.";
    expect(
      resolveFailoverReasonFromError({
        message: `402 Payment Required: ${message}`,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message,
      }),
    ).toBe("rate_limit");
  });

  it("keeps explicit 402 rate-limit wrappers aligned with status-split payloads", () => {
    const message = "rate limit exceeded";
    expect(
      resolveFailoverReasonFromError({
        message: `HTTP 402 Payment Required: ${message}`,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message,
      }),
    ).toBe("rate_limit");
  });

  it("keeps plan-upgrade 402 wrappers aligned with status-split billing payloads", () => {
    const message = "Your usage limit has been reached. Please upgrade your plan.";
    expect(
      resolveFailoverReasonFromError({
        message: `HTTP 402 Payment Required: ${message}`,
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        status: 402,
        message,
      }),
    ).toBe("billing");
  });

  it("infers format errors from error messages", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "invalid request format: messages.1.content.1.tool_use.id",
      }),
    ).toBe("format");
  });

  it("infers timeout from common node error codes", () => {
    expect(resolveFailoverReasonFromError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "ECONNREFUSED" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "ECONNRESET" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "EAI_AGAIN" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "EHOSTUNREACH" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "EHOSTDOWN" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "ENETRESET" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "ENETUNREACH" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "EPIPE" })).toBe("timeout");
  });

  it("infers rate-limit and overload from symbolic error codes", () => {
    expect(resolveFailoverReasonFromError({ code: "RESOURCE_EXHAUSTED" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ code: "THROTTLING_EXCEPTION" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ code: "OVERLOADED_ERROR" })).toBe("overloaded");
  });

  it("infers timeout from abort/error stop-reason messages", () => {
    expect(resolveFailoverReasonFromError({ message: "Unhandled stop reason: abort" })).toBe(
      "timeout",
    );
    expect(resolveFailoverReasonFromError({ message: "Unhandled stop reason: error" })).toBe(
      "timeout",
    );
    expect(resolveFailoverReasonFromError({ message: "stop reason: abort" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "stop reason: error" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "reason: abort" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "reason: error" })).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({ message: "Unhandled stop reason: network_error" }),
    ).toBe("timeout");
  });

  it("infers timeout from connection/network error messages", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "model_cooldown: All credentials for model gpt-5 are cooling down",
      }),
    ).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ message: "Connection error." })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "fetch failed" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "Network error: ECONNREFUSED" })).toBe(
      "timeout",
    );
    expect(
      resolveFailoverReasonFromError({
        message: "dial tcp: lookup api.example.com: no such host (ENOTFOUND)",
      }),
    ).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "temporary dns failure EAI_AGAIN" })).toBe(
      "timeout",
    );
  });

  it("treats AbortError reason=abort as timeout", () => {
    const err = Object.assign(new Error("aborted"), {
      name: "AbortError",
      reason: "reason: abort",
    });
    expect(isTimeoutError(err)).toBe(true);
  });

  it("classifies abort-wrapped RESOURCE_EXHAUSTED as rate_limit", () => {
    const err = Object.assign(new Error("request aborted"), {
      name: "AbortError",
      cause: {
        error: {
          code: 429,
          message: GEMINI_RESOURCE_EXHAUSTED_MESSAGE,
          status: "RESOURCE_EXHAUSTED",
        },
      },
    });

    expect(resolveFailoverReasonFromError(err)).toBe("rate_limit");
    expect(coerceToFailoverError(err)?.reason).toBe("rate_limit");
    expect(coerceToFailoverError(err)?.status).toBe(429);
  });

  it("lets wrapped causes override parent context-overflow classifications", () => {
    const err = new Error("INVALID_ARGUMENT: input exceeds the maximum number of tokens", {
      cause: { code: "RESOURCE_EXHAUSTED" },
    });

    expect(resolveFailoverReasonFromError(err)).toBe("rate_limit");
    expect(coerceToFailoverError(err)?.reason).toBe("rate_limit");
  });

  it("coerces failover-worthy errors into FailoverError with metadata", () => {
    const err = coerceToFailoverError("credit balance too low", {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(err?.name).toBe("FailoverError");
    expect(err?.reason).toBe("billing");
    expect(err?.status).toBe(402);
    expect(err?.provider).toBe("anthropic");
    expect(err?.model).toBe("claude-opus-4-6");
  });

  it("preserves raw provider error text for diagnostic logs", () => {
    const err = new FailoverError("LLM request failed: provider rejected the request schema.", {
      reason: "format",
      provider: "openai",
      model: "gpt-5.4",
      status: 400,
      rawError:
        "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.",
    });

    const description = describeFailoverError(err);
    expect(description.message).toBe("LLM request failed: provider rejected the request schema.");
    expect(description.rawError).toBe(
      "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.",
    );
    expect(description.reason).toBe("format");
    expect(description.status).toBe(400);
  });

  it("coerces JSON-wrapped OpenRouter stealth-model 404s into FailoverError", () => {
    const err = coerceToFailoverError(OPENROUTER_MODEL_NOT_FOUND_PAYLOAD, {
      provider: "openrouter",
      model: "openrouter/healer-alpha",
    });

    expect(err?.reason).toBe("model_not_found");
    expect(err?.status).toBe(404);
  });

  it("maps overloaded to a 503 fallback status", () => {
    expect(resolveFailoverStatus("overloaded")).toBe(503);
  });

  it("maps server_error to a 500 fallback status", () => {
    expect(resolveFailoverStatus("server_error")).toBe(500);
  });

  it("coerces format errors with a 400 status", () => {
    const err = coerceToFailoverError("invalid request format", {
      provider: "google",
      model: "cloud-code-assist",
    });
    expect(err?.reason).toBe("format");
    expect(err?.status).toBe(400);
  });

  it("401/403 with generic message still returns auth (backward compat)", () => {
    expect(resolveFailoverReasonFromError({ status: 401, message: "Unauthorized" })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 403, message: "Forbidden" })).toBe("auth");
  });

  it("401 with ambiguous auth message returns auth", () => {
    expect(resolveFailoverReasonFromError({ status: 401, message: "invalid_api_key" })).toBe(
      "auth",
    );
  });

  it("403 with revoked key message returns auth_permanent", () => {
    expect(resolveFailoverReasonFromError({ status: 403, message: "api key revoked" })).toBe(
      "auth_permanent",
    );
  });

  it("403 OpenRouter 'Key limit exceeded' returns billing (model fallback trigger)", () => {
    // GitHub: openclaw/openclaw#53849 — OpenRouter returns 403 with "Key limit exceeded"
    // when the monthly key spending limit is reached. This must trigger billing failover
    // (model fallback), not generic auth.
    expect(
      resolveFailoverReasonFromError({
        provider: "openrouter",
        status: 403,
        message: "Key limit exceeded",
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "openrouter",
        status: 403,
        message: "403 Key limit exceeded (monthly limit)",
      }),
    ).toBe("billing");
  });

  it("403 OpenRouter API-key budget limit errors return billing", () => {
    expect(
      resolveFailoverReasonFromError({
        provider: "openrouter",
        status: 403,
        message: "403 API key budget limit exceeded (monthly limit). Contact your org admin.",
      }),
    ).toBe("billing");
  });

  it("uses model-fallback provider context for OpenRouter API-key budget limit errors", () => {
    const err = coerceToFailoverError(
      Object.assign(
        new Error("403 API key budget limit exceeded (monthly limit). Contact your org admin."),
        { status: 403 },
      ),
      { provider: "openrouter", model: "xiaomi/mimo-v2-pro" },
    );

    expect(err?.reason).toBe("billing");
  });

  it("401 billing-style message returns billing instead of generic auth", () => {
    expect(
      resolveFailoverReasonFromError({
        provider: "openrouter",
        status: 401,
        message: "401 Key limit exceeded (monthly limit)",
      }),
    ).toBe("billing");
  });

  it("does not treat OpenRouter key-limit text as billing without provider context", () => {
    expect(resolveFailoverReasonFromError({ message: "Key limit exceeded" })).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        status: 403,
        message: "403 Key limit exceeded (monthly limit)",
      }),
    ).toBe("auth");
  });

  it("resolveFailoverStatus maps auth_permanent to 403", () => {
    expect(resolveFailoverStatus("auth_permanent")).toBe(403);
  });

  it("coerces ambiguous auth error into the short auth lane", () => {
    const err = coerceToFailoverError(
      { status: 401, message: "invalid_api_key" },
      { provider: "anthropic", model: "claude-opus-4-6" },
    );
    expect(err?.reason).toBe("auth");
    expect(err?.provider).toBe("anthropic");
  });

  it("403 bare permission_error returns auth", () => {
    expect(resolveFailoverReasonFromError({ status: 403, message: "permission_error" })).toBe(
      "auth",
    );
  });

  it("permission_error with organization denial stays auth_permanent", () => {
    const err = coerceToFailoverError(
      "HTTP 403 permission_error: OAuth authentication is currently not allowed for this organization.",
      { provider: "anthropic", model: "claude-opus-4-6" },
    );
    expect(err?.reason).toBe("auth_permanent");
  });

  it("'not allowed for this organization' classifies as auth_permanent", () => {
    const err = coerceToFailoverError(
      "OAuth authentication is currently not allowed for this organization",
      { provider: "anthropic", model: "claude-opus-4-6" },
    );
    expect(err?.reason).toBe("auth_permanent");
  });

  it("describes non-Error values consistently", () => {
    const described = describeFailoverError(123);
    expect(described.message).toBe("123");
    expect(described.reason).toBeUndefined();
  });

  it("classifies OpenAI-compatible server_error payloads at the error boundary", () => {
    expect(
      resolveFailoverReasonFromError({
        message: OPENAI_SERVER_ERROR_PAYLOAD,
      }),
    ).toBe("server_error");
    expect(
      resolveFailoverReasonFromError({
        status: 500,
        message: OPENAI_SERVER_ERROR_PAYLOAD,
      }),
    ).toBe("server_error");

    const err = coerceToFailoverError(
      {
        status: 500,
        message: OPENAI_SERVER_ERROR_PAYLOAD,
      },
      { provider: "openai-codex", model: "gpt-5.4" },
    );
    expect(err?.reason).toBe("server_error");
    expect(err?.status).toBe(500);
  });

  it("keeps explicit 4xx classification ahead of server_error markers", () => {
    const payload = '{"type":"error","error":{"type":"server_error","code":"server_error"}}';

    expect(resolveFailoverReasonFromError({ status: 401, message: payload })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 402, message: payload })).toBe("billing");
    expect(resolveFailoverReasonFromError({ status: 422, message: payload })).toBe("format");
    expect(resolveFailoverReasonFromError(`402 Payment Required ${payload}`)).toBe("billing");
  });

  it("propagates sessionId/lane/provider attribution through FailoverError (#42713)", () => {
    const err = new FailoverError("all fallbacks exhausted", {
      reason: "rate_limit",
      provider: "anthropic",
      model: "claude-opus-4-6",
      profileId: "profile-2",
      sessionId: "session:browser-abcd",
      lane: "answer",
      status: 429,
    });
    expect(err.sessionId).toBe("session:browser-abcd");
    expect(err.lane).toBe("answer");
    const description = describeFailoverError(err);
    expect(description.provider).toBe("anthropic");
    expect(description.model).toBe("claude-opus-4-6");
    expect(description.profileId).toBe("profile-2");
    expect(description.sessionId).toBe("session:browser-abcd");
    expect(description.lane).toBe("answer");
    expect(description.reason).toBe("rate_limit");
    expect(description.status).toBe(429);
  });

  it("coerceToFailoverError carries sessionId/lane from context (#42713)", () => {
    const err = coerceToFailoverError("rate limit exceeded", {
      provider: "openai",
      model: "gpt-5",
      profileId: "p1",
      sessionId: "session:browser-1234",
      lane: "draft",
    });
    expect(err?.sessionId).toBe("session:browser-1234");
    expect(err?.lane).toBe("draft");
    expect(err?.provider).toBe("openai");
  });
});
