import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import { MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS } from "./placement-session-tool-operations.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-worker-gate",
  agentId: "main",
  sessionKey: "agent:main:worker-gate",
};
const ENVIRONMENT_ID = "environment-worker-gate";
const OWNER_EPOCH = 7;

describe("worker session placement gate", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-gate-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function activate() {
    let placement = store.startDispatch(SESSION);
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: ENVIRONMENT_ID },
    });
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: "manifest-worker-gate",
        remoteWorkspaceDir: "/workspace/worker-gate",
      },
    });
    return store.transition({
      sessionId: SESSION.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: OWNER_EPOCH },
    });
  }

  function preclaim(runId: string) {
    const placement = activate();
    return store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: `claim:${runId}`,
      runId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
  }

  function bindingFor(claim: ReturnType<typeof preclaim>) {
    return claim;
  }

  it("rejects restart-inherited claims while preserving workspace recovery authority", () => {
    const claim = preclaim("run-inherited-worker");
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    store.updateAckCursors({ claim, liveEvent: 1 });

    const restartedStore = createWorkerSessionPlacementStore({ database });
    const gate = createWorkerSessionPlacementGate(restartedStore, {
      rejectExistingWorkerClaims: true,
    });
    const binding = {
      sessionId: claim.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
    };

    expect(restartedStore.validateTurnClaim(claim)).toBe(true);
    expect(restartedStore.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
    expect(gate.validateWorkerTurn(claim)).toBe(false);
    expect(gate.readWorkerTurnClaim(binding)).toEqual(claim);
    expect(gate.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
    expect(() => gate.updateAckCursors({ claim, transcriptSeq: 2 })).toThrow("stale worker turn");
  });

  it("does not classify a same-id claim from a different run as inherited", () => {
    const first = preclaim("run-inherited-a");
    const gate = createWorkerSessionPlacementGate(store, {
      rejectExistingWorkerClaims: true,
    });
    expect(gate.validateWorkerTurn(first)).toBe(false);
    store.releaseTurn(first);
    const placement = store.get(SESSION.sessionId)!;
    const second = store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: first.claimId,
      runId: "run-current-b",
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });

    expect(gate.validateWorkerTurn(second)).toBe(true);
  });

  it("fences a replaced exact claim when the durable run id is reused", () => {
    const runId = "run-reused-worker";
    const first = preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const firstBinding = bindingFor(first);
    store.releaseTurn(first);
    const placement = store.get(SESSION.sessionId)!;
    const second = store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: "claim:replacement",
      runId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
    const secondBinding = bindingFor(second);
    store.authorizeWorkerTurnTools(second, ["sessions_send"]);

    expect(gate.validateWorkerTurn(firstBinding)).toBe(false);
    expect(gate.validateWorkerTurn(secondBinding)).toBe(true);
    expect(gate.isWorkerTurnToolAuthorized(firstBinding, "sessions_send")).toBe(false);
    expect(gate.isWorkerTurnToolAuthorized(secondBinding, "sessions_send")).toBe(true);
    expect(() => gate.updateAckCursors({ claim: firstBinding, transcriptSeq: 3 })).toThrow(
      "stale worker turn",
    );
  });

  it("atomically retains the finishing cursor and workspace-result fence", () => {
    const runId = "run-worker-ack";
    const claim = preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const binding = bindingFor(claim);

    gate.updateAckCursors({ claim: binding, transcriptSeq: 4 });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    gate.updateAckCursors({ claim: binding, liveSeq: 9 });
    expect(store.get(SESSION.sessionId)).toMatchObject({
      generation: claim.placementGeneration,
      lastTranscriptAckCursor: 4,
      lastLiveEventAckCursor: 9,
    });
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: SESSION.sessionId, runId },
    ]);
    store.acceptWorkspaceResult(claim);
    store.completeWorkspaceResultAndReleaseTurn(claim);
    expect(store.get(SESSION.sessionId)?.turnClaim).toBeNull();
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("lets the admitted worker finish acknowledgements after draining closes admission", () => {
    const runId = "run-worker-draining-ack";
    const claim = preclaim(runId);
    const active = store.get(SESSION.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const gate = createWorkerSessionPlacementGate(store);
    const binding = bindingFor(claim);

    expect(gate.validateWorkerTurn(binding)).toBe(true);
    gate.updateAckCursors({ claim: binding, transcriptSeq: 5 });
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBe(5);
    store.releaseTurn(claim);
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("drains running session-tool operations before revoking their durable state", async () => {
    const claim = preclaim("run-worker-tools");
    const binding = bindingFor(claim);
    store.authorizeWorkerTurnTools(claim, ["sessions_spawn"]);

    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(true);
    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
      }),
    ).toMatchObject({
      kind: "execute",
      operationSeed: expect.any(String),
    });
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
      }),
    ).toEqual({ kind: "in-progress" });
    const closing = store.closeWorkerTurnToolState(claim);
    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(false);
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-after-close",
        requestDigest: "digest-after-close",
      }),
    ).toEqual({ kind: "unauthorized" });

    expect(
      store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await closing;
    store.releaseTurn(claim);

    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(false);
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_turn_tool_authorities").get(),
    ).toEqual({ count: 0 });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_session_tool_operations").get(),
    ).toEqual({ count: 0 });
  });

  it("does not reconcile away a claim while its session operation is running", () => {
    const claim = preclaim("run-worker-reconcile-tools");
    const binding = bindingFor(claim);
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-reconcile-send",
        requestDigest: "digest-reconcile-send",
      }),
    ).toMatchObject({ kind: "execute" });
    const draining = store.startDrain({
      sessionId: claim.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      expectedGeneration: claim.placementGeneration,
    });

    expect(() =>
      store.startReconcile({
        sessionId: claim.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        expectedGeneration: draining.generation,
      }),
    ).toThrow("running worker session operation");
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId },
    });

    expect(
      store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-reconcile-send",
        requestDigest: "digest-reconcile-send",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    expect(
      store.startReconcile({
        sessionId: claim.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        expectedGeneration: draining.generation,
      }),
    ).toMatchObject({ state: "reconciling", turnClaim: null });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_turn_tool_authorities").get(),
    ).toEqual({ count: 0 });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_session_tool_operations").get(),
    ).toEqual({ count: 0 });
  });

  it("caps running session operations across connection incarnations", () => {
    const claim = preclaim("run-worker-tool-capacity");
    const binding = bindingFor(claim);
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    for (let index = 0; index < MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS; index += 1) {
      expect(
        store.beginWorkerSessionToolOperation({
          claim: binding,
          toolName: "sessions_send",
          toolCallId: `capacity-call-${index}`,
          requestDigest: `capacity-digest-${index}`,
        }),
      ).toMatchObject({ kind: "execute" });
    }

    const reconnectedStore = createWorkerSessionPlacementStore({ database });
    expect(
      reconnectedStore.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "capacity-overflow",
        requestDigest: "capacity-overflow-digest",
      }),
    ).toEqual({ kind: "capacity" });
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "capacity-call-0",
        requestDigest: "capacity-digest-0",
      }),
    ).toMatchObject({ kind: "in-progress" });
  });

  it("does not let a foreign store steal a live operation fence", () => {
    const claim = preclaim("run-worker-restart");
    const binding = bindingFor(claim);
    store.authorizeWorkerTurnTools(claim, ["sessions_spawn", "sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toMatchObject({ kind: "execute" });

    const restarted = createWorkerSessionPlacementStore({ database });
    expect(
      restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "changed-digest",
      }),
    ).toEqual({ kind: "conflict" });
    expect(() => restarted.releaseTurn(claim)).toThrow("running worker session operation");
    expect(
      store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    expect(
      restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toEqual({ kind: "completed", resultJson: '{"status":"ok"}' });
    restarted.releaseTurn(claim);
  });

  it("makes crash-ambiguous operations terminal before restart reconciliation", () => {
    const claim = preclaim("run-worker-crash-recovery");
    const binding = bindingFor(claim);
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-before-crash",
        requestDigest: "digest-before-crash",
      }),
    ).toMatchObject({ kind: "execute" });

    const restarted = createWorkerSessionPlacementStore({ database });
    expect(restarted.recoverWorkerSessionToolOperationsAfterRestart()).toBe(1);
    expect(
      restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-before-crash",
        requestDigest: "digest-before-crash",
      }),
    ).toEqual({ kind: "unknown" });
    expect(() => restarted.releaseTurn(claim)).not.toThrow();
  });
});
