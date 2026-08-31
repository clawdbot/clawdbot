import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resetHeartbeatWakeStateForTests,
  setHeartbeatWakeHandler,
} from "../../../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import { dispatchReturnCovenantCase } from "./case-dispatch.js";
import {
  cleanupReturnCovenantCase,
  observeReturnCovenantCase,
  releaseReturnCovenantCase,
  retainedReturnCovenantResources,
  transitionReturnCovenantCase,
} from "./case-lifecycle.js";
import { createPreparedReturnCovenantCase } from "./case-setup.js";
import {
  requireReturnCovenantCasePhase,
  returnCovenantExecutionKey,
  returnCovenantReceiptId,
  systemReturnCovenantClock,
  type ReturnCovenantCaseState,
  type ReturnCovenantClock,
  type ReturnCovenantFixtureContext,
  type ReturnCovenantRunCleanupReceipt,
} from "./case-state.js";
import {
  closeReturnCovenantProductStores,
  openReturnCovenantProductStores,
  prepareReturnCovenantDatabaseProfiles,
} from "./database.js";
import type { ReturnCovenantGatewayControl } from "./gateway.js";
import {
  ReturnCovenantProtocolError,
  type ReturnCovenantCaseRequest,
  type ReturnCovenantDriverAttestation,
  type ReturnCovenantPhaseRequest,
  type ReturnCovenantPlan,
} from "./protocol.js";

export class ReturnCovenantFixtureRun {
  readonly #context: ReturnCovenantFixtureContext;
  readonly #disposeHeartbeatHandler: () => void;
  readonly #states = new Map<string, ReturnCovenantCaseState>();
  readonly #statesByHandle = new Map<string, ReturnCovenantCaseState>();
  #cleanupRun: ReturnCovenantRunCleanupReceipt | undefined;
  #finalizeRequested = false;

  private constructor(context: ReturnCovenantFixtureContext) {
    this.#context = context;
    resetHeartbeatWakeStateForTests();
    this.#disposeHeartbeatHandler = setHeartbeatWakeHandler(async (wake) => {
      if (wake.sessionKey) {
        for (const state of this.#states.values()) {
          if (state.casePlan.logicalSessionKey === wake.sessionKey && state.release) {
            state.wakeCount += 1;
          }
        }
      }
      return { status: "ran", durationMs: 0 };
    });
  }

  static async create(params: {
    clock?: ReturnCovenantClock;
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    gateway: ReturnCovenantGatewayControl;
    plan: ReturnCovenantPlan;
  }): Promise<ReturnCovenantFixtureRun> {
    const profiles = await prepareReturnCovenantDatabaseProfiles({
      env: params.env,
      plan: params.plan,
    });
    const stores = openReturnCovenantProductStores(params.env);
    return new ReturnCovenantFixtureRun({
      clock: params.clock ?? systemReturnCovenantClock,
      config: params.config,
      env: params.env,
      gateway: params.gateway,
      plan: params.plan,
      profiles,
      storePath: stores.agentDatabasePath,
    });
  }

  get finalizeRequested(): boolean {
    return this.#finalizeRequested;
  }

  readWakeCount(caseId: string, form: "typed-tool" | "bracket-token"): number {
    return this.#states.get(returnCovenantExecutionKey(caseId, form))?.wakeCount ?? 0;
  }

  async handle(
    request: ReturnCovenantPhaseRequest,
    attestation: ReturnCovenantDriverAttestation,
  ): Promise<Record<string, unknown>> {
    switch (request.phase) {
      case "prepare":
        return await this.#prepare(request);
      case "dispatch":
        return await this.#dispatch(request);
      case "transition":
        return await this.#transition(request, attestation);
      case "release":
        return await this.#release(request);
      case "observe":
        return await this.#observe(request);
      case "cleanup":
        return await this.#cleanup(request);
      case "cleanup-run":
        return await this.#cleanupWholeRun(request, attestation);
    }
  }

  async close(): Promise<void> {
    this.#disposeHeartbeatHandler();
    resetHeartbeatWakeStateForTests();
    resetSystemEventsForTest();
    closeReturnCovenantProductStores();
  }

  async buildCleanupClaims(): Promise<Record<string, unknown>> {
    const startedAt = new Date(this.#context.clock.wallNow()).toISOString();
    const retained = await retainedReturnCovenantResources({
      context: this.#context,
    });
    const cleanupRun =
      this.#cleanupRun ??
      this.#fallbackCleanupReceipt("0".repeat(64), "0".repeat(64), "0".repeat(64));
    return {
      startedAt,
      endedAt: new Date(this.#context.clock.wallNow()).toISOString(),
      retained: {
        ...retained,
        gateways: 0,
        fixtureProcesses: 0,
      },
      allCaseHandlesClosed: [...this.#states.values()].every((state) => state.closed),
      caseHandles: [...this.#statesByHandle.keys()],
      observationSetSha256: cleanupRun.observationSetSha256,
      phaseChainSha256: cleanupRun.phaseChainSha256,
      driverAttestationSha256: cleanupRun.driverAttestationSha256,
      runCleanupReceiptId: cleanupRun.receiptId,
    };
  }

  async #prepare(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "prepare" }>,
  ): Promise<Record<string, unknown>> {
    const key = returnCovenantExecutionKey(request.caseId, request.form);
    if (this.#states.has(key)) {
      throw new ReturnCovenantProtocolError(
        "phase-replay",
        `case ${request.caseId}/${request.form} was already prepared`,
        409,
      );
    }
    const state = await createPreparedReturnCovenantCase({
      context: this.#context,
      request,
    });
    this.#states.set(key, state);
    this.#statesByHandle.set(state.caseHandle, state);
    return {
      caseHandle: state.caseHandle,
      prepare: {
        caseHandle: state.caseHandle,
        receiptId: state.database.canonicalFixtureReceiptId,
      },
    };
  }

  async #dispatch(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "dispatch" }>,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "prepared");
    const acceptance = await dispatchReturnCovenantCase({
      context: this.#context,
      state,
    });
    state.phase = "dispatched";
    return { acceptance };
  }

  async #transition(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "transition" }>,
    attestation: ReturnCovenantDriverAttestation,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "dispatched");
    this.#assertAcceptanceBinding(state, request);
    const transition = await transitionReturnCovenantCase({
      attestation,
      context: this.#context,
      request,
      state,
    });
    state.phase = "transitioned";
    return { transition };
  }

  async #release(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "release" }>,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "transitioned");
    this.#assertAcceptanceBinding(state, request);
    if (
      request.transitionReceiptId !== state.lifecycle?.receiptId ||
      request.heldResultId !== state.acceptance?.heldResultId ||
      request.resultMarker !== state.acceptance.resultMarker
    ) {
      throw new ReturnCovenantProtocolError(
        "stale-accepted-receipt",
        "release is not bound to the accepted held result and transition",
        409,
      );
    }
    const release = await releaseReturnCovenantCase({
      context: this.#context,
      request,
      state,
    });
    state.phase = "released";
    return { release };
  }

  async #observe(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "observe" }>,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    if ((state.phase !== "released" && state.phase !== "observed") || state.closed) {
      throw new ReturnCovenantProtocolError(
        "phase-order",
        "observe requires a released, open case",
        409,
      );
    }
    if (request.settlementWindowMs !== state.request.settlementWindowMs) {
      throw new ReturnCovenantProtocolError(
        "settlement-mismatch",
        "observe settlement window differs from prepare",
      );
    }
    const elapsed =
      this.#context.clock.monotonicNow() - (state.releasedAtMonotonic ?? Number.POSITIVE_INFINITY);
    if (elapsed < request.settlementWindowMs) {
      return { settled: false, observation: null };
    }
    state.observation ??= await observeReturnCovenantCase({
      context: this.#context,
      state,
    });
    state.phase = "observed";
    return { settled: true, observation: state.observation };
  }

  async #cleanup(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "cleanup" }>,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    if (state.closed) {
      throw new ReturnCovenantProtocolError("phase-replay", "case was already cleaned", 409);
    }
    await cleanupReturnCovenantCase({ context: this.#context, state });
    return {
      cleanup: {
        caseHandle: state.caseHandle,
        closed: true,
        receiptId: returnCovenantReceiptId("case-cleanup", state.caseHandle),
      },
    };
  }

  async #cleanupWholeRun(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "cleanup-run" }>,
    attestation: ReturnCovenantDriverAttestation,
  ): Promise<Record<string, unknown>> {
    if (request.fallback === true) {
      for (const state of this.#states.values()) {
        if (!state.closed) {
          await cleanupReturnCovenantCase({
            context: this.#context,
            state,
          });
        }
      }
      this.#cleanupRun ??= this.#fallbackCleanupReceipt(
        "0".repeat(64),
        "0".repeat(64),
        attestation.attestationSha256,
      );
      this.#finalizeRequested = true;
      return { cleanupRun: this.#cleanupRun };
    }
    if (this.#cleanupRun) {
      throw new ReturnCovenantProtocolError("phase-replay", "run cleanup already completed", 409);
    }
    const expectedExecutions = this.#context.plan.cases.length * 2;
    if (
      this.#states.size !== expectedExecutions ||
      [...this.#states.values()].some((state) => !state.closed)
    ) {
      throw new ReturnCovenantProtocolError(
        "incomplete-cleanup",
        "run cleanup requires every planned case/form handle to be closed",
        409,
      );
    }
    const retained = await retainedReturnCovenantResources({
      context: this.#context,
    });
    if (Object.values(retained).some((count) => count !== 0)) {
      throw new ReturnCovenantProtocolError(
        "incomplete-cleanup",
        "run cleanup found retained delegate, queue, or temporary-session state",
        409,
      );
    }
    const { observationSetSha256, phaseChainSha256, driverAttestationSha256 } = request;
    if (!observationSetSha256 || !phaseChainSha256 || !driverAttestationSha256) {
      throw new ReturnCovenantProtocolError(
        "incomplete-cleanup",
        "run cleanup is missing evidence bindings",
      );
    }
    this.#cleanupRun = {
      completed: true,
      receiptId: returnCovenantReceiptId("run-cleanup", {
        observationSetSha256,
        phaseChainSha256,
      }),
      observationSetSha256,
      phaseChainSha256,
      driverAttestationSha256,
      runtimeConfigSha256: this.#context.plan.target.runtimeConfigSha256,
      runtimeArtifactManifestSha256: this.#context.plan.target.runtimeArtifactManifestSha256,
    };
    return { cleanupRun: this.#cleanupRun };
  }

  #stateFor(
    request: Exclude<ReturnCovenantCaseRequest, { phase: "prepare" }>,
  ): ReturnCovenantCaseState {
    const state = this.#statesByHandle.get(request.caseHandle);
    if (
      !state ||
      state.casePlan.id !== request.caseId ||
      state.form !== request.form ||
      state.casePlan.kind !== request.kind ||
      state.casePlan.lifecycleEdge !== request.lifecycleEdge
    ) {
      throw new ReturnCovenantProtocolError(
        "case-handle-mismatch",
        "phase request case handle does not own the requested case/form",
        409,
      );
    }
    return state;
  }

  #assertAcceptanceBinding(
    state: ReturnCovenantCaseState,
    request: {
      acceptedDispatchReceiptId: string;
      capturedAuthorityGeneration: string;
    },
  ): void {
    if (
      request.acceptedDispatchReceiptId !== state.acceptance?.receiptId ||
      request.capturedAuthorityGeneration !== state.acceptance.capturedAuthorityGeneration
    ) {
      throw new ReturnCovenantProtocolError(
        "stale-accepted-receipt",
        "phase request is not bound to this case's accepted dispatch",
        409,
      );
    }
  }

  #fallbackCleanupReceipt(
    observationSetSha256: string,
    phaseChainSha256: string,
    driverAttestationSha256: string,
  ): ReturnCovenantRunCleanupReceipt {
    return {
      completed: true,
      receiptId: returnCovenantReceiptId("run-cleanup-fallback", this.#context.plan.runId),
      observationSetSha256,
      phaseChainSha256,
      driverAttestationSha256,
      runtimeConfigSha256: this.#context.plan.target.runtimeConfigSha256,
      runtimeArtifactManifestSha256: this.#context.plan.target.runtimeArtifactManifestSha256,
    };
  }
}
