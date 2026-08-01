// Prompt failure tests cover retry composition around profile rotation.
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
    maybeEscalateRateLimitProfileFallback: vi.fn(),
    advanceAttemptAuthProfile: vi.fn(async () => true),
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => {}),
    attemptedThinking: new Set(),
    thinkLevel: "low",
    getThinkLevel: () => "low",
    traceAttempts: [],
    previousRetryFailoverReason: null,
  };
  return { ...defaults, ...overrides };
}

describe("handleEmbeddedPromptFailure", () => {
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
          advanceAttemptAuthProfile: vi.fn(async () => {
            events.push("advance");
            return true;
          }),
          maybeMarkAuthProfileFailure,
          maybeBackoffBeforeOverloadFailover: vi.fn(async () => {
            events.push("backoff");
          }),
        }),
      );

      expect(outcome).toEqual({
        action: "retry",
        thinkLevel: "low",
        authRetryPending: false,
        lastRetryFailoverReason: "rate_limit",
      });
      expect(events).toEqual(["advance", "mark-start", "backoff"]);
      expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId: "openai:p1",
        reason: "rate_limit",
        modelId: "gpt-5",
      });
    } finally {
      releaseMark?.();
    }

    await vi.waitFor(() =>
      expect(events).toEqual(["advance", "mark-start", "backoff", "mark-finish"]),
    );
  });
});
