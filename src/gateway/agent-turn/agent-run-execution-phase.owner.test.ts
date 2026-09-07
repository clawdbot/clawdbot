import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";

const dispatchAgentRunFromGateway = vi.hoisted(() => vi.fn());
const prepareGatewaySkillAuthoring = vi.hoisted(() => vi.fn());
const getAdmittedRunDelegatedAuthority = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("./agent-run-dispatch.js", () => ({
  dispatchAgentRunFromGateway,
  resolveAbortedAgentStopReason: () => "rpc",
}));

vi.mock("../skill-library-authoring.js", () => ({
  prepareGatewaySkillAuthoring,
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  getAdmittedRunDelegatedAuthority,
}));

function createExecution(options: { aborted?: boolean; assertContextCurrent?: () => void } = {}) {
  const abortCleanup = vi.fn();
  const gatewayRelease = vi.fn();
  let resolveRuntimeReleased!: () => void;
  const runtimeReleased = new Promise<void>((resolve) => {
    resolveRuntimeReleased = resolve;
  });
  const runtimeRelease = vi.fn(resolveRuntimeReleased);
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    runtimeRelease,
    runtimeReleased,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        dispatchTaskTrackingMode: "none",
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        preparedModelRuntimeLease: { release: runtimeRelease, snapshot: {} },
        replyDispatchRuntime: {
          config: { runtime: "A" },
          pluginGeneration: "generation-A",
        },
        unpersistedOffloadedRefs: [],
        userTurn: {
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: false,
          suppressPromptPersistence: false,
        },
        workspaceOverride: "/workspace/A",
      },
      request: {},
      cfg: {},
      activeSessionAgentId: "main",
      delivery: {},
      isNewSession: false,
      isRawModelRun: true,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: false,
      suppressVisibleSessionEffects: true,
      images: [],
      imageOrder: [],
      media: [],
      runId: "owner-test",
      resolvedSessionKey: "agent:main:dashboard:test",
      agentDedupeKeys: [],
      bestEffortDeliver: false,
      lifecycleGeneration: "test",
      preserveUserFacingSessionModelState: false,
      skipAgentInitialSessionTouch: true,
      canUseInternalRuntimeHandoff: false,
      client: null,
      context: {
        dedupe: new Map(),
        deps: {},
        logGateway: { error: vi.fn(), warn: vi.fn() },
        resolveGatewayContext: () => ({}),
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: vi.fn(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as unknown as Parameters<typeof startAgentRunExecution>[0],
  };
}

describe("startAgentRunExecution Gateway ownership", () => {
  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    prepareGatewaySkillAuthoring.mockReset();
    getAdmittedRunDelegatedAuthority.mockReset().mockReturnValue({});
  });

  it("dispatches with the runtime generation frozen at admission", async () => {
    const execution = createExecution();
    let resolveDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      resolveDispatched = resolve;
    });
    let resolveCleanupObserved!: () => void;
    const cleanupObserved = new Promise<void>((resolve) => {
      resolveCleanupObserved = resolve;
    });
    let borrowedAfterCleanup: Promise<unknown> | undefined;
    let dispatchedGeneration: unknown;
    let dispatchedSnapshot: unknown;
    dispatchAgentRunFromGateway.mockImplementationOnce(() => {
      const generation = execution.params.prepared.replyDispatchRuntime.pluginGeneration;
      dispatchedGeneration = getPreparedModelRuntimePluginGeneration();
      dispatchedSnapshot = getPreparedModelRuntimeBorrowedSnapshot(generation);
      borrowedAfterCleanup = (async () => {
        await cleanupObserved;
        return getPreparedModelRuntimeBorrowedSnapshot(generation);
      })();
      resolveDispatched();
    });

    const completion = startAgentRunExecution(execution.params);

    await dispatched;
    expect(dispatchedGeneration).toBe(
      execution.params.prepared.replyDispatchRuntime.pluginGeneration,
    );
    expect(dispatchedSnapshot).toBe(execution.params.prepared.preparedModelRuntimeLease.snapshot);
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    expect(dispatch?.commandRuntimeContext).toEqual({
      config: { runtime: "A" },
      pluginGeneration: "generation-A",
    });
    expect(dispatch?.ingressOpts.workspaceDir).toBe("/workspace/A");
    expect(execution.runtimeRelease).not.toHaveBeenCalled();

    dispatch?.cleanupAbortController();
    dispatch?.cleanupAbortController();
    resolveCleanupObserved();
    await expect(borrowedAfterCleanup).resolves.toBeUndefined();
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
    await completion;
  });

  it("releases the admitted runtime once when aborted before dispatch", async () => {
    const execution = createExecution({ aborted: true });

    await startAgentRunExecution(execution.params);
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(execution.abortCleanup).toHaveBeenCalledOnce();
    expect(execution.gatewayRelease).toHaveBeenCalledOnce();
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
  });

  it("releases the admitted runtime once when its owner retires before dispatch", async () => {
    const execution = createExecution({
      assertContextCurrent: () => {
        throw new Error("Gateway owner retired");
      },
    });

    await startAgentRunExecution(execution.params);
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(execution.abortCleanup).toHaveBeenCalledOnce();
    expect(execution.gatewayRelease).toHaveBeenCalledOnce();
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
  });

  it("does not fail the whole run when a mid-admission run replacement rejects the skill-authoring bind", async () => {
    const bind = vi.fn(() => {
      throw new Error("Personal authoring cannot move to a replacement run. Send a fresh message.");
    });
    prepareGatewaySkillAuthoring.mockReturnValue({ bind });
    const execution = createExecution();
    dispatchAgentRunFromGateway.mockImplementationOnce(() => undefined);

    await startAgentRunExecution(execution.params);

    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    // A replaced admission still reaches onAdmittedRunContext with the new
    // context; the skill-authoring bind rejects it (real behavior, unmocked),
    // but that must not propagate out of the callback.
    expect(() => dispatch?.ingressOpts.onAdmittedRunContext({})).not.toThrow();
    expect(bind).toHaveBeenCalledOnce();
    expect(execution.params.context.logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("skill authoring bind skipped after run replacement"),
    );
    // The rest of admission (delegated-authority check) still ran normally.
    expect(getAdmittedRunDelegatedAuthority).toHaveBeenCalledOnce();
  });
});
