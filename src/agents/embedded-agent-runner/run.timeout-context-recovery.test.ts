import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { recoverEmbeddedRunTimeout } from "./run/timeout-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  info: vi.fn(),
  postCompactionSideEffects: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./run/compaction-runtime.js", () => ({
  compactEmbeddedRunForRecovery: mocks.compact,
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
  const attempt = {
    terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    ...attemptOverride,
  } as EmbeddedRunAttemptResult;
  return {
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
    contextEngine: {
      info: { id: "legacy", name: "Legacy" },
      ingest: vi.fn(),
      assemble: vi.fn(),
      compact: vi.fn(),
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
    runtimeAuthPlan: {},
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
    buildRuntimeSettings: () => ({}),
    onCompactionHookMessages: vi.fn(async () => {}),
    runOwnsCompactionBeforeHook: vi.fn(async () => {}),
    runOwnsCompactionAfterHook: vi.fn(async () => {}),
    adoptCompactionTranscript: vi.fn(async () => undefined),
    getActiveSession: () => ({ id: "session-1", file: "/tmp/session-1.jsonl" }),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    armPostCompactionGuard: vi.fn(),
    ...inputOverrides,
  } as unknown as RecoveryInput;
}

describe("recoverEmbeddedRunTimeout", () => {
  beforeEach(() => {
    mocks.compact.mockReset().mockResolvedValue({
      result: successfulCompaction(),
      runtimeContext: {},
      runtimeSettings: {},
    });
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
      input,
      expect.objectContaining({
        tokenBudget: 200_000,
        trigger: "timeout_recovery",
        attempt: 1,
        maxAttempts: 2,
      }),
    );
    expect(input.runOwnsCompactionBeforeHook).toHaveBeenCalledWith("timeout recovery");
    expect(input.adoptCompactionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ compacted: true }),
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

  it("counts compacted-false results against the shared retry cap", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    mocks.compact.mockResolvedValue({
      result: { ok: false, compacted: false, reason: "nothing to compact" },
      runtimeContext: {},
      runtimeSettings: {},
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

  it("runs post-compaction side effects only for an engine-owned compaction", async () => {
    const input = makeInput({
      contextEngine: {
        info: { id: "test", name: "Test", ownsCompaction: true },
        ingest: vi.fn(),
        assemble: vi.fn(),
        compact: vi.fn(),
      } as RecoveryInput["contextEngine"],
      getActiveSession: () => ({ id: "rotated", file: "/tmp/rotated.jsonl" }),
    });

    expect(await recoverEmbeddedRunTimeout(input)).toBe(true);

    expect(mocks.postCompactionSideEffects).toHaveBeenCalledWith({
      config: {},
      sessionKey: "agent:main:session-1",
      sessionId: "rotated",
      agentId: "main",
      sessionFile: "/tmp/rotated.jsonl",
    });
  });
});
