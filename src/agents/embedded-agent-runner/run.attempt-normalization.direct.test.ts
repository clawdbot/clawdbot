import { describe, expect, it, vi } from "vitest";
import { createEmbeddedRunReplayState, type EmbeddedRunReplayState } from "./replay-state.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { createIdleTimeoutBreakerState } from "./run/idle-timeout-breaker.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

function makeAttempt(
  preflightRecovery?: EmbeddedRunAttemptResult["preflightRecovery"],
): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    preflightRecovery,
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

function makePromptState(options: { waitForPersistence?: () => Promise<void> } = {}) {
  const activePrompt = { persisted: false, internal: false };
  const state = {
    sessionId: "session-1",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    },
    activePrompt,
    suppressNextUserMessagePersistence: false,
    adoptSessionId: vi.fn(),
    waitForCurrentUserMessagePersistence: vi.fn(
      options.waitForPersistence ?? (async () => undefined),
    ),
    continueFromCurrentTranscript: vi.fn(),
  };
  return state;
}

function makeNormalizationInput(
  attempt: EmbeddedRunAttemptResult,
  sessionPromptState: ReturnType<typeof makePromptState>,
  replayState: EmbeddedRunReplayState = createEmbeddedRunReplayState(),
): Parameters<typeof normalizeEmbeddedRunAttempt>[0] {
  return {
    runInput: {
      runParams: {
        sessionId: "session-1",
        sessionFile: "agent:main:main",
        config: {},
      },
      laneController: { throwIfAborted: vi.fn() },
      fallbackConfigured: false,
      startedAtMs: Date.now(),
      resolvedSessionKey: "agent:main:main",
    } as never,
    preparedRuntime: {
      nativeModelOwned: false,
      model: { id: "gpt-5.6-luna" },
      attemptAuthProfileStore: { profiles: {} },
      snapshot: () => ({
        effectiveModel: { provider: "openai", id: "gpt-5.6-luna" },
        outerContextTokenMeta: {},
        lastProfileId: undefined,
      }),
    } as never,
    dispatchedAttempt: { rawAttempt: attempt, cancellationRequested: false } as never,
    sessionPromptState: sessionPromptState as never,
    provider: "openai",
    modelId: "gpt-5.6-luna",
    bootstrapPromptWarningSignaturesSeen: [],
    usageAccumulator: createUsageAccumulator(),
    lastRunPromptUsage: undefined,
    idleTimeoutBreakerState: createIdleTimeoutBreakerState(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    replayState,
    lastRetryFailoverReason: null,
  };
}

describe("normalizeEmbeddedRunAttempt", () => {
  it("waits for pending user-turn persistence before deriving retry suppression", async () => {
    let releasePersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const state = makePromptState({
      waitForPersistence: async () => {
        await persistence;
        state.activePrompt.persisted = true;
      },
    });
    let settled = false;

    const resultPromise = normalizeEmbeddedRunAttempt(
      makeNormalizationInput(makeAttempt(), state),
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(state.waitForCurrentUserMessagePersistence).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(state.suppressNextUserMessagePersistence).toBe(false);

    releasePersistence?.();
    const result = await resultPromise;

    expect(result.action).toBe("proceed");
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("retries the original prompt after handled preflight truncation", async () => {
    const state = makePromptState();

    const result = await normalizeEmbeddedRunAttempt(
      makeNormalizationInput(
        makeAttempt({
          route: "truncate_tool_results_only",
          handled: true,
          truncatedCount: 2,
        }),
        state,
      ),
    );

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.retryKind).toBe("recovery");
    expect(state.continueFromCurrentTranscript).not.toHaveBeenCalled();
  });

  it("continues from the current transcript after handled mid-turn truncation", async () => {
    const state = makePromptState();

    const result = await normalizeEmbeddedRunAttempt(
      makeNormalizationInput(
        makeAttempt({
          route: "truncate_tool_results_only",
          source: "mid-turn",
          handled: true,
          truncatedCount: 2,
        }),
        state,
      ),
    );

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.retryKind).toBe("recovery");
    expect(state.continueFromCurrentTranscript).toHaveBeenCalledOnce();
  });

  it("marks a successful no-op mid-turn retry as a progress continuation", async () => {
    const state = makePromptState();
    const attempt = makeAttempt({
      route: "truncate_tool_results_only",
      source: "mid-turn",
      handled: true,
      truncatedCount: 0,
    });
    attempt.toolMetas = [{ toolName: "read", isError: false }];

    const input = makeNormalizationInput(attempt, state);
    input.lastRunPromptUsage = { input: 42_000, output: 1_000, total: 43_000 };
    const result = await normalizeEmbeddedRunAttempt(input);

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.retryKind).toBe("progress_continuation");
    expect(state.continueFromCurrentTranscript).toHaveBeenCalledOnce();
  });

  it("keeps a failed no-op mid-turn retry in the recovery budget", async () => {
    const state = makePromptState();
    const attempt = makeAttempt({
      route: "truncate_tool_results_only",
      source: "mid-turn",
      handled: true,
      truncatedCount: 0,
    });
    attempt.toolMetas = [{ toolName: "read", isError: true }];

    const result = await normalizeEmbeddedRunAttempt(makeNormalizationInput(attempt, state));

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.retryKind).toBe("recovery");
  });

  it("keeps replay state unsafe after a later clean attempt", async () => {
    const state = makePromptState();
    const dirty = await normalizeEmbeddedRunAttempt(
      makeNormalizationInput(
        {
          ...makeAttempt(),
          replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
        },
        state,
      ),
    );
    if (dirty.action !== "proceed") {
      throw new Error(`expected dirty attempt to proceed, got ${dirty.action}`);
    }

    const clean = await normalizeEmbeddedRunAttempt(
      makeNormalizationInput(
        {
          ...makeAttempt(),
          replayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
        },
        state,
        dirty.replayState,
      ),
    );

    if (clean.action !== "proceed") {
      throw new Error(`expected clean attempt to proceed, got ${clean.action}`);
    }
    expect(clean.replayState).toEqual({ replayInvalid: true, hadPotentialSideEffects: true });
  });

  it("does not promote historical CLI usage without context provenance", async () => {
    const state = makePromptState();
    const legacyAssistant = {
      role: "assistant",
      api: "cli",
      provider: "openai",
      model: "gpt-5.6-luna",
      content: [{ type: "text", text: "legacy reply" }],
      usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      stopReason: "error",
      timestamp: 1,
    };
    const attempt = makeAttempt();
    attempt.messagesSnapshot = [legacyAssistant] as never;
    attempt.lastAssistant = legacyAssistant as never;

    const result = await normalizeEmbeddedRunAttempt(makeNormalizationInput(attempt, state));

    expect(result.action).toBe("proceed");
    if (result.action !== "proceed") {
      throw new Error(`expected proceed, got ${result.action}`);
    }
    expect(result.lastRunPromptUsage).toEqual({ contextUsage: { state: "unavailable" } });
  });

  it("keeps the unavailable sentinel across a retry instead of reviving prior usage", async () => {
    const state = makePromptState();
    const legacyAssistant = {
      role: "assistant",
      api: "cli",
      provider: "openai",
      model: "gpt-5.6-luna",
      content: [{ type: "text", text: "legacy reply" }],
      usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      stopReason: "stop",
      timestamp: 1,
    };
    const attempt = makeAttempt({
      route: "compact_only",
      handled: true,
      truncatedCount: 0,
    });
    attempt.messagesSnapshot = [legacyAssistant] as never;
    attempt.lastAssistant = legacyAssistant as never;
    const input = makeNormalizationInput(attempt, state);
    input.lastRunPromptUsage = { input: 42_000, output: 1_000, total: 43_000 };

    const result = await normalizeEmbeddedRunAttempt(input);

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.lastRunPromptUsage).toEqual({ contextUsage: { state: "unavailable" } });
  });
});
