import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { createSubscribedSessionHarness } from "../embedded-agent-subscribe.e2e-harness.js";
import {
  createEmbeddedRunReplayState,
  type EmbeddedRunReplayState,
  observeReplayMetadata,
} from "./replay-state.js";
import type { EmbeddedRunAttemptInternalParams } from "./run/internal-params.js";
import { createEmbeddedRunLaneController } from "./run/lane-controller.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run/run-attempt-dispatch.js";

const mocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
  settleRequesterAfterSessionSpawns: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  agentHarnessBuildsOpenClawTools: (id: string) => id === "codex" || id === "copilot",
  runAgentHarnessAttempt: mocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

vi.mock("../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: ({
    provider,
    modelId,
    preparedAuthPlan,
  }: {
    provider: string;
    modelId: string;
    preparedAuthPlan: unknown;
  }) => ({ resolvedRef: { provider, modelId }, auth: preparedAuthPlan }),
}));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns: mocks.settleRequesterAfterSessionSpawns,
}));

vi.mock("./run/skill-workshop-attempt-params.js", () => ({
  resolveSkillWorkshopAttemptParams: vi.fn(() => ({})),
}));

let admittedRunContext: AdmittedRunContext;

function makeDispatchInput(
  sessionManager: object,
  replayState: EmbeddedRunReplayState,
): Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0] {
  const workspaceDir = tempDirs.make("openclaw-retry-dispatch-");
  const params = {
    admittedRunContext,
    sessionId: "session-1",
    sessionFile: "agent:main:session-1",
    workspaceDir,
    prompt: "hello",
    runId: "run-1",
    timeoutMs: 30_000,
    config: {},
    disableTrajectory: true,
  };
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane: "retry-dispatch-global",
    sessionLane: "retry-dispatch-session",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    setLifecycleGeneration: (value) => {
      lifecycleGeneration = value;
    },
    setParams: () => {},
  });
  const authProfileStore = { version: 1, profiles: {} };
  const runtime = {
    agentHarness: { id: "codex" },
    pluginHarnessOwnsTransport: true,
    effectiveModel: {
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-responses",
      contextWindow: 200_000,
    },
    thinkLevel: "off",
    apiKeyInfo: null,
    runtimeAuthState: null,
    activePreparedAuthPlan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    },
    providerRuntimeHandle: { provider: "openai" },
  };
  return {
    runInput: {
      runParams: {
        ...params,
        sessionManager,
        contextEngineLogicalTurnLease: { owner: "logical-turn" },
        onContextEngineTurnCandidate: vi.fn(),
      },
      provider: "openai",
      modelId: "gpt-5.6-luna",
      workspaceResolution: { agentId: "main", workspaceDir },
      workspaceDir,
      isCanonicalWorkspace: false,
      agentDir: workspaceDir,
      resolvedSessionKey: "agent:main:session-1",
      resolvedToolResultFormat: "markdown",
      startedAtMs: Date.now(),
      startupStages: { mark: vi.fn() },
      emitStartupStageSummary: vi.fn(),
      lifecycleGeneration,
      laneController,
      progressController: {
        resolveAttemptFastModeParam: () => false,
        maybeAnnounceFastModeAutoOff: vi.fn(),
        notifyExecutionPhase: vi.fn(),
        notifyRunProgress: vi.fn(),
        notifyToolResult: vi.fn(),
        notifyAgentEvent: vi.fn(),
      },
    },
    preparedRuntime: {
      requestedModelId: "gpt-5.6-luna",
      nativeModelOwned: true,
      authStorage: {},
      modelRegistry: {},
      attemptAuthProfileStore: authProfileStore,
      resolveRunAttemptAuthProfileStore: () => authProfileStore,
      snapshot: () => runtime,
    },
    sessionPromptState: {
      sessionId: "session-1",
      sessionFile: "agent:main:session-1",
      sessionTargetAdopted: true,
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      },
      activePrompt: { persisted: false, internal: false },
      onUserMessagePersisted: vi.fn(),
      settleOwnedTranscriptProjection: vi.fn(),
      suppressNextUserMessagePersistence: false,
    },
    terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
    provider: "openai",
    modelId: "gpt-5.6-luna",
    replayState,
    startupStagesEmitted: false,
    bootstrapPromptWarningSignaturesSeen: [],
    resolveRuntimeFallbackReason: () => null,
    observeToolOutcome: vi.fn(),
    isTurnTainted: vi.fn(() => false),
    allocateToolOutcomeOrdinal: vi.fn(() => 1),
    getPostCompactionAbortError: vi.fn(() => undefined),
    setPostCompactionAbortController: vi.fn(),
    clearPostCompactionAbortController: vi.fn(),
  } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];
}

describe("embedded run retry dispatch", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(async () => {
    mocks.runAttempt.mockReset().mockResolvedValue({ terminal: { kind: "ok" } });
    mocks.settleRequesterAfterSessionSpawns.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "dispatch-test");
    admittedRunContext = await admission.admit("plugin-harness", "dispatch-test");
  });
  afterEach(() => admission.close());

  it.each([undefined, "global", "agent:main:policy"])(
    "dispatches a global plugin attempt with its prepared owner (%s)",
    async (sandboxSessionKey) => {
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.runInput.runParams.config = {
        agents: {
          ownership: "explicit",
          defaults: { sandbox: { mode: "off" } },
          list: [{ id: "main" }, { id: "marketing" }],
        },
      };
      input.runInput.runParams.sessionKey = "global";
      input.runInput.runParams.sandboxSessionKey = sandboxSessionKey;
      input.runInput.workspaceResolution.agentId = "marketing";
      input.runInput.resolvedSessionKey = "global";
      input.runInput.workspaceDir = tempDirs.make("openclaw-global-plugin-attempt-");

      const { dispatchedAttempt: result } = await prepareAndDispatchEmbeddedRunAttempt(input);

      expect(result.preparedAttempt).toMatchObject({
        agentId: "marketing",
        sessionKey: "global",
        sandbox: null,
      });
      expect(mocks.runAttempt).toHaveBeenCalledTimes(1);
      expect(mocks.runAttempt.mock.calls[0]?.[0]).toEqual(result.preparedAttempt);
      expect(mocks.runAttempt.mock.calls[0]?.[1]).toBeUndefined();
    },
  );

  it("forwards private commit accounting before queued notices and thrown attempt cleanup", async () => {
    const flushStarted = createDeferred();
    const flush = createDeferred();
    const afterTurnError = new Error("after-turn cleanup failed");
    const onContextAccountingEvent = vi.fn();
    const input = makeDispatchInput({}, createEmbeddedRunReplayState());
    input.preparedRuntime.snapshot().agentHarness.id = "openclaw";
    input.preparedRuntime.snapshot().pluginHarnessOwnsTransport = false;
    Object.assign(input.runInput.runParams, { onContextAccountingEvent });
    let subscription: ReturnType<typeof createSubscribedSessionHarness>["subscription"] | undefined;
    mocks.runAttempt.mockImplementationOnce(async (attempt: EmbeddedRunAttemptInternalParams) => {
      const harness = createSubscribedSessionHarness({
        runId: attempt.runId,
        sessionExtras: { messages: [] },
        blockReplyBreak: "message_end",
        onBlockReplyFlush: () => {
          flushStarted.resolve();
          return flush.promise;
        },
        onContextAccountingEvent: attempt.onContextAccountingEvent,
      });
      subscription = harness.subscription;
      try {
        harness.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Completed answer" }],
            stopReason: "stop",
          },
        });
        await flushStarted.promise;
        // The mocked attempt reports its replacement hook before the public notice.
        attempt.onContextAccountingEvent?.({ kind: "compaction", tokensAfter: 40 });
        harness.emit({
          type: "compaction_end",
          reason: "threshold",
          outcome: { status: "completed", tokensBefore: 100, tokensAfter: 40, willRetry: false },
        });
        expect(subscription.getCompactionCount()).toBe(0);
        throw afterTurnError;
      } finally {
        subscription.unsubscribe();
      }
    });

    try {
      await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBe(afterTurnError);
      expect(onContextAccountingEvent.mock.calls).toEqual([
        [{ kind: "model", contextTokens: undefined }],
        [{ kind: "compaction", tokensAfter: 40 }],
      ]);
    } finally {
      flush.resolve();
      await subscription?.waitForPendingEvents();
      subscription?.unsubscribe();
    }
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
    const { dispatchedAttempt: result } = await prepareAndDispatchEmbeddedRunAttempt(input);

    expect(result.preparedAttempt.sessionManager).toBe(sessionManager);
    expect(result.preparedAttempt.sessionTarget).toBeUndefined();
    expect(result.preparedAttempt.contextEngineLogicalTurnLease).toBeUndefined();
    expect(result.preparedAttempt.onContextEngineTurnCandidate).toBe(
      input.runInput.runParams.onContextEngineTurnCandidate,
    );
    expect(replayState).toEqual({ replayInvalid: true, hadPotentialSideEffects: true });
    expect(result.preparedAttempt.initialReplayState).toBe(replayState);
    expect(mocks.runAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.runAttempt.mock.calls[0]?.[0]).toEqual(result.preparedAttempt);
    expect(mocks.runAttempt.mock.calls[0]?.[1]).toBeUndefined();
    expect(mocks.settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
  });

  it("forwards effective and authored context facts without a context engine (#124702)", async () => {
    const cappedInput = makeDispatchInput({}, createEmbeddedRunReplayState());
    cappedInput.preparedRuntime.snapshot().contextTokenBudget = 272_000;
    cappedInput.preparedRuntime.snapshot().authoredContextTokenCap = 32_000;
    const { dispatchedAttempt: capped } = await prepareAndDispatchEmbeddedRunAttempt(cappedInput);

    expect(capped.preparedAttempt.contextTokenBudget).toBe(272_000);
    expect(capped.preparedAttempt.authoredContextTokenCap).toBe(32_000);

    const uncappedInput = makeDispatchInput({}, createEmbeddedRunReplayState());
    uncappedInput.preparedRuntime.snapshot().contextTokenBudget = 272_000;
    const { dispatchedAttempt: uncapped } =
      await prepareAndDispatchEmbeddedRunAttempt(uncappedInput);

    expect(uncapped.preparedAttempt.contextTokenBudget).toBe(272_000);
    expect(uncapped.preparedAttempt).not.toHaveProperty("authoredContextTokenCap");
  });

  it.each([undefined, false, true])(
    "preserves prepared GitHub publication capability (%s)",
    async (githubPublicationAvailable) => {
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.runInput.runParams.githubPublicationAvailable = githubPublicationAvailable;

      const { dispatchedAttempt: result } = await prepareAndDispatchEmbeddedRunAttempt(input);

      expect(result.preparedAttempt.githubPublicationAvailable).toBe(githubPublicationAvailable);
    },
  );

  it.each([undefined, "current-turn-tool-policy"])(
    "preserves the supplied turn tool authority at dispatch (%s)",
    async (toolAuthorityFingerprint) => {
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.runInput.runParams.toolAuthorityFingerprint = toolAuthorityFingerprint;

      await prepareAndDispatchEmbeddedRunAttempt(input);

      expect(mocks.runAttempt.mock.calls[0]?.[0].toolAuthorityFingerprint).toBe(
        toolAuthorityFingerprint,
      );
    },
  );

  it.each([true, false])(
    "settles accepted spawns before a late post-compaction abort (yielded: %s)",
    async (yieldDetected) => {
      const postCompactionAbortError = new Error("post-compaction loop detected");
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.getPostCompactionAbortError = vi.fn(() => postCompactionAbortError);
      const acceptedSessionSpawns = [
        { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
      ];
      mocks.runAttempt.mockResolvedValueOnce({
        terminal: { kind: "ok" },
        agentHarnessId: "codex",
        yieldDetected,
        acceptedSessionSpawns,
      });

      await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBe(
        postCompactionAbortError,
      );

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
