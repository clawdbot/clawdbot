import { createHash } from "node:crypto";
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
  WorkerSessionPlacementIdentity,
  WorkerSessionPlacementRecord,
} from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-failed-redispatch",
  agentId: "main",
  sessionKey: "agent:main:failed-redispatch",
};

describe("failed worker placement redispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-redispatch-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function advanceToStarting() {
    let placement = store.startDispatch(SESSION);
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: "environment-failed-dispatch" },
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
        workspaceBaseManifestRef: "manifest-failed-dispatch",
        remoteWorkspaceDir: "/workspace/failed-dispatch",
      },
    });
    return placement;
  }

  function advanceToActive(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
    const placement = advanceToStarting();
    const active = store.transition({
      sessionId: SESSION.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: 7 },
    });
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    return active;
  }

  it("uses the canonical generation and identity reset", () => {
    const placement = advanceToStarting();
    const failed = store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: placement.generation,
      recoveryError: "gateway restarted during activation",
    });

    expect(store.startDispatch(SESSION)).toMatchObject({
      state: "requested",
      generation: failed.generation + 1,
      environmentId: null,
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
    });
  });

  it.each(["pending result", "retained workspace journal"] as const)(
    "blocks redispatch while a %s owns terminal recovery",
    async (recoveryOwner) => {
      const active = advanceToActive();
      if (recoveryOwner === "pending result") {
        const claim = store.claimTurn({
          ...SESSION,
          owner: {
            kind: "worker",
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          claimId: "redispatch-pending-claim",
          runId: "redispatch-pending-run",
        });
        store.markWorkspaceResultPending(claim);
        await store.failPendingWorkspaceResult({
          pending: store.listPendingWorkspaceResults()[0]!,
          recoveryError: "workspace recovery requires operator action",
        });
      } else {
        const owner = {
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          placementGeneration: active.generation,
        };
        const basePack = Buffer.from("retained redispatch base pack");
        store.beginWorkspaceReconciliation(owner, {
          version: 1,
          temporaryNonce: "c".repeat(32),
          baseManifestRef: active.workspaceBaseManifestRef,
          currentManifestRef: `sha256:${"d".repeat(64)}`,
          baseEntries: [],
          appliedEntries: [],
          baseTree: "e".repeat(40),
          basePackSha256: createHash("sha256").update(basePack).digest("hex"),
          basePack,
        });
        store.retainWorkspaceReconciliationForForcedAbandonment(owner);
        const draining = store.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
        if (draining.state !== "draining") {
          throw new Error("expected draining worker placement");
        }
        const reconciling = store.startReconcile({
          sessionId: draining.sessionId,
          environmentId: draining.environmentId,
          ownerEpoch: draining.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        });
        store.fail({
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError: "workspace recovery requires operator action",
        });
      }

      expect(store.get(SESSION.sessionId)).toMatchObject({
        state: "failed",
        terminalRecovery: { action: "force-destroy-environment" },
      });
      expect(() => store.startDispatch(SESSION)).toThrow(
        "must be force-abandoned before redispatch",
      );
      expect(store.get(SESSION.sessionId)).toMatchObject({
        state: "failed",
        terminalRecovery: { action: "force-destroy-environment" },
      });
      expect(store.listPendingWorkspaceResults()).toHaveLength(
        recoveryOwner === "pending result" ? 1 : 0,
      );
      expect(store.listWorkspaceReconciliationOwners()).toHaveLength(
        recoveryOwner === "retained workspace journal" ? 1 : 0,
      );
    },
  );
});
