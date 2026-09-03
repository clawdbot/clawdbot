// Covers provider hook structured failover signals.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../../shared/assistant-error-format.js";
import { buildApiErrorObservationFields } from "../embedded-agent-error-observation.js";
import { classifyAssistantFailoverReason } from "../embedded-agent-helpers/assistant-message-failures.js";
import {
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
} from "../embedded-agent-helpers/error-text.js";
import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyFailoverSignal } from "./classify.js";
import { formatBillingErrorMessage, PROVIDER_SCHEMA_REJECTION_USER_TEXT } from "./user-copy.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

vi.mock("../../plugins/provider-failover.js", () => providerRuntimeMocks);

describe("provider failover hook structured signals", () => {
  beforeEach(() => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReset();
  });

  it.each([
    {
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
      copy: "LLM streaming response contained a malformed fragment. Please try again.",
      runtimeKind: "unclassified",
    },
    {
      errorMessage: "opaque provider refusal",
      copy: "⚠️ openai/test-model request failed.",
      runtimeKind: "unclassified",
    },
    {
      errorMessage: "model input limit reached",
      copy: "⚠️ openai/test-model request failed.",
      runtimeKind: "unclassified",
    },
    {
      errorMessage: "Request size exceeds model context window",
      copy: "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      runtimeKind: "unclassified",
    },
    {
      errorMessage: '429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}',
      copy: "⚠️ API rate limit reached. Please try again later.",
      runtimeKind: "rate_limit",
    },
  ])(
    "presents and observes $errorMessage without provider discovery",
    ({ errorMessage, copy, runtimeKind }) => {
      const message = makeAssistantMessageFixture({ errorMessage });
      expect(formatUserFacingAssistantErrorText(message)).toBe(copy);
      expect
        .soft(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin)
        .not.toHaveBeenCalled();
      providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockClear();
      expect(
        buildApiErrorObservationFields(errorMessage, { provider: message.provider }),
      ).toMatchObject({
        providerRuntimeFailureKind: runtimeKind,
        rawErrorHash: expect.stringMatching(/^sha256:/),
      });
      expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it.each(["billing", "rate_limit", "context_overflow", "model_not_found", "format"] as const)(
    "presents prepared %s policy with the full signal and no rediscovery",
    (reason) => {
      const classifyFailoverReason = vi.fn(() => reason);
      const matchesContextOverflowError = vi.fn(() => reason === "context_overflow");
      const message = makeAssistantMessageFixture({
        provider: "custom-route",
        errorMessage: "403 fixture refusal",
        errorCode: "PROVIDER_CODE",
        errorType: "PROVIDER_TYPE",
      });
      const copies = {
        billing: formatBillingErrorMessage("custom-route", message.model),
        rate_limit: "⚠️ API rate limit reached. Please try again later.",
        context_overflow:
          "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
        model_not_found:
          "The selected model was not found by the provider. Check the model id or choose a different model.",
        format: PROVIDER_SCHEMA_REJECTION_USER_TEXT,
      };
      expect(
        formatUserFacingAssistantErrorText(message, {
          provider: "custom-route",
          providerOwner: {
            id: "prepared-owner",
            matchesContextOverflowError,
            classifyFailoverReason,
          },
        }),
      ).toBe(copies[reason]);
      expect(matchesContextOverflowError).toHaveBeenCalledWith({
        provider: "prepared-owner",
        status: 403,
        code: "PROVIDER_CODE",
        errorType: "PROVIDER_TYPE",
        errorMessage: message.errorMessage,
      });
      if (reason === "context_overflow") {
        expect(classifyFailoverReason).not.toHaveBeenCalled();
      } else {
        expect(classifyFailoverReason).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "prepared-owner",
            status: 403,
            code: "PROVIDER_CODE",
            errorType: "PROVIDER_TYPE",
          }),
        );
      }
      expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it.each([
    { errorCode: "RESOURCE_EXHAUSTED", copy: "⚠️ API rate limit reached. Please try again later." },
    {
      errorMessage: '400 {"error":{"type":"invalid_request_error","message":"provider refusal"}}',
      errorCode: "RESOURCE_EXHAUSTED",
      copy: "⚠️ API rate limit reached. Please try again later.",
    },
    { errorType: "invalid_request_error", copy: PROVIDER_SCHEMA_REJECTION_USER_TEXT },
    {
      errorMessage: undefined,
      errorCode: "RESOURCE_EXHAUSTED",
      copy: "⚠️ API rate limit reached. Please try again later.",
    },
    {
      errorMessage: undefined,
      errorType: "invalid_request_error",
      copy: PROVIDER_SCHEMA_REJECTION_USER_TEXT,
    },
    {
      errorMessage:
        '400 {"error":{"type":"invalid_request_error","message":"max_tokens (100) exceeds maximum output tokens (50)"}}',
      errorBody: '{"error":{"message":"insufficient credits"}}',
      copy: formatBillingErrorMessage(),
    },
    {
      errorBody: '{"error":{"message":"Request size exceeds model context window"}}',
      copy: "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
    },
    {
      errorBody: '{"error":{"message":"insufficient credits"}}',
      copy: formatBillingErrorMessage(),
    },
    {
      errorMessage: '{"error":{"type":"invalid_request_error","message":"provider refusal"}}',
      errorBody: '{"error":{"message":"insufficient credits"}}',
      copy: formatBillingErrorMessage(),
    },
    {
      errorMessage: '{"error":{"type":"invalid_request_error","message":"provider refusal"}}',
      errorCode: "RESOURCE_EXHAUSTED",
      copy: "⚠️ API rate limit reached. Please try again later.",
    },
  ])(
    "presents structured signal $errorCode $errorType $errorBody without discovery",
    ({ copy, ...fields }) => {
      expect(
        formatUserFacingAssistantErrorText(
          makeAssistantMessageFixture({
            errorMessage: "provider refusal",
            ...fields,
          }),
        ),
      ).toBe(copy);
      expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      errorCode: "DEACTIVATED_WORKSPACE",
      detail: "authentication was rejected",
      hint: "Re-authenticate the provider and try again.",
    },
    {
      errorType: "upstream_error",
      detail: "provider internal error",
      hint: "This is usually temporary — try again shortly.",
    },
    {
      errorBody: '{"error":{"type":"upstream_error"}}',
      detail: "provider internal error",
      hint: "This is usually temporary — try again shortly.",
    },
    {
      errorMessage: undefined,
      errorType: "upstream_error",
      detail: "provider internal error",
      hint: "This is usually temporary — try again shortly.",
    },
  ])(
    "carries structured $errorCode $errorType $errorBody into safe composed copy",
    ({ detail, hint, ...fields }) => {
      const message = makeAssistantMessageFixture({
        errorMessage:
          "RAW_BODY_CANARY Authorization: Bearer secret-canary https://private.invalid/body",
        ...fields,
      });
      const text = formatUserFacingAssistantErrorText(message);
      const expected = `⚠️ openai/test-model request failed (${detail}). ${hint}`;
      expect(text).toBe(expected);
      if ("errorMessage" in fields && fields.errorMessage === undefined) {
        expect(formatAssistantErrorText(message)).toBe(expected);
      }
      expect(text).not.toMatch(/RAW_BODY_CANARY|Authorization|secret-canary|private\.invalid/);
      expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it("carries a prepared owner's structured decision into safe composed copy", () => {
    const classifyFailoverReason = vi.fn(
      ({ code, errorType }: { code?: string; errorType?: string }) =>
        code === "OWNER_CODE" && errorType === "OWNER_TYPE" ? ("server_error" as const) : undefined,
    );
    const message = makeAssistantMessageFixture({
      provider: "custom-route",
      errorMessage:
        "403 RAW_BODY_CANARY Authorization: Bearer secret-canary https://private.invalid/body",
      errorCode: "OWNER_CODE",
      errorType: "OWNER_TYPE",
    });
    const text = formatUserFacingAssistantErrorText(message, {
      providerOwner: { id: "prepared-owner", classifyFailoverReason },
    });
    expect(text).toBe(
      "⚠️ custom-route/test-model request failed (provider internal error, HTTP 403). This is usually temporary — try again shortly.",
    );
    expect(text).not.toMatch(/RAW_BODY_CANARY|Authorization|secret-canary|private\.invalid/);
    expect(classifyFailoverReason).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "prepared-owner",
        status: 403,
        code: "OWNER_CODE",
        errorType: "OWNER_TYPE",
      }),
    );
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("does not resolve provider runtime for a generic non-ambiguous error", () => {
    expect(
      classifyFailoverSignal({ provider: "demo-provider", message: "503 service unavailable" }),
    ).toEqual({ kind: "reason", reason: "overloaded" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("resolves provider runtime for a context-shaped message", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(
      "context_overflow",
    );

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        message: "input exceeds the maximum context window",
      }),
    ).toEqual({ kind: "context_overflow" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "uses a prepared provider without registry dispatch (overflow=%s)",
    (overflow) => {
      const classifyFailoverReason = vi.fn(() => "billing" as const);
      const matchesContextOverflowError = vi.fn(() => overflow);
      expect(
        classifyFailoverSignal(
          { provider: "custom-route", status: 403, message: "fixture refusal" },
          {
            providerPlugin: {
              id: "prepared-owner",
              matchesContextOverflowError,
              classifyFailoverReason,
            },
          },
        ),
      ).toEqual(overflow ? { kind: "context_overflow" } : { kind: "reason", reason: "billing" });
      expect(matchesContextOverflowError).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "prepared-owner", status: 403 }),
      );
      expect(classifyFailoverReason).toHaveBeenCalledTimes(overflow ? 0 : 1);
      expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it("lets provider hooks refine ambiguous auth statuses from stable codes", () => {
    // HTTP 403 is ambiguous; provider-owned stable codes can refine it to
    // billing or rate-limit without weakening default auth handling.
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
      ({ context }) => {
        if (
          context.provider === "demo-provider" &&
          context.status === 403 &&
          context.code === "PROVIDER_RATE_LIMITED"
        ) {
          return "rate_limit";
        }
        return context.provider === "demo-provider" &&
          context.status === 403 &&
          context.code === "PROVIDER_QUOTA_EXHAUSTED"
          ? "billing"
          : undefined;
      },
    );

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_QUOTA_EXHAUSTED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_RATE_LIMITED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "rate_limit" });
    expect(
      classifyFailoverSignal({
        provider: "other-provider",
        status: 403,
        code: "PROVIDER_QUOTA_EXHAUSTED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "auth" });
  });

  it("lets provider billing text override a leading 403 in assistant failures", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
      ({ context }) => {
        return context.provider === "demo-provider" &&
          context.errorMessage.includes("quota exhausted")
          ? "billing"
          : undefined;
      },
    );

    const errorMessage = '403 {"error":"Account quota exhausted"}';
    expect(
      classifyAssistantFailoverReason(
        makeAssistantMessageFixture({ provider: "demo-provider", errorMessage }),
      ),
    ).toBe("billing");
    expect(
      classifyAssistantFailoverReason(
        makeAssistantMessageFixture({ provider: "other-provider", errorMessage }),
      ),
    ).toBe("auth");
  });

  it("consults the provider hook once with the fullest signal", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(null);

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_CODE",
        errorType: "PROVIDER_TYPE",
        message: "invalid_api_key",
      }),
    ).toEqual({ kind: "reason", reason: "auth" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(1);
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledWith({
      provider: "demo-provider",
      context: {
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_CODE",
        errorType: "PROVIDER_TYPE",
        errorMessage: "invalid_api_key",
      },
    });
  });

  it("uses provider-attributed inferred auth statuses only for scoped hook consultation", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
      ({ provider, context }) =>
        provider === "demo-provider" && (context.status === 403 || context.status === 429)
          ? "billing"
          : undefined,
    );

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        message: "403 concurrency limit breached",
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledWith({
      provider: "demo-provider",
      context: {
        provider: "demo-provider",
        errorMessage: "403 concurrency limit breached",
        status: 403,
        code: undefined,
        errorType: undefined,
      },
    });
    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        message: "429 API key budget limit exceeded",
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenLastCalledWith({
      provider: "demo-provider",
      context: {
        provider: "demo-provider",
        errorMessage: "429 API key budget limit exceeded",
        status: 429,
        code: undefined,
        errorType: undefined,
      },
    });
  });

  it("passes nested provider error types through failover error normalization", () => {
    // SDK wrappers often put the provider code under error.type; normalization
    // should preserve that code for provider hooks.
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
      ({ context }) => {
        return context.provider === "demo-provider" &&
          context.errorType === "PROVIDER_QUOTA_EXHAUSTED"
          ? "billing"
          : undefined;
      },
    );

    expect(
      resolveFailoverReasonFromError({
        provider: "demo-provider",
        status: 403,
        type: "error",
        error: {
          type: "PROVIDER_QUOTA_EXHAUSTED",
          message: "Forbidden",
        },
      }),
    ).toBe("billing");
  });

  it("classifies raw and typed invalid-request errors through one core mapping", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);
    const raw =
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.27.content.1: thinking blocks cannot be modified"}}';

    expect(classifyFailoverSignal({ provider: "anthropic", message: raw })).toEqual({
      kind: "reason",
      reason: "format",
    });
    expect(
      classifyFailoverSignal({
        provider: "anthropic",
        errorType: "invalid_request_error",
        message: "thinking blocks cannot be modified",
      }),
    ).toEqual({ kind: "reason", reason: "format" });
    expect(
      classifyAssistantFailoverReason(
        makeAssistantMessageFixture({
          provider: "anthropic",
          errorMessage: raw,
        }),
      ),
    ).toBe("format");
    expect(classifyProviderRuntimeFailureKind(raw)).toBe("schema");
  });

  it("classifies replay-invalid carriers as terminal format failures", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);
    const carriers = [
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
      'Validation error: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
    ];

    for (const errorMessage of carriers) {
      expect(classifyFailoverSignal({ provider: "anthropic", message: errorMessage })).toEqual({
        kind: "reason",
        reason: "format",
      });
      expect(
        classifyAssistantFailoverReason(
          makeAssistantMessageFixture({
            provider: "anthropic",
            errorMessage,
          }),
        ),
      ).toBe("format");
      expect(classifyProviderRuntimeFailureKind(errorMessage)).toBe("replay_invalid");
    }
  });

  it("keeps specific raw API error classifications ahead of invalid-request format", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);

    expect(
      classifyFailoverSignal({
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      }),
    ).toEqual({ kind: "context_overflow" });
    expect(
      classifyFailoverSignal({
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"You are out of extra usage. Add more at claude.ai/settings/usage"}}',
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
  });

  it("keeps specific typed API error classifications ahead of invalid-request format", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);

    expect(
      classifyFailoverSignal({
        provider: "anthropic",
        errorType: "invalid_request_error",
        message: "Request size exceeds model context window",
      }),
    ).toEqual({ kind: "context_overflow" });
    expect(
      classifyFailoverSignal({
        provider: "anthropic",
        errorType: "invalid_request_error",
        message: "You are out of extra usage. Add more at claude.ai/settings/usage",
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
  });

  it("lets structured billing details override an ambiguous quota message", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);
    const message = makeAssistantMessageFixture({
      provider: "openai",
      errorMessage: "You exceeded your current quota, please check your plan and billing details.",
      errorCode: "insufficient_quota",
      errorType: "insufficient_quota",
      errorBody: JSON.stringify({
        error: {
          code: "insufficient_quota",
          type: "insufficient_quota",
        },
      }),
    });

    expect(classifyAssistantFailoverReason(message)).toBe("billing");
  });

  it.each([
    { errorType: "rate_limit_error", reason: "rate_limit", runtimeKind: "rate_limit" },
    { errorType: "api_error", reason: "server_error", runtimeKind: "unclassified" },
  ] as const)(
    "classifies message-less Anthropic $errorType assistant failures",
    ({ errorType, reason, runtimeKind }) => {
      providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
        ({ context }) => {
          if (context.provider !== "anthropic") {
            return undefined;
          }
          if (context.errorType === "rate_limit_error") {
            return "rate_limit";
          }
          return context.errorType === "api_error" ? "server_error" : undefined;
        },
      );

      const message = makeAssistantMessageFixture({
        provider: "anthropic",
        errorMessage: undefined,
        errorType,
        content: [],
      });

      expect(classifyAssistantFailoverReason(message)).toBe(reason);
      const signal = { provider: "anthropic", message: "", errorType };
      expect(classifyProviderRuntimeFailureKind(signal)).toBe(runtimeKind);
      expect(classifyProviderRuntimeFailureKind(signal, { providerPlugin: null })).toBe(
        "unclassified",
      );
    },
  );

  it.each([
    { provider: "google", code: "SERVER_ERROR" },
    { provider: "anthropic", code: "INSUFFICIENT_QUOTA" },
    { provider: "openai", code: "INTERNAL" },
    { provider: "openai", code: "DEADLINE_EXCEEDED" },
    { provider: "anthropic", code: "UNAVAILABLE" },
    { provider: "google", code: "API_ERROR" },
    { provider: "google", code: "RATE_LIMIT_ERROR" },
  ] as const)(
    "does not apply provider-native $code semantics to non-owner $provider",
    ({ provider, code }) => {
      providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);

      expect(classifyFailoverSignal({ provider, code, message: "" })).toBeNull();
      expect(classifyProviderRuntimeFailureKind({ provider, code, message: "" })).toBe(
        "unclassified",
      );
    },
  );

  it("consults message-only hooks without promoting generic SDK type strings", () => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue("billing");

    expect(
      resolveFailoverReasonFromError({
        provider: "demo-provider",
        type: "api_error",
        message: "unclassified provider failure",
      }),
    ).toBe("billing");
    expect(
      resolveFailoverReasonFromError({
        provider: "demo-provider",
        message: "unclassified provider failure",
        detail: { type: "api_error" },
      }),
    ).toBe("billing");
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(2);
    for (const [call] of providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mock.calls) {
      expect(call).toEqual({
        provider: "demo-provider",
        context: {
          provider: "demo-provider",
          status: undefined,
          code: undefined,
          errorType: undefined,
          errorMessage: "unclassified provider failure",
        },
      });
    }
  });

  it("routes a preserved server_error code to server_error instead of timeout (#117609)", () => {
    // The OpenAI provider hook maps SERVER_ERROR -> server_error. When the
    // structured code is preserved at the transport boundary, hasStructuredDescriptor
    // becomes true, the hook is consulted, and it outranks the prose classifier.
    // The folded message "server_error: ..." otherwise matches isServerErrorMessage
    // (ERROR_PATTERNS.serverError includes "server_error") and classifies as timeout
    // with the hook skipped. Same message, only the preserved code differs.
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
      ({ context }) =>
        context.provider === "openai" && context.code === "server_error"
          ? "server_error"
          : undefined,
    );

    // Pre-fix shape: code lost in normalization -> no structured descriptor ->
    // hook skipped -> prose misclassifies as timeout.
    expect(
      classifyFailoverSignal({
        provider: "openai",
        message: "server_error: provider failed",
      }),
    ).toEqual({ kind: "reason", reason: "timeout" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();

    // Post-fix shape: code preserved -> hook consulted -> server_error.
    expect(
      classifyFailoverSignal({
        provider: "openai",
        code: "server_error",
        message: "server_error: provider failed",
      }),
    ).toEqual({ kind: "reason", reason: "server_error" });
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(1);
  });
});
