import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import {
  compactEmbeddedRunForRecovery,
  createEmbeddedRunCompactionRuntime,
} from "./run/compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

describe("compactEmbeddedRunForRecovery", () => {
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
      {
        runParams: {
          ...baseRunParams,
          modelSelectionLocked: true,
          modelFallbacksOverride: [],
        },
        state: createEmbeddedRunContextRecoveryState(),
        contextEngine,
        contextTokenBudget: 200_000,
        genericCompactionRecoveryAllowed: true,
        attempt: makeAttempt({ promptCache }),
        runtimeAuthPlan,
        resolvedSessionKey: baseRunParams.sessionKey,
        sessionAgentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        modelId: "gpt-5.5",
        harnessRuntime: "openclaw",
        thinkLevel: "ultra",
        authProfileId: "openai:work",
        authProfileIdSource: "user",
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
        getActiveSession: () => ({ id: "session-1", file: baseRunParams.sessionFile }),
        armPostCompactionGuard: vi.fn(),
      },
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
