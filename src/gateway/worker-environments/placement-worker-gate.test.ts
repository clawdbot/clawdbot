import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type {
  WorkerPlacementExecutionMode,
  WorkerSessionPlacementIdentity,
} from "./placement-record.js";
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

  function activate(executionMode: WorkerPlacementExecutionMode = "worker-turn") {
    let placement = store.startDispatch({ ...SESSION, executionMode });
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

  function preclaim(runId: string, owner: "local" | "worker" = "worker") {
    const placement = activate(owner === "worker" ? "worker-turn" : "remote-exec");
    return store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: `claim:${runId}`,
      runId,
      owner:
        owner === "worker"
          ? { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH }
          : { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
  }

  it("accepts only the exact gateway-preclaimed worker run", () => {
    const runId = "run-worker-gate";
    preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId,
    };

    expect(gate.hasWorkerTurn(binding)).toBe(true);
    expect(gate.validateWorkerTurn(binding)).toBe(true);
    expect(gate.validateWorkerTurn({ ...binding, runId: "run-competing" })).toBe(false);
    expect(gate.validateWorkerTurn({ ...binding, ownerEpoch: OWNER_EPOCH + 1 })).toBe(false);
  });

  it("atomically retains the finishing cursor and workspace-result fence", () => {
    const runId = "run-worker-ack";
    const claim = preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId,
    };

    gate.updateAckCursors({ ...binding, transcriptSeq: 4 });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    gate.updateAckCursors({ ...binding, liveSeq: 9 });
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
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId,
    };

    expect(gate.validateWorkerTurn(binding)).toBe(true);
    gate.updateAckCursors({ ...binding, transcriptSeq: 5 });
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBe(5);
    store.releaseTurn(claim);
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("drains running session-tool operations before revoking their durable state", async () => {
    const claim = preclaim("run-worker-tools");
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_spawn"]);

    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(true);
    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
      }),
    ).toMatchObject({
      kind: "execute",
      claimId: claim.claimId,
      operationSeed: expect.any(String),
    });
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
      }),
    ).toEqual({ kind: "in-progress", claimId: claim.claimId });
    const closing = store.closeWorkerTurnToolState(claim);
    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(false);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
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
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
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
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    for (let index = 0; index < MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS; index += 1) {
      expect(
        store.beginWorkerSessionToolOperation({
          binding,
          toolName: "sessions_send",
          toolCallId: `capacity-call-${index}`,
          requestDigest: `capacity-digest-${index}`,
        }),
      ).toMatchObject({ kind: "execute" });
    }

    const reconnectedStore = createWorkerSessionPlacementStore({ database });
    expect(
      reconnectedStore.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "capacity-overflow",
        requestDigest: "capacity-overflow-digest",
      }),
    ).toEqual({ kind: "capacity" });
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "capacity-call-0",
        requestDigest: "capacity-digest-0",
      }),
    ).toMatchObject({ kind: "in-progress" });
  });

  it("does not let a foreign store steal a live operation fence", () => {
    const claim = preclaim("run-worker-restart");
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_spawn", "sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toMatchObject({ kind: "execute" });

    const restarted = createWorkerSessionPlacementStore({ database });
    expect(
      restarted.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      restarted.beginWorkerSessionToolOperation({
        binding,
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
        binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toEqual({ kind: "completed", resultJson: '{"status":"ok"}' });
    restarted.releaseTurn(claim);
  });

  it("makes crash-ambiguous operations terminal before restart reconciliation", () => {
    const claim = preclaim("run-worker-crash-recovery");
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "call-before-crash",
        requestDigest: "digest-before-crash",
      }),
    ).toMatchObject({ kind: "execute" });

    const restarted = createWorkerSessionPlacementStore({ database });
    expect(restarted.recoverWorkerSessionToolOperationsAfterRestart()).toBe(1);
    expect(
      restarted.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "call-before-crash",
        requestDigest: "digest-before-crash",
      }),
    ).toEqual({ kind: "unknown" });
    expect(() => restarted.releaseTurn(claim)).not.toThrow();
  });

  it.each(["worker", "local"] as const)(
    "fences an environment for an exact %s placement-owned recovery record",
    async (owner) => {
      const claim = preclaim(`run-${owner}-terminal`, owner);
      store.markWorkspaceResultPending(claim);
      const active = store.get(SESSION.sessionId);
      if (active?.state !== "active") {
        throw new Error("expected active placement");
      }
      const gate = createWorkerSessionPlacementGate(store);
      expect(gate.isEnvironmentTeardownFenced(ENVIRONMENT_ID)).toBe(true);
      expect(store.canDestroyAcceptedWorkspaceResult(claim)).toBe(false);
      store.acceptWorkspaceResult(claim);
      expect(store.canDestroyAcceptedWorkspaceResult(claim)).toBe(true);
      const pending = store.listPendingWorkspaceResults()[0]!;
      await store.failPendingWorkspaceResult({
        pending,
        recoveryError: "workspace recovery retained for operator action",
      });
      expect(store.get(SESSION.sessionId)).toMatchObject({
        state: "failed",
        terminalRecovery: {
          action: "force-destroy-environment",
          dataLoss: "unreconciled-workspace-result",
        },
      });
      expect(gate.isEnvironmentTeardownFenced(ENVIRONMENT_ID)).toBe(true);
      expect(store.canDestroyAcceptedWorkspaceResult(claim)).toBe(false);
      expect(store.canDestroyForceAbandonedEnvironment(ENVIRONMENT_ID)).toBe(false);
      expect(gate.isEnvironmentTeardownFenced("environment-other")).toBe(false);

      store.forceAbandonPendingWorkspaceResult({
        pending,
        recoveryError: "forced abandonment",
      });
      expect(gate.isEnvironmentTeardownFenced(ENVIRONMENT_ID)).toBe(false);
      expect(store.canDestroyForceAbandonedEnvironment(ENVIRONMENT_ID)).toBe(true);
    },
  );
});
