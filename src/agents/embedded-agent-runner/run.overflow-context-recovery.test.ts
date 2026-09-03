import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { AssistantMessage } from "../../llm/types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { recoverEmbeddedRunOverflow } from "./run/overflow-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  debug: vi.fn(),
  getProviderPromptState: vi.fn(),
  info: vi.fn(),
  isDebugEnabled: vi.fn(() => true),
  isNoRealConversationCompactionNoop: vi.fn(() => false),
  maintenance: vi.fn(),
  markProviderPromptRejected: vi.fn(),
  resetNoRealConversationTokenSnapshot: vi.fn(),
  sessionLikelyHasOversizedToolResults: vi.fn(() => false),
  truncateOversizedToolResults: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: mocks.maintenance,
}));

vi.mock("./logger.js", () => ({
  log: {
    debug: mocks.debug,
    info: mocks.info,
    isEnabled: mocks.isDebugEnabled,
    warn: mocks.warn,
  },
}));

vi.mock("./provider-prompt-state.js", () => ({
  getProviderPromptState: mocks.getProviderPromptState,
  markLastProviderPromptContextRejected: mocks.markProviderPromptRejected,
}));

vi.mock("./tool-result-truncation.js", () => ({
  resolveLiveToolResultMaxChars: () => 32_000,
  sessionLikelyHasOversizedToolResults: mocks.sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSessionManager: mocks.truncateOversizedToolResults,
}));

vi.mock("./run/session-bootstrap.js", async () => {
  const { buildContextEngineCompactionSessionTarget } = await vi.importActual<
    typeof import("./run/session-bootstrap.js")
  >("./run/session-bootstrap.js");
  return {
    buildContextEngineCompactionSessionTarget,
    isNoRealConversationCompactionNoop: mocks.isNoRealConversationCompactionNoop,
    resetNoRealConversationTokenSnapshot: mocks.resetNoRealConversationTokenSnapshot,
  };
});

type RecoveryInput = Parameters<typeof recoverEmbeddedRunOverflow>[0];
type RecoveryInputOverrides = Omit<Partial<RecoveryInput>, "attempt"> & {
  attempt?: Partial<EmbeddedRunAttemptResult>;
};
type CompactionResult = Awaited<ReturnType<RecoveryInput["contextEngine"]["compact"]>>;

const overflowError = () => new Error("request_too_large: Request size exceeds context window");

const successfulCompaction = (): CompactionResult =>
  ({
    ok: true,
    compacted: true,
    result: {
      summary: "Compacted session",
      tokensBefore: 150_000,
      tokensAfter: 80_000,
    },
  }) as CompactionResult;

function makeAssistantMessage(
  input: Pick<AssistantMessage, "stopReason"> &
    Partial<Pick<AssistantMessage, "errorMessage" | "usage">>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: input.usage ?? {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: input.stopReason,
    errorMessage: input.errorMessage,
    timestamp: 1,
  };
}

function makeInput(overrides: RecoveryInputOverrides = {}): RecoveryInput {
  const promptError = Object.hasOwn(overrides, "promptError")
    ? overrides.promptError
    : overflowError();
  const attempt = makeAttemptResult({
    terminal: promptError
      ? { kind: "failed", source: "prompt", error: promptError }
      : { kind: "ok" },
    sessionIdUsed: "session-1",
    assistantTexts: [],
    messagesSnapshot: [],
    replayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
    ...overrides.attempt,
  });

  const input: RecoveryInput = {
    runParams: {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 1_000,
      onAutoCompactionSucceeded: vi.fn(),
    },
    state: createEmbeddedRunContextRecoveryState(),
    assertRecoveryActive: vi.fn(),
    // This leaf doubles orchestration; real admission and writer fencing have composed coverage.
    prepareRecoveryOwner: () => {
      const assertActive = () => {
        input.runParams.abortSignal?.throwIfAborted();
        input.assertRecoveryActive();
      };
      assertActive();
      const session = input.getActiveSession();
      return {
        session: {
          ...session,
          target: {
            ...session.target,
            agentId: session.target?.agentId ?? input.sessionAgentId,
            sessionId: session.id,
            sessionKey: session.target?.sessionKey ?? input.resolvedSessionKey,
            storePath:
              session.target?.storePath ?? path.join(input.workspaceDir, "openclaw-agent.sqlite"),
          },
        },
        assertActive,
        withTranscriptWrites: async <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
          signal?.throwIfAborted();
          assertActive();
          return await run();
        },
      };
    },
    prepareRecoverySession: () => ({
      sessionManager: SessionManager.inMemory("/tmp/workspace"),
      assertActive: vi.fn(),
      withSessionManagerRewriteLock: async <T>(operation: () => Promise<T> | T) =>
        await operation(),
    }),
    contextEngine: {
      info: { id: "legacy", name: "Legacy" },
      ingest: vi.fn(),
      assemble: vi.fn(),
      compact: mocks.compact,
    },
    contextTokenBudget: 200_000,
    genericCompactionRecoveryAllowed: true,
    aborted: false,
    signalOwnedInterruption: false,
    promptError,
    toolResultPromptProjectionState: {
      replacements: new Map(),
      frozen: new Set(),
      ambiguousBaseKeys: new Set(),
      restoredCacheTtl: new Map(),
      sourceTextByKey: new Map(),
    },
    attemptCompactionCount: 0,
    runtimeAuthPlan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    },
    resolvedSessionKey: "agent:main:session-1",
    sessionAgentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    harnessRuntime: "embedded",
    thinkLevel: "off",
    authProfileIdSource: "auto",
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
      buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: input.provider,
        requestedModel: input.modelId,
        resolvedModel: input.modelId,
        promptTokenBudget: tokenBudget,
        degradedReason,
      }),
    onCompactionHookMessages: vi.fn(async () => {}),
    runOwnsCompactionBeforeHook: vi.fn(async () => {}),
    runOwnsCompactionAfterHook: vi.fn(async () => {}),
    adoptCompactionTranscript: vi.fn(async () => undefined),
    getActiveSession: () => ({ id: "session-1", file: "/tmp/session-1.jsonl" }),
    prepareCurrentTranscriptRetry: vi.fn(),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    markOwnedTranscriptRetry: vi.fn(),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
    ...overrides,
    attempt,
  };
  return input;
}

describe("recoverEmbeddedRunOverflow", () => {
  beforeEach(() => {
    mocks.compact.mockReset().mockResolvedValue(successfulCompaction());
    mocks.debug.mockReset();
    mocks.getProviderPromptState.mockReset();
    mocks.info.mockReset();
    mocks.isDebugEnabled.mockReset().mockReturnValue(true);
    mocks.isNoRealConversationCompactionNoop.mockReset().mockReturnValue(false);
    mocks.maintenance.mockReset();
    mocks.markProviderPromptRejected.mockReset();
    mocks.resetNoRealConversationTokenSnapshot.mockReset();
    mocks.sessionLikelyHasOversizedToolResults.mockReset().mockReturnValue(false);
    mocks.truncateOversizedToolResults.mockReset().mockReturnValue({
      truncated: false,
      truncatedCount: 0,
      reason: "nothing to truncate",
    });
    mocks.warn.mockReset();
  });

  it("uses the canonical assistant classifier when the text heuristic misses", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model",
    });
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: null, assistantOverflowCandidate }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  });

  it("does not compact after an ambiguous bodyless 400", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "400 status code (no body)",
    });
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: null, assistantOverflowCandidate }),
    );

    expect(result).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it.each([
    { name: "refusal alone", promptError: null, action: "none" },
    { name: "independent prompt overflow", promptError: overflowError(), action: "retry" },
    {
      name: "non-overflow prompt failure",
      promptError: new Error("transport disconnected"),
      action: "none",
    },
  ])("preserves a structured refusal alongside $name", async ({ promptError, action }) => {
    const assistant = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "Anthropic refusal: prompt is too long.",
    });
    assistant.diagnostics = [{ type: "provider_refusal", timestamp: 1 }];
    const input = makeInput({
      promptError,
      assistantOverflowCandidate: assistant,
      assistantErrorText: assistant.errorMessage,
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action });
    expect(mocks.compact).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
    expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
  });

  it("preserves compaction recovery after a bodyless 413", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "413 status code (no body)",
    });
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: null, assistantOverflowCandidate }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
  });

  it("recovers a canonical zero-output length overflow", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "length",
      usage: {
        input: 199_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 199_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: null, assistantOverflowCandidate }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
  });

  it("keeps a whole code point at the context-overflow diagnostic boundary", async () => {
    const marker = "request_too_large: ";
    const prefix = `${marker}${"a".repeat(199 - marker.length)}`;
    await recoverEmbeddedRunOverflow(makeInput({ promptError: new Error(`${prefix}😀tail`) }));

    const diagnostic = mocks.warn.mock.calls
      .map(([entry]) => String(entry))
      .find((entry) => entry.startsWith("[context-overflow-diag]"));
    expect(diagnostic?.endsWith(`error=${prefix}`)).toBe(true);
  });

  it("forwards observed overflow tokens into compaction diagnostics", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: new Error("Context window exceeded: requested 12,000 tokens") }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTokenCount: 12_000,
        runtimeContext: expect.objectContaining({ trigger: "overflow" }),
      }),
    );
  });

  it("surfaces context overflow when compaction fails", async () => {
    mocks.compact.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await recoverEmbeddedRunOverflow(makeInput());

    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("auto-compaction failed"));
  });

  it("falls back to append-only tool-result truncation after failed compaction", async () => {
    const projectionState: ToolResultPromptProjectionState = {
      replacements: new Map(),
      frozen: new Set(["tool:call_1:1"]),
      ambiguousBaseKeys: new Set(),
      restoredCacheTtl: new Map(),
      sourceTextByKey: new Map(),
    };
    const messagesSnapshot = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(64_000) }],
        isError: false,
        timestamp: 1,
      },
    ] as EmbeddedRunAttemptResult["messagesSnapshot"];
    mocks.compact.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mocks.sessionLikelyHasOversizedToolResults.mockReturnValueOnce(true);
    mocks.truncateOversizedToolResults.mockReturnValueOnce({
      truncated: true,
      truncatedCount: 1,
    });
    const input = makeInput({
      attempt: {
        terminal: { kind: "failed", source: "prompt", error: overflowError() },
        sessionIdUsed: "session-1",
        messagesSnapshot,
      },
      toolResultPromptProjectionState: projectionState,
    });

    const result = await recoverEmbeddedRunOverflow(input);

    expect(result).toEqual({ action: "retry" });
    expect(mocks.truncateOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionState,
        sessionManager: expect.any(SessionManager),
      }),
    );
  });

  it("forwards the complete mixed tool tail into fallback classification", async () => {
    const messagesSnapshot = [
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(80_000) }] },
      { role: "toolResult", content: [{ type: "text", text: "alpha beta ".repeat(800) }] },
      { role: "toolResult", content: [{ type: "text", text: "gamma delta ".repeat(800) }] },
    ] as EmbeddedRunAttemptResult["messagesSnapshot"];
    mocks.compact.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mocks.sessionLikelyHasOversizedToolResults.mockReturnValueOnce(true);
    mocks.truncateOversizedToolResults.mockReturnValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        attempt: {
          terminal: { kind: "failed", source: "prompt", error: overflowError() },
          sessionIdUsed: "session-1",
          messagesSnapshot,
        },
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.sessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({ messages: messagesSnapshot }),
    );
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining("Truncated 2 tool result(s)"));
  });

  it("compacts after an unsuccessful truncate-only preflight route", async () => {
    const input = makeInput({
      attempt: {
        terminal: { kind: "failed", source: "precheck", error: overflowError() },
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        preflightRecovery: { route: "compact_only" },
      },
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
    expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
  });

  it("continues from the current transcript after mid-turn compaction", async () => {
    const input = makeInput({
      attempt: {
        terminal: { kind: "failed", source: "precheck", error: overflowError() },
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        preflightRecovery: { route: "compact_only", source: "mid-turn" },
      },
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(input.prepareCurrentTranscriptRetry).toHaveBeenCalledOnce();
    expect(input.prepareCompactedTranscriptRetry).not.toHaveBeenCalled();
  });

  it("truncates the frozen projection after compaction for a mixed preflight route", async () => {
    mocks.truncateOversizedToolResults.mockReturnValueOnce({
      truncated: true,
      truncatedCount: 2,
    });
    const input = makeInput({
      attempt: {
        terminal: { kind: "failed", source: "precheck", error: overflowError() },
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        preflightRecovery: { route: "compact_then_truncate" },
      },
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(mocks.truncateOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionState: input.toolResultPromptProjectionState,
        protectTrailingToolResults: true,
      }),
    );
    expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
  });

  it("caps overflow compaction at three attempts across shared recovery state", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await recoverEmbeddedRunOverflow(makeInput({ state }))).toEqual({ action: "retry" });
    }

    const exhausted = await recoverEmbeddedRunOverflow(makeInput({ state }));

    expect(exhausted).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(state.overflowCompactionAttempts).toBe(3);
    expect(mocks.compact).toHaveBeenCalledTimes(3);
  });

  it("bypasses compaction for a compaction_failure overflow", async () => {
    const promptError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    const result = await recoverEmbeddedRunOverflow(makeInput({ promptError }));

    expect(result).toMatchObject({ action: "surface", kind: "compaction_failure" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("stops the run on a provider request-size ceiling instead of compacting", async () => {
    // Groq refuses an oversized single request with a 413 naming TPM that states both numbers.
    // Requested above Limit cannot be admitted by any bucket state, and compaction budgets
    // against the model's context window rather than this per-request ceiling, so the owner
    // must stop the run rather than compact, adopt a transcript, truncate, or retry.
    const promptError = new Error(
      "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
        "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
        "please reduce your message size and try again.",
    );

    // Oversized tool results are present, so a bypass that only skipped compaction would still
    // fall into fallback truncation and return { action: "retry" }. This pins real terminality.
    mocks.sessionLikelyHasOversizedToolResults.mockReturnValue(true);
    const input = makeInput({ promptError });

    const result = await recoverEmbeddedRunOverflow(input);

    // Returning { action: "none" } would hand the refusal back to the same-model rate-limit
    // retry that reported it, so the run must end here rather than merely skip compaction.
    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("provider request-size ceiling"),
    );
    // The run's recovery budget is untouched, so a genuine overflow later in the same run still
    // gets its full compaction attempts and its one tool-result truncation.
    expect(input.state.overflowCompactionAttempts).toBe(0);
    expect(input.state.toolResultTruncationAttempted).toBe(false);
  });

  it("keeps ordinary TPM throttling out of overflow recovery", async () => {
    // Same wording family, but the requested size fits the limit: waiting still resolves it,
    // so this stays a rate limit and never reaches overflow recovery at all.
    const promptError = new Error(
      "429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` " +
        "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7500, " +
        "Requested 1000, please try again in 3.5s.",
    );

    const result = await recoverEmbeddedRunOverflow(makeInput({ promptError }));

    expect(result).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("recovers overflow reported only by the assistant error text", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        promptError: null,
        assistantErrorText: "request_too_large: Request size exceeds model context window",
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  });

  it("does not inherit stale assistant overflow after a non-overflow prompt error", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        promptError: new Error("transport disconnected"),
        assistantErrorText: "request_too_large: Request size exceeds model context window",
      }),
    );

    expect(result).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("recovers provider overflow when an owns-compaction engine skipped precheck", async () => {
    const input = makeInput({
      contextEngine: {
        info: { id: "test", name: "Test", ownsCompaction: true },
        ingest: vi.fn(),
        assemble: vi.fn(),
        compact: mocks.compact,
        maintain: mocks.maintenance,
      } as RecoveryInput["contextEngine"],
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(input.runOwnsCompactionBeforeHook).toHaveBeenCalledWith("overflow recovery");
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "overflow recovery",
      expect.objectContaining({ compacted: true, ok: true }),
      undefined,
    );
    expect(input.runParams.onAutoCompactionSucceeded).toHaveBeenCalledWith(1);
  });

  it("leaves overflow recovery to a transport-owning harness", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ genericCompactionRecoveryAllowed: false }),
    );

    expect(result).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("forwards preflight prompt estimates into synthetic overflow compaction", async () => {
    const promptError = overflowError();
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        promptError,
        attempt: {
          terminal: { kind: "failed", source: "precheck", error: promptError },
          preflightRecovery: {
            route: "compact_then_truncate",
            source: "mid-turn",
            estimatedPromptTokens: 268_138,
            promptBudgetBeforeReserve: 241_616,
            overflowTokens: 26_522,
          },
        },
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 241_616,
        currentTokenCount: 268_138,
        runtimeContext: expect.objectContaining({ trigger: "overflow" }),
      }),
    );
  });

  it("keeps the raw budget for provider overflow with preflight metadata", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        attempt: {
          preflightRecovery: {
            route: "compact_then_truncate",
            source: "mid-turn",
            estimatedPromptTokens: 268_138,
            promptBudgetBeforeReserve: 241_616,
            overflowTokens: 26_522,
          },
        },
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 200_000 }));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps the raw budget for an invalid preflight budget of %s",
    async (promptBudgetBeforeReserve) => {
      const promptError = overflowError();
      const result = await recoverEmbeddedRunOverflow(
        makeInput({
          promptError,
          attempt: {
            terminal: { kind: "failed", source: "precheck", error: promptError },
            preflightRecovery: {
              route: "compact_only",
              source: "mid-turn",
              estimatedPromptTokens: 268_138,
              promptBudgetBeforeReserve,
              overflowTokens: 26_522,
            },
          },
        }),
      );

      expect(result).toEqual({ action: "retry" });
      expect(mocks.compact).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 200_000 }));
    },
  );

  it("uses the minimally over-budget count for unparseable overflow text", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: new Error("Context window exceeded for this request") }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledWith(
      expect.objectContaining({ currentTokenCount: 200_001 }),
    );
  });

  it("does not reset the overflow-compaction budget after an in-attempt compaction", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    const input = makeInput({ state, attemptCompactionCount: 1 });
    const result = await recoverEmbeddedRunOverflow(input);

    expect(result).toEqual({ action: "retry" });
    expect(state.overflowCompactionAttempts).toBe(1);
    expect(input.markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("resets stale token state after an empty preflight compaction", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    state.lastCompactionTokensAfter = 80_000;
    state.lastContextBudgetStatus = {
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 1,
      provider: "openai",
      model: "gpt-test",
      route: "compact_only",
      shouldCompact: true,
      estimatedPromptTokens: 268_138,
      contextTokenBudget: 200_000,
      promptBudgetBeforeReserve: 196_000,
      reserveTokens: 4_000,
      effectiveReserveTokens: 4_000,
      remainingPromptBudgetTokens: 0,
      overflowTokens: 72_138,
      toolResultReducibleChars: 0,
      messageCount: 0,
      unwindowedMessageCount: 0,
    };
    mocks.compact.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "no real conversation messages",
    });
    mocks.isNoRealConversationCompactionNoop.mockReturnValueOnce(true);

    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        state,
        attempt: { preflightRecovery: { route: "compact_only" } },
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(state.lastCompactionTokensAfter).toBeUndefined();
    expect(state.lastContextBudgetStatus).toBeUndefined();
    expect(mocks.resetNoRealConversationTokenSnapshot).toHaveBeenCalledWith({
      sessionTarget: undefined,
      sessionPersistence: undefined,
      assertActive: expect.any(Function),
    });
  });

  it("runs hooks and maintenance against the adopted compacted transcript", async () => {
    let activeSession = {
      id: "session-1",
      file: "/tmp/session-1.jsonl",
      target: undefined,
    };
    const adoptCompactionTranscript = vi.fn(async () => {
      activeSession = {
        id: "rotated-session",
        file: "/tmp/rotated-session.jsonl",
        target: undefined,
      };
      return "session-1";
    });
    const input = makeInput({
      contextEngine: {
        info: { id: "test", name: "Test", ownsCompaction: true },
        ingest: vi.fn(),
        assemble: vi.fn(),
        compact: mocks.compact,
        maintain: mocks.maintenance,
      } as RecoveryInput["contextEngine"],
      adoptCompactionTranscript,
      getActiveSession: () => activeSession,
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(input.runOwnsCompactionBeforeHook).toHaveBeenCalledWith("overflow recovery");
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "overflow recovery",
      expect.objectContaining({ compacted: true, ok: true }),
      "session-1",
    );
    expect(mocks.maintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "rotated-session",
        sessionFile: "/tmp/rotated-session.jsonl",
        reason: "compaction",
      }),
    );
    expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
  });

  it("guards thrown compaction attempts and still runs the after hook", async () => {
    mocks.compact.mockRejectedValueOnce(new Error("engine boom"));
    const input = makeInput();

    const result = await recoverEmbeddedRunOverflow(input);

    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(input.runOwnsCompactionBeforeHook).toHaveBeenCalledOnce();
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "overflow recovery",
      expect.objectContaining({ compacted: false, ok: false }),
      undefined,
    );
  });

  it("surfaces a visible blocked recovery payload after attempts are exhausted", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    state.overflowCompactionAttempts = 3;

    const result = await recoverEmbeddedRunOverflow(makeInput({ state }));

    expect(result).toMatchObject({
      action: "surface",
      kind: "context_overflow",
      userText: expect.stringContaining("Context overflow"),
    });
    if (result.action !== "surface") {
      throw new Error("Expected exhausted overflow recovery to surface");
    }
    expect(result.userText).toContain("/reset");
    expect(result.userText).toContain("/new");
  });
});
