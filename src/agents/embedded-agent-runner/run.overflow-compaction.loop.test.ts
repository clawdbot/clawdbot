import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createEmbeddedRunReplayState,
  type EmbeddedRunReplayState,
  observeReplayMetadata,
} from "./replay-state.js";
import { dispatchEmbeddedRunAttempt } from "./run/run-attempt-dispatch.js";

const mocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
  settleRequesterAfterSessionSpawns: vi.fn(),
}));

vi.mock("../delegation-capability.js", () => ({
  resolveDelegationCapability: vi.fn(() => undefined),
}));

vi.mock("../model-auth.js", () => ({
  applyAuthHeaderOverride: vi.fn((model: unknown) => model),
  applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
}));

vi.mock("../tool-terminal-outcome.js", () => ({
  createToolTerminalObserver: vi.fn(() => vi.fn()),
}));

vi.mock("./run/attempt-exec-approval-continuation.js", () => ({
  prepareExecApprovalContinuationForAttempt: vi.fn(({ prompt, transcriptPrompt }) => ({
    prompt,
    transcriptPrompt,
  })),
}));

vi.mock("../harness/selection.js", () => ({
  runAgentHarnessAttempt: mocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns: mocks.settleRequesterAfterSessionSpawns,
}));

vi.mock("./run/skill-workshop-attempt-params.js", () => ({
  resolveSkillWorkshopAttemptParams: vi.fn(() => ({})),
}));

function makeDispatchInput(
  sessionManager: object,
  replayState: EmbeddedRunReplayState,
): Parameters<typeof dispatchEmbeddedRunAttempt>[0] {
  return {
    params: {
      sessionFile: "agent:main:session-1",
      runId: "run-1",
      timeoutMs: 30_000,
      config: {},
      contextEngineLogicalTurnLease: { owner: "logical-turn" },
      onContextEngineTurnCandidate: vi.fn(),
      admittedRunContext: createTestAdmittedRunContext("run-1"),
    },
    transcriptOwnership: { kind: "caller-owned", sessionManager },
    runtime: {
      sessionId: "session-1",
      sessionFile: "agent:main:session-1",
      sessionKey: "agent:main:session-1",
      workspaceDir: "/tmp/workspace",
      isCanonicalWorkspace: false,
      agentDir: "/tmp/agent",
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      requestedModelId: "gpt-5.6-luna",
      fallbackActive: false,
      fallbackReason: null,
      agentHarnessId: "codex",
      runtimePlan: {},
      model: {
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        contextWindow: 200_000,
      },
      authProfileIdSource: "auto",
      initialReplayState: replayState,
      authStorage: {},
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: {},
      agentId: "main",
      thinkLevel: "off",
      fastMode: false,
      toolResultFormat: "markdown",
      skipPreparedUserTurnMessage: false,
      apiKeyInfo: undefined,
      runtimeAuthActive: false,
      captureRuntimeArtifact: false,
    },
    control: {
      lifecycleGeneration: "test-generation",
      pluginHarnessOwnsTransport: true,
      laneTaskAbortController: new AbortController(),
      laneTaskReleaseController: new AbortController(),
      noteLaneTaskProgress: vi.fn(),
      onToolOutcome: vi.fn(),
      isTurnTainted: vi.fn(() => false),
      allocateToolOutcomeOrdinal: vi.fn(() => 1),
      onToolStreamBoundary: vi.fn(),
      onRunProgress: vi.fn(),
      onToolResult: vi.fn(),
      onAgentEvent: vi.fn(),
      onUserMessagePersisted: vi.fn(),
      onUserMessagePersistenceInvalidated: vi.fn(),
      getPostCompactionAbortError: vi.fn(() => undefined),
      setPostCompactionAbortController: vi.fn(),
      clearPostCompactionAbortController: vi.fn(),
    },
    bootstrapPromptWarningSignaturesSeen: [],
    suppressNextUserMessagePersistence: false,
    beforeAgentFinalizeRevisionAttempts: 0,
    maxBeforeAgentFinalizeRevisions: 1,
  } as unknown as Parameters<typeof dispatchEmbeddedRunAttempt>[0];
}

describe("embedded run retry dispatch", () => {
  beforeEach(() => {
    mocks.runAttempt.mockReset().mockResolvedValue({ terminal: { kind: "ok" } });
    mocks.settleRequesterAfterSessionSpawns.mockReset();
  });

  it("preserves caller-owned turn facts and unsafe replay state on the next attempt", async () => {
    const sessionManager = { owner: "caller" };
    const replayState = observeReplayMetadata(
      observeReplayMetadata(createEmbeddedRunReplayState(), {
        replaySafe: false,
        hadPotentialSideEffects: true,
      }),
      { replaySafe: true, hadPotentialSideEffects: false },
    );

    const input = makeDispatchInput(sessionManager, replayState);
    const result = await dispatchEmbeddedRunAttempt(input);

    expect(result.preparedAttempt.sessionManager).toBe(sessionManager);
    expect(result.preparedAttempt.sessionTarget).toBeUndefined();
    expect(result.preparedAttempt.contextEngineLogicalTurnLease).toBeUndefined();
    expect(result.preparedAttempt.onContextEngineTurnCandidate).toBe(
      input.params.onContextEngineTurnCandidate,
    );
    expect(replayState).toEqual({ replayInvalid: true, hadPotentialSideEffects: true });
    expect(result.preparedAttempt.initialReplayState).toBe(replayState);
    expect(mocks.runAttempt).toHaveBeenCalledWith(result.preparedAttempt);
    expect(mocks.settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
  });

  it("forwards effective and authored context facts without a context engine (#124702)", async () => {
    const cappedInput = makeDispatchInput({}, createEmbeddedRunReplayState());
    cappedInput.runtime.contextTokenBudget = 272_000;
    cappedInput.runtime.authoredContextTokenCap = 32_000;
    const capped = await dispatchEmbeddedRunAttempt(cappedInput);

    expect(capped.preparedAttempt.contextTokenBudget).toBe(272_000);
    expect(capped.preparedAttempt.authoredContextTokenCap).toBe(32_000);

    const uncappedInput = makeDispatchInput({}, createEmbeddedRunReplayState());
    uncappedInput.runtime.contextTokenBudget = 272_000;
    const uncapped = await dispatchEmbeddedRunAttempt(uncappedInput);

    expect(uncapped.preparedAttempt.contextTokenBudget).toBe(272_000);
    expect(uncapped.preparedAttempt).not.toHaveProperty("authoredContextTokenCap");
  });

  it.each([undefined, false, true])(
    "preserves prepared GitHub publication capability (%s)",
    async (githubPublicationAvailable) => {
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.params.githubPublicationAvailable = githubPublicationAvailable;

      const result = await dispatchEmbeddedRunAttempt(input);

      expect(result.preparedAttempt.githubPublicationAvailable).toBe(githubPublicationAvailable);
    },
  );

  it.each([true, false])(
    "settles accepted spawns before a late post-compaction abort (yielded: %s)",
    async (yieldDetected) => {
      const postCompactionAbortError = new Error("post-compaction loop detected");
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.control.getPostCompactionAbortError = vi.fn(() => postCompactionAbortError);
      const acceptedSessionSpawns = [
        { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
      ];
      mocks.runAttempt.mockResolvedValueOnce({
        terminal: { kind: "ok" },
        agentHarnessId: "codex",
        yieldDetected,
        acceptedSessionSpawns,
      });

      await expect(dispatchEmbeddedRunAttempt(input)).rejects.toBe(postCompactionAbortError);

      expect(mocks.settleRequesterAfterSessionSpawns).toHaveBeenCalledWith({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:session-1",
        requesterTurnRunId: "run-1",
        requesterYielded: yieldDetected,
        acceptedSessionSpawns,
      });
    },
  );
});
