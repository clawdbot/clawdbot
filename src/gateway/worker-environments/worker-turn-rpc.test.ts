import { describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { hashWorkerCredential } from "./credential.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { bindWorkerTurnExecutionIdentity } from "./placement-turn-claim-events.js";
import { signalWorkerTurnClaimClosed } from "./placement-turn-claims.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceOptions = support.WorkerEnvironmentServiceOptions;

function claimWorkerPlacement(params: {
  environmentId: string;
  ownerEpoch: number;
  runId?: string;
  sessionId: string;
}): { claim: WorkerSessionTurnClaim; store: ReturnType<typeof createWorkerSessionPlacementStore> } {
  const store = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const identity = {
    sessionId: params.sessionId,
    agentId: "main",
    sessionKey: `agent:main:${params.sessionId}`,
  };
  let placement = store.startDispatch(identity);
  placement = store.transition({
    sessionId: params.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: params.environmentId },
  });
  placement = store.transition({
    sessionId: params.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: support.BUNDLE_HASH },
  });
  placement = store.transition({
    sessionId: params.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `manifest-${params.sessionId}`,
      remoteWorkspaceDir: `/workspace/${params.sessionId}`,
    },
  });
  store.transition({
    sessionId: params.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: params.ownerEpoch },
  });
  const claim = store.claimTurn({
    ...identity,
    claimId: `claim-${params.sessionId}`,
    runId: params.runId ?? "run-1",
    owner: {
      kind: "worker",
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
    },
  });
  return { claim, store };
}

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits an npm-installed worker from canonical bundle identity without registry access", async () => {
    const environmentId = "worker-npm-admission";
    support.seedReady(environmentId, "npm");
    support.testState.prepareInstallation = vi.fn(async (install) => {
      if (install === "npm") {
        throw new Error("registry unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    const workerService = support.createService(support.createProvider());

    await expect(
      workerService.admitWorker(support.admissionFor(environmentId)),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(support.testState.prepareInstallation).toHaveBeenCalledTimes(1);
    expect(support.testState.prepareInstallation).toHaveBeenCalledWith("bundle");
  });

  it("fences transcript commits by current epoch and exact session credential binding", async () => {
    const environmentId = "worker-transcript-fence";
    const sessionId = "session-transcript-fence";
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-1");
    const { identity, workerService } = support.placementHarness(environmentId, sessionId, {
      applyTranscriptCommit,
    });
    const request = support.transcriptRequest(identity, "hello");

    await expect(workerService.commitTranscript(identity, request)).resolves.toMatchObject({
      ok: true,
    });
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();

    await expect(
      workerService.commitTranscript(identity, {
        ...request,
        runEpoch: identity.ownerEpoch + 1,
        seq: 2,
      }),
    ).resolves.toEqual({ ok: false, reason: "epoch-mismatch" });
    support.testState.stateDb.db
      .prepare("UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?")
      .run("session-other", environmentId);
    await expect(workerService.commitTranscript(identity, { ...request, seq: 2 })).resolves.toEqual(
      { ok: false, reason: "session-not-attached" },
    );
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("admits only a gateway-preclaimed worker placement and fences later requests", async () => {
    const environmentId = "worker-placement-fence";
    const sessionId = "session-placement-fence";
    const { identity, placementStore, workerService } = support.placementHarness(
      environmentId,
      sessionId,
    );
    const admission = {
      environmentId,
      credential: [support.CREDENTIAL, environmentId, sessionId].join("-"),
      sessionId,
      runId: "run-1",
      ownerEpoch: identity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: support.BOOTSTRAP_RECEIPT,
    };

    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    expect(workerService.validateWorkerConnection(identity)).toBeNull();

    const warmEnvironmentId = "worker-placement-warm";
    support.seedReady(warmEnvironmentId);
    const warmAdmission = await workerService.admitWorker(support.admissionFor(warmEnvironmentId));
    expect(warmAdmission).toMatchObject({ ok: true });
    if (!warmAdmission.ok) {
      throw new Error("warm worker admission failed");
    }
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBeNull();

    placementStore.validateWorkerTurn.mockReturnValue(false);
    await expect(
      workerService.admitWorker({ ...admission, runId: "run-conflict" }),
    ).resolves.toEqual({ ok: false, reason: "placement-mismatch" });

    placementStore.validateWorkerTurn.mockReturnValue(true);
    support.testState.nowMs += 10_000;
    expect(workerService.validateWorkerConnection(identity)).toBeNull();
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBe(
      "credential-expired",
    );
    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({
      ok: true,
      identity: { sessionId, runId: "run-1" },
    });

    placementStore.validateWorkerTurn.mockReturnValue(false);
    expect(workerService.validateWorkerConnection(identity)).toBe("placement-mismatch");
    vi.mocked(support.testState.prepareInstallation).mockClear();
    await expect(workerService.admitWorker(admission)).resolves.toEqual({
      ok: false,
      reason: "credential-expired",
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    await expect(
      workerService.commitTranscript(identity, support.transcriptRequest(identity, "fenced")),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
  });

  it("records credential, build, owner-epoch, and successful worker admission gates", async () => {
    const environmentId = "worker-sensitive-environment";
    const sessionId = "session-sensitive-worker";
    const environmentIdentity = support.seedAttachedIdentity(environmentId, sessionId);
    const { claim, store } = claimWorkerPlacement({
      environmentId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      runId: "run-worker-receipts",
      sessionId,
    });
    const operationalRun = createOperationalRunInstanceRef(claim.runId);
    const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRun);
    bindWorkerTurnExecutionIdentity(
      store,
      claim,
      createExecutionIdentityAdmissionToken(claim.runId, {
        contextId: "context-worker-receipts",
        executionId: "execution-worker-receipts",
        now: 100,
      }),
      operationalRun,
      { agentId: "main", sessionKey: `agent:main:${sessionId}` },
    );
    const gate = createWorkerSessionPlacementGate(store);
    const workerService = support.createService(support.createProvider(), { placementStore: gate });
    const credential = await workerService.acquireTurnCredential(claim);
    const admission = {
      environmentId,
      credential: credential.credential,
      sessionId,
      runId: claim.runId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: support.BOOTSTRAP_RECEIPT,
    };
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await expect(
        workerService.admitWorker({ ...admission, credential: "credential-must-not-leak" }),
      ).resolves.toEqual({ ok: false, reason: "invalid-credential" });
      await expect(
        workerService.admitWorker({
          ...admission,
          handshake: { ...admission.handshake, bundleHash: "b".repeat(64) },
        }),
      ).resolves.toEqual({ ok: false, reason: "bundle-mismatch" });
      await expect(
        workerService.admitWorker({ ...admission, ownerEpoch: admission.ownerEpoch + 1 }),
      ).resolves.toEqual({ ok: false, reason: "invalid-credential" });
      await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    } finally {
      clear();
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    }
    expect(receipts.map((receipt) => receipt.decision.reasonCode)).toEqual([
      "worker_admission_invalid_credential",
      "worker_admission_bundle_mismatch",
      "worker_admission_gate_allowed",
    ]);
    expect(receipts.map((receipt) => receipt.enforcement.coverageState)).toEqual([
      "enforced",
      "enforced",
      "enforced",
    ]);
    const serialized = JSON.stringify(receipts);
    expect(serialized).not.toContain("credential-must-not-leak");
    expect(serialized).not.toContain("b".repeat(64));
    expect(serialized).not.toContain(environmentId);
    expect(serialized).not.toContain(sessionId);
  });

  it("does not attribute a late admission result to a replacement using the same run id", async () => {
    const environmentId = "worker-admission-replacement";
    const sessionId = "session-admission-replacement";
    const environmentIdentity = support.seedAttachedIdentity(environmentId, sessionId);
    const { claim: first, store } = claimWorkerPlacement({
      environmentId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      runId: "run-admission-replacement",
      sessionId,
    });
    const firstOperationalRun = createOperationalRunInstanceRef(first.runId);
    const firstAuthority = claimAgentRunDelegatedAuthority(firstOperationalRun);
    bindWorkerTurnExecutionIdentity(
      store,
      first,
      createExecutionIdentityAdmissionToken(first.runId, {
        contextId: "context-admission-first",
        executionId: "execution-admission-first",
        now: 100,
      }),
      firstOperationalRun,
      { agentId: "main", sessionKey: `agent:main:${sessionId}` },
    );
    let resumeInstallation: (() => void) | undefined;
    support.testState.prepareInstallation = vi.fn(
      async () =>
        await new Promise<typeof support.BUNDLE_ARTIFACT>((resolve) => {
          resumeInstallation = () => resolve(support.BUNDLE_ARTIFACT);
        }),
    );
    const gate = createWorkerSessionPlacementGate(store);
    const workerService = support.createService(support.createProvider(), { placementStore: gate });
    const firstCredential = await workerService.acquireTurnCredential(first);
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const admission = {
      environmentId,
      credential: firstCredential.credential,
      sessionId,
      runId: first.runId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: support.BOOTSTRAP_RECEIPT,
    };
    let secondAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
    try {
      const pendingAdmission = workerService.admitWorker(admission);
      expect(support.testState.prepareInstallation).toHaveBeenCalledOnce();

      store.releaseTurn(first);
      releaseAgentRunDelegatedAuthority(firstAuthority);
      const placement = store.get(sessionId)!;
      const second = store.claimTurn({
        sessionId,
        agentId: placement.agentId,
        sessionKey: placement.sessionKey,
        claimId: "claim-admission-replacement",
        runId: first.runId,
        owner: { kind: "worker", environmentId, ownerEpoch: environmentIdentity.ownerEpoch },
      });
      const secondOperationalRun = createOperationalRunInstanceRef(second.runId);
      secondAuthority = claimAgentRunDelegatedAuthority(secondOperationalRun);
      bindWorkerTurnExecutionIdentity(
        store,
        second,
        createExecutionIdentityAdmissionToken(second.runId, {
          contextId: "context-admission-second",
          executionId: "execution-admission-second",
          now: 101,
        }),
        secondOperationalRun,
        { agentId: "main", sessionKey: `agent:main:${sessionId}` },
      );
      resumeInstallation?.();

      await expect(pendingAdmission).resolves.toEqual({ ok: false, reason: "invalid-credential" });
      expect(receipts).toEqual([]);
    } finally {
      clear();
      releaseAgentRunDelegatedAuthority(firstAuthority);
      if (secondAuthority) {
        releaseAgentRunDelegatedAuthority(secondAuthority);
      }
    }
  });

  it("keeps restart-inherited claims recovery-only across every worker authority surface", async () => {
    const environmentId = "worker-inherited-claim";
    const sessionId = "session-inherited-claim";
    const environmentIdentity = support.seedAttachedIdentity(environmentId, sessionId);
    const { claim, store } = claimWorkerPlacement({
      environmentId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      sessionId,
    });
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    store.updateAckCursors({ claim, liveEvent: 1 });
    const preRestartService = support.createService(support.createProvider(), {
      placementStore: createWorkerSessionPlacementGate(store),
    });
    const recoveryCredential = await preRestartService.acquireTurnCredential(claim);
    await preRestartService.stop();
    store.handoffWorkspaceResultRecovery(claim);

    const restartedStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
    });
    const gate = createWorkerSessionPlacementGate(restartedStore, {
      rejectExistingWorkerClaims: true,
    });
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>();
    const executeSessionTool =
      vi.fn<NonNullable<WorkerEnvironmentServiceOptions["executeSessionTool"]>>();
    const liveEvents = support.createLiveEvents();
    const workerService = support.createService(support.createProvider(), {
      executeInference,
      executeSessionTool,
      liveEvents,
      placementStore: gate,
    });
    workerService.start();
    const identity = {
      ...environmentIdentity,
      runId: claim.runId,
      turnClaim: claim,
    };
    const admission = {
      environmentId,
      credential: recoveryCredential.credential,
      sessionId,
      runId: claim.runId,
      ownerEpoch: identity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: support.BOOTSTRAP_RECEIPT,
    };

    expect(restartedStore.validateTurnClaim(claim)).toBe(true);
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
    await expect(workerService.admitWorker(admission)).resolves.toEqual({
      ok: false,
      reason: "placement-mismatch",
    });
    expect(workerService.acknowledgeCredentialDelivery(recoveryCredential)).toBe(false);
    expect(workerService.validateWorkerConnection(identity)).toBe("placement-mismatch");
    await expect(
      workerService.commitTranscript(identity, support.transcriptRequest(identity, "stale")),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "stale")),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(
      workerService.startInference(identity, support.inferenceRequest(identity), {
        connectionId: "inherited-claim",
        send: vi.fn(),
      }),
    ).toEqual({ ok: false, closeReason: "placement-mismatch" });
    await expect(
      workerService.executeSessionTool(identity, "sessions_send", {
        toolCallId: "inherited-tool",
        sessionKey: "agent:main:target",
        message: "stale",
      }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(executeInference).not.toHaveBeenCalled();
    expect(executeSessionTool).not.toHaveBeenCalled();
  });

  it("binds credentials and reconnect identities to the exact replacement claim", async () => {
    const environmentId = "worker-claim-credential";
    const sessionId = "session-claim-credential";
    const environmentIdentity = support.seedAttachedIdentity(environmentId, sessionId);
    const { claim: first, store } = claimWorkerPlacement({
      environmentId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      sessionId,
    });
    const gate = createWorkerSessionPlacementGate(store);
    const workerService = support.createService(support.createProvider(), { placementStore: gate });
    const firstCredential = await workerService.acquireTurnCredential(first);
    const admission = {
      environmentId,
      credential: firstCredential.credential,
      sessionId,
      runId: first.runId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: support.BOOTSTRAP_RECEIPT,
    };
    await expect(
      workerService.admitWorker({
        ...admission,
        credential: "invalid-worker-credential",
        runId: "run-unknown",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid-credential" });
    await expect(
      workerService.admitWorker({
        ...admission,
        credential: "invalid-worker-credential",
        sessionId: "session-unknown",
        runId: "run-unknown",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid-credential" });
    await expect(
      workerService.admitWorker({ ...admission, runId: "run-unknown" }),
    ).resolves.toEqual({ ok: false, reason: "placement-mismatch" });
    const firstAdmission = await workerService.admitWorker(admission);
    expect(firstAdmission).toMatchObject({ ok: true, identity: { turnClaim: first } });
    store.releaseTurn(first);
    const placement = store.get(sessionId)!;
    const second = store.claimTurn({
      sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: "claim-replacement",
      runId: first.runId,
      owner: { kind: "worker", environmentId, ownerEpoch: environmentIdentity.ownerEpoch },
    });

    expect(workerService.acknowledgeCredentialDelivery(firstCredential)).toBe(false);
    await expect(workerService.admitWorker(admission)).resolves.toEqual({
      ok: false,
      reason: "invalid-credential",
    });
    if (!firstAdmission.ok) {
      throw new Error("first exact worker admission failed");
    }
    expect(workerService.validateWorkerConnection(firstAdmission.identity)).toBe(
      "placement-mismatch",
    );

    const secondCredential = await workerService.acquireTurnCredential(second);
    expect(workerService.acknowledgeCredentialDelivery(secondCredential)).toBe(true);
    const secondAdmission = { ...admission, credential: secondCredential.credential };
    await expect(workerService.admitWorker(secondAdmission)).resolves.toMatchObject({
      ok: true,
      identity: { turnClaim: second },
    });
    await expect(workerService.admitWorker(secondAdmission)).resolves.toMatchObject({ ok: true });
  });

  it("keeps exact-claim inference live past TTL and aborts promptly on claim closure", async () => {
    const environmentId = "worker-claim-inference";
    const sessionId = "session-claim-inference";
    const environmentIdentity = support.seedAttachedIdentity(environmentId, sessionId);
    const { claim: first, store } = claimWorkerPlacement({
      environmentId,
      ownerEpoch: environmentIdentity.ownerEpoch,
      sessionId,
    });
    const signals: AbortSignal[] = [];
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async ({ signal }) => {
        signals.push(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { type: "error", reason: "cancelled", message: "Inference cancelled" };
      },
    );
    const workerService = support.createService(support.createProvider(), {
      executeInference,
      placementStore: createWorkerSessionPlacementGate(store),
      workerCredentialTtlMs: 20,
    });
    const admitClaim = async (claim: WorkerSessionTurnClaim) => {
      const credential = await workerService.acquireTurnCredential(claim);
      const admitted = await workerService.admitWorker({
        environmentId,
        credential: credential.credential,
        sessionId,
        runId: claim.runId,
        ownerEpoch: environmentIdentity.ownerEpoch,
        rpcSetVersion: 1,
        handshake: support.BOOTSTRAP_RECEIPT,
      });
      if (!admitted.ok) {
        throw new Error(`worker admission failed: ${admitted.reason}`);
      }
      expect(workerService.acknowledgeCredentialDelivery(credential)).toBe(true);
      return admitted.identity;
    };
    const firstIdentity = await admitClaim(first);
    const started = workerService.startInference(
      firstIdentity,
      support.inferenceRequest(firstIdentity),
      {
        connectionId: "claim-inference-a",
        send: vi.fn(),
      },
    );
    if (!started.ok) {
      throw new Error("first inference failed to start");
    }
    started.launch();
    await support.waitForFast(() => expect(signals).toHaveLength(1));
    support.testState.nowMs = firstIdentity.credentialExpiresAtMs + 1;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(signals[0]?.aborted).toBe(false);

    store.releaseTurn(first);
    expect(signals[0]?.aborted).toBe(true);
    const placement = store.get(sessionId)!;
    const second = store.claimTurn({
      sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: "claim-inference-replacement",
      runId: first.runId,
      owner: { kind: "worker", environmentId, ownerEpoch: environmentIdentity.ownerEpoch },
    });
    const secondIdentity = await admitClaim(second);
    const replacement = workerService.startInference(
      secondIdentity,
      { ...support.inferenceRequest(secondIdentity), turnId: "turn-replacement" },
      { connectionId: "claim-inference-b", send: vi.fn() },
    );
    if (!replacement.ok) {
      throw new Error("replacement inference failed to start");
    }
    replacement.launch();
    await support.waitForFast(() => expect(signals).toHaveLength(2));
    signalWorkerTurnClaimClosed(support.testState.stateDb.path, first);
    expect(signals[1]?.aborted).toBe(false);
    store.releaseTurn(second);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("does not rotate an expired delivered credential while its durable turn is active", async () => {
    const environmentId = "worker-expired-active-turn";
    const sessionId = "session-expired-active-turn";
    const liveEvents = support.createLiveEvents();
    const { identity, workerService } = support.placementHarness(environmentId, sessionId, {
      liveEvents,
    });
    support.testState.store.markCredentialDelivered({
      environmentId,
      credentialHash: identity.credentialHash,
      ownerEpoch: identity.ownerEpoch,
      sessionId,
      deliveredAtMs: support.testState.nowMs,
    });
    support.testState.nowMs = identity.credentialExpiresAtMs;

    await workerService.reconcileOnce();

    expect(support.testState.store.getCredential(environmentId)?.credentialHash).toBe(
      identity.credentialHash,
    );
    expect(liveEvents.rotateCredential).not.toHaveBeenCalled();
  });

  it("keeps preview ACKs in memory and persists only transcript and terminal cursors", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-placement");
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-ack",
      "session-placement-ack",
      {
        applyTranscriptCommit,
        liveEvents,
      },
    );
    const claim = identity.turnClaim!;

    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "commit", { seq: 7 }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      claim,
      transcriptSeq: 7,
    });

    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "preview")),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();

    await expect(
      workerService.pushLiveEvent(
        identity,
        support.terminalEvent(identity, { lastAckedSeq: 1, seq: 2 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
    expect(placementStore.updateAckCursors).toHaveBeenLastCalledWith({
      claim,
      liveSeq: 2,
    });
  });

  it("uses worker finishing as the durable workspace-result fence", async () => {
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-finishing",
      "session-placement-finishing",
      { liveEvents },
    );
    const terminal = support.terminalEvent(identity);
    const finishing = {
      ...terminal,
      event: {
        kind: "lifecycle" as const,
        payload: { phase: "finishing" as const, startedAt: 1, endedAt: 2 },
      },
    };

    await expect(workerService.pushLiveEvent(identity, finishing)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });
    expect(placementStore.updateAckCursors).toHaveBeenLastCalledWith({
      claim: identity.turnClaim,
      liveSeq: 1,
    });
  });

  it("does not ACK a transcript commit after its worker claim is fenced", async () => {
    let finishCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const applyTranscriptCommit = support.successfulTranscriptCommit(
      "entry-placement-race",
      () => commitBlocked,
    );
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-race",
      "session-placement-race",
      { applyTranscriptCommit },
    );

    const commit = workerService.commitTranscript(
      identity,
      support.transcriptRequest(identity, "commit before claim fence"),
    );
    await support.waitForFast(() => expect(applyTranscriptCommit).toHaveBeenCalledOnce());
    placementStore.validateWorkerTurn.mockReturnValue(false);
    finishCommit?.();

    await expect(commit).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(2);
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
  });

  it("advances the transcript cursor when a stale-base commit consumes its sequence", async () => {
    const applyTranscriptCommit = vi
      .fn<NonNullable<WorkerEnvironmentServiceOptions["applyTranscriptCommit"]>>()
      .mockResolvedValueOnce({ ok: false, reason: "stale-base-leaf" })
      .mockResolvedValueOnce({ ok: false, reason: "invalid-batch" });
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-stale",
      "session-placement-stale",
      { applyTranscriptCommit },
    );
    const request = support.transcriptRequest(identity, "stale commit", {
      seq: 11,
      baseLeafId: "stale-leaf",
    });

    await expect(workerService.commitTranscript(identity, request)).resolves.toEqual({
      ok: false,
      reason: "stale-base-leaf",
    });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      claim: identity.turnClaim,
      transcriptSeq: 11,
    });

    await expect(
      workerService.commitTranscript(identity, { ...request, seq: 12 }),
    ).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
  });

  it("fences after a buffered terminal event becomes acknowledged by a gap fill", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-after-terminal-gap");
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents((seq) =>
      seq === 1 ? 2 : 0,
    );
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-gap",
      "session-placement-gap",
      {
        applyTranscriptCommit,
        liveEvents,
      },
    );

    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity, { seq: 2 })),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "fills gap")),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      claim: identity.turnClaim,
      liveSeq: 2,
    });
    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "late transcript"),
      ),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.assistantEvent(identity, "late", { lastAckedSeq: 2, seq: 3 }),
      ),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).not.toHaveBeenCalled();
    expect(liveApply).toHaveBeenCalledTimes(2);
  });

  it("applies a terminal ACK only after its transcript commit finishes", async () => {
    let finishCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const applyTranscriptCommit = support.successfulTranscriptCommit(
      "entry-order",
      () => commitBlocked,
    );
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-order",
      "session-placement-order",
      { applyTranscriptCommit, liveEvents },
    );

    const commit = workerService.commitTranscript(
      identity,
      support.transcriptRequest(identity, "commit before terminal"),
    );
    await support.waitForFast(() => expect(applyTranscriptCommit).toHaveBeenCalledOnce());
    const terminal = workerService.pushLiveEvent(identity, support.terminalEvent(identity));
    await Promise.resolve();
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    finishCommit?.();
    await expect(commit).resolves.toMatchObject({ ok: true });
    await expect(terminal).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors.mock.calls).toEqual([
      [
        {
          claim: identity.turnClaim,
          transcriptSeq: 1,
        },
      ],
      [
        {
          claim: identity.turnClaim,
          liveSeq: 1,
        },
      ],
    ]);
  });

  it("fences post-terminal mutations while preserving sequenced replays", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-terminal");
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents();
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const { identity, workerService } = support.placementHarness(
      "worker-terminal-fence",
      "session-terminal-fence",
      { applyTranscriptCommit, executeInference, liveEvents },
    );
    const transcript = support.transcriptRequest(identity, "terminal fence");
    const terminal = support.terminalEvent(identity);

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      workerService.commitTranscript(identity, { ...transcript, seq: 2 }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(2);

    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });
    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "late", { seq: 2 })),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(liveApply).toHaveBeenCalledTimes(2);

    expect(
      workerService.startInference(identity, support.inferenceRequest(identity), {
        connectionId: "connection-terminal-fence",
        send: vi.fn(),
      }),
    ).toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(workerService.cancelInference(identity, support.inferenceRequest(identity))).toEqual({
      ok: false,
      closeReason: "placement-mismatch",
    });
    expect(executeInference).not.toHaveBeenCalled();

    const rotatedCredentialHash = hashWorkerCredential(
      ["rotated", identity.environmentId, identity.sessionId].join("-"),
    );
    support.testState.stateDb.db
      .prepare(
        "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
      )
      .run(rotatedCredentialHash, identity.environmentId);
    const rotatedIdentity = { ...identity, credentialHash: rotatedCredentialHash };
    await expect(
      workerService.commitTranscript(rotatedIdentity, { ...transcript, seq: 2 }),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(3);
  });

  it("does not treat a terminal event on an already ACKed sequence as authoritative", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-after-reuse");
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, workerService } = support.placementHarness(
      "worker-terminal-reuse",
      "session-terminal-reuse",
      { applyTranscriptCommit, liveEvents },
    );
    const event = support.assistantEvent(identity, "first");

    await expect(workerService.pushLiveEvent(identity, event)).resolves.toMatchObject({ ok: true });
    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity)),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "still mutable"),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("fences inference by epoch and the durable session credential", async () => {
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const { identity, workerService } = support.placementHarness(
      "worker-inference-fence",
      "session-inference-fence",
      { executeInference },
    );
    const request = support.inferenceRequest(identity);
    expect(
      workerService.startInference(
        identity,
        { ...request, sessionId: "session-other" },
        { connectionId: "connection-a", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "session-not-attached" });
    expect(
      workerService.startInference(
        identity,
        { ...request, runEpoch: request.runEpoch + 1 },
        { connectionId: "connection-b", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "epoch-mismatch" });

    const send = vi.fn();
    const started = workerService.startInference(identity, request, {
      connectionId: "connection-c",
      send,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    support.testState.stateDb.db
      .prepare(
        "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
      )
      .run(
        hashWorkerCredential(["replacement", identity.environmentId].join("-")),
        identity.environmentId,
      );
    started.launch();
    await support.waitForFast(() => expect(send).toHaveBeenCalledOnce());
    expect(executeInference).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: { reason: "session-not-attached" } },
    });
  });

  it("fences and rotates live credentials", async () => {
    const environmentId = "worker-live";
    const sessionId = "session-live";
    const liveEvents = support.createLiveEvents();
    let inferenceSignal: AbortSignal | undefined;
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async ({ signal }) => {
        inferenceSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { type: "error", reason: "cancelled", message: "Inference cancelled" };
      },
    );
    const { identity, workerService } = support.placementHarness(environmentId, sessionId, {
      executeInference,
      liveEvents,
    });
    const request = { ...support.LIVE_EVENT, runEpoch: identity.ownerEpoch };
    const push = workerService.pushLiveEvent.bind(workerService, identity);
    await push(request);
    await expect(push({ ...request, runEpoch: identity.ownerEpoch + 1 })).resolves.toEqual({
      ok: false,
      details: { reason: "epoch-mismatch" },
    });
    const started = workerService.startInference(identity, support.inferenceRequest(identity), {
      connectionId: "connection-rotation",
      send: vi.fn(),
    });
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    started.launch();
    await support.waitForFast(() => expect(executeInference).toHaveBeenCalledOnce());
    support.testState.stateDb.db
      .prepare("UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?")
      .run("session-other", environmentId);
    await expect(push({ ...request, seq: 2 })).resolves.toEqual({
      ok: false,
      details: { reason: "session-not-attached" },
    });
    liveEvents.rotateCredential.mockClear();
    support.testState.nowMs += 10_000;
    await workerService.reconcileOnce();
    expect(inferenceSignal?.aborted).toBe(true);
    expect(liveEvents.rotateCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialHash: support.testState.store.getCredential(environmentId)?.credentialHash,
        previousCredentialHash: identity.credentialHash,
        runEpoch: identity.ownerEpoch,
      }),
    );
  });
});
