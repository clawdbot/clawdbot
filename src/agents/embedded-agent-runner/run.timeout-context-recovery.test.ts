import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { recoverEmbeddedRunTimeout } from "./run/timeout-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  info: vi.fn(),
  postCompactionSideEffects: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./compaction-hooks.js", () => ({
  runPostCompactionSideEffects: mocks.postCompactionSideEffects,
}));

vi.mock("./logger.js", () => ({
  log: {
    info: mocks.info,
    warn: mocks.warn,
  },
}));

type RecoveryInput = Parameters<typeof recoverEmbeddedRunTimeout>[0];
type RecoveryOverrides = Omit<Partial<RecoveryInput>, "attempt" | "state"> & {
  attempt?: Partial<EmbeddedRunAttemptResult>;
  state?: RecoveryInput["state"];
};
type CompactionResult = Awaited<ReturnType<RecoveryInput["contextEngine"]["compact"]>>;

const successfulCompaction = (overrides: Record<string, unknown> = {}): CompactionResult =>
  ({
    ok: true,
    compacted: true,
    result: {
      summary: "timeout recovery",
      tokensBefore: 150_000,
      tokensAfter: 80_000,
      ...overrides,
    },
  }) as CompactionResult;

function makeInput(overrides: RecoveryOverrides = {}): RecoveryInput {
  const {
    attempt: attemptOverride,
    state = createEmbeddedRunContextRecoveryState(),
    ...inputOverrides
  } = overrides;
  const attempt = makeAttemptResult({
    terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
    sessionIdUsed: "session-1",
    assistantTexts: [],
    messagesSnapshot: [],
    ...attemptOverride,
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
    state,
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
      sessionManager: undefined,
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
    timedOut: true,
    signalOwnedInterruption: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    lastRunPromptUsage: { input: 150_000, total: 150_000 },
    attempt,
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
    harnessRuntime: "openclaw",
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
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
    ...inputOverrides,
  };
  return input;
}

describe("recoverEmbeddedRunTimeout", () => {
  beforeEach(() => {
    mocks.compact.mockReset().mockResolvedValue(successfulCompaction());
    mocks.info.mockReset();
    mocks.postCompactionSideEffects.mockReset();
    mocks.warn.mockReset();
  });

  it.each([
    ["generic recovery is unavailable", { genericCompactionRecoveryAllowed: false }],
    ["the context budget is unavailable", { contextTokenBudget: undefined }],
    ["the attempt did not time out", { timedOut: false }],
    ["the caller owns the interruption", { signalOwnedInterruption: true }],
    ["compaction itself timed out", { timedOutDuringCompaction: true }],
    ["tool execution timed out", { timedOutDuringToolExecution: true }],
    ["the aggregate run budget timed out", { timedOutByRunBudget: true }],
  ] as const)("does not compact when %s", async (_label, override) => {
    expect(await recoverEmbeddedRunTimeout(makeInput(override))).toBe(false);
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("requires prompt pressure above the 65 percent threshold", async () => {
    expect(
      await recoverEmbeddedRunTimeout(
        makeInput({ lastRunPromptUsage: { input: 130_000, total: 190_000 } }),
      ),
    ).toBe(false);
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("uses the explicit context snapshot instead of aggregate billing buckets", async () => {
    expect(
      await recoverEmbeddedRunTimeout(
        makeInput({
          lastRunPromptUsage: {
            input: 20_000,
            cacheRead: 150_000,
            contextUsage: {
              state: "available",
              promptTokens: 20_000,
              totalTokens: 20_500,
            },
            total: 170_500,
          },
        }),
      ),
    ).toBe(false);
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("compacts once, adopts the successor, and arms the retry guard", async () => {
    const input = makeInput({
      adoptCompactionTranscript: vi.fn(async () => "previous-session"),
    });

    expect(await recoverEmbeddedRunTimeout(input)).toBe(true);

    expect(mocks.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 200_000,
        runtimeContext: expect.objectContaining({
          trigger: "timeout_recovery",
          attempt: 1,
          maxAttempts: 2,
        }),
      }),
    );
    expect(input.runOwnsCompactionBeforeHook).toHaveBeenCalledWith("timeout recovery");
    expect(input.adoptCompactionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ compacted: true }),
      undefined,
    );
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "timeout recovery",
      expect.objectContaining({ compacted: true }),
      "previous-session",
    );
    expect(input.state).toMatchObject({
      timeoutCompactionAttempts: 1,
      autoCompactionCount: 1,
      lastCompactionTokensAfter: 80_000,
    });
    expect(input.runParams.onAutoCompactionSucceeded).toHaveBeenCalledWith(1);
    expect(input.armPostCompactionGuard).toHaveBeenCalledOnce();
    expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
  });

  it.each([
    { sessionId: "session-1", tokensAfter: 80_000 },
    { sessionId: "unaccepted-successor", tokensAfter: undefined },
  ])(
    "does not attribute $sessionId tokens to the predecessor when acceptance is cancelled",
    async ({ sessionId, tokensAfter }) => {
      const controller = new AbortController();
      const callerError = new Error("caller cancelled successor acceptance");
      mocks.compact.mockResolvedValueOnce(successfulCompaction({ sessionId }));
      const input = makeInput({
        assertRecoveryActive: () => controller.signal.throwIfAborted(),
        adoptCompactionTranscript: vi.fn(async () => {
          controller.abort(callerError);
          throw callerError;
        }),
      });
      input.runParams.abortSignal = controller.signal;

      await expect(recoverEmbeddedRunTimeout(input)).rejects.toBe(callerError);

      expect(input.state.autoCompactionCount).toBe(1);
      expect(input.state.lastCompactionTokensAfter).toBe(tokensAfter);
      expect(mocks.postCompactionSideEffects).not.toHaveBeenCalled();
      expect(input.prepareCompactedTranscriptRetry).not.toHaveBeenCalled();
    },
  );

  it("counts compacted-false results against the shared retry cap", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    mocks.compact.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    expect(await recoverEmbeddedRunTimeout(makeInput({ state }))).toBe(false);
    expect(await recoverEmbeddedRunTimeout(makeInput({ state }))).toBe(false);
    expect(await recoverEmbeddedRunTimeout(makeInput({ state }))).toBe(false);

    expect(state.timeoutCompactionAttempts).toBe(2);
    expect(mocks.compact).toHaveBeenCalledTimes(2);
  });

  it("normalizes thrown compaction failures and still consumes retry budget", async () => {
    const input = makeInput();
    mocks.compact.mockRejectedValueOnce(new Error("engine crashed"));

    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);

    expect(input.state.timeoutCompactionAttempts).toBe(1);
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "timeout recovery",
      expect.objectContaining({ compacted: false, reason: "Error: engine crashed" }),
      undefined,
    );
  });

  it.each(["durable", "detached"] as const)(
    "keeps %s recovery accounting separate from durable post-compaction effects",
    async (sessionPersistence) => {
      const input = makeInput({
        contextEngine: {
          info: { id: "test", name: "Test", ownsCompaction: true },
          ingest: vi.fn(),
          assemble: vi.fn(),
          compact: mocks.compact,
        } as RecoveryInput["contextEngine"],
        getActiveSession: () => ({ id: "rotated", file: "/tmp/rotated.jsonl" }),
      });
      input.runParams.sessionPersistence = sessionPersistence;

      expect(await recoverEmbeddedRunTimeout(input)).toBe(true);
      expect(input.state.autoCompactionCount).toBe(1);
      expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
      if (sessionPersistence === "detached") {
        expect(mocks.postCompactionSideEffects).not.toHaveBeenCalled();
      } else {
        expect(mocks.postCompactionSideEffects).toHaveBeenCalledWith({
          config: {},
          sessionKey: "agent:main:session-1",
          sessionId: "rotated",
          agentId: "main",
          sessionFile: "/tmp/rotated.jsonl",
          assertActive: input.assertRecoveryActive,
        });
      }
    },
  );
});
