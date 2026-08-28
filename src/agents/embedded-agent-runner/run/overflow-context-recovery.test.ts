import { describe, expect, it, vi } from "vitest";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
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
});
