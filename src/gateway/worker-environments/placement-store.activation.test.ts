import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import type {
  WorkerSessionPlacementIdentity,
  WorkerPlacementExecutionMode,
} from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};

describe("worker session placement activation", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let environments: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    environments = createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function attachEnvironment(
    environmentId: string,
    sessionId: string,
    from: "ready" | "idle" = "ready",
  ) {
    return environments.transition({
      environmentId,
      from,
      to: "attached",
      patch: {
        attachedSessionIds: [sessionId],
        credential: {
          credentialHash: hashWorkerCredential(`${environmentId}:${sessionId}:${nowMs}`),
          sessionId,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
  }

  function createAttachedEnvironment(identity: WorkerSessionPlacementIdentity = SESSION) {
    const environmentId = `environment-${identity.sessionId}`;
    environments.createIntent({
      environmentId,
      providerId: "test-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: `provision:${environmentId}`,
    });
    environments.transition({ environmentId, from: "requested", to: "provisioning" });
    environments.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${environmentId}`,
        nodeDeviceId: `node:${environmentId}`,
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.9.1",
          protocolFeatures: ["worker-execution-context-v2"],
        },
        credential: {
          credentialHash: hashWorkerCredential(`ready:${environmentId}`),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
    return attachEnvironment(environmentId, identity.sessionId);
  }

  function advanceToStarting(
    identity: WorkerSessionPlacementIdentity = SESSION,
    executionMode: WorkerPlacementExecutionMode = "worker-turn",
    environmentId = `environment-${identity.sessionId}`,
  ) {
    let placement = store.startDispatch({ ...identity, executionMode });
    placement = store.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId },
    });
    placement = store.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    return store.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: `/workspace/${identity.sessionId}`,
      },
    });
  }

  function activate(placement: ReturnType<typeof advanceToStarting>, ownerEpoch: number) {
    const active = store.transition({
      sessionId: placement.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: ownerEpoch },
    });
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    return active;
  }

  function advanceToActive(
    identity: WorkerSessionPlacementIdentity = SESSION,
    executionMode: WorkerPlacementExecutionMode = "worker-turn",
  ) {
    const environment = createAttachedEnvironment(identity);
    return activate(advanceToStarting(identity, executionMode), environment.ownerEpoch);
  }

  it.each(["environment", "epoch", "state", "session", "multiple sessions", "closing", "revoked"])(
    "rolls back activation when the attached environment %s does not match",
    (mismatch) => {
      const environment = createAttachedEnvironment();
      const starting = advanceToStarting(
        SESSION,
        "worker-turn",
        mismatch === "environment" ? "missing-environment" : environment.environmentId,
      );
      let ownerEpoch = environment.ownerEpoch;
      if (mismatch === "state" || mismatch === "session") {
        ownerEpoch = environments.transition({
          environmentId: environment.environmentId,
          from: "attached",
          to: "idle",
        }).ownerEpoch;
        if (mismatch === "session") {
          ownerEpoch = attachEnvironment(
            environment.environmentId,
            "another-session",
            "idle",
          ).ownerEpoch;
        }
      } else if (mismatch === "closing" || mismatch === "revoked") {
        environments.requestDestroy({
          environmentId: environment.environmentId,
          state: "attached",
        });
        if (mismatch === "revoked") {
          environments.revokeEnvironmentCredential(environment.environmentId);
        }
      } else if (mismatch === "multiple sessions") {
        database.db
          .prepare(
            "UPDATE worker_environments SET attached_session_ids_json = ? WHERE environment_id = ?",
          )
          .run(JSON.stringify([SESSION.sessionId, "another-session"]), environment.environmentId);
      }
      const environmentRow = () =>
        database.db
          .prepare("SELECT * FROM worker_environments WHERE environment_id = ?")
          .get(environment.environmentId);
      const before = environmentRow();
      nowMs = 2_000;

      expect(() => activate(starting, ownerEpoch + (mismatch === "epoch" ? 1 : 0))).toThrow();
      expect(store.get(SESSION.sessionId)).toEqual(starting);
      expect(environmentRow()).toEqual(before);
    },
  );

  it("does not record a failed pre-active dispatch as successful demand", () => {
    const environment = createAttachedEnvironment();
    const starting = advanceToStarting();
    nowMs = 5_000;
    const failed = store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: starting.generation,
      recoveryError: "workspace startup failed",
    });
    store.retireSessionPlacement({
      sessionId: SESSION.sessionId,
      expectedState: "failed",
      expectedGeneration: failed.generation,
    });
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBeNull();
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "retains %s activation time through claims, adoption, failure and retirement",
    (executionMode) => {
      const environment = createAttachedEnvironment();
      const starting = advanceToStarting(SESSION, executionMode);
      expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBeNull();
      nowMs = 5_000;
      const active = activate(starting, environment.ownerEpoch);
      expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
      nowMs = 6_000;
      const owner = {
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      };
      const claim = store.claimTurn({
        ...SESSION,
        owner:
          executionMode === "worker-turn"
            ? { kind: "worker", ...owner }
            : { kind: "local", ...owner },
        claimId: "activation-claim",
        runId: "activation-run",
      });
      store.releaseTurn(claim);
      expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);

      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
      environments = createWorkerEnvironmentStore({ database, now: () => nowMs });
      nowMs = 7_000;
      store.adoptActive({
        sessionId: SESSION.sessionId,
        ...owner,
        expectedGeneration: active.generation,
      });
      expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
      const draining = store.startDrain({
        sessionId: SESSION.sessionId,
        ...owner,
        expectedGeneration: active.generation,
      });
      const reconciling = store.startReconcile({
        sessionId: SESSION.sessionId,
        ...owner,
        expectedGeneration: draining.generation,
      });
      const failed = store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "workspace recovery failed",
      });
      nowMs = 8_000;
      store.retireSessionPlacement({
        sessionId: SESSION.sessionId,
        expectedState: "failed",
        expectedGeneration: failed.generation,
      });
      expect(store.get(SESSION.sessionId)).toBeUndefined();
      expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
    },
  );

  it("preserves the latest successful activation when an environment is reused", () => {
    nowMs = 5_000;
    let active = advanceToActive();
    for (const activationTime of [4_000, 9_000]) {
      const owner = {
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      };
      const draining = store.startDrain({ ...owner, expectedGeneration: active.generation });
      const reconciling = store.startReconcile({
        ...owner,
        expectedGeneration: draining.generation,
      });
      store.transition({
        sessionId: SESSION.sessionId,
        from: "reconciling",
        to: "local",
        expectedGeneration: reconciling.generation,
      });
      environments.transition({
        environmentId: active.environmentId,
        from: "attached",
        to: "idle",
      });
      nowMs = activationTime;
      const attached = attachEnvironment(active.environmentId, SESSION.sessionId, "idle");
      active = activate(advanceToStarting(), attached.ownerEpoch);
      expect(environments.get(active.environmentId)?.lastActivatedAtMs).toBe(
        Math.max(5_000, activationTime),
      );
    }
  });

  it("persists the placement lifecycle and rejects stale transition generations", () => {
    const requested = store.startDispatch(SESSION);
    expect(requested).toMatchObject({
      state: "requested",
      generation: 1,
      environmentId: null,
      activeOwnerEpoch: null,
    });

    const provisioning = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "environment-placement" },
    });
    expect(provisioning).toMatchObject({
      state: "provisioning",
      generation: 2,
      environmentId: "environment-placement",
    });
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: 1,
      }),
    ).toThrow("expected provisioning@1, found provisioning@2");
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "provisioning",
        to: "active",
        expectedGeneration: provisioning.generation,
      }),
    ).toThrow("Illegal worker session placement transition");

    const failed = store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "workspace synchronization failed",
    });
    expect(failed).toMatchObject({
      state: "failed",
      generation: 3,
      recoveryError: "workspace synchronization failed",
      terminalReason: "workspace synchronization failed",
      terminalAtMs: 1_000,
    });
    expect(() =>
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: failed.generation - 1,
        recoveryError: "stale teardown failure",
      }),
    ).toThrow("changed before failure");
    expect(store.get(SESSION.sessionId)?.recoveryError).toBe("workspace synchronization failed");
    nowMs = 2_000;
    expect(
      store.fail({ sessionId: SESSION.sessionId, recoveryError: "teardown retry failed" }),
    ).toMatchObject({
      state: "failed",
      generation: failed.generation,
      recoveryError: "teardown retry failed",
      terminalReason: "workspace synchronization failed",
      terminalAtMs: 1_000,
    });
    database.db
      .prepare("UPDATE worker_session_placements SET execution_mode = NULL WHERE session_id = ?")
      .run(SESSION.sessionId);
    expect(store.get(SESSION.sessionId)).toMatchObject({ executionMode: "worker-turn" });
  });

  it("requires each placement phase to persist its complete metadata", () => {
    const requested = store.startDispatch(SESSION);
    const provisioning = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "environment-placement" },
    });
    expect(provisioning).toMatchObject({
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
    });

    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: provisioning.generation,
      }),
    ).toThrow("requires an environment and bundle");
    const syncing = store.transition({
      sessionId: SESSION.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: provisioning.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });

    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: { workspaceBaseManifestRef: "manifest-placement" },
      }),
    ).toThrow("requires complete workspace metadata");
    expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: {
          workspaceBaseManifestRef: "manifest-placement",
          remoteWorkspaceDir: "/workspace/placement",
        },
      }),
    ).toMatchObject({
      state: "starting",
      environmentId: "environment-placement",
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "manifest-placement",
      remoteWorkspaceDir: "/workspace/placement",
    });
  });
});
