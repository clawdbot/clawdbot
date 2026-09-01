import { describe, expect, it, vi } from "vitest";
import { createEmbeddedRunReplayState, type EmbeddedRunReplayState } from "./replay-state.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import {
  createIdleTimeoutBreakerState,
  MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
} from "./run/idle-timeout-breaker.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator, toNormalizedUsage } from "./usage-accumulator.js";

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

function makeCliUsageAssistant(stopReason: "aborted" | "error" | "stop", text = "legacy reply") {
  return {
    role: "assistant",
    api: "cli",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text }],
    usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
    stopReason,
    timestamp: 1,
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
    markOwnedTranscriptRetry: vi.fn(),
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
  it("keeps the physical-attempt source when the idle-timeout breaker completes the run", async () => {
    const attempt = {
      ...makeAttempt(),
      modelAttempt: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: { kind: "profile" as const },
      },
      terminal: { kind: "timeout" as const, phase: "prompt" as const, source: "idle" as const },
    };
    const input = makeNormalizationInput(attempt, makePromptState());
    let result: Awaited<ReturnType<typeof normalizeEmbeddedRunAttempt>> | undefined;
    for (let index = 0; index < MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT; index += 1) {
      result = await normalizeEmbeddedRunAttempt(input);
    }

    expect(result?.action).toBe("complete");
    if (!result || result.action !== "complete") {
      throw new Error(`expected complete, got ${result?.action ?? "no result"}`);
    }
    expect(result.result.meta.agentMeta?.credentialSource).toEqual({ kind: "profile" });
  });

  it.each([undefined, 0.125])(
    "keeps attempt cost %s authoritative over a synthetic assistant zero-cost placeholder",
    async (total) => {
      const attempt = makeAttempt();
      attempt.attemptUsage = {
        input: 300_000,
        output: 200,
        ...(total !== undefined ? { cost: { total } } : {}),
      };
      const assistant = {
        ...makeCliUsageAssistant("stop"),
        api: "openai-chatgpt-responses",
        usage: {
          input: 150_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150_100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      attempt.lastAssistant = assistant as never;
      attempt.currentAttemptAssistant = assistant as never;
      const input = makeNormalizationInput(attempt, makePromptState());

      await normalizeEmbeddedRunAttempt(input);

      expect(toNormalizedUsage(input.usageAccumulator)).toMatchObject({
        input: 300_000,
        output: 200,
      });
      expect(toNormalizedUsage(input.usageAccumulator)?.cost).toEqual(
        total !== undefined ? { total } : undefined,
      );
    },
  );

  it("keeps exact attempt context usage for a tool-only turn", async () => {
    const attempt = makeAttempt();
    attempt.attemptUsage = {
      input: 521,
      output: 197,
      total: 21_966,
      contextUsage: { state: "available", promptTokens: 21_769, totalTokens: 21_966 },
    };

    const result = await normalizeEmbeddedRunAttempt(
      makeNormalizationInput(attempt, makePromptState()),
    );

    expect(result).toMatchObject({
      action: "proceed",
      lastRunPromptUsage: attempt.attemptUsage,
    });
  });

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
    expect(state.markOwnedTranscriptRetry).toHaveBeenCalledOnce();
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
    expect(state.markOwnedTranscriptRetry).not.toHaveBeenCalled();
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

  it("writes canonical assistant abort lifecycle metadata", async () => {
    const state = makePromptState();
    const assistant = makeCliUsageAssistant("aborted", "");
    const setTerminalLifecycleMeta = vi.fn();
    const attempt = makeAttempt();
    attempt.lastAssistant = assistant as never;
    attempt.currentAttemptAssistant = assistant as never;
    attempt.setTerminalLifecycleMeta = setTerminalLifecycleMeta;

    const result = await normalizeEmbeddedRunAttempt(makeNormalizationInput(attempt, state));

    expect(result.action).toBe("proceed");
    if (result.action !== "proceed") {
      throw new Error(`expected proceed, got ${result.action}`);
    }
    result.setTerminalLifecycleMeta({ replayInvalid: false, livenessState: "blocked" });
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
      stopReason: "aborted",
      aborted: true,
    });
  });

  it("does not promote historical CLI usage without context provenance", async () => {
    const state = makePromptState();
    const legacyAssistant = makeCliUsageAssistant("error");
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
    const legacyAssistant = makeCliUsageAssistant("stop");
    const attempt = makeAttempt({
      route: "compact_only",
      handled: true,
      truncatedCount: 0,
    });
    attempt.messagesSnapshot = [legacyAssistant] as never;
    attempt.lastAssistant = legacyAssistant as never;
    attempt.currentAttemptAssistant = legacyAssistant as never;
    const input = makeNormalizationInput(attempt, state);
    input.lastRunPromptUsage = { input: 42_000, output: 1_000, total: 43_000 };

    const result = await normalizeEmbeddedRunAttempt(input);

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.lastRunPromptUsage).toEqual({ contextUsage: { state: "unavailable" } });
  });

  it("keeps newer carried usage over an older transcript fallback", async () => {
    const state = makePromptState();
    const historicalAssistant = makeCliUsageAssistant("stop", "historical reply");
    const attempt = makeAttempt({
      route: "compact_only",
      handled: true,
      truncatedCount: 0,
    });
    attempt.messagesSnapshot = [historicalAssistant] as never;
    attempt.lastAssistant = historicalAssistant as never;
    const input = makeNormalizationInput(attempt, state);
    input.lastRunPromptUsage = { input: 42_000, output: 1_000, total: 43_000 };

    const result = await normalizeEmbeddedRunAttempt(input);

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.lastRunPromptUsage).toEqual({
      input: 42_000,
      output: 1_000,
      total: 43_000,
    });
  });
});
