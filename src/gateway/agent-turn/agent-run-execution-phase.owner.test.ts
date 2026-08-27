import { describe, expect, it, vi } from "vitest";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";

const dispatchAgentRunFromGateway = vi.hoisted(() => vi.fn());

vi.mock("../../agents/prepared-model-runtime.js", () => ({
  loadPublishedGatewayReplyDispatchRuntime: async () => ({
    config: {},
    pluginGeneration: "test",
  }),
}));

vi.mock("./agent-run-dispatch.js", () => ({
  dispatchAgentRunFromGateway,
  resolveAbortedAgentStopReason: () => "rpc",
}));

describe("startAgentRunExecution Gateway ownership", () => {
  it("rejects a retired owner after preparation and before final dispatch", async () => {
    const cleanup = vi.fn();
    const release = vi.fn();
    let resolveFinal!: () => void;
    const final = new Promise<void>((resolve) => {
      resolveFinal = resolve;
    });

    startAgentRunExecution({
      assertContextCurrent: () => {
        throw new Error("Gateway owner retired");
      },
      prepared: {
        activeGatewayWorkAdmission: {
          release,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup,
          controller: new AbortController(),
          registered: false,
        },
        dispatchTaskTrackingMode: "none",
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        unpersistedOffloadedRefs: [],
        userTurn: {
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: false,
          suppressPromptPersistence: false,
        },
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
      runId: "owner-retired",
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
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: () => resolveFinal(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as never);

    await final;
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
