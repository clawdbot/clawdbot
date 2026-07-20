import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: transient connection/timeout retry (#87180)", () => {
  it("retries the full fallback cycle once for a bare connection error, then succeeds (#87180 compat)", async () => {
    // The embedded prompt-lock window pins SDK maxRetries to 0 so an in-window
    // retry cannot widen the session-takeover race. Connection-error resilience
    // is restored at the orchestrator, which re-runs the whole cycle once where
    // each retry re-acquires the lock.
    state.runWithModelFallbackMock
      .mockRejectedValueOnce(new Error("Connection error."))
      .mockImplementationOnce(async (params: FallbackRunnerParams) => ({
        result: await params.run("anthropic", "claude"),
        provider: "anthropic",
        model: "claude",
        attempts: [],
      }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "recovered" }],
      meta: {
        agentMeta: { sessionId: "session", provider: "anthropic", model: "claude" },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    vi.useFakeTimers();
    try {
      const promise = runAgentTurnWithFallback({
        commandBody: "hello",
        followupRun,
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
        } as unknown as TemplateContext,
        opts: {},
        typingSignals: createMockTypingSignaler(),
        blockReplyPipeline: null,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        applyReplyToMode: (payload) => payload,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        pendingToolTasks: new Set(),
        resetSessionAfterRoleOrderingConflict: async () => false,
        isHeartbeat: false,
        sessionKey: "main",
        getActiveSessionEntry: () => undefined,
        resolvedVerboseLevel: "off",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(result.kind).toBe("success");
      // 1 initial cycle + exactly 1 orchestrator retry.
      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after a single connection-error retry instead of looping when it keeps failing", async () => {
    // The transient-retry budget is one; once consumed the orchestrator must
    // surface a terminal failure instead of spinning the full cycle forever.
    state.runWithModelFallbackMock.mockRejectedValue(new Error("socket hang up"));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    vi.useFakeTimers();
    try {
      const promise = runAgentTurnWithFallback({
        commandBody: "hello",
        followupRun,
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
        } as unknown as TemplateContext,
        opts: {},
        typingSignals: createMockTypingSignaler(),
        blockReplyPipeline: null,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        applyReplyToMode: (payload) => payload,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        pendingToolTasks: new Set(),
        resetSessionAfterRoleOrderingConflict: async () => false,
        isHeartbeat: false,
        sessionKey: "main",
        getActiveSessionEntry: () => undefined,
        resolvedVerboseLevel: "off",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(result.kind).toBe("final");
      // 1 initial cycle + exactly 1 retry, then the transient budget is exhausted.
      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the full fallback cycle once for a request-timeout error, then succeeds (#87180 compat)", async () => {
    // Symmetric with the connection-error retry: the embedded prompt-lock window
    // pins SDK maxRetries to 0, so the SDK's default timeout retries are disabled
    // and the timeout error is rethrown to this single-model outer gate. The
    // orchestrator re-runs the whole cycle once, re-acquiring the lock each time.
    state.runWithModelFallbackMock
      .mockRejectedValueOnce(new Error("Request timed out."))
      .mockImplementationOnce(async (params: FallbackRunnerParams) => ({
        result: await params.run("anthropic", "claude"),
        provider: "anthropic",
        model: "claude",
        attempts: [],
      }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "recovered" }],
      meta: {
        agentMeta: { sessionId: "session", provider: "anthropic", model: "claude" },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    vi.useFakeTimers();
    try {
      const promise = runAgentTurnWithFallback({
        commandBody: "hello",
        followupRun,
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
        } as unknown as TemplateContext,
        opts: {},
        typingSignals: createMockTypingSignaler(),
        blockReplyPipeline: null,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        applyReplyToMode: (payload) => payload,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        pendingToolTasks: new Set(),
        resetSessionAfterRoleOrderingConflict: async () => false,
        isHeartbeat: false,
        sessionKey: "main",
        getActiveSessionEntry: () => undefined,
        resolvedVerboseLevel: "off",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(result.kind).toBe("success");
      // 1 initial cycle + exactly 1 orchestrator retry.
      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after a single request-timeout retry instead of looping when it keeps failing (#87180)", async () => {
    // The transient-retry budget is one; a persistent timeout must surface a
    // terminal failure instead of spinning the full cycle forever.
    state.runWithModelFallbackMock.mockRejectedValue(new Error("Request timed out."));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    vi.useFakeTimers();
    try {
      const promise = runAgentTurnWithFallback({
        commandBody: "hello",
        followupRun,
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
        } as unknown as TemplateContext,
        opts: {},
        typingSignals: createMockTypingSignaler(),
        blockReplyPipeline: null,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        applyReplyToMode: (payload) => payload,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        pendingToolTasks: new Set(),
        resetSessionAfterRoleOrderingConflict: async () => false,
        isHeartbeat: false,
        sessionKey: "main",
        getActiveSessionEntry: () => undefined,
        resolvedVerboseLevel: "off",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(result.kind).toBe("final");
      // 1 initial cycle + exactly 1 retry, then the transient budget is exhausted.
      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry CLI subprocess timeouts through the transient gate (#87180)", async () => {
    // CLI subprocess budget kills read like timeout strings but are subprocess
    // kills, not transport timeouts. The transient gate must skip them so they
    // run exactly once and surface their own CLI-subprocess copy.
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      new Error("CLI exceeded timeout (300s) and was terminated."),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    // No transient retry: a single cycle, then the surfaced CLI copy.
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(result.payload.text).toContain("CLI turn: timed out");
    expect(result.payload.text).toContain("overall turn limit");
  });

  it("does not retry Codex app-server timeouts through the transient gate (#87180)", async () => {
    // Codex app-server idle timeouts read like timeout strings but are bridge
    // failures with their own surfaced copy and their own replay handling. The
    // transient gate must skip them so they run once and surface the Codex copy.
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      new Error("codex app-server turn idle timed out waiting for turn/completed"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    // No transient retry: a single cycle, then the surfaced Codex app-server copy.
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(result.payload.text).toContain("Codex app-server");
  });

  it("does not retry a timeout-only fallback summary through the transient timeout gate (#87180)", async () => {
    // A fallback summary whose text is pure timeout (no connection keyword)
    // only matches the timeout disjunct. isFallbackSummaryError must keep it out
    // of that disjunct so the exhausted multi-model summary is not redundantly
    // re-run; the connection-retry path is unaffected since the message carries
    // no connection signature.
    const summary = Object.assign(
      new Error("All models failed (1): anthropic/claude: Request timed out. (timeout)"),
      { attempts: [{ provider: "anthropic", model: "claude" }] },
    );
    summary.name = "FallbackSummaryError";
    state.runWithModelFallbackMock.mockRejectedValueOnce(summary);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
    });

    expect(result.kind).toBe("final");
    // No transient retry through the timeout disjunct: a single cycle only.
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
  });
});
