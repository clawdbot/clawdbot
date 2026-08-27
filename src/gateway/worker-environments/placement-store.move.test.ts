import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerPlacementMoveService } from "./placement-move-service.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-move",
  agentId: "main",
  sessionKey: "agent:main:move",
};

describe("worker session placement moves", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-move-store-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function advanceToActive() {
    let placement = store.startDispatch(SESSION);
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: "environment-move" },
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
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/workspace/move",
      },
    });
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

  function seedAttachedEnvironment(input: {
    environmentId: string;
    sessionId: string;
    ownerEpoch: number;
    profileId?: string;
  }): void {
    database.db
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch,
          attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES (?, 'test', ?, '{}', ?, 'lease-test', 'attached', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.environmentId,
        input.profileId ?? "profile-source",
        `provision:${input.environmentId}`,
        input.ownerEpoch,
        JSON.stringify([input.sessionId]),
        nowMs,
        nowMs,
        nowMs,
      );
  }

  it("lazily begins one exact-source move in the drain transaction", () => {
    database.db.exec("DROP TABLE worker_session_placement_moves");
    expect(
      database.db
        .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_session_placement_moves"),
    ).toBeUndefined();
    expect(store.listPlacementMoves()).toEqual([]);

    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const workerClaim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "move-source-claim",
      runId: "move-source-run",
    });
    const source = {
      generation: active.generation,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };

    const begun = store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source,
      target: { kind: "gateway" },
    });

    expect(begun).toMatchObject({
      joined: false,
      intent: {
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "gateway" },
        abandonSource: false,
        lastError: null,
      },
      placement: {
        state: "draining",
        generation: active.generation + 1,
        turnClaim: { claimId: workerClaim.claimId },
      },
    });
    expect(begun.intent.operationId).toMatch(/^move:v1:[A-Za-z0-9_-]{43}$/u);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 13 });
    expect(store.getPlacementMove(SESSION.sessionId)).toEqual(begun.intent);
    expect(store.getPlacementMoves([SESSION.sessionId, "missing"])).toEqual(
      new Map([[SESSION.sessionId, begun.intent]]),
    );

    expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "gateway" },
      }),
    ).toMatchObject({ joined: true, intent: { operationId: begun.intent.operationId } });
    expect(() =>
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "profile", profileId: "other-profile" },
      }),
    ).toThrow("already has a conflicting placement move");
    expect(() =>
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "gateway" },
        abandonSource: true,
      }),
    ).toThrow("already has a conflicting placement move");
  });

  it("prepares only new abandonment decisions and joins exact draining retries", async () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const source = {
      generation: active.generation,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
    const request = {
      sessionId: active.sessionId,
      source,
      target: { kind: "gateway" as const },
      abandonSource: true as const,
    };
    const prepareNew = vi.fn(async () => {
      expect(store.get(active.sessionId)).toMatchObject({ state: "active" });
      expect(store.getPlacementMove(active.sessionId)).toBeUndefined();
    });

    const begun = await store.preparePlacementMove(request, prepareNew);

    expect(begun).toMatchObject({ joined: false, placement: { state: "draining" } });
    await expect(store.preparePlacementMove(request, prepareNew)).resolves.toMatchObject({
      joined: true,
      intent: { operationId: begun.intent.operationId },
    });
    expect(prepareNew).toHaveBeenCalledOnce();

    const conflictingRequests = [
      { ...request, source: { ...source, generation: source.generation + 1 } },
      {
        sessionId: active.sessionId,
        source,
        target: { kind: "profile" as const, profileId: "other" },
      },
      { sessionId: active.sessionId, source, target: { kind: "gateway" as const } },
    ];
    for (const conflictingRequest of conflictingRequests) {
      await expect(store.preparePlacementMove(conflictingRequest, prepareNew)).rejects.toThrow(
        "already has a conflicting placement move",
      );
    }
    expect(prepareNew).toHaveBeenCalledOnce();
  });

  it("keeps the source active when new abandonment preparation fails", async () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });

    await expect(
      store.preparePlacementMove(
        {
          sessionId: active.sessionId,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "gateway" },
          abandonSource: true,
        },
        async () => {
          throw new Error("partial transcript persistence failed");
        },
      ),
    ).rejects.toThrow("partial transcript persistence failed");

    expect(store.get(active.sessionId)).toMatchObject({ state: "active" });
    expect(store.getPlacementMove(active.sessionId)).toBeUndefined();
  });

  it("persists explicit abandonment and atomically completes its exact failed source", () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const begun = store.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
      abandonSource: true,
    });
    expect(store.getPlacementMove(active.sessionId)).toMatchObject({ abandonSource: true });
    const reconciling = store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: begun.placement.generation,
    });
    const recoveryError = "Worker result abandoned by forced operator teardown";
    const failed = store.fail({
      sessionId: active.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError,
    });
    expect(() =>
      store.completeAbandonedPlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: active.sessionId,
        expectedGeneration: failed.generation,
        expectedRecoveryError: "different abandonment",
      }),
    ).toThrow("Cannot complete stale abandoned placement move");

    expect(
      store.completeAbandonedPlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: active.sessionId,
        expectedGeneration: failed.generation,
        expectedRecoveryError: recoveryError,
      }),
    ).toMatchObject({ state: "local", generation: failed.generation + 1 });
    expect(store.getPlacementMove(active.sessionId)).toBeUndefined();
  });

  it("persists a profile machine class and joins only the exact target", () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const source = {
      generation: active.generation,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
    const target = {
      kind: "profile",
      profileId: "profile-destination",
      machineClass: "beast",
    } as const;
    const begun = store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source,
      target: { ...target, machineClass: " beast " },
    });

    expect(store.getPlacementMove(SESSION.sessionId)).toMatchObject({ target });
    expect(
      store.beginPlacementMove({ sessionId: SESSION.sessionId, source, target }),
    ).toMatchObject({ joined: true, intent: { operationId: begun.intent.operationId, target } });
    expect(() =>
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { ...target, machineClass: "fast" },
      }),
    ).toThrow("already has a conflicting placement move");
  });

  it("rejects a machine class stored for a non-profile target", () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    database.db
      .prepare(
        "UPDATE worker_session_placement_moves SET target_machine_class = 'beast' WHERE session_id = ?",
      )
      .run(SESSION.sessionId);

    expect(() => store.getPlacementMove(SESSION.sessionId)).toThrow(
      "Invalid worker placement move target: gateway",
    );
  });

  it("keeps invalid move attempts from creating optional storage", () => {
    database.db.exec("DROP TABLE worker_session_placement_moves");
    const active = advanceToActive();

    expect(() =>
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      }),
    ).toThrow("Cannot move stale worker environment");
    expect(
      database.db
        .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_session_placement_moves"),
    ).toBeUndefined();
    expect(store.get(SESSION.sessionId)).toMatchObject({
      state: "active",
      generation: active.generation,
    });
  });

  it("fences move errors and Gateway completion by operation id", () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const begun = store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });

    expect(
      store.recordPlacementMoveError({
        operationId: "move:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sessionId: SESSION.sessionId,
        error: "stale move failed",
      }),
    ).toBe(false);
    expect(
      store.recordPlacementMoveError({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        error: "workspace reconciliation is waiting",
      }),
    ).toBe(true);
    expect(store.getPlacementMove(SESSION.sessionId)?.lastError).toBe(
      "workspace reconciliation is waiting",
    );

    const reconciling = store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: begun.placement.generation,
    });
    expect(() =>
      store.completePlacementMoveSourceToLocal({
        operationId: "move:v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
      }),
    ).toThrow("placement move changed before completion");

    expect(
      store.completePlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
      }),
    ).toMatchObject({ state: "local", generation: reconciling.generation + 1 });
    expect(store.getPlacementMove(SESSION.sessionId)).toBeUndefined();
  });

  it("completes a worker move only against the exact attached destination", () => {
    const source = advanceToActive();
    seedAttachedEnvironment({
      environmentId: source.environmentId,
      sessionId: source.sessionId,
      ownerEpoch: source.activeOwnerEpoch,
    });
    const begun = store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source: {
        generation: source.generation,
        environmentId: source.environmentId,
        ownerEpoch: source.activeOwnerEpoch,
      },
      target: { kind: "profile", profileId: "profile-destination", machineClass: "beast" },
    });
    const reconciling = store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: source.environmentId,
      ownerEpoch: source.activeOwnerEpoch,
      expectedGeneration: begun.placement.generation,
    });
    const local = store.completePlacementMoveSourceToLocal({
      operationId: begun.intent.operationId,
      sessionId: SESSION.sessionId,
      expectedGeneration: reconciling.generation,
    });
    expect(store.getPlacementMove(SESSION.sessionId)).toEqual(begun.intent);
    database.db
      .prepare(
        "UPDATE worker_environments SET state = 'destroyed', attached_session_ids_json = '[]'",
      )
      .run();
    const destination = advanceToActive();
    database.db
      .prepare(
        `UPDATE worker_environments
         SET state = 'attached', profile_id = ?, owner_epoch = ?, attached_session_ids_json = ?
         WHERE environment_id = ?`,
      )
      .run(
        "profile-destination",
        destination.activeOwnerEpoch,
        JSON.stringify([destination.sessionId]),
        destination.environmentId,
      );
    expect(destination.generation).toBeGreaterThan(local.generation);

    expect(
      store.completePlacementMoveToWorker({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        expectedGeneration: destination.generation,
        environmentId: destination.environmentId,
        ownerEpoch: destination.activeOwnerEpoch,
      }),
    ).toMatchObject({ state: "active", generation: destination.generation });
    expect(store.getPlacementMove(SESSION.sessionId)).toBeUndefined();
  });

  it("completes a persisted abandonment only after a later sweep makes its placement local", async () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const begun = store.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
      abandonSource: true,
    });
    const reconciling = store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: begun.placement.generation,
    });
    const recoveryError = "Worker result abandoned by forced operator teardown";
    const failed = store.fail({
      sessionId: active.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError,
    });
    const abandonSource = vi
      .fn()
      .mockRejectedValueOnce(new Error("device teardown is still pending"))
      .mockImplementationOnce(async () =>
        store.completeAbandonedPlacementMoveSourceToLocal({
          operationId: begun.intent.operationId,
          sessionId: active.sessionId,
          expectedGeneration: failed.generation,
          expectedRecoveryError: recoveryError,
        }),
      );
    const moves = createWorkerPlacementMoveService({
      placements: store,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ begin }) => begin(),
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource: vi.fn(),
      abandonSource,
      resolveDestination: vi.fn(),
    });

    await moves.recoverAll();

    expect(store.get(active.sessionId)).toEqual(failed);
    expect(store.getPlacementMove(active.sessionId)?.lastError).toBe(
      "device teardown is still pending",
    );
    await moves.recoverAll();

    expect(store.get(active.sessionId)).toMatchObject({
      sessionId: active.sessionId,
      state: "local",
      generation: failed.generation + 1,
    });
    expect(store.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(abandonSource).toHaveBeenCalledTimes(2);
  });

  it("completes an ordinary reconciled move with one durable Gateway placement", async () => {
    const active = advanceToActive();
    seedAttachedEnvironment({
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    const begun = store.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    const reconciling = store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: begun.placement.generation,
    });
    const moves = createWorkerPlacementMoveService({
      placements: store,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ begin }) => begin(),
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(),
      resolveDestination: vi.fn(),
    });

    await moves.recoverAll();

    const recovered = store.get(active.sessionId);
    expect(recovered).toMatchObject({ state: "local", generation: reconciling.generation + 1 });
    expect(store.getPlacementMove(active.sessionId)).toBeUndefined();
    await moves.recoverAll();
    expect(store.get(active.sessionId)).toEqual(recovered);
  });

  it("fails a pending profile move after restart loses request authority", async () => {
    const source = advanceToActive();
    seedAttachedEnvironment({
      environmentId: source.environmentId,
      sessionId: source.sessionId,
      ownerEpoch: source.activeOwnerEpoch,
    });
    const begun = store.beginPlacementMove({
      sessionId: source.sessionId,
      source: {
        generation: source.generation,
        environmentId: source.environmentId,
        ownerEpoch: source.activeOwnerEpoch,
      },
      target: { kind: "profile", profileId: "profile-destination", machineClass: "beast" },
    });
    const reconciling = store.startReconcile({
      sessionId: source.sessionId,
      environmentId: source.environmentId,
      ownerEpoch: source.activeOwnerEpoch,
      expectedGeneration: begun.placement.generation,
    });
    const local = store.completePlacementMoveSourceToLocal({
      operationId: begun.intent.operationId,
      sessionId: source.sessionId,
      expectedGeneration: reconciling.generation,
    });
    const dispatch = vi.fn();
    const reclaimSource = vi.fn(async () => {
      throw new Error("failed destination must not reclaim the old source");
    });
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const moves = createWorkerPlacementMoveService({
      placements: restartedStore,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ begin }) => begin(),
      dispatch,
      reclaimSource,
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(async () => {
        throw new Error("unexpected source abandonment");
      }),
      resolveDestination: async (_identity, target) => {
        if (target.kind !== "profile") {
          throw new Error("expected profile move target");
        }
        return {
          profileId: target.profileId,
          executionMode: "worker-turn",
          machineClass: target.machineClass,
        };
      },
    });

    await moves.recoverAll();

    expect(reclaimSource).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(restartedStore.get(source.sessionId)).toMatchObject({
      state: "failed",
      generation: local.generation + 1,
      recoveryError:
        "Cloud worker move request authority expired after Gateway restart; retry move",
    });
    expect(restartedStore.getPlacementMove(source.sessionId)).toBeUndefined();
  });
});
