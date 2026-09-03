import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { FailoverError } from "../../failover-error.js";
import { resolveAgentRunErrorLifecycleFields } from "../../run-termination.js";
import { handleEmbeddedPromptFailure } from "./prompt-failure.js";

type Params = Parameters<typeof handleEmbeddedPromptFailure>[0];

function makeParams(overrides: Partial<Params> = {}): Params {
  const provider = "openai";
  const modelId = "gpt-5";
  const defaults: Params = {
    runParams: {
      config: undefined,
      runId: "run:prompt-failure-test",
    } as Params["runParams"],
    attempt: {
      terminal: { kind: "ok" },
      replayMetadata: {
        replaySafe: true,
      },
    } as Params["attempt"],
    promptError: new Error("rate limit exceeded"),
    promptErrorSource: "prompt",
    activeErrorContext: { provider, model: modelId },
    provider,
    modelId,
    authProfileId: "openai:p1",
    authProfileStore: {
      version: 1,
      profiles: {},
    },
    sessionIdUsed: "session:prompt-failure-test",
    lane: "test",
    agentDir: "/tmp/openclaw-prompt-failure-test",
    suspensionSessionId: "session:prompt-failure-test",
    runtimeAuthRetry: false,
    maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    suspendForFailure: vi.fn(),
    resolveReplayInvalid: vi.fn(() => false),
    setTerminalLifecycleMeta: vi.fn(),
    buildErrorAgentMeta: vi.fn(),
    startedAtMs: 0,
    fallbackConfigured: true,
    aborted: false,
    externalAbort: false,
    pluginHarnessOwnsTransport: false,
    timedOutByRunBudget: false,
    resolveAuthProfileFailureReason: vi.fn<Params["resolveAuthProfileFailureReason"]>(
      () => "rate_limit",
    ),
    advanceAuthProfile: vi.fn(async () => true),
    advanceRateLimitAuthProfile: vi.fn(async () => true),
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    maybeRetryTransient: vi.fn(async () => false),
    getTransientRetryCount: () => 0,
    attemptedThinking: new Set(),
    thinkLevel: "low",
    getThinkLevel: () => "low",
    traceAttempts: [],
    previousRetryFailoverReason: null,
  };
  return { ...defaults, ...overrides };
}

describe("handleEmbeddedPromptFailure", () => {
  it.each(
    (["prompt", "compaction", "tool_execution"] as const).flatMap((phase) =>
      [false, true].map((fallbackConfigured) => ({ phase, fallbackConfigured })),
    ),
  )(
    "preserves recorded $phase timeouts with fallback=$fallbackConfigured",
    async ({ phase, fallbackConfigured }) => {
      const params = makeParams({
        promptError: new FailoverError("Provider stopped responding", { reason: "timeout" }),
        fallbackConfigured,
        advanceAuthProfile: vi.fn(async () => false),
        resolveAuthProfileFailureReason: vi.fn(() => null),
      });
      params.attempt.terminal = { kind: "timeout", phase, source: "runtime" };

      const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);

      const fields = resolveAgentRunErrorLifecycleFields(error, undefined);
      expect(fields).toEqual({
        stopReason: "timeout",
        ...(phase === "prompt" ? { timeoutPhase: "provider", providerStarted: true } : {}),
      });
      expect(
        buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
      ).toBe(phase === "prompt" ? "hard_timeout" : "timed_out");
    },
  );

  it("retains a harness's provider-started timeout without inventing its phase", async () => {
    const params = makeParams({
      promptError: new FailoverError("Harness deadline reached", { reason: "timeout" }),
      advanceAuthProfile: vi.fn(async () => false),
      resolveAuthProfileFailureReason: vi.fn(() => null),
    });
    params.attempt.terminal = { kind: "timeout", phase: "tool_execution", source: "runtime" };
    params.attempt.promptTimeoutOutcome = { providerStarted: true };
    const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);
    const fields = resolveAgentRunErrorLifecycleFields(error, undefined);
    expect(fields).toEqual({ stopReason: "timeout", providerStarted: true });
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
    ).toBe("hard_timeout");
  });

  it.each(["prompt", "compaction", "tool_execution"] as const)(
    "retains an opaque %s watchdog failure without changing its retry routing",
    async (phase) => {
      const params = makeParams({
        promptError: new Error("Opaque provider failure"),
        resolveAuthProfileFailureReason: vi.fn(() => null),
      });
      params.attempt.terminal = { kind: "timeout", phase, source: "runtime" };

      const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);

      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
        stopReason: "timeout",
        ...(phase === "prompt" ? { timeoutPhase: "provider", providerStarted: true } : {}),
      });
      expect(params.maybeRetryTransient).not.toHaveBeenCalled();
      expect(params.advanceAuthProfile).not.toHaveBeenCalled();
      expect(error).toHaveProperty("cause", params.promptError);
    },
  );

  it.each([false, true])(
    "surfaces trusted checkpoint recovery without provider failover (altered message: %s)",
    async (alteredMessage) => {
      const promptError = new CompactionReplayRefreshRequiredError();
      const recoveryText = promptError.message;
      if (alteredMessage) {
        promptError.message = "untrusted provider detail: rate limit exceeded";
      }
      const params = makeParams({ promptError, promptErrorSource: "precheck" });

      const outcome = await handleEmbeddedPromptFailure(params);

      expect(outcome).toMatchObject({
        action: "complete",
        result: {
          payloads: [{ text: recoveryText, isError: true }],
          meta: {
            finalAssistantVisibleText: recoveryText,
            finalAssistantRawText: recoveryText,
            livenessState: "blocked",
            error: { kind: "compaction_replay_refresh_required", message: recoveryText },
          },
        },
      });
      expect(recoveryText).toContain("/compact");
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Verify JSON transport serialization, not an in-memory clone.
      expect(JSON.parse(JSON.stringify(outcome))).toMatchObject({
        result: { payloads: [{ text: recoveryText, isError: true }] },
      });
      expect(JSON.stringify(outcome)).not.toContain("untrusted provider detail");
      expect(params.setTerminalLifecycleMeta).toHaveBeenCalledWith({
        replayInvalid: false,
        livenessState: "blocked",
      });
      for (const callback of [
        params.maybeRefreshRuntimeAuthForAuthError,
        params.suspendForFailure,
        params.resolveAuthProfileFailureReason,
        params.advanceAuthProfile,
        params.advanceRateLimitAuthProfile,
        params.maybeMarkAuthProfileFailure,
        params.maybeRetryTransient,
      ]) {
        expect(callback).not.toHaveBeenCalled();
      }
      expect(params.traceAttempts).toEqual([]);
    },
  );

  it.each([
    ["plain error", new Error(new CompactionReplayRefreshRequiredError().message), "precheck"],
    [
      "spoofed error name",
      Object.assign(new Error(new CompactionReplayRefreshRequiredError().message), {
        name: "CompactionReplayRefreshRequiredError",
      }),
      "precheck",
    ],
    [
      "serialized error",
      {
        name: "CompactionReplayRefreshRequiredError",
        message: new CompactionReplayRefreshRequiredError().message,
      },
      "precheck",
    ],
    ["provider error", new CompactionReplayRefreshRequiredError(), "prompt"],
  ] satisfies Array<[string, unknown, Params["promptErrorSource"]]>)(
    "does not trust %s as local checkpoint recovery",
    async (_label, promptError, promptErrorSource) => {
      const params = makeParams({
        promptError,
        promptErrorSource,
        resolveAuthProfileFailureReason: vi.fn(() => null),
      });

      await expect(handleEmbeddedPromptFailure(params)).rejects.toBeInstanceOf(Error);

      expect(params.setTerminalLifecycleMeta).not.toHaveBeenCalled();
      expect(params.maybeRefreshRuntimeAuthForAuthError).toHaveBeenCalledOnce();
    },
  );

  it("never refreshes auth or retries a recorded CLI terminal stop, even with an auth-shaped reason", async () => {
    // The stop message repeats the backend's own terminal_reason; a value like
    // `unauthorized` reads as an auth failure to text classifiers, and a retry
    // would replay tool effects the terminal-stop policy exists to protect.
    const promptError = new FailoverError(
      "Claude CLI ended the turn without a reply (terminal_reason: unauthorized, stop_reason: end_turn). " +
        "Tool actions may already have run; verify their effects before retrying.",
      { reason: "unknown", code: "cli_turn_stopped", provider: "claude-cli", model: "sonnet" },
    );
    const params = makeParams({
      promptError,
      provider: "claude-cli",
      modelId: "sonnet",
      activeErrorContext: { provider: "claude-cli", model: "sonnet" },
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => true),
      maybeRetryTransient: vi.fn(async () => true),
      resolveAuthProfileFailureReason: vi.fn(() => null),
    });

    await expect(handleEmbeddedPromptFailure(params)).rejects.toMatchObject({
      code: "cli_turn_stopped",
    });

    for (const callback of [
      params.maybeRefreshRuntimeAuthForAuthError,
      params.maybeRetryTransient,
      params.advanceAuthProfile,
      params.advanceRateLimitAuthProfile,
    ]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(params.traceAttempts).toEqual([
      expect.objectContaining({ result: "surface_error", stage: "prompt" }),
    ]);
  });

  it("returns the profile-rotation retry before failure marking finishes", async () => {
    const events: string[] = [];
    let releaseMark: (() => void) | undefined;
    const markCanFinish = new Promise<void>((resolve) => {
      releaseMark = resolve;
    });
    const maybeMarkAuthProfileFailure = vi.fn(async () => {
      events.push("mark-start");
      await markCanFinish;
      events.push("mark-finish");
    });

    try {
      const outcome = await handleEmbeddedPromptFailure(
        makeParams({
          advanceRateLimitAuthProfile: vi.fn(async () => {
            events.push("advance");
            return true;
          }),
          maybeMarkAuthProfileFailure,
        }),
      );

      expect(outcome).toEqual({
        action: "retry",
        thinkLevel: "low",
        authRetryPending: false,
        lastRetryFailoverReason: "rate_limit",
      });
      expect(events).toEqual(["advance", "mark-start"]);
      expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId: "openai:p1",
        reason: "rate_limit",
        modelId: "gpt-5",
      });
    } finally {
      releaseMark?.();
    }

    await vi.waitFor(() => expect(events).toEqual(["advance", "mark-start", "mark-finish"]));
  });
});
