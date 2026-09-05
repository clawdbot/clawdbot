// Coverage for assistant failover decisions and auth-profile rotation.
import { describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { buildRealtimeVoiceAgentErrorProviderResult } from "../../../talk/agent-run-control.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { formatBillingErrorMessage } from "../../embedded-agent-helpers.js";
import { FailoverError } from "../../failover-error.js";
import { resolveAgentRunErrorLifecycleFields } from "../../run-termination.js";
import { handleAssistantFailover, isShortWindowRateLimitMessage } from "./assistant-failover.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

type Params = Parameters<typeof handleAssistantFailover>[0];
type Outcome = Awaited<ReturnType<typeof handleAssistantFailover>>;

function makeParams(overrides: Partial<Params> = {}): Params {
  // Defaults model a billing-classified provider failure; tests override only
  // the branch-specific signals they need.
  const provider = "Anthropic";
  const model = "claude-haiku-4-5-20251001";
  const terminal: Params["terminal"] = overrides.terminal ?? { kind: "ok" };
  const defaults: Params = {
    initialDecision: { action: "surface_error", reason: "billing" },
    terminal,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt: { terminal },
      assistant: undefined,
    }),
    fallbackConfigured: false,
    failoverFailure: true,
    failoverReason: "billing",
    harnessOwnsTransport: false,
    assistantProfileFailureReason: null,
    lastProfileId: undefined,
    modelId: model,
    provider,
    activeErrorContext: { provider, model },
    lastAssistant: undefined,
    config: undefined,
    sessionKey: undefined,
    authFailure: false,
    rateLimitFailure: false,
    billingFailure: true,
    cloudCodeAssistFormatError: false,
    isProbeSession: false,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 3,
    previousRetryFailoverReason: null,
    logAssistantFailoverDecision: vi.fn(),
    warn: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    getTransientRetryCount: () => 0,
    maybeRetryTransient: vi.fn(async () => false),
    advanceAuthProfile: vi.fn(async () => false),
    advanceRateLimitAuthProfile: vi.fn(async () => false),
  };
  return { ...defaults, ...overrides };
}

function expectThrownFailoverError(outcome: Outcome): FailoverError {
  // Surface-error branches return a throw outcome instead of throwing directly
  // so the runner can compose cleanup and logging around the decision.
  expect(outcome.action).toBe("throw");
  if (outcome.action !== "throw") {
    throw new Error("expected throw outcome");
  }
  expect(outcome.error).toBeInstanceOf(FailoverError);
  return outcome.error;
}

describe("handleAssistantFailover", () => {
  it.each([
    { action: "surface_error", terminal: { kind: "ok" }, timeout: false },
    { action: "fallback_model", terminal: { kind: "ok" }, timeout: false },
    {
      action: "fallback_model",
      terminal: { kind: "timeout", phase: "prompt", source: "idle" },
      timeout: true,
    },
    {
      action: "fallback_model",
      terminal: { kind: "timeout", phase: "compaction", source: "observation" },
      timeout: false,
    },
    {
      action: "fallback_model",
      terminal: { kind: "timeout", phase: "compaction", source: "runtime" },
      timeout: true,
    },
    {
      action: "fallback_model",
      terminal: { kind: "timeout", phase: "tool_execution", source: "runtime" },
      timeout: true,
    },
  ] satisfies Array<{
    action: "surface_error" | "fallback_model";
    terminal: Params["terminal"];
    timeout: boolean;
  }>)(
    "carries timeout facts independently of the retry reason ($action, $terminal, $timeout)",
    async ({ action, terminal, timeout }) => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action, reason: "timeout" },
          terminal,
          failoverReason: "timeout",
          billingFailure: false,
          lastAssistant: {
            errorMessage: "500 injected provider failure",
          } as Params["lastAssistant"],
        }),
      );
      const error = expectThrownFailoverError(outcome);

      expect(error.reason).toBe("timeout");
      const fields = resolveAgentRunErrorLifecycleFields(error, undefined);
      const providerTimeout = terminal.kind === "timeout" && terminal.phase === "prompt";
      expect(fields).toEqual(
        timeout
          ? {
              stopReason: "timeout",
              ...(providerTimeout ? { timeoutPhase: "provider", providerStarted: true } : {}),
            }
          : {},
      );
      expect(
        buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
      ).toBe(timeout ? (providerTimeout ? "hard_timeout" : "timed_out") : "failed");
    },
  );

  describe("rotate_profile branch", () => {
    it("rotates before waiting on auth profile failure marking", async () => {
      // Rotation is latency-sensitive; profile failure marking can persist in
      // the background after the next profile is selected.
      const events: string[] = [];
      let releaseMark: (() => void) | undefined;
      const markFinished = new Promise<void>((resolve) => {
        releaseMark = resolve;
      });
      const markSettled = new Promise<void>((resolve) => {
        void markFinished.then(() => resolve());
      });
      const maybeMarkAuthProfileFailure = vi.fn(async () => {
        events.push("mark-start");
        await markFinished;
        events.push("mark-finish");
      });

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          assistantProfileFailureReason: "rate_limit",
          lastProfileId: "openai:p1",
          billingFailure: false,
          rateLimitFailure: true,
          maybeMarkAuthProfileFailure,
          advanceRateLimitAuthProfile: vi.fn(async () => {
            events.push("advance");
            return true;
          }),
        }),
      );

      expect(outcome.action).toBe("retry");
      expect(events).toEqual(["advance", "mark-start"]);
      if (!releaseMark) {
        throw new Error("Expected auth profile failure mark release callback to be initialized");
      }
      releaseMark();
      await markSettled;
      await vi.waitFor(() => expect(events).toEqual(["advance", "mark-start", "mark-finish"]));
      expect(events).toEqual(["advance", "mark-start", "mark-finish"]);
    });

    it("retries the same model before spending a rate-limit profile rotation", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "HTTP 429 Too Many Requests: requests per minute exceeded",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("same_model_transient");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    });

    it("rotates when the rate-limit controller denies a same-model retry", async () => {
      const maybeRetryTransient = vi.fn(async () => false);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "HTTP 429 Too Many Requests: requests per minute exceeded",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("profile_rotation");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    });

    it("does not spend same-model retry budget on quota-style rate limits", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage:
              "You exceeded your current quota, please check your plan and billing details.",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("profile_rotation");
      expect(maybeRetryTransient).not.toHaveBeenCalled();
      expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    });

    it("does not treat bare 429 quota_exceeded as a short-window throttle", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "Provider API error (429): Quota exceeded [code=quota_exceeded]",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("profile_rotation");
      expect(maybeRetryTransient).not.toHaveBeenCalled();
      expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    });

    it("does not treat generic rate-limit text as a short-window throttle", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "rate limit exceeded",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("profile_rotation");
      expect(maybeRetryTransient).not.toHaveBeenCalled();
      expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    });

    it("retries the same model on a status-prefixed 429 with no window wording", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "429 Provider returned error",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("same_model_transient");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    });

    it("does not spend same-model retry budget when Retry-After is long", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "429 rate_limit_exceeded; Retry-After: 3600",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("profile_rotation");
      expect(maybeRetryTransient).not.toHaveBeenCalled();
      expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    });

    it("does not spend same-model retry budget when Retry-After date is beyond the retry budget", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
      try {
        const maybeRetryTransient = vi.fn(async () => true);
        const advanceRateLimitAuthProfile = vi.fn(async () => true);

        const outcome = await handleAssistantFailover(
          makeParams({
            initialDecision: { action: "rotate_profile", reason: "rate_limit" },
            failoverReason: "rate_limit",
            billingFailure: false,
            rateLimitFailure: true,
            lastAssistant: {
              errorMessage: "429 rate_limit_exceeded; Retry-After: Thu, 11 Jun 2026 01:05:00 GMT",
            } as Params["lastAssistant"],
            maybeRetryTransient,
            advanceRateLimitAuthProfile,
          }),
        );

        expect(outcome.action).toBe("retry");
        if (outcome.action !== "retry") {
          return;
        }
        expect(outcome.retryKind).toBe("profile_rotation");
        expect(maybeRetryTransient).not.toHaveBeenCalled();
        expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("allows short Retry-After intervals to use same-model retry", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "429 rate_limit_exceeded; Retry-After: 30 seconds",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("same_model_transient");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    });

    it("allows RESOURCE_EXHAUSTED messages with short-window 429 hints", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "429 RESOURCE_EXHAUSTED: tokens per minute limit exceeded",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("same_model_transient");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    });

    it("allows quota wording when it points at a per-minute throttle", async () => {
      const maybeRetryTransient = vi.fn(async () => true);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage:
              "Quota exceeded for quota metric 'Generate requests per minute' and limit 'Generate requests per minute per project'.",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("same_model_transient");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    });

    it("falls back to profile rotation after the same-model rate-limit budget is exhausted", async () => {
      const maybeRetryTransient = vi.fn(async () => false);
      const advanceRateLimitAuthProfile = vi.fn(async () => true);

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
          lastAssistant: {
            errorMessage: "429 rate_limit_exceeded: too many requests per minute",
          } as Params["lastAssistant"],
          maybeRetryTransient,
          advanceRateLimitAuthProfile,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("profile_rotation");
      expect(maybeRetryTransient).toHaveBeenCalledTimes(1);
      expect(advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    });

    it("does not log profile-specific warnings without a failed profile id", async () => {
      const warn = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "timeout" },
          failoverReason: "timeout",
          terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
          cloudCodeAssistFormatError: true,
          lastProfileId: undefined,
          billingFailure: false,
          advanceAuthProfile: vi.fn(async () => true),
          warn,
        }),
      );

      expect(outcome.action).toBe("retry");
      expect(warn).not.toHaveBeenCalled();
    });

    it("marks inline auth failures even when no profile id is active", async () => {
      const maybeMarkAuthProfileFailure = vi.fn(async () => {});

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "billing" },
          failoverReason: "billing",
          assistantProfileFailureReason: "billing",
          lastProfileId: undefined,
          advanceAuthProfile: vi.fn(async () => false),
          maybeMarkAuthProfileFailure,
        }),
      );

      expect(outcome.action).toBe("throw");
      expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId: undefined,
        reason: "billing",
        modelId: "claude-haiku-4-5-20251001",
      });
    });

    it("marks provider-started timeout rotations against the failed profile", async () => {
      const maybeMarkAuthProfileFailure = vi.fn(async () => {});

      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "timeout" },
          failoverReason: "timeout",
          terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
          assistantProfileFailureReason: "timeout",
          lastProfileId: "profile-timeout",
          advanceAuthProfile: vi.fn(async () => true),
          maybeMarkAuthProfileFailure,
        }),
      );

      expect(outcome.action).toBe("retry");
      expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId: "profile-timeout",
        reason: "timeout",
        modelId: "claude-haiku-4-5-20251001",
      });
    });

    it("preserves harness-owned timeout policy when profile rotation is exhausted", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "timeout" },
          terminal: { kind: "ok" },
          harnessOwnsTransport: true,
          fallbackConfigured: true,
          failoverReason: "timeout",
          billingFailure: false,
          advanceAuthProfile: vi.fn(async () => false),
        }),
      );

      expect(outcome.action).toBe("continue_normal");
    });
  });

  describe("surface_error branch (openclaw#70124)", () => {
    it.each([
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
      new Error("provider connection failed"),
    ])(
      "keeps provider $name failures visible to realtime voice with an active caller",
      async (error) => {
        const signal = new AbortController().signal;
        const projected = projectProviderError(error, signal);
        expect(projected.stopReason).toBe("error");
        const outcome = await handleAssistantFailover(
          makeParams({
            initialDecision: { action: "surface_error", reason: null },
            failoverReason: null,
            billingFailure: false,
            lastAssistant: {
              role: "assistant",
              api: "openai-completions",
              provider: "openai",
              model: "test-model",
              content: [],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: 0,
              ...projected,
            },
          }),
        );
        const failure = expectThrownFailoverError(outcome);
        expect(failure.rawError).toBe(error.message);
        expect(buildRealtimeVoiceAgentErrorProviderResult(failure)).toEqual({
          error: failure.message,
        });
        expect(signal.aborted).toBe(false);
      },
    );

    it("logs the incremented count after a successful transient retry", async () => {
      let transientRetryCount = 0;
      const logAssistantFailoverDecision = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "server_error" },
          failoverReason: "server_error",
          billingFailure: false,
          maybeRetryTransient: vi.fn(async () => {
            transientRetryCount += 1;
            return true;
          }),
          getTransientRetryCount: () => transientRetryCount,
          logAssistantFailoverDecision,
        }),
      );

      expect(outcome.action).toBe("retry");
      expect(logAssistantFailoverDecision).toHaveBeenCalledWith("retry_same_model", {
        retryCount: 1,
        profileRotationCount: 0,
      });
    });

    it("throws a billing FailoverError so the webchat can render the provider failure", async () => {
      const logDecision = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "billing" },
          failoverReason: "billing",
          billingFailure: true,
          logAssistantFailoverDecision: logDecision,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("billing");
      expect(err.message).toBe(formatBillingErrorMessage("Anthropic", "claude-haiku-4-5-20251001"));
      expect(err.status).toBe(402);
      expect(err.provider).toBe("Anthropic");
      expect(err.model).toBe("claude-haiku-4-5-20251001");
      expect(logDecision).toHaveBeenCalledWith(
        "surface_error",
        expect.objectContaining({ retryCount: 0, profileRotationCount: 0 }),
      );
    });

    it("throws an auth FailoverError for auth-classified surface errors", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "auth" },
          failoverReason: "auth",
          billingFailure: false,
          authFailure: true,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("auth");
      expect(err.message).toBe("LLM request unauthorized.");
      expect(err.status).toBe(401);
    });

    it("throws a rate_limit FailoverError for rate-limited surface errors", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("rate_limit");
      expect(err.message).toBe("LLM request rate limited.");
      expect(err.status).toBe(429);
    });

    it("throws format-classified provider rejections to the outer model fallback", async () => {
      const rawError =
        '{"type":"error","error":{"type":"invalid_request_error","message":"thinking blocks cannot be modified"}}';
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "format" },
          fallbackConfigured: true,
          failoverReason: "format",
          billingFailure: false,
          lastAssistant: {
            errorMessage: rawError,
            model: "claude-haiku-4-5-20251001",
            provider: "Anthropic",
          } as Params["lastAssistant"],
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("format");
      expect(err.status).toBe(400);
      expect(err.rawError).toBe(rawError);
    });

    it.each([
      [
        "surface_error",
        "billing",
        '  400 {"error":{"message":"credit balance is too low"}}  ',
        400,
      ],
      ["surface_error", "timeout", "500 provider returned HTTP 500", 500],
      ["surface_error", "timeout", "503 service unavailable", 503],
      ["surface_error", "timeout", "request timed out", 408],
      ["fallback_model", "timeout", "500 provider returned HTTP 500", 500],
      ["fallback_model", "timeout", "503 service unavailable", 503],
      ["fallback_model", "timeout", "request timed out", 408],
      ["rotate_profile", "overloaded", "529 overloaded", 529],
      ["rotate_profile", "overloaded", "503 overloaded", 503],
    ] as const)(
      "preserves provider status and raw error through %s: %s / %s",
      async (action, reason, rawError, status) => {
        const outcome = await handleAssistantFailover(
          makeParams({
            initialDecision: { action, reason },
            failoverReason: reason,
            fallbackConfigured: action !== "surface_error",
            overloadProfileRotations: 3,
            billingFailure: reason === "billing",
            lastAssistant: {
              stopReason: "error",
              errorMessage: rawError,
              model: "claude-haiku-4-5-20251001",
              provider: "Anthropic",
            } as Params["lastAssistant"],
          }),
        );

        const err = expectThrownFailoverError(outcome);
        expect(err.reason).toBe(reason);
        expect(err.status).toBe(status);
        expect(err.rawError).toBe(rawError.trim());
      },
    );

    it("coerces a null decision reason onto the most specific non-timeout failure signal", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: null },
          failoverReason: null,
          billingFailure: false,
          authFailure: true,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("auth");
      expect(err.message).toBe("LLM request unauthorized.");
      expect(err.status).toBe(401);
    });

    it("leaves successful turns with a stale classified errorMessage on the continue_normal path", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "billing" },
          failoverFailure: false,
          failoverReason: "billing",
          billingFailure: false,
        }),
      );

      expect(outcome.action).toBe("continue_normal");
    });

    it("does not escalate stale classified text after an already-started rotation attempt", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "rotate_profile", reason: "billing" },
          fallbackConfigured: true,
          failoverFailure: false,
          failoverReason: "billing",
          billingFailure: false,
        }),
      );

      expect(outcome.action).toBe("continue_normal");
    });

    it("leaves externally-aborted runs on the continue_normal path", async () => {
      // External aborts (user pressed stop) must never synthesize a
      // provider error; the partial assistant output carries the turn.
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: null },
          terminal: { kind: "aborted", source: "external" },
          failoverReason: null,
          billingFailure: false,
        }),
      );

      expect(outcome.action).toBe("continue_normal");
    });

    it("leaves plain timeouts on the continue_normal path for the runner's timeout-payload synthesis", async () => {
      // `run.ts` already emits an explicit timeout payload when
      // `buildEmbeddedRunPayloads` produces no assistant content or only a
      // partial prompt-timeout fragment. Throwing a FailoverError here would
      // short-circuit that synthesis and break
      // timeout-compaction retry coverage in
      // `run.timeout-context-recovery.test.ts`. The throw path is
      // reserved for concrete provider failures that have no other
      // downstream surface.
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: null },
          failoverReason: null,
          terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
          billingFailure: false,
        }),
      );

      expect(outcome.action).toBe("continue_normal");
    });
  });

  describe("fallback_model branch", () => {
    it("throws timeout FailoverError for opencode-go provider-owned stalled streams", async () => {
      const logDecision = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "fallback_model", reason: "timeout" },
          fallbackConfigured: true,
          failoverReason: "timeout",
          billingFailure: false,
          lastAssistant: {
            role: "assistant",
            api: "openai-completions",
            provider: "opencode-go",
            model: "deepseek-v4-flash",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
            content: [],
            timestamp: 0,
          },
          activeErrorContext: { provider: "opencode-go", model: "deepseek-v4-flash" },
          provider: "opencode-go",
          modelId: "deepseek-v4-flash",
          logAssistantFailoverDecision: logDecision,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("timeout");
      expect(err.status).toBe(408);
      expect(logDecision).toHaveBeenCalledWith(
        "fallback_model",
        expect.objectContaining({ status: 408, retryCount: 0, profileRotationCount: 0 }),
      );
    });

    it("still throws a FailoverError after the surface_error refactor", async () => {
      const logDecision = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "fallback_model", reason: "billing" },
          fallbackConfigured: true,
          failoverReason: "billing",
          billingFailure: true,
          logAssistantFailoverDecision: logDecision,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("billing");
      expect(err.status).toBe(402);
      expect(err.message).toBe(formatBillingErrorMessage("Anthropic", "claude-haiku-4-5-20251001"));
      expect(logDecision).toHaveBeenCalledWith(
        "fallback_model",
        expect.objectContaining({ status: 402, retryCount: 0, profileRotationCount: 0 }),
      );
    });
  });
});

describe("isShortWindowRateLimitMessage", () => {
  it.each([
    ["429 Provider returned error", true],
    ["429 insufficient_quota: You exceeded your current quota", false],
    ["429 usage limit reached for this billing period", false],
    ["Provider API error (429): Provider returned error", false],
    ["rate limit exceeded", false],
  ])("classifies %s", (message, expected) => {
    expect(isShortWindowRateLimitMessage(message)).toBe(expected);
  });
});
