/**
 * Regression coverage for provider/model failover classification.
 * Exercises raw error coercion, remediation hints, timeout/auth/billing/rate-limit cases.
 */
import { describe, expect, it } from "vitest";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import {
  buildFailoverRemediationHint,
  buildProviderReauthCommand,
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  findCliTimeoutError,
  hasProviderRequestSizeCeiling,
  isNonProviderRuntimeCoordinationError,
  isSignalTimeoutReason,
  isTimeoutError,
  resolveFailoverReasonFromError,
  resolveFailoverStatus,
  resolveModelFallbackError,
} from "./failover-error.js";

// OpenAI 429 example shape: https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors
const OPENAI_RATE_LIMIT_MESSAGE =
  "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.";
// Anthropic overloaded_error example shape: https://docs.anthropic.com/en/api/errors
const ANTHROPIC_OVERLOADED_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}';
// Gemini RESOURCE_EXHAUSTED troubleshooting example: https://ai.google.dev/gemini-api/docs/troubleshooting
const GEMINI_RESOURCE_EXHAUSTED_MESSAGE =
  "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).";
// Issue-backed Moonshot/Kimi exhausted-balance shape surfaced under HTTP 429 (#43447).
const MOONSHOT_INSUFFICIENT_BALANCE_429_PAYLOAD =
  '{"error":{"type":"rate_limit_reached","message":"Insufficient account balance. Please recharge your Moonshot account."}}';
const OPENROUTER_MODEL_NOT_FOUND_PAYLOAD =
  '{"error":{"message":"Healer Alpha was a stealth model revealed on March 18th as an early testing version of MiMo-V2-Omni. Find it here: https://openrouter.ai/xiaomi/mimo-v2-omni","code":404},"user_id":"user_33GTyP8uDSYYbaeBO48AGHXyuMC"}';
// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';
// Structured OpenAI-compatible server_error payload shape seen in Codex/OpenAI runs.
const OPENAI_SERVER_ERROR_PAYLOAD =
  'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}';

describe("failover-error", () => {
  it("finds structured CLI timeout context through aggregate wrappers", () => {
    const timeout = new FailoverError("CLI exceeded timeout", {
      reason: "timeout",
      code: "cli_overall_timeout",
      cliTimeout: {
        mode: "overall",
        timeoutSeconds: 600,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 1,
      },
    });
    const aggregate = new AggregateError([{ cause: timeout }], "CLI turn failed");

    expect(findCliTimeoutError(aggregate)).toBe(timeout);
  });

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
    expect(resolveFailoverReasonFromError({ statusCode: "+429" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ statusCode: "0x1ad" })).toBeNull();
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

  it("classifies certificate failures separately from timeouts", () => {
    expect(
      resolveFailoverReasonFromError({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        message: "Hostname/IP does not match certificate's altnames",
      }),
    ).toBe("tls_certificate");
    expect(
      resolveFailoverReasonFromError(
        new TypeError("fetch failed", {
          cause: {
            code: "CERT_HAS_EXPIRED",
            message: "certificate has expired",
          },
        }),
      ),
    ).toBe("tls_certificate");
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        code: "CERT_HAS_EXPIRED",
        message: "certificate field rejected",
      }),
    ).toBe("format");
    expect(resolveFailoverStatus("tls_certificate")).toBe(502);
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

  it("lets an overloaded payload override timeout-shaped HTTP 499", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 499,
        message: ANTHROPIC_OVERLOADED_PAYLOAD,
      }),
    ).toBe("overloaded");
  });

  it("lets Moonshot/Kimi billing-shaped 429 payloads win over generic rate limit status", () => {
    expect(
      resolveFailoverReasonFromError({
        provider: "moonshot",
        status: 429,
        message: MOONSHOT_INSUFFICIENT_BALANCE_429_PAYLOAD,
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError(
        {
          status: 429,
          message: MOONSHOT_INSUFFICIENT_BALANCE_429_PAYLOAD,
        },
        "kimi-claw",
      ),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "moonshot",
        status: 429,
        message: OPENAI_RATE_LIMIT_MESSAGE,
      }),
    ).toBe("rate_limit");
    expect(
      resolveFailoverReasonFromError({
        provider: "openai",
        status: 429,
        message: MOONSHOT_INSUFFICIENT_BALANCE_429_PAYLOAD,
      }),
    ).toBe("rate_limit");
  });

  it("classifies account-restricted model 400s as model_not_found (#104490)", () => {
    // Codex/OpenAI reject plan-restricted models with HTTP 400
    // invalid_request_error; without a model_not_found classification the 400
    // branch collapses this into "format" and users get generic retry//new copy
    // for a config-only failure.
    const codexAccountRestrictedPayload =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5-pro\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(
      resolveFailoverReasonFromError({
        provider: "codex",
        status: 400,
        message: codexAccountRestrictedPayload,
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

  it("classifies the bare shared model runtime stream wrapper as timeout (#71620)", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "An unknown error occurred",
      }),
    ).toBe("timeout");
  });

  it("treats 400 insufficient_quota payloads as billing instead of format", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: INSUFFICIENT_QUOTA_PAYLOAD,
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "openai",
        status: 429,
        message: INSUFFICIENT_QUOTA_PAYLOAD,
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "openai",
        status: 429,
        message: '{"error":"insufficient_balance","message":"Your credit balance is too low."}',
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "openai",
        status: 429,
        message: '{"error":"insufficient_balance","message":"Insufficient account balance"}',
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "openai",
        status: 429,
        message:
          'HTTP 429: {"error":"insufficient_balance","message":"Insufficient account balance"}',
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "openai",
        status: 429,
        message: "This model requires more credits to use",
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

  it("classifies structured HTTP 400 context overflow payloads without using format", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
      }),
    ).toBe("context_overflow");
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

  it("uses structured OpenAI-compatible param detail for model-not-found 400s", () => {
    const err = Object.assign(new Error("400 Param Incorrect"), {
      status: 400,
      code: "400",
      param: "Not supported model some-model-id",
      error: {
        code: "400",
        message: "Param Incorrect",
        param: "Not supported model some-model-id",
      },
    });

    expect(resolveFailoverReasonFromError(err)).toBe("model_not_found");
    expect(describeFailoverError(err)).toMatchObject({
      message: "400 Param Incorrect",
      reason: "model_not_found",
      status: 400,
      code: "400",
    });
  });

  it("keeps unsupported capability details classified as format", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "400 Param Incorrect",
        error: {
          message: "Param Incorrect",
          param: "This model is not supported for tool calling.",
        },
      }),
    ).toBe("format");
  });

  it("treats HTTP 422 as format error", () => {
    expect(
      resolveFailoverReasonFromError({
        status: 422,
        message: "check open ai req parameter error",
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
    expect(resolveFailoverReasonFromError({ code: "ERR_STREAM_PREMATURE_CLOSE" })).toBe("timeout");
  });

  it("infers rate-limit and overload from symbolic error codes", () => {
    expect(resolveFailoverReasonFromError({ code: "RESOURCE_EXHAUSTED" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ code: "THROTTLING_EXCEPTION" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ code: "OVERLOADED_ERROR" })).toBe("overloaded");
  });

  it("infers timeout from connection/network error messages", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "stream disconnected before completion: response.completed was not received",
      }),
    ).toBe("timeout");
    expect(
      resolveFailoverReasonFromError({
        message:
          "Premature close of server response while trying to fetch https://api.example.test",
      }),
    ).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "Premature close" })).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        message: "stream disconnected while copying a local archive",
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        message: "worker reported a premature close while compressing logs",
      }),
    ).toBeNull();
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

  it("classifies a structured prompt error independently of its wording", () => {
    const promptError = Object.assign(new Error("quota exhausted"), { status: 429 as const });
    const failoverError = coerceToFailoverError(promptError, {
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(failoverError?.reason).toBe("rate_limit");
    expect(failoverError?.status).toBe(429);
    expect(failoverError?.message).toBe("quota exhausted");
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
      authMode: "oauth",
    });
    expect(err?.name).toBe("FailoverError");
    expect(err?.reason).toBe("billing");
    expect(err?.status).toBe(402);
    expect(err?.provider).toBe("anthropic");
    expect(err?.model).toBe("claude-opus-4-6");
    expect(err?.authMode).toBe("oauth");
  });

  it("enriches an existing FailoverError with the active auth mode", () => {
    const original = new FailoverError("credit balance too low", {
      reason: "billing",
      provider: "anthropic",
      model: "claude-opus-4-6",
      profileId: "anthropic:default",
      status: 402,
    });

    const err = coerceToFailoverError(original, { authMode: "token" });

    expect(err).not.toBe(original);
    expect(err).toMatchObject({
      reason: "billing",
      provider: "anthropic",
      model: "claude-opus-4-6",
      profileId: "anthropic:default",
      authMode: "token",
      status: 402,
    });
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

  it("403 with revoked key message returns auth_permanent", () => {
    expect(resolveFailoverReasonFromError({ status: 403, message: "api key revoked" })).toBe(
      "auth_permanent",
    );
  });

  it("Codex deactivated workspace marker returns auth_permanent", () => {
    expect(resolveFailoverReasonFromError({ code: "deactivated_workspace" })).toBe(
      "auth_permanent",
    );
    expect(
      resolveFailoverReasonFromError({
        detail: { code: "deactivated_workspace" },
      }),
    ).toBe("auth_permanent");
    expect(
      resolveFailoverReasonFromError({
        status: 403,
        message: "Forbidden",
        detail: { code: "deactivated_workspace" },
      }),
    ).toBe("auth_permanent");
    expect(
      resolveFailoverReasonFromError({
        status: 400,
        message: "Bad request",
        detail: { code: "deactivated_workspace" },
      }),
    ).toBe("auth_permanent");
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

  it("preserves a selected-profile error code in the auth failover lane", () => {
    const err = coerceToFailoverError(
      Object.assign(new Error("selected profile missing"), {
        status: 401,
        code: "selected_auth_profile_unavailable",
      }),
      { provider: "openai", model: "gpt-5.6-sol" },
    );

    expect(err).toMatchObject({
      reason: "auth",
      status: 401,
      code: "selected_auth_profile_unavailable",
    });
  });

  it("permission_error with organization denial stays auth_permanent", () => {
    const err = coerceToFailoverError(
      "HTTP 403 permission_error: OAuth authentication is currently not allowed for this organization.",
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
    const err = coerceToFailoverError(
      {
        status: 500,
        message: OPENAI_SERVER_ERROR_PAYLOAD,
      },
      { provider: "openai", model: "gpt-5.4" },
    );
    expect(err?.reason).toBe("server_error");
    expect(err?.status).toBe(500);
  });

  it("propagates sessionId/lane/provider attribution through FailoverError (#42713)", () => {
    const err = new FailoverError("all fallbacks exhausted", {
      reason: "rate_limit",
      provider: "anthropic",
      model: "claude-opus-4-6",
      profileId: "profile-2",
      authMode: "oauth",
      sessionId: "session:browser-abcd",
      lane: "answer",
      status: 429,
      code: "selected_auth_profile_unavailable",
    });
    expect(err.sessionId).toBe("session:browser-abcd");
    expect(err.lane).toBe("answer");
    const description = describeFailoverError(err);
    expect(description.provider).toBe("anthropic");
    expect(description.model).toBe("claude-opus-4-6");
    expect(description.profileId).toBe("profile-2");
    expect(description.authMode).toBe("oauth");
    expect(description.sessionId).toBe("session:browser-abcd");
    expect(description.lane).toBe("answer");
    expect(description.reason).toBe("rate_limit");
    expect(description.status).toBe(429);
    expect(description.code).toBe("selected_auth_profile_unavailable");
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

  describe("isNonProviderRuntimeCoordinationError", () => {
    it("returns true for stale gateway lifecycle ownership loss", () => {
      const staleLifecycle = createAgentRunStaleLifecycleError();
      expect(isNonProviderRuntimeCoordinationError(staleLifecycle)).toBe(true);
      expect(
        isNonProviderRuntimeCoordinationError(new Error("wrapper", { cause: staleLifecycle })),
      ).toBe(true);
    });

    it.each([
      ["availability", "WorkerRunnerUnavailableError", "The device runner is offline"],
      ["capacity", "WorkerRunnerCapacityError", "device worker capacity remained full"],
      [
        "workspace reconciliation",
        "WorkerWorkspaceReconciliationError",
        "cloud worker workspace result could not be reconciled",
      ],
    ])("returns true for direct and nested runner %s failures", (_label, name, message) => {
      const coordination = new Error(message);
      coordination.name = name;
      for (const error of [
        coordination,
        new Error("worker turn failed", { cause: coordination }),
      ]) {
        expect(isNonProviderRuntimeCoordinationError(error)).toBe(true);
        expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
      }
    });

    it("returns true for Codex missing tool-result local execution failures", () => {
      const missingToolResultMessage =
        "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.";
      expect(isNonProviderRuntimeCoordinationError({ reason: "missing_tool_result" })).toBe(true);
      expect(
        isNonProviderRuntimeCoordinationError({
          message: "codex app-server turn failed",
          cause: { result: { reason: "missing_tool_result" } },
        }),
      ).toBe(true);
      expect(resolveFailoverReasonFromError(new Error(missingToolResultMessage))).toBeNull();
    });

    it("returns false for plain timeouts and provider errors", () => {
      const timeoutErr = Object.assign(new Error("operation timed out"), { name: "TimeoutError" });
      expect(isNonProviderRuntimeCoordinationError(timeoutErr)).toBe(false);
      expect(
        isNonProviderRuntimeCoordinationError({
          status: 503,
          message: "upstream overloaded",
          cause: { result: { reason: "missing_tool_result" } },
        }),
      ).toBe(false);
      expect(
        isNonProviderRuntimeCoordinationError({
          status: 503,
          message: "upstream overloaded",
          cause: createAgentRunStaleLifecycleError(),
        }),
      ).toBe(false);
      expect(isNonProviderRuntimeCoordinationError(null)).toBe(false);
      expect(isNonProviderRuntimeCoordinationError(undefined)).toBe(false);
    });

    it("does not suppress provider fallback for unrelated free text mentioning the marker", () => {
      expect(isNonProviderRuntimeCoordinationError("reason=missing_tool_result")).toBe(false);
    });
  });
});

describe("buildFailoverRemediationHint", () => {
  it("returns a copy-pasteable login command for auth failures", () => {
    const err = new FailoverError("missing token", {
      reason: "auth",
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(buildFailoverRemediationHint(err)).toBe(
      "Re-authenticate with: openclaw models auth login --provider 'anthropic' --force",
    );
  });

  it("routes Gemini CLI auth failures to supported recovery paths", () => {
    const err = new FailoverError("revoked", {
      reason: "auth_permanent",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(buildFailoverRemediationHint(err)).toBe(
      "Authenticate in Gemini CLI directly, or configure a supported Google API key with: openclaw configure",
    );
  });

  it("quotes provider ids that contain shell metacharacters", () => {
    expect(buildProviderReauthCommand("custom;touch /tmp/pwned")).toBe(
      "openclaw models auth login --provider 'custom;touch /tmp/pwned' --force",
    );
    expect(buildProviderReauthCommand("custom'provider")).toBe(
      "openclaw models auth login --provider 'custom'\\''provider' --force",
    );
  });

  it("refuses control characters in rendered provider commands", () => {
    expect(buildProviderReauthCommand("custom\nprovider")).toBeUndefined();
  });

  it("wraps rendered provider commands in the standard CLI formatter", () => {
    expect(buildProviderReauthCommand("anthropic", { OPENCLAW_PROFILE: "work" })).toBe(
      "openclaw --profile work models auth login --provider 'anthropic' --force",
    );
    expect(buildProviderReauthCommand("anthropic", { OPENCLAW_CONTAINER_HINT: "dev" })).toBe(
      "openclaw --container dev models auth login --provider 'anthropic' --force",
    );
  });

  it("returns undefined for non-auth reasons", () => {
    const err = new FailoverError("429", {
      reason: "rate_limit",
      provider: "openai",
      model: "gpt-5",
    });
    expect(buildFailoverRemediationHint(err)).toBeUndefined();
  });

  it("returns undefined when provider is not attributed", () => {
    const err = new FailoverError("no token", {
      reason: "auth",
      model: "claude-opus-4-7",
    });
    expect(buildFailoverRemediationHint(err)).toBeUndefined();
  });

  it("returns undefined for non-FailoverError inputs", () => {
    expect(buildFailoverRemediationHint(new Error("oops"))).toBeUndefined();
    expect(buildFailoverRemediationHint(undefined)).toBeUndefined();
    expect(buildFailoverRemediationHint("just a string")).toBeUndefined();
  });
});

describe("isSignalTimeoutReason", () => {
  it("returns false for plain AbortController.abort() DOMException (client disconnect)", () => {
    // watchClientDisconnect calls abort() with no args, producing AbortError.
    // This must not be classified as a run timeout (#90764).
    const err = new DOMException("This operation was aborted", "AbortError");
    expect(isSignalTimeoutReason(err)).toBe(false);
  });

  it("returns false for AbortError whose message matches ABORT_TIMEOUT_RE", () => {
    // Old isTimeoutError returned true here via ABORT_TIMEOUT_RE (/request.*aborted/i).
    const err = Object.assign(new Error("request aborted"), { name: "AbortError" });
    expect(isSignalTimeoutReason(err)).toBe(false);
  });

  it("returns true for AbortSignal.timeout() DOMException", () => {
    const err = new DOMException("signal timed out", "TimeoutError");
    expect(isSignalTimeoutReason(err)).toBe(true);
  });

  it("returns true for makeTimeoutAbortReason()-style Error", () => {
    // makeTimeoutAbortReason() in attempt.ts: Error("request timed out", name="TimeoutError")
    const err = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    expect(isSignalTimeoutReason(err)).toBe(true);
  });

  it("returns false for null and undefined", () => {
    expect(isSignalTimeoutReason(null)).toBe(false);
    expect(isSignalTimeoutReason(undefined)).toBe(false);
  });
});

describe("hasProviderRequestSizeCeiling", () => {
  const GROQ_REQUEST_CEILING_413 =
    "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
    "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
    "please reduce your message size and try again.";

  it("reads the fact a failover error recorded from the provider's own text", () => {
    // The user-facing message no longer states the figures, which is the whole reason the fact
    // is recorded at construction rather than re-read here.
    const err = new FailoverError("Context overflow: prompt too large for the model.", {
      reason: "context_overflow",
      rawError: GROQ_REQUEST_CEILING_413,
    });
    expect(err.requestSizeCeiling).toBe(true);
    expect(hasProviderRequestSizeCeiling(err)).toBe(true);
  });

  it("reads an unnormalized error straight from its message", () => {
    expect(hasProviderRequestSizeCeiling(new Error(GROQ_REQUEST_CEILING_413))).toBe(true);
  });

  it.each(["error", "cause", "aggregate"])("finds the fact through a %s wrapper", (kind) => {
    const ceiling = new FailoverError("Context overflow: prompt too large for the model.", {
      reason: "context_overflow",
      rawError: GROQ_REQUEST_CEILING_413,
    });
    const wrapped =
      kind === "aggregate"
        ? new AggregateError([new Error("unrelated"), { cause: ceiling }], "agent run failed")
        : kind === "cause"
          ? new Error("agent run failed", { cause: ceiling })
          : { error: ceiling };
    expect(hasProviderRequestSizeCeiling(wrapped)).toBe(true);
  });

  it("is false for throttling that states a requested size within the limit", () => {
    const throttled =
      "429 Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): " +
      "Limit 8000, Used 7500, Requested 1000, please try again in 3.5s.";
    expect(hasProviderRequestSizeCeiling(new Error(throttled))).toBe(false);
    expect(
      new FailoverError("rate limited", { reason: "rate_limit", rawError: throttled })
        .requestSizeCeiling,
    ).toBe(false);
  });

  it("is false for a context overflow no provider ceiling explains", () => {
    const overflow = new FailoverError("Context overflow: prompt too large for the model.", {
      reason: "context_overflow",
      rawError: "400 input is too long for the model",
    });
    expect(hasProviderRequestSizeCeiling(overflow)).toBe(false);
  });

  it("is false for unrelated values", () => {
    expect(hasProviderRequestSizeCeiling(undefined)).toBe(false);
    expect(hasProviderRequestSizeCeiling(null)).toBe(false);
  });
});
