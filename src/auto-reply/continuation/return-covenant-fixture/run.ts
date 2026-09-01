import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  type ReturnCovenantFixtureFaults,
  type ReturnCovenantGatewayInvocation,
  type ReturnCovenantRunCleanupReceipt,
} from "./case-state.js";
import {
  closeReturnCovenantGlobalStore,
  prepareReturnCovenantDatabaseProfiles,
  restoreReturnCovenantDatabaseProfiles,
} from "./database.js";
import {
  assertReturnCovenantGatewayBinding,
  returnCovenantGatewayBindingsEqual,
} from "./gateway-generation.js";
import {
  ReturnCovenantProtocolError,
  sha256ReturnCovenant,
  type ReturnCovenantCaseRequest,
  type ReturnCovenantDriverAttestation,
  type ReturnCovenantPhaseRequest,
  type ReturnCovenantPlan,
} from "./protocol.js";
import { ReturnCovenantRetentionInspector } from "./retention.js";
import {
  RETURN_COVENANT_RUN_SNAPSHOT_SCHEMA,
  restoreReturnCovenantActiveState,
  type CompletedReturnCovenantCase,
  type ReturnCovenantFixtureRunSnapshot,
} from "./run-snapshot.js";

export type { ReturnCovenantFixtureRunSnapshot } from "./run-snapshot.js";

export class ReturnCovenantFixtureRun {
  readonly #caseHandles = new Set<string>();
  readonly #closedCaseHandles = new Set<string>();
  readonly #completed = new Map<string, CompletedReturnCovenantCase>();
  readonly #context: ReturnCovenantFixtureContext;
  readonly #disposeHeartbeatHandler: () => void;
  readonly #retentionInspector = new ReturnCovenantRetentionInspector();
  readonly #states = new Map<string, ReturnCovenantCaseState>();
  readonly #statesByHandle = new Map<string, ReturnCovenantCaseState>();
  #cleanupRun: ReturnCovenantRunCleanupReceipt | undefined;
  #closed = false;
  #finalizeRequested = false;
  #normalCleanupComplete = false;
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
    faults?: ReturnCovenantFixtureFaults;
    plan: ReturnCovenantPlan;
  }): Promise<ReturnCovenantFixtureRun> {
    const profiles = await prepareReturnCovenantDatabaseProfiles({
      env: params.env,
      plan: params.plan,
    });
    return new ReturnCovenantFixtureRun({
      clock: params.clock ?? systemReturnCovenantClock,
      config: params.config,
      env: params.env,
      ...(params.faults ? { faults: params.faults } : {}),
      plan: params.plan,
      profiles,
    });
  }

  static async restore(params: {
    clock?: ReturnCovenantClock;
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    faults?: ReturnCovenantFixtureFaults;
    plan: ReturnCovenantPlan;
    snapshot: ReturnCovenantFixtureRunSnapshot;
  }): Promise<ReturnCovenantFixtureRun> {
    const { snapshot } = params;
    if (
      snapshot.schema !== RETURN_COVENANT_RUN_SNAPSHOT_SCHEMA ||
      snapshot.runId !== params.plan.runId
    ) {
      throw new Error("return-covenant run snapshot identity mismatch");
    }
    const profiles = await restoreReturnCovenantDatabaseProfiles({
      env: params.env,
      plan: params.plan,
      snapshot: snapshot.profiles,
    });
    const run = new ReturnCovenantFixtureRun({
      clock: params.clock ?? systemReturnCovenantClock,
      config: params.config,
      env: params.env,
      ...(params.faults ? { faults: params.faults } : {}),
      plan: params.plan,
      profiles,
    });
    for (const caseHandle of snapshot.caseHandles) {
      run.#caseHandles.add(caseHandle);
    }
    for (const caseHandle of snapshot.closedCaseHandles) {
      if (!run.#caseHandles.has(caseHandle)) {
        throw new Error("return-covenant snapshot closed an unknown case handle");
      }
      run.#closedCaseHandles.add(caseHandle);
    }
    for (const [key, completed] of snapshot.completed) {
      if (
        run.#completed.has(key) ||
        !run.#closedCaseHandles.has(completed.caseHandle) ||
        !isRecord(completed.observation)
      ) {
        throw new Error("return-covenant snapshot has invalid completed observations");
      }
      run.#completed.set(key, {
        caseHandle: completed.caseHandle,
        observation: completed.observation,
      });
    }
    if (snapshot.activeState) {
      const state = await restoreReturnCovenantActiveState({
        context: run.#context,
        plan: params.plan,
        snapshot: snapshot.activeState,
      });
      const key = returnCovenantExecutionKey(state.casePlan.id, state.form);
      if (
        run.#states.has(key) ||
        run.#statesByHandle.has(state.caseHandle) ||
        !run.#caseHandles.has(state.caseHandle) ||
        run.#closedCaseHandles.has(state.caseHandle)
      ) {
        throw new Error("return-covenant restart snapshot duplicates active case state");
      }
      run.#states.set(key, state);
      run.#statesByHandle.set(state.caseHandle, state);
    }
    return run;
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
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      throw new ReturnCovenantProtocolError(
        "stale-gateway-generation",
        "return-covenant run belongs to a closed gateway generation",
        409,
      );
    }
    switch (request.phase) {
      case "prepare":
        return await this.#prepare(request, invocation);
      case "dispatch":
        return await this.#dispatch(request, invocation);
      case "transition":
        return await this.#transition(request, attestation, invocation);
      case "release":
        return await this.#release(request, invocation);
      case "observe":
        return await this.#observe(request, invocation);
      case "cleanup":
        return await this.#cleanup(request, invocation);
      case "cleanup-run":
        return await this.#cleanupWholeRun(request, attestation, invocation);
      default:
        return request satisfies never;
    }
  }

  async snapshotForGatewayRestart(): Promise<ReturnCovenantFixtureRunSnapshot> {
    const activeStates = [...this.#states.values()];
    if (
      activeStates.length !== 1 ||
      activeStates[0]?.phase !== "dispatched" ||
      !activeStates[0].casePlan.restartBetweenAcceptanceAndRelease
    ) {
      throw new Error("return-covenant restart snapshot requires one dispatched restart case");
    }
    const snapshot: ReturnCovenantFixtureRunSnapshot = {
      schema: RETURN_COVENANT_RUN_SNAPSHOT_SCHEMA,
      runId: this.#context.plan.runId,
      activeState: structuredClone(activeStates[0]),
      caseHandles: [...this.#caseHandles],
      closedCaseHandles: [...this.#closedCaseHandles],
      completed: [...this.#completed].map(([key, completed]) => [key, structuredClone(completed)]),
      profiles: this.#context.profiles.snapshot(),
    };
    await this.close({ preserveProfiles: true });
    return snapshot;
  }

  async close(options: { preserveProfiles?: boolean } = {}): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#disposeHeartbeatHandler();
    resetHeartbeatWakeStateForTests();
    resetSystemEventsForTest();
    const profileCloseMode = options.preserveProfiles
      ? "preserve-active"
      : this.#normalCleanupComplete
        ? "retain-canonical"
        : undefined;
    await this.#context.profiles.close(profileCloseMode);
    closeReturnCovenantGlobalStore();
  }
  async buildCleanupClaims(): Promise<Record<string, unknown>> {
    const startedAt = new Date(this.#context.clock.wallNow()).toISOString();
    const retained = await retainedReturnCovenantResources({
      context: this.#context,
    });
    const cleanupRun =
      this.#cleanupRun ??
      this.#fallbackCleanupReceipt("0".repeat(64), "0".repeat(64), "0".repeat(64), undefined);
    return {
      startedAt,
      endedAt: new Date(this.#context.clock.wallNow()).toISOString(),
      retained,
      allCaseHandlesClosed: [...this.#caseHandles].every((caseHandle) =>
        this.#closedCaseHandles.has(caseHandle),
      ),
      caseHandles: [...this.#caseHandles],
      observationSetSha256: cleanupRun.observationSetSha256,
      phaseChainSha256: cleanupRun.phaseChainSha256,
      driverAttestationSha256: cleanupRun.driverAttestationSha256,
      runCleanupReceiptId: cleanupRun.receiptId,
    };
  }

  async inspectRetention(
    requestValue: unknown,
    gateway: ReturnCovenantGatewayInvocation["gateway"],
  ): Promise<Record<string, unknown>> {
    return await this.#retentionInspector.inspect({
      activeCaseCount: this.#states.size,
      cleanupRun: this.#cleanupRun,
      completed: this.#completed,
      context: this.#context,
      gateway,
      requestValue,
    });
  }

  async #prepare(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "prepare" }>,
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    const key = returnCovenantExecutionKey(request.caseId, request.form);
    if (this.#states.has(key) || this.#completed.has(key)) {
      throw new ReturnCovenantProtocolError(
        "phase-replay",
        `case ${request.caseId}/${request.form} was already prepared`,
        409,
      );
    }
    await this.#context.profiles.activate({
      caseId: request.caseId,
      form: request.form,
      onActivated: this.#context.faults?.afterProfileActivated,
    });
    let state: ReturnCovenantCaseState;
    try {
      state = await createPreparedReturnCovenantCase({
        context: this.#context,
        gateway: invocation.gateway,
        request,
      });
    } catch (error) {
      await this.#context.profiles
        .deactivate({ caseId: request.caseId, form: request.form })
        .catch(() => undefined);
      throw error;
    }
    this.#states.set(key, state);
    this.#statesByHandle.set(state.caseHandle, state);
    this.#caseHandles.add(state.caseHandle);
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
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "prepared");
    this.#recordGatewayPhase(state, "dispatch", invocation);
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
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "dispatched");
    this.#assertAcceptanceBinding(state, request);
    this.#recordGatewayPhase(state, "transition", invocation);
    const transition = await transitionReturnCovenantCase({
      attestation,
      context: this.#context,
      request,
      ...(invocation.restart ? { restart: invocation.restart } : {}),
      state,
    });
    state.phase = "transitioned";
    return { transition };
  }

  async #release(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "release" }>,
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "transitioned");
    this.#assertAcceptanceBinding(state, request);
    this.#recordGatewayPhase(state, "release", invocation);
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
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    if ((state.phase !== "released" && state.phase !== "observed") || state.closed) {
      throw new ReturnCovenantProtocolError(
        "phase-order",
        "observe requires a released, open case",
        409,
      );
    }
    this.#recordGatewayPhase(state, "observe", invocation);
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
    if (!state.observationFaultApplied) {
      state.observationFaultApplied = true;
      await this.#context.faults?.beforeObserve?.({ context: this.#context, state });
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
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    const state = this.#stateFor(request);
    requireReturnCovenantCasePhase(state, "observed");
    this.#recordGatewayPhase(state, "cleanup", invocation);
    if (!state.observation) {
      throw new ReturnCovenantProtocolError(
        "phase-order",
        "cleanup requires a settled product observation",
        409,
      );
    }
    if (request.settlementWindowMs !== state.request.settlementWindowMs) {
      throw new ReturnCovenantProtocolError(
        "settlement-mismatch",
        "cleanup settlement window differs from prepare",
      );
    }
    await cleanupReturnCovenantCase({ context: this.#context, state });
    await this.#context.profiles.completeActiveCase({
      caseId: state.casePlan.id,
      form: state.form,
      retainCanonical:
        this.#completed.size === this.#context.plan.cases.length * 2 - 1 && this.#states.size === 1,
    });
    state.closed = true;
    const key = returnCovenantExecutionKey(state.casePlan.id, state.form);
    this.#completed.set(key, {
      caseHandle: state.caseHandle,
      observation: state.observation,
    });
    this.#closedCaseHandles.add(state.caseHandle);
    this.#states.delete(key);
    this.#statesByHandle.delete(state.caseHandle);
    return {
      cleanup: {
        caseHandle: state.caseHandle,
        closed: true,
        receiptId: returnCovenantReceiptId("case-cleanup", {
          caseHandle: state.caseHandle,
          gateway: invocation.gateway,
        }),
      },
    };
  }

  async #cleanupWholeRun(
    request: Extract<ReturnCovenantPhaseRequest, { phase: "cleanup-run" }>,
    attestation: ReturnCovenantDriverAttestation,
    invocation: ReturnCovenantGatewayInvocation,
  ): Promise<Record<string, unknown>> {
    if (request.fallback === true) {
      for (const state of this.#states.values()) {
        await cleanupReturnCovenantCase({
          context: this.#context,
          state,
        });
        await this.#context.profiles.deactivate({
          caseId: state.casePlan.id,
          form: state.form,
        });
        state.closed = true;
        this.#closedCaseHandles.add(state.caseHandle);
        this.#states.delete(returnCovenantExecutionKey(state.casePlan.id, state.form));
        this.#statesByHandle.delete(state.caseHandle);
      }
      this.#cleanupRun ??= this.#fallbackCleanupReceipt(
        "0".repeat(64),
        "0".repeat(64),
        attestation.attestationSha256,
        invocation.gateway,
      );
      this.#finalizeRequested = true;
      return { cleanupRun: this.#cleanupRun };
    }
    if (this.#cleanupRun) {
      throw new ReturnCovenantProtocolError("phase-replay", "run cleanup already completed", 409);
    }
    const expectedExecutions = this.#context.plan.cases.length * 2;
    if (this.#completed.size !== expectedExecutions || this.#states.size !== 0) {
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
    const productObservationSetSha256 = this.#productObservationSetSha256();
    if (
      observationSetSha256 !== productObservationSetSha256 ||
      driverAttestationSha256 !== attestation.attestationSha256
    ) {
      throw new ReturnCovenantProtocolError(
        "evidence-mismatch",
        "run cleanup evidence bindings do not match product observations and attestation",
        409,
      );
    }
    this.#cleanupRun = {
      completed: true,
      receiptId: returnCovenantReceiptId("run-cleanup", {
        driverAttestationSha256: attestation.attestationSha256,
        gateway: invocation.gateway,
        observationSetSha256: productObservationSetSha256,
        phaseChainSha256,
      }),
      observationSetSha256: productObservationSetSha256,
      phaseChainSha256,
      driverAttestationSha256: attestation.attestationSha256,
      runtimeConfigSha256: this.#context.plan.target.runtimeConfigSha256,
      runtimeArtifactManifestSha256: this.#context.plan.target.runtimeArtifactManifestSha256,
    };
    this.#normalCleanupComplete = true;
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
    this.#context.profiles.assertActive(state.casePlan.id, state.form);
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

  #recordGatewayPhase(
    state: ReturnCovenantCaseState,
    phase: "dispatch" | "transition" | "release" | "observe" | "cleanup",
    invocation: ReturnCovenantGatewayInvocation,
  ): void {
    const existing = state.gatewayPhases[phase];
    if (existing) {
      assertReturnCovenantGatewayBinding(
        invocation.gateway,
        existing,
        "return-covenant phase changed gateway generation during replay",
      );
      return;
    }
    const previousPhase = {
      dispatch: "prepare",
      transition: "dispatch",
      release: "transition",
      observe: "release",
      cleanup: "observe",
    } as const;
    const previous = state.gatewayPhases[previousPhase[phase]];
    if (!previous) {
      throw new ReturnCovenantProtocolError(
        "stale-gateway-generation",
        "return-covenant phase lacks its prior gateway generation",
        409,
      );
    }
    const expectsRestart =
      phase === "transition" && state.casePlan.restartBetweenAcceptanceAndRelease;
    if (expectsRestart) {
      if (
        !invocation.restart ||
        !returnCovenantGatewayBindingsEqual(invocation.restart.original, previous) ||
        !returnCovenantGatewayBindingsEqual(invocation.restart.replacement, invocation.gateway)
      ) {
        throw new ReturnCovenantProtocolError(
          "stale-gateway-generation",
          "return-covenant restart is not bound to the replaced and current gateway generations",
          409,
        );
      }
    } else if (
      invocation.restart ||
      !returnCovenantGatewayBindingsEqual(previous, invocation.gateway)
    ) {
      throw new ReturnCovenantProtocolError(
        "stale-gateway-generation",
        "return-covenant phase used a replaced gateway generation",
        409,
      );
    }
    state.gatewayPhases[phase] = invocation.gateway;
  }

  #productObservationSetSha256(): string {
    const observations: Record<string, unknown>[] = [];
    for (const casePlan of this.#context.plan.cases) {
      for (const form of casePlan.forms) {
        const completed = this.#completed.get(returnCovenantExecutionKey(casePlan.id, form));
        if (!completed) {
          throw new ReturnCovenantProtocolError(
            "incomplete-cleanup",
            "run cleanup requires every planned case/form observation",
            409,
          );
        }
        observations.push(completed.observation);
      }
    }
    return sha256ReturnCovenant(stableStringify(observations));
  }

  #fallbackCleanupReceipt(
    observationSetSha256: string,
    phaseChainSha256: string,
    driverAttestationSha256: string,
    gateway: ReturnCovenantGatewayInvocation["gateway"] | undefined,
  ): ReturnCovenantRunCleanupReceipt {
    return {
      completed: true,
      receiptId: returnCovenantReceiptId("run-cleanup-fallback", {
        gateway,
        runId: this.#context.plan.runId,
      }),
      observationSetSha256,
      phaseChainSha256,
      driverAttestationSha256,
      runtimeConfigSha256: this.#context.plan.target.runtimeConfigSha256,
      runtimeArtifactManifestSha256: this.#context.plan.target.runtimeArtifactManifestSha256,
    };
  }
}
