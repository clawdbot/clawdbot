import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
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
