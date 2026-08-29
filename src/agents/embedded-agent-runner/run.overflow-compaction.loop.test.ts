import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createReplyOperation,
  expireStaleReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../run-termination.js";
import {
  createEmbeddedRunReplayState,
  type EmbeddedRunReplayState,
  observeReplayMetadata,
} from "./replay-state.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./run/attempt-finalize.js";
import { prepareEmbeddedAttemptStream } from "./run/attempt-stream-prepare.js";
import { createDeferredEmbeddedRunLifecycleManager } from "./run/deferred-lifecycle-owner.js";
import { dispatchEmbeddedRunAttempt } from "./run/run-attempt-dispatch.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import { abortEmbeddedAgentRun, isEmbeddedAgentRunActive } from "./runs.js";

const mocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
  settleRequesterAfterSessionSpawns: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
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
      runtimePlan: {
        resolvedRef: { provider: "openai", modelId: "gpt-5.6-luna" },
        auth: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
        },
      },
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
    mocks.subscribe.mockReset().mockReturnValue({
      toolMetas: [],
      isCompacting: () => false,
    });
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

  it.each([undefined, "current-turn-tool-policy"])(
    "preserves the supplied turn tool authority at dispatch (%s)",
    async (toolAuthorityFingerprint) => {
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.params.toolAuthorityFingerprint = toolAuthorityFingerprint;

      await dispatchEmbeddedRunAttempt(input);

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

  it.each([
    "user",
    "restart",
    "stale",
    "superseded",
    "upstream",
    "native-restart",
    "native-superseded",
  ] as const)(
    "retains %s cancellation ownership through the deferred native lifecycle",
    async (source) => {
      const input = makeDispatchInput({}, createEmbeddedRunReplayState());
      input.control.pluginHarnessOwnsTransport = false;
      input.control.lifecycleGeneration = getAgentEventLifecycleGeneration();
      input.runtime.agentHarnessId = "openclaw";
      const upstream = new AbortController();
      const upstreamReason = new Error("upstream cancelled before backend notification");
      const operation = createReplyOperation({
        sessionId: input.runtime.sessionId,
        sessionKey: input.runtime.sessionKey!,
        resetTriggered: false,
        upstreamAbortSignal: upstream.signal,
      });
      operation.setPhase("running");
      const abortByUser = vi.spyOn(operation, "abortByUser");
      const manager = createDeferredEmbeddedRunLifecycleManager({
        runId: input.params.runId,
        sessionId: input.runtime.sessionId,
        sessionKey: input.runtime.sessionKey,
        sessionFile: input.runtime.sessionFile,
        abortSignal: operation.abortSignal,
        replyOperation: operation,
      });
      const onDeferredLifecycleAbort = vi.fn(manager.abort);
      input.params.replyOperation = operation;
      input.params.abortSignal = manager.signal;
      input.params.deferTerminalLifecycle = true;
      input.params.onDeferredLifecycleOwner = manager.adopt;
      input.params.onDeferredLifecycleAbort = onDeferredLifecycleAbort;
      const runAbortController = new AbortController();
      const abortActiveSession = vi.fn(async () => {});
      const state = {
        markAborted: vi.fn(),
        markExternalAbort: vi.fn(),
        markTimedOut: vi.fn(),
        markTimedOutDuringCompaction: vi.fn(),
        markTimedOutDuringToolExecution: vi.fn(),
        readTimedOutDuringCompaction: () => false,
        setPromptError: vi.fn(),
      };
      let external: ReturnType<typeof createEmbeddedAttemptExternalAbortController> | undefined;
      let onAttemptAbort: Mock<NonNullable<EmbeddedRunAttemptParams["onAttemptAbort"]>> | undefined;
      let firstNativeReason: unknown;
      mocks.runAttempt.mockImplementationOnce(async (attempt: EmbeddedRunAttemptParams) => {
        external = createEmbeddedAttemptExternalAbortController({
          abortSignal: attempt.abortSignal,
          cleanupAfterEarlyAbort: async () => {},
          runAbortController,
          runId: attempt.runId,
          state,
        });
        const abortRun = createEmbeddedAttemptRunAbort({
          abortActiveSession,
          activeSession: { abortCompaction: vi.fn(), isCompacting: false },
          attempt,
          getQueueHandle: () => prepared.queueHandle,
          isProbeSession: true,
          log: { warn: vi.fn() },
          runAbortController,
          state,
        });
        external.setRunAbort(abortRun);
        external.arm();
        // Observe the callback minted by real dispatch; do not reproduce its abort policy.
        onAttemptAbort = vi.fn(attempt.onAttemptAbort);
        const prepared = prepareEmbeddedAttemptStream({
          attempt: { ...attempt, onAttemptAbort },
          activeSession: { agent: {}, isStreaming: true } as never,
          hookRunner: undefined as never,
          hookAgentId: "main",
          diagnosticTrace: {} as never,
          diagnosticOwner: createDiagnosticEmbeddedRunOwner({
            runId: attempt.runId,
            sessionId: attempt.sessionId,
            sessionKey: attempt.sessionKey,
          }),
          clientToolCallSlots: [],
          toolSearchTargetTranscriptProjections: [],
          isReplaySafeTool: () => false,
          runAbortController,
          abortRun,
          markExternalAbort: state.markExternalAbort,
          getRunState: () => ({
            aborted: runAbortController.signal.aborted,
            promptError: undefined,
            timedOut: false,
            yieldDetected: false,
          }),
          hasDeliveredSourceReply: () => false,
          markSourceReplyDelivered: vi.fn(),
          onBlockReply: undefined,
          onBlockReplyFlush: undefined,
          sandboxSessionKey: operation.key,
          builtinToolNames: new Set(),
          replaySafeToolNames: new Set(),
        });
        expect(isEmbeddedAgentRunActive(attempt.sessionId)).toBe(true);
        expect(manager.signal.aborted).toBe(false);
        switch (source) {
          case "user":
            expect(abortEmbeddedAgentRun(attempt.sessionId)).toBe(true);
            break;
          case "restart":
            expect(operation.abortForRestart()).toBe(true);
            break;
          case "stale":
            expect(expireStaleReplyOperation(operation, "stuck_recovery")).toBe(false);
            break;
          case "superseded":
            expect(operation.supersede()).toBe(true);
            break;
          case "upstream":
            upstream.abort(upstreamReason);
            break;
          case "native-restart":
            // Lifecycle eviction aborts the native owner before a reply result exists.
            prepared.queueHandle.abort("restart");
            break;
          case "native-superseded":
            // Writer replacement reaches this native handle without first aborting the reply owner.
            prepared.queueHandle.cancel("superseded");
            break;
        }
        firstNativeReason = runAbortController.signal.reason;
        prepared.queueHandle.cancel(
          source === "restart" || source === "native-restart" ? "user_abort" : "restart",
        );
        expect(runAbortController.signal.reason).toBe(firstNativeReason);
        throw firstNativeReason;
      });

      try {
        let dispatchFailure: unknown;
        try {
          await dispatchEmbeddedRunAttempt(input);
        } catch (error) {
          dispatchFailure = error;
        }
        expect(mocks.runAttempt).toHaveBeenCalledOnce();
        expect(runAbortController.signal.aborted).toBe(true);
        expect(dispatchFailure).toBe(firstNativeReason);
        expect(input.control.laneTaskAbortController.signal.aborted).toBe(true);
        expect(onAttemptAbort).toHaveBeenCalledOnce();
        expect(onDeferredLifecycleAbort).toHaveBeenCalledOnce();
        expect(state.markAborted).toHaveBeenCalledOnce();
        expect(state.markTimedOut).not.toHaveBeenCalled();
        expect(abortActiveSession).toHaveBeenCalledExactlyOnceWith(firstNativeReason);
        if (source === "restart" || source === "native-restart") {
          expect(isAgentRunRestartAbortReason(firstNativeReason)).toBe(true);
        } else if (
          source === "stale" ||
          source === "superseded" ||
          source === "native-superseded"
        ) {
          expect(isAgentRunSupersededAbortReason(firstNativeReason)).toBe(true);
        } else if (source === "upstream") {
          expect(firstNativeReason).toBe(upstreamReason);
        }
        expect(operation.result).toEqual(
          source === "stale"
            ? { kind: "failed", code: "run_stalled" }
            : {
                kind: "aborted",
                code:
                  source === "restart" || source === "native-restart"
                    ? "aborted_for_restart"
                    : source === "superseded" || source === "native-superseded"
                      ? "aborted_for_supersession"
                      : "aborted_by_user",
              },
        );
        if (source !== "stale") {
          expect(abortByUser).toHaveBeenCalledTimes(source === "user" ? 1 : 0);
        }
        expect(operation.abortSignal.aborted).toBe(true);
        if (source !== "stale") {
          expect(firstNativeReason).toBe(operation.abortSignal.reason);
        }
      } finally {
        external?.dispose();
        await manager.complete();
        operation.complete();
        await Promise.allSettled(abortActiveSession.mock.results.map((result) => result.value));
      }
      expect(isEmbeddedAgentRunActive(input.runtime.sessionId)).toBe(false);
    },
  );
});
