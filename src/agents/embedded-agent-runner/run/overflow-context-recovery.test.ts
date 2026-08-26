import { describe, expect, it, vi } from "vitest";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { recoverEmbeddedRunOverflow as recoverEmbeddedRunOverflowType } from "./overflow-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const truncateOversizedToolResultsInActiveTargetMock = vi.hoisted(() =>
  vi.fn(async () => ({ truncated: true, truncatedCount: 1 })),
);
const sessionLikelyHasOversizedToolResultsMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../tool-result-truncation.js", () => ({
  resolveLiveToolResultMaxChars: () => 32_000,
  sessionLikelyHasOversizedToolResults: sessionLikelyHasOversizedToolResultsMock,
  truncateOversizedToolResultsInActiveTarget: truncateOversizedToolResultsInActiveTargetMock,
}));

describe("recoverEmbeddedRunOverflow", () => {
  it("passes the frozen prompt projection into append-only fallback truncation", async () => {
    const { recoverEmbeddedRunOverflow } = await import("./overflow-context-recovery.js");
    const promptError = new Error("Context window exceeded for this request");
    const projectionState: ToolResultPromptProjectionState = {
      replacements: new Map(),
      frozen: new Set(["tool:call_1:1"]),
      ambiguousBaseKeys: new Set(),
      sourceTextByKey: new Map(),
    };
    const attempt = {
      terminal: { kind: "failed", source: "prompt", error: promptError },
      messagesSnapshot: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(64_000) }],
          isError: false,
          timestamp: 1,
        },
      ],
    } as EmbeddedRunAttemptResult;
    const markOwnedTranscriptRetry = vi.fn();

    const result = await recoverEmbeddedRunOverflow({
      runParams: {
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
      },
      state: {
        autoCompactionCount: 0,
        lastCompactionTokensAfter: undefined,
        lastContextBudgetStatus: undefined,
        overflowCompactionAttempts: 3,
        timeoutCompactionAttempts: 0,
        toolResultTruncationAttempted: false,
      },
      contextEngine: {
        info: { id: "legacy", name: "Legacy" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({
          messages,
        }: {
          messages: EmbeddedRunAttemptResult["messagesSnapshot"];
        }) => ({
          messages,
          estimatedTokens: 0,
        }),
        compact: async () => ({ ok: true, compacted: false }),
      },
      contextTokenBudget: 200_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt,
      toolResultPromptProjectionState: projectionState,
      attemptCompactionCount: 0,
      runtimeAuthPlan: {},
      resolvedSessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      modelId: "gpt-test",
      harnessRuntime: "embedded",
      thinkLevel: "off",
      authProfileIdSource: "auto",
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}),
      onCompactionHookMessages: async () => {},
      runOwnsCompactionBeforeHook: async () => {},
      runOwnsCompactionAfterHook: async () => {},
      adoptCompactionTranscript: async () => undefined,
      getActiveSession: () => ({ id: "session-1", file: "agent:main:session-1" }),
      prepareCurrentTranscriptRetry: () => {},
      prepareCompactedTranscriptRetry: async () => {},
      markOwnedTranscriptRetry,
      armPostCompactionGuard: () => {},
    } as unknown as Parameters<typeof recoverEmbeddedRunOverflow>[0]);

    expect(result).toEqual({ action: "retry" });
    expect(markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(truncateOversizedToolResultsInActiveTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionState,
        scope: expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      }),
    );
  });

  it("fails closed when active session ownership changes during compaction", async () => {
    const { recoverEmbeddedRunOverflow } = await import("./overflow-context-recovery.js");
    const promptError = new Error("Context window exceeded for this request");
    const adoptCompactionTranscript = vi.fn(async () => undefined);
    let activeSession = { id: "session-1", file: "agent:main:session-1" };
    sessionLikelyHasOversizedToolResultsMock.mockReturnValueOnce(false);

    const result = await recoverEmbeddedRunOverflow({
      runParams: {
        runId: "run-owner-change",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
      },
      state: {
        autoCompactionCount: 0,
        lastCompactionTokensAfter: undefined,
        lastContextBudgetStatus: undefined,
        overflowCompactionAttempts: 0,
        timeoutCompactionAttempts: 0,
        toolResultTruncationAttempted: false,
      },
      contextEngine: {
        info: { id: "legacy", name: "Legacy" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }: { messages: [] }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => {
          activeSession = { id: "session-2", file: "agent:main:session-2" };
          return { ok: true as const, compacted: true as const, result: { summary: "done" } };
        },
      },
      contextTokenBudget: 200_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt: {
        terminal: { kind: "failed", source: "precheck", error: promptError },
        messagesSnapshot: [],
        replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      } as unknown as EmbeddedRunAttemptResult,
      toolResultPromptProjectionState: {
        replacements: new Map(),
        frozen: new Set(),
        ambiguousBaseKeys: new Set(),
        sourceTextByKey: new Map(),
      },
      attemptCompactionCount: 0,
      runtimeAuthPlan: {},
      resolvedSessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      modelId: "gpt-test",
      harnessRuntime: "embedded",
      thinkLevel: "off",
      authProfileIdSource: "auto",
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}),
      onCompactionHookMessages: async () => {},
      runOwnsCompactionBeforeHook: async () => {},
      runOwnsCompactionAfterHook: async () => {},
      adoptCompactionTranscript,
      getActiveSession: () => activeSession,
      prepareCurrentTranscriptRetry: () => {},
      prepareCompactedTranscriptRetry: async () => {},
      armPostCompactionGuard: () => {},
    } as unknown as Parameters<typeof recoverEmbeddedRunOverflow>[0]);

    expect(adoptCompactionTranscript).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "surface",
      kind: "context_overflow",
      userText: expect.stringContaining("Completed tool actions were not replayed"),
    });
  });

  // Groq refuses an oversized single request with a 413 that names TPM and states both numbers.
  // Requested above Limit cannot be admitted by any bucket state, and compaction budgets against
  // the model's 131k context window rather than the provider's 8k per-request ceiling, so the
  // recovery owner must go terminal instead of compacting, adopting, truncating, or retrying.
  const GROQ_REQUEST_CEILING_413 =
    "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
    "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
    "please reduce your message size and try again.";

  function buildCeilingRecoveryInput(promptError: Error, overrides: Record<string, unknown>) {
    return {
      runParams: {
        runId: "run-ceiling",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
      },
      state: {
        autoCompactionCount: 0,
        lastCompactionTokensAfter: undefined,
        lastContextBudgetStatus: undefined,
        // Zero attempts means generic recovery would compact if it were allowed to.
        overflowCompactionAttempts: 0,
        timeoutCompactionAttempts: 0,
        toolResultTruncationAttempted: false,
      },
      contextTokenBudget: 131_072,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt: {
        terminal: { kind: "failed", source: "prompt", error: promptError },
        messagesSnapshot: [],
        replayMetadata: { replaySafe: false, hadPotentialSideEffects: false },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      } as unknown as EmbeddedRunAttemptResult,
      toolResultPromptProjectionState: {
        replacements: new Map(),
        frozen: new Set(),
        ambiguousBaseKeys: new Set(),
        sourceTextByKey: new Map(),
      },
      attemptCompactionCount: 0,
      runtimeAuthPlan: {},
      resolvedSessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "mock-groq",
      modelId: "openai/gpt-oss-120b",
      harnessRuntime: "embedded",
      thinkLevel: "off",
      authProfileIdSource: "auto",
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}),
      onCompactionHookMessages: async () => {},
      runOwnsCompactionAfterHook: async () => {},
      getActiveSession: () => ({ id: "session-1", file: "agent:main:session-1" }),
      prepareCurrentTranscriptRetry: () => {},
      armPostCompactionGuard: () => {},
      ...overrides,
    } as unknown as Parameters<typeof recoverEmbeddedRunOverflowType>[0];
  }

  it("surfaces reset guidance without compacting when the provider states a request-size ceiling", async () => {
    const { recoverEmbeddedRunOverflow } = await import("./overflow-context-recovery.js");
    const compact = vi.fn(async () => ({ ok: true as const, compacted: true as const }));
    const adoptCompactionTranscript = vi.fn(async () => undefined);
    const prepareCompactedTranscriptRetry = vi.fn(async () => {});
    const runOwnsCompactionBeforeHook = vi.fn(async () => {});
    truncateOversizedToolResultsInActiveTargetMock.mockClear();
    sessionLikelyHasOversizedToolResultsMock.mockReturnValue(true);

    const result = await recoverEmbeddedRunOverflow(
      buildCeilingRecoveryInput(new Error(GROQ_REQUEST_CEILING_413), {
        contextEngine: {
          info: { id: "legacy", name: "Legacy" },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: [] }) => ({ messages, estimatedTokens: 0 }),
          compact,
        },
        adoptCompactionTranscript,
        prepareCompactedTranscriptRetry,
        runOwnsCompactionBeforeHook,
      }),
    );

    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect((result as { userText: string }).userText).toContain("/reset");
    // Terminal: none of the generic recovery machinery may run for an unsatisfiable request.
    expect(compact).not.toHaveBeenCalled();
    expect(runOwnsCompactionBeforeHook).not.toHaveBeenCalled();
    expect(adoptCompactionTranscript).not.toHaveBeenCalled();
    expect(prepareCompactedTranscriptRetry).not.toHaveBeenCalled();
    expect(truncateOversizedToolResultsInActiveTargetMock).not.toHaveBeenCalled();
  });

  it("leaves ordinary TPM throttling to the rate-limit owner instead of overflow recovery", async () => {
    const { recoverEmbeddedRunOverflow } = await import("./overflow-context-recovery.js");
    const compact = vi.fn(async () => ({ ok: true as const, compacted: false as const }));
    truncateOversizedToolResultsInActiveTargetMock.mockClear();

    const result = await recoverEmbeddedRunOverflow(
      buildCeilingRecoveryInput(
        new Error(
          "429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` " +
            "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7500, " +
            "Requested 1000, please try again in 3.5s.",
        ),
        {
          contextEngine: {
            info: { id: "legacy", name: "Legacy" },
            ingest: async () => ({ ingested: true }),
            assemble: async ({ messages }: { messages: [] }) => ({ messages, estimatedTokens: 0 }),
            compact,
          },
          adoptCompactionTranscript: async () => undefined,
          prepareCompactedTranscriptRetry: async () => {},
          runOwnsCompactionBeforeHook: async () => {},
        },
      ),
    );

    expect(result).toEqual({ action: "none" });
    expect(compact).not.toHaveBeenCalled();
  });
});
