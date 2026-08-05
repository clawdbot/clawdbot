import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { AgentHarness } from "../harness/types.js";
import {
  codexHarnessSupportsKnownProviders,
  expectLogExcludes,
  expectLogIncludes,
  expectMockCallFields,
  expectRecordFields,
  mockCallArg,
} from "./run.continuation-fixture.test-support.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedCompactDirect,
  mockedContextEngine,
  mockedGlobalHookRunner,
  mockedIsLikelyContextOverflowError,
  mockedLog,
  mockedRunContextEngineMaintenance,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function mockOverflowRetrySuccess(params: {
  runEmbeddedAttempt: {
    mockResolvedValueOnce: (value: ReturnType<typeof makeAttemptResult>) => unknown;
  };
  compactDirect: {
    mockResolvedValueOnce: (value: ReturnType<typeof makeCompactionSuccess>) => unknown;
  };
  overflowMessage?: string;
}) {
  const overflowError = makeOverflowError(params.overflowMessage);

  params.runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({ terminal: { kind: "failed", source: "prompt", error: overflowError } }),
  );
  params.runEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
  params.compactDirect.mockResolvedValueOnce(
    makeCompactionSuccess({
      summary: "Compacted session",
      firstKeptEntryId: "entry-5",
      tokensBefore: 150000,
    }),
  );

  return overflowError;
}

function queueOverflowAttemptWithOversizedToolOutput(
  runEmbeddedAttempt: {
    mockResolvedValueOnce: (value: ReturnType<typeof makeAttemptResult>) => unknown;
  },
  overflowError: Error = makeOverflowError(),
): Error {
  runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({
      terminal: { kind: "failed", source: "prompt", error: overflowError },
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "x".repeat(80_000) }],
        } as unknown as ReturnType<typeof makeAttemptResult>["messagesSnapshot"][number],
      ],
    }),
  );
  return overflowError;
}

describe("runEmbeddedAgent overflow recovery continuation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const compactParams = expectMockCallFields(mockedCompactDirect, {
      sessionId: "test-session",
      sessionTarget: expect.objectContaining({
        sessionId: "test-session",
        sessionKey: overflowBaseRunParams.sessionKey,
      }),
    });
    expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
      authProfileId: "test-profile",
    });
    expectLogIncludes(mockedLog.warn, "[context-pressure:fire] mid-turn trigger=overflow");
  });

  it("uses the canonical session identity when sessionKey is empty on overflow path", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedAgent({ ...overflowBaseRunParams, sessionKey: "" });

    expectLogIncludes(
      mockedLog.warn,
      "[context-pressure:fire] mid-turn trigger=overflow attempt=1/3 tokens=?k/200k sessionKey=agent:main:test-session",
    );
    expectLogExcludes(mockedLog.warn, "[session-key:missing] site=pi-runner.overflow-compaction");
  });

  it("keeps implicit Codex overflow recovery out of generic compaction without a native compactor", async () => {
    useOpenAIPlatformAuthFixture();
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const overflowError = makeOverflowError();
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({
        promptError: overflowError,
        promptErrorSource: "prompt",
        assistantTexts: [],
      }),
    );
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });

    try {
      await expect(
        runEmbeddedAgent({
          ...overflowBaseRunParams,
          provider: "openai",
          model: "gpt-5.5",
          config: {
            models: {
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: "test-key",
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          },
          runId: "implicit-codex-overflow-owner",
        }),
      ).rejects.toThrow(overflowError.message);
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    const attemptParams = expectMockCallFields(pluginRunAttempt, { agentHarnessId: "codex" });
    expect(attemptParams.modelSelectionLocked).not.toBe(true);
    expect(mockedIsLikelyContextOverflowError).toHaveBeenCalledWith(overflowError.message);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it("threads prompt-cache runtime context into overflow compaction", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          promptCache: {
            retention: "short",
            lastCallUsage: {
              input: 150000,
              cacheRead: 32000,
              total: 182000,
            },
            observation: {
              broke: false,
              cacheRead: 32000,
            },
            lastCacheTouchAt: 1_700_000_000_000,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        tokensBefore: 150000,
        tokensAfter: 80000,
      }),
    );

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    const compactParams = expectMockCallFields(mockedCompactDirect, {});
    const runtimeContext = expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
    });
    const promptCache = expectRecordFields(runtimeContext.promptCache, {
      retention: "short",
      lastCacheTouchAt: 1_700_000_000_000,
    });
    expectRecordFields(promptCache.lastCallUsage, {
      input: 150000,
      cacheRead: 32000,
    });
    expectRecordFields(promptCache.observation, {
      broke: false,
      cacheRead: 32000,
    });
    expect(result.meta.agentMeta?.compactionTokensAfter).toBe(80_000);
  });

  it("recovers preflight compaction when stale tokens point at an empty transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-empty-preflight-"));
    const storePath = path.join(dir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey: overflowBaseRunParams.sessionKey, storePath },
      {
        sessionId: "test-session",
        updatedAt: 1,
        totalTokens: 1_500_000,
        totalTokensFresh: true,
        inputTokens: 20,
        outputTokens: 10_855,
        cacheRead: 1_761_324,
        cacheWrite: 33_047,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "claude-cli",
          model: "claude-opus-4-7",
          route: "compact_only",
          shouldCompact: true,
          estimatedPromptTokens: 1_794_391,
          contextTokenBudget: 1_048_576,
          promptBudgetBeforeReserve: 1_044_480,
          reserveTokens: 4_096,
          effectiveReserveTokens: 4_096,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 749_911,
          toolResultReducibleChars: 0,
          messageCount: 0,
          unwindowedMessageCount: 0,
        },
      },
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 1,
            provider: "claude-cli",
            model: "claude-opus-4-7",
            route: "compact_only",
            shouldCompact: true,
            estimatedPromptTokens: 1_794_391,
            contextTokenBudget: 1_048_576,
            promptBudgetBeforeReserve: 1_044_480,
            reserveTokens: 4_096,
            effectiveReserveTokens: 4_096,
            remainingPromptBudgetTokens: 0,
            overflowTokens: 749_911,
            toolResultReducibleChars: 0,
            messageCount: 0,
            unwindowedMessageCount: 0,
          },
          assistantTexts: [],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "no real conversation messages",
    });

    try {
      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        config: {
          session: {
            store: storePath,
          },
        } as RunEmbeddedAgentParams["config"],
      });

      expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.meta.error).toBeUndefined();
      expect(result.meta.agentMeta?.compactionTokensAfter).toBeUndefined();
      expect(result.meta.agentMeta?.contextBudgetStatus).toBeUndefined();
      const stored = loadSessionEntry({ sessionKey: overflowBaseRunParams.sessionKey, storePath });
      expect(stored?.totalTokens).toBe(0);
      expect(stored?.totalTokensFresh).toBe(true);
      expect(stored?.inputTokens).toBeUndefined();
      expect(stored?.outputTokens).toBeUndefined();
      expect(stored?.cacheRead).toBeUndefined();
      expect(stored?.cacheWrite).toBeUndefined();
      expect(stored?.contextBudgetStatus).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a visible blocked payload for Codex promptError overflow without assistant text", async () => {
    const promptError = new Error(
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );
    const terminalLifecycleMeta: Array<Record<string, unknown>> = [];
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError,
        promptErrorSource: "prompt",
        assistantTexts: [],
        attemptUsage: { input: 0, output: 0, total: 0 },
        setTerminalLifecycleMeta: (meta) => {
          terminalLifecycleMeta.push(meta);
        },
      }),
    );

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedIsLikelyContextOverflowError).toHaveBeenCalledWith(promptError.message);
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: expect.stringContaining("Context overflow"),
    });
    expect(result.payloads?.[0]?.text).toContain("/reset");
    expect(result.payloads?.[0]?.text).toContain("/new");
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.finalAssistantVisibleText).toBe(result.payloads?.[0]?.text);
    expect(terminalLifecycleMeta.at(-1)).toMatchObject({ livenessState: "blocked" });
  });

  it("does not reset compaction attempt budget after successful tool-result truncation", async () => {
    const overflowError = queueOverflowAttemptWithOversizedToolOutput(
      mockedRunEmbeddedAttempt,
      makeOverflowError(),
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "nothing to compact",
      })
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 3",
          firstKeptEntryId: "entry-7",
          tokensBefore: 140000,
        }),
      );

    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
  });

  it("retries overflow recovery against the rotated compacted transcript", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          sessionIdUsed: "rotated-session",
          sessionFileUsed: "/tmp/rotated-session.json",
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "rotated overflow compaction",
        tokensAfter: 50,
        sessionId: "rotated-session",
        sessionFile: "/tmp/rotated-session.json",
      }),
    );

    const replyOperation = createReplyOperation({
      sessionKey: overflowBaseRunParams.sessionKey,
      sessionId: "test-session",
      resetTriggered: false,
    });
    const onSessionIdChanged = vi.fn();
    replyOperation.setPhase("running");
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        replyOperation,
        onSessionIdChanged,
      });

      const compactParams = expectMockCallFields(mockedCompactDirect, {});
      expectMockCallFields(
        mockedRunEmbeddedAttempt,
        {
          sessionId: "rotated-session",
          sessionFile: "/tmp/rotated-session.json",
        },
        1,
      );
      const maintenanceParams = expectMockCallFields(mockedRunContextEngineMaintenance, {
        sessionId: "rotated-session",
        sessionFile: "/tmp/rotated-session.json",
      });
      expect(maintenanceParams.runtimeSettings).toBe(compactParams.runtimeSettings);
      const runtimeSettings = expectRecordFields(maintenanceParams.runtimeSettings, {});
      expectRecordFields(runtimeSettings.runtime, {
        mode: "degraded",
      });
      expectRecordFields(runtimeSettings.diagnostics, {
        degradedReason: "context_overflow",
      });
      expect(replyOperation.sessionId).toBe("rotated-session");
      expect(onSessionIdChanged).toHaveBeenCalledWith("rotated-session");
      expectRecordFields(mockCallArg(mockedGlobalHookRunner.runAfterCompaction), {
        previousSessionId: "test-session",
        sessionFile: "/tmp/rotated-session.json",
      });
      expectRecordFields(mockCallArg(mockedGlobalHookRunner.runAfterCompaction, 0, 1), {
        sessionId: "rotated-session",
      });
    } finally {
      replyOperation.complete();
    }
  });

  it("guards thrown engine-owned overflow compaction attempts", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    mockedCompactDirect.mockRejectedValueOnce(new Error("engine boom"));

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("threads a composed run abort signal into engine-owned overflow compaction", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    const abortController = new AbortController();
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({ summary: "engine-owned compaction", tokensAfter: 50 }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      abortSignal: abortController.signal,
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const compactArg = mockCallArg(mockedCompactDirect) as { abortSignal?: AbortSignal };
    expect(compactArg.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
