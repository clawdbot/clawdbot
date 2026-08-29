import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { normalizeUsage } from "../usage.js";
import {
  compactEmbeddedRunForRecovery,
  createEmbeddedRunCompactionRuntime,
  type EmbeddedRunCompactionRecoveryInput,
} from "./run/compaction-runtime.js";
import { readCompactionUsageRecorder } from "./run/compaction-usage-bridge.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const completionMocks = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../simple-completion-runtime.js", () => completionMocks);

// Keep this dedicated leaf on the compaction composition boundary. Runtime/auth/lane policy is
// covered at its direct owners so this shard never reloads the complete public runner graph.
const baseRunParams = {
  admittedRunContext: createTestAdmittedRunContext("run-1"),
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

function makeContextEngine(compact = vi.fn()): ContextEngine {
  return {
    info: { id: "test", name: "Test", ownsCompaction: true },
    ingest: vi.fn(),
    assemble: vi.fn(),
    compact,
  } as ContextEngine;
}

function makeRecoveryInput(
  overrides: Partial<EmbeddedRunCompactionRecoveryInput> = {},
): EmbeddedRunCompactionRecoveryInput {
  const runParams = overrides.runParams ?? baseRunParams;
  return {
    runParams,
    state: createEmbeddedRunContextRecoveryState(),
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
      result: { summary: "compacted", tokensAfter: 80_000 },
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
    ).rejects.toThrow("not bound to an active session agent");
    expect(completionMocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

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
      readCompactionUsageRecorder(params.runtimeContext)?.(usage);
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
  function createRuntime(
    params: {
      compactResult?: Awaited<ReturnType<ContextEngine["compact"]>>;
      sessionTarget?: { sessionKey: string; storePath: string; sessionId?: string };
    } = {},
  ) {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeCompaction: vi.fn(async () => undefined),
      runAfterCompaction: vi.fn(async () => undefined),
    };
    const onAgentEvent = vi.fn(async () => undefined);
    const sessionPromptState = {
      sessionId: "session-1",
      sessionFile: "agent:main:session-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(
          tempDirs.make("openclaw-overflow-compaction-session-"),
          "openclaw.sqlite",
        ),
      },
      adoptSessionId: vi.fn((sessionId?: string) => {
        if (sessionId) {
          sessionPromptState.sessionId = sessionId;
        }
      }),
      adoptSessionTarget: vi.fn(async (target?: { sessionId?: string }) => {
        if (target?.sessionId) {
          sessionPromptState.sessionId = target.sessionId;
        }
      }),
    };
    const runtime = createEmbeddedRunCompactionRuntime({
      runParams: { ...baseRunParams, onAgentEvent },
      contextEngine: makeContextEngine(),
      hookRunner: hookRunner as never,
      hookContext: {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
      },
      sessionPromptState: sessionPromptState as never,
    });
    const compactResult =
      params.compactResult ??
      ({
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensAfter: 50,
          sessionId: "rotated-session",
          sessionFile: "/tmp/rotated-session.jsonl",
          sessionTarget: params.sessionTarget,
        },
      } as Awaited<ReturnType<ContextEngine["compact"]>>);
    return { compactResult, hookRunner, onAgentEvent, runtime, sessionPromptState };
  }

  it("adopts the top-level successor id for a partial session target", async () => {
    const fixture = createRuntime({
      sessionTarget: {
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/rotated.sqlite",
      },
    });

    const previousSessionId = await fixture.runtime.adoptCompactionTranscript(
      fixture.compactResult,
    );

    expect(previousSessionId).toBe("session-1");
    expect(fixture.sessionPromptState.adoptSessionTarget).toHaveBeenCalledWith({
      sessionKey: "agent:main:session-1",
      storePath: "/tmp/rotated.sqlite",
      sessionId: "rotated-session",
    });
    expect(fixture.sessionPromptState.sessionId).toBe("rotated-session");
  });

  it("fires ownership hooks against the rotated compacted transcript", async () => {
    const fixture = createRuntime();
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
        sessionFile: "/tmp/rotated-session.jsonl",
      }),
      expect.objectContaining({ sessionId: "rotated-session" }),
    );
  });

  it("forwards non-empty compaction hook messages as agent events", async () => {
    const fixture = createRuntime();

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
