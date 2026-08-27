// Covers provider hook structured failover signals.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAssistantFailoverReason } from "../embedded-agent-helpers/assistant-message-failures.js";
import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyFailoverSignal } from "./classify.js";

const providerRuntimeMocks = vi.hoisted(() => {
  const runtime = { classifyProviderFailoverSignalWithPlugin: vi.fn() };
  return { ...runtime, requireProviderRuntime: vi.fn(() => runtime) };
});

vi.mock("../../logging/node-require.js", () => ({
  resolveNodeRequireFromMeta: () => providerRuntimeMocks.requireProviderRuntime,
}));

describe("provider failover hook structured signals", () => {
  beforeEach(() => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReset();
    providerRuntimeMocks.requireProviderRuntime.mockClear();
  });

  it("does not resolve provider runtime for a generic non-ambiguous error", () => {
    expect(
      classifyFailoverSignal({ provider: "demo-provider", message: "503 service unavailable" }),
    ).toEqual({ kind: "reason", reason: "overloaded" });
    expect(providerRuntimeMocks.requireProviderRuntime).not.toHaveBeenCalled();
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
    expect(providerRuntimeMocks.requireProviderRuntime).toHaveBeenCalledTimes(1);
    expect(providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(1);
  });

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
      expect(
        classifyProviderRuntimeFailureKind({
          provider: "anthropic",
          message: "",
          errorType,
        }),
      ).toBe(runtimeKind);
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
});
