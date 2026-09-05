import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { markRuntimeCompactionDelegate } from "../../context-engine/compaction-watchdog.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { normalizeUsage } from "../usage.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import {
  compactEmbeddedRunForRecovery,
  createEmbeddedRunCompactionRuntime,
  type EmbeddedRunCompactionRecoveryInput,
} from "./run/compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const admissions: PreparedAgentRunAdmission[] = [];
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
});
const completionMocks = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));
const compactRuntimeMocks = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemand: vi.fn(),
}));

vi.mock("../simple-completion-runtime.js", () => completionMocks);
vi.mock("./compact.runtime.js", () => compactRuntimeMocks);

// Keep this dedicated leaf on the compaction composition boundary. Runtime/auth/lane policy is
// covered at its direct owners so this shard never reloads the complete public runner graph.
const baseRunParams = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  sessionFile: "agent:main:session-1",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} satisfies PreparedEmbeddedRunInput["runParams"];

function makeAttempt(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "failed", source: "prompt", error: new Error("context overflow") },
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
    ...overrides,
  };
}

function makeContextEngine(
  compact: ContextEngine["compact"] | ReturnType<typeof vi.fn> = vi.fn(),
  ownsCompaction = true,
): ContextEngine {
  return {
    info: { id: "test", name: "Test", ownsCompaction },
    ingest: vi.fn(),
    assemble: vi.fn(),
    compact,
  } as ContextEngine;
}

function makeRecoveryInput(
  overrides: Partial<EmbeddedRunCompactionRecoveryInput> = {},
): EmbeddedRunCompactionRecoveryInput {
  const runParams: EmbeddedRunCompactionRecoveryInput["runParams"] =
    overrides.runParams ?? baseRunParams;
  return {
    runParams,
    state: createEmbeddedRunContextRecoveryState(),
    assertRecoveryActive: vi.fn(),
    prepareRecoveryOwner: () => ({
      session: {
        id: runParams.sessionId,
        file: runParams.sessionFile ?? runParams.sessionKey ?? runParams.sessionId,
        target: {
          agentId: "main",
          sessionId: runParams.sessionId,
          sessionKey: runParams.sessionKey ?? baseRunParams.sessionKey,
          storePath: path.join(runParams.workspaceDir, "openclaw-agent.sqlite"),
        },
      },
      assertActive: () => {
        runParams.abortSignal?.throwIfAborted();
        overrides.assertRecoveryActive?.();
      },
      withTranscriptWrites: async <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
        signal?.throwIfAborted();
        return await run();
      },
    }),
    prepareRecoverySession: () => ({
      sessionManager: SessionManager.inMemory(),
      assertActive: vi.fn(),
      withSessionManagerRewriteLock: async <T>(operation: () => Promise<T> | T) =>
        await operation(),
    }),
    contextEngine: makeContextEngine(),
    genericCompactionRecoveryAllowed: true,
    attempt: makeAttempt(),
    runtimeAuthPlan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    },
    resolvedSessionKey: runParams.sessionKey ?? baseRunParams.sessionKey,
    sessionAgentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    provider: "openai",
    modelId: "gpt-5.5",
    harnessRuntime: "openclaw",
    thinkLevel: "off",
    authProfileIdSource: "auto",
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
      buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: "openai",
        requestedModel: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        promptTokenBudget: tokenBudget,
        degradedReason,
      }),
    onCompactionHookMessages: vi.fn(async () => {}),
    runOwnsCompactionBeforeHook: vi.fn(async () => {}),
    runOwnsCompactionAfterHook: vi.fn(async () => {}),
    adoptCompactionTranscript: vi.fn(async () => undefined),
    getActiveSession: () => ({
      id: "session-1",
      file: runParams.sessionFile ?? runParams.sessionKey ?? runParams.sessionId,
    }),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
    ...overrides,
  };
}

describe("compactEmbeddedRunForRecovery", () => {
  beforeEach(() => {
    compactRuntimeMocks.compactEmbeddedAgentSessionOnDemand.mockReset();
    completionMocks.prepareSimpleCompletionModelForAgent.mockReset();
    completionMocks.completeWithPreparedSimpleCompletionModel.mockReset();
    completionMocks.resolveSimpleCompletionSelectionForAgent.mockReset();
    completionMocks.prepareSimpleCompletionModelForAgent.mockResolvedValue({
      selection: { provider: "openai", modelId: "gpt-5.5", agentDir: "/tmp/main" },
      model: {
        provider: "openai",
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai",
        input: ["text"],
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
    });
    completionMocks.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 1, total: 2 },
    });
    completionMocks.resolveSimpleCompletionSelectionForAgent.mockReturnValue({
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: "/tmp/main",
    });
  });

  it("carries locked model, auth, fallback, cache, and overflow facts into compaction", async () => {
    const compact = vi.fn(async () => ({
      ok: true as const,
      compacted: true as const,
      result: { summary: "compacted", tokensBefore: 150_000, tokensAfter: 80_000 },
    }));
    const contextEngine = makeContextEngine(compact);
    const promptCache = {
      retention: "short" as const,
      lastCallUsage: { input: 150_000, cacheRead: 32_000, total: 182_000 },
      observation: { broke: false, cacheRead: 32_000 },
      lastCacheTouchAt: 1_700_000_000_000,
    };
    const runtimeAuthPlan = {
      authProfileProviderForAuth: "openai",
      providerForAuth: "openai",
    } satisfies AgentRuntimeAuthPlan;

    const result = await compactEmbeddedRunForRecovery(
      makeRecoveryInput({
        runParams: {
          ...baseRunParams,
          sandboxSessionKey: "global",
          sandboxAgentId: "main",
          modelSelectionLocked: true,
          modelFallbacksOverride: [],
        },
        contextEngine,
        contextTokenBudget: 200_000,
        attempt: makeAttempt({ promptCache }),
        runtimeAuthPlan,
        thinkLevel: "ultra",
        authProfileId: "openai:work",
        authProfileIdSource: "user",
      }),
      {
        tokenBudget: 200_000,
        trigger: "overflow",
        diagId: "diag-1",
        attempt: 1,
        maxAttempts: 3,
        currentTokenCount: 277_403,
      },
    );

    expect(result.result).toMatchObject({ ok: true, compacted: true });
    expect(compact).toHaveBeenCalledOnce();
    const compactInput = (
      compact.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0];
    expect(compactInput).toMatchObject({
      sessionId: "session-1",
      sessionKey: baseRunParams.sessionKey,
      currentTokenCount: 277_403,
      tokenBudget: 200_000,
      runtimeContext: {
        sandboxSessionKey: "global",
        sandboxAgentId: "main",
        trigger: "overflow",
        currentTokenCount: 277_403,
        provider: "openai",
        model: "gpt-5.5",
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
        authProfileId: "openai:work",
        promptCache,
      },
    });
  });

  it.each(["overflow", "timeout_recovery"] as const)(
    "lets delegated native %s compaction use its progress-aware watchdog",
    async (trigger) => {
      vi.useFakeTimers();
      try {
        compactRuntimeMocks.compactEmbeddedAgentSessionOnDemand.mockImplementationOnce(
          (params: { compactionTimeoutReset?: () => void }) =>
            new Promise((resolve) => {
              setTimeout(() => params.compactionTimeoutReset?.(), 900);
              setTimeout(() => resolve({ ok: true, compacted: false }), 1_100);
            }),
        );
        const contextEngine = makeContextEngine(delegateCompactionToRuntime, false);
        const pending = compactEmbeddedRunForRecovery(
          makeRecoveryInput({
            runParams: {
              ...baseRunParams,
              config: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } },
            },
            contextEngine,
          }),
          {
            tokenBudget: 200_000,
            trigger,
            diagId: `diag-${trigger}`,
            attempt: 1,
            maxAttempts: 3,
          },
        );
        const assertion = expect(pending).resolves.toMatchObject({
          result: { ok: true, compacted: false },
        });

        await vi.advanceTimersByTimeAsync(1_100);
        await assertion;
        expect(compactRuntimeMocks.compactEmbeddedAgentSessionOnDemand).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not trust the active run fallback during recovery compaction", async () => {
    const compact = vi.fn(async (params: { runtimeContext?: ContextEngineRuntimeContext }) => {
      await params.runtimeContext?.llm?.complete({
        messages: [{ role: "user", content: "summarize" }],
      });
      return { ok: true as const, compacted: false as const };
    });
    const contextEngine = makeContextEngine(compact);
    const runParams = {
      ...baseRunParams,
      config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      sessionKey: "legacy-session",
      sessionFile: "legacy-session",
    } satisfies PreparedEmbeddedRunInput["runParams"];

    await expect(
      compactEmbeddedRunForRecovery(
        makeRecoveryInput({
          runParams,
          contextEngine,
          resolvedSessionKey: "legacy-session",
        }),
        {
          tokenBudget: 200_000,
          trigger: "overflow",
          diagId: "diag-unbound",
          attempt: 1,
          maxAttempts: 3,
        },
      ),
    ).resolves.toMatchObject({
      result: {
        ok: false,
        compacted: false,
        reason: expect.stringContaining("not bound to an active session agent"),
      },
    });
    expect(completionMocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it.each(["returned", "failed", "cancelled", "failed-result"] as const)(
    "keeps committed context chronology when the backend is %s",
    async (outcome) => {
      const state = createEmbeddedRunContextRecoveryState();
      const controller = new AbortController();
      const error = new Error("backend settled after the committed replacement");
      const usageAccumulator = createUsageAccumulator();
      let progressReset: unknown;
      const compact = vi.fn<ContextEngine["compact"]>(async ({ runtimeContext }) => {
        progressReset = runtimeContext?.compactionTimeoutReset;
        const recorder = readCompactionAccountingRecorder(runtimeContext);
        recorder?.recordUsage({ input: 100, output: 50, total: 150 });
        recorder?.recordCompaction(40);
        state.observeContextAccounting({ kind: "model", contextTokens: 20 });
        if (outcome === "failed") {
          throw error;
        }
        if (outcome === "cancelled") {
          controller.abort(error);
        }
        if (outcome === "failed-result") {
          return {
            ok: false,
            compacted: false,
            reason: error.message,
            result: {
              summary: "Unaccepted partial successor",
              tokensBefore: 100,
              tokensAfter: 70,
              sessionId: "unaccepted-successor",
            },
          };
        }
        return { ok: true, compacted: true, result: { tokensBefore: 100, tokensAfter: 70 } };
      });
      const input = makeRecoveryInput({
        state,
        usageAccumulator,
        runParams: { ...baseRunParams, abortSignal: controller.signal },
        // Only this synthetic canonical delegate is tagged; the real safety helper
        // must project its progress callback without losing private accounting.
        contextEngine: makeContextEngine(markRuntimeCompactionDelegate(compact), false),
      });
      const recovery = {
        tokenBudget: 100,
        trigger: "overflow" as const,
        diagId: "ordered-commit",
        attempt: 1,
        maxAttempts: 3,
      };
      const pending = compactEmbeddedRunForRecovery(input, recovery);
      if (outcome === "cancelled") {
        await expect(pending).rejects.toBe(error);
      } else if (outcome === "failed-result") {
        const settled = await pending;
        const completedFact = { ok: false, compacted: true, reason: error.message };
        expect.soft(settled.result).toMatchObject(completedFact);
        expect.soft(settled.result.result).toBeUndefined();
        expect
          .soft(input.adoptCompactionTranscript)
          .toHaveBeenCalledExactlyOnceWith(completedFact, undefined);
      } else {
        await expect(pending).resolves.toMatchObject({ result: { ok: outcome === "returned" } });
      }
      expect(compact).toHaveBeenCalledOnce();
      expect.soft(typeof progressReset).toBe("function");
      expect.soft(usageAccumulator).toMatchObject({ input: 100, output: 50, total: 150 });
      expect(state).toMatchObject({
        autoCompactionCount: 1,
        lastCompactionTokensAfter: 40,
        currentContextSnapshot: { tokens: 20 },
      });
      if (outcome === "returned") {
        compact.mockResolvedValueOnce({
          ok: true,
          compacted: true,
          result: { tokensBefore: 100, tokensAfter: 60 },
        });
        await compactEmbeddedRunForRecovery(input, { ...recovery, attempt: 2 });
        expect(state).toMatchObject({
          autoCompactionCount: 2,
          currentContextSnapshot: { tokens: 60 },
        });
      }
    },
  );

  it("accounts recovery model usage even when compaction fails", async () => {
    const compact = vi.fn(async (params: { runtimeContext?: ContextEngineRuntimeContext }) => {
      const usage = normalizeUsage({
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
      });
      if (!usage) {
        throw new Error("expected normalized usage");
      }
      readCompactionAccountingRecorder(params.runtimeContext)?.recordUsage(usage);
      return { ok: false as const, compacted: false as const, reason: "invalid summary" };
    });
    const usageAccumulator = createUsageAccumulator();

    await compactEmbeddedRunForRecovery(
      makeRecoveryInput({ contextEngine: makeContextEngine(compact), usageAccumulator }),
      {
        tokenBudget: 200_000,
        trigger: "overflow",
        diagId: "diag-usage",
        attempt: 1,
        maxAttempts: 3,
      },
    );

    expect(usageAccumulator).toMatchObject({ input: 100, output: 50, total: 150 });
  });
});

describe("createEmbeddedRunCompactionRuntime", () => {
  async function createRuntime(
    params: {
      compactResult?: Awaited<ReturnType<ContextEngine["compact"]>>;
      sessionTarget?: ContextEngineSessionTarget;
    } = {},
  ) {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeCompaction: vi.fn(async () => undefined),
      runAfterCompaction: vi.fn(async () => undefined),
    };
    const onAgentEvent = vi.fn(async () => undefined);
    const currentTarget = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(
        tempDirs.make("openclaw-overflow-compaction-session-"),
        "openclaw-agent.sqlite",
      ),
    };
    const admission = prepareSystemAgentRunAdmission(
      {},
      baseRunParams.runId,
      "main",
      "compaction-hook-test",
    );
    admissions.push(admission);
    const admittedRunContext = await admission.admit("embedded");
    const runParams = {
      ...baseRunParams,
      onAgentEvent,
      admittedRunContext,
      sessionTarget: currentTarget,
      sessionManager: SessionManager.inMemory(baseRunParams.workspaceDir),
    };
    const sessionPromptState = createEmbeddedRunSessionPromptState({
      runParams,
      sessionAgentId: "main",
      resolvedSessionKey: baseRunParams.sessionKey,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
    });
    const runtime = createEmbeddedRunCompactionRuntime({
      runParams,
      contextEngine: makeContextEngine(),
      hookRunner: hookRunner as never,
      hookContext: {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
      },
      sessionPromptState,
    });
    const compactResult =
      params.compactResult ??
      ({
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: 120,
          tokensAfter: 50,
          sessionId: "rotated-session",
          sessionTarget: params.sessionTarget,
        },
      } as Awaited<ReturnType<ContextEngine["compact"]>>);
    return { compactResult, hookRunner, onAgentEvent, runtime, sessionPromptState, currentTarget };
  }

  it("adopts the top-level successor id for a partial session target", async () => {
    const fixture = await createRuntime({
      sessionTarget: {
        sessionKey: "agent:main:session-1",
        threadId: "thread-hint",
      },
    });

    const previousSessionId = await fixture.runtime.adoptCompactionTranscript(
      fixture.compactResult,
    );

    expect(previousSessionId).toBe("session-1");
    expect(fixture.sessionPromptState.sessionTarget).toEqual({
      ...fixture.currentTarget,
      sessionId: "rotated-session",
      threadId: "thread-hint",
    });
    expect(fixture.sessionPromptState.sessionId).toBe("rotated-session");
    expect(fixture.sessionPromptState.committedCompactionSuccessor).toBeUndefined();
  });

  it("fires ownership hooks against the rotated compacted transcript", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.runOwnsCompactionBeforeHook("overflow recovery");
    const previousSessionId = await fixture.runtime.adoptCompactionTranscript(
      fixture.compactResult,
    );

    await fixture.runtime.runOwnsCompactionAfterHook(
      "overflow recovery",
      fixture.compactResult,
      previousSessionId,
    );

    expect(fixture.hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      {
        messageCount: -1,
        sessionFile: "agent:main:session-1",
      },
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(fixture.hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenCount: 50,
        previousSessionId: "session-1",
        sessionFile: baseRunParams.sessionKey,
      }),
      expect.objectContaining({ sessionId: "rotated-session" }),
    );
  });

  it("forwards non-empty compaction hook messages as agent events", async () => {
    const fixture = await createRuntime();

    await fixture.runtime.onCompactionHookMessages({
      phase: "after",
      messages: ["", "Compaction complete"],
    });

    expect(fixture.onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: {
        phase: "end",
        completed: true,
        messages: ["Compaction complete"],
      },
      sessionKey: "agent:main:session-1",
    });
  });
});
