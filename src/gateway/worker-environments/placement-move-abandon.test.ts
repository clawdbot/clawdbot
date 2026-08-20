import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("offline device placement abandonment", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;

  beforeEach(() => {
    root = tempDirs.make("openclaw-device-abandon-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function seedEnvironment(
    active: Extract<ReturnType<WorkerSessionPlacementStore["get"]>, { state: "active" }>,
    providerId = "device",
  ): void {
    database.db
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch, node_device_id,
          attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES (?, ?, ?, '{}', ?, 'lease-device', 'attached', ?, ?, ?, 1000, 1000, 1000)`,
      )
      .run(
        active.environmentId,
        providerId,
        providerId === "device" ? "device:device-1" : "development",
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        providerId === "device" ? "device-1" : null,
        JSON.stringify([active.sessionId]),
      );
  }

  function requestFor(
    active: Extract<ReturnType<WorkerSessionPlacementStore["get"]>, { state: "active" }>,
    abandonSource = true,
  ) {
    return {
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" as const },
      ...(abandonSource ? { abandonSource: true as const } : {}),
    };
  }

  it("forces the exact offline device local and closes its stale turn claim", async () => {
    let afterMoveBegin = () => {};
    const beforeMoveBegin = vi.fn(async (abandoned: { runId: string } | undefined) => {
      expect(abandoned).toMatchObject({ runId: "offline-device-run" });
      expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active" });
      expect(placements.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
    });
    const harness = createHarness(placements, {
      beforeMoveBegin,
      afterMoveBegin: () => afterMoveBegin(),
    });
    const active = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active);
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "offline-device-claim",
      runId: "offline-device-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    afterMoveBegin = () => {
      placements.markWorkspaceResultPending(claim);
    };

    await expect(harness.service.move(requestFor(active))).resolves.toMatchObject({
      state: "local",
      turnClaim: null,
    });

    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.log).toEqual(
      expect.arrayContaining([
        "placement:draining",
        "placement:reconciling",
        "placement:failed",
        "teardown:destroy",
        "placement:local",
      ]),
    );
    expect(harness.log.indexOf("placement:draining")).toBeLessThan(
      harness.log.indexOf("placement:reconciling"),
    );
    expect(harness.log.indexOf("placement:reconciling")).toBeLessThan(
      harness.log.indexOf("placement:failed"),
    );
    expect(harness.log.indexOf("placement:failed")).toBeLessThan(
      harness.log.indexOf("teardown:destroy"),
    );
    expect(harness.log.indexOf("teardown:destroy")).toBeLessThan(
      harness.log.indexOf("placement:local"),
    );
    expect(placements.validateTurnClaim(claim)).toBe(false);
    expect(placements.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
    expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
    expect(() => placements.acceptWorkspaceResult(claim)).toThrow(
      "Cannot update stale worker workspace result",
    );
    expect(
      placements.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "late-tool-result",
        requestDigest: "late-tool-result-digest",
        resultJson: '{"status":"late"}',
      }),
    ).toBe(false);
    expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(beforeMoveBegin).toHaveBeenCalledOnce();
  });

  it("joins a durable abandonment retry without validating or persisting the source again", async () => {
    const persistedPartials: string[] = [];
    const beforeMoveBegin = vi.fn(async (abandoned: { runId: string } | undefined) => {
      if (abandoned) {
        persistedPartials.push(abandoned.runId);
      }
    });
    const afterMoveBegin = vi.fn().mockImplementationOnce(() => {
      throw new Error("move barrier interrupted after durable begin");
    });
    const options = { beforeMoveBegin, afterMoveBegin, deviceRunnerAvailable: false };
    const harness = createHarness(placements, options);
    const active = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active);
    placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "offline-retry-claim",
      runId: "offline-retry-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const request = requestFor(active);

    await expect(harness.service.move(request)).rejects.toThrow(
      "move barrier interrupted after durable begin",
    );

    expect(placements.get(active.sessionId)).toMatchObject({ state: "draining" });
    expect(placements.getPlacementMove(active.sessionId)).toMatchObject({
      source: request.source,
      target: request.target,
      abandonSource: true,
    });
    expect(persistedPartials).toEqual(["offline-retry-run"]);
    options.deviceRunnerAvailable = true;

    await expect(harness.service.move(request)).resolves.toMatchObject({ state: "local" });

    expect(beforeMoveBegin).toHaveBeenCalledOnce();
    expect(persistedPartials).toEqual(["offline-retry-run"]);
    expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "partial persistence fails", outcome: "persist-error" },
    { name: "the source changes during persistence", outcome: "stale-source" },
    { name: "the worker claim rotates during persistence", outcome: "rotated-claim" },
  ] as const)("keeps abandonment uncommitted when $name", async (scenario) => {
    const beforeMoveBegin = vi.fn(async (abandoned: { runId: string } | undefined) => {
      expect(abandoned).toMatchObject({ runId: "offline-device-run" });
      if (scenario.outcome === "persist-error") {
        throw new Error("partial transcript persistence failed");
      }
      placements.releaseTurn({
        sessionId: source.sessionId,
        claimId: "offline-device-claim",
        runId: "offline-device-run",
        placementGeneration: source.generation,
        owner: {
          kind: "worker",
          environmentId: source.environmentId,
          ownerEpoch: source.activeOwnerEpoch,
        },
      });
      if (scenario.outcome === "rotated-claim") {
        placements.claimTurn({
          sessionId: source.sessionId,
          sessionKey: source.sessionKey,
          agentId: source.agentId,
          claimId: "replacement-device-claim",
          runId: "replacement-device-run",
          owner: {
            kind: "worker",
            environmentId: source.environmentId,
            ownerEpoch: source.activeOwnerEpoch,
          },
        });
      } else {
        placements.startDrain({
          sessionId: source.sessionId,
          environmentId: source.environmentId,
          ownerEpoch: source.activeOwnerEpoch,
          expectedGeneration: source.generation,
        });
      }
    });
    const harness = createHarness(placements, { beforeMoveBegin });
    const source = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(source);
    placements.claimTurn({
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
      agentId: source.agentId,
      claimId: "offline-device-claim",
      runId: "offline-device-run",
      owner: {
        kind: "worker",
        environmentId: source.environmentId,
        ownerEpoch: source.activeOwnerEpoch,
      },
    });

    await expect(harness.service.move(requestFor(source))).rejects.toThrow(
      scenario.outcome === "persist-error"
        ? "partial transcript persistence failed"
        : "abandonment worker turn changed; retry",
    );

    expect(beforeMoveBegin).toHaveBeenCalledOnce();
    expect(placements.getPlacementMove(source.sessionId)).toBeUndefined();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(placements.get(source.sessionId)?.state).toBe(
      scenario.outcome === "stale-source" ? "draining" : "active",
    );
    if (scenario.outcome === "rotated-claim") {
      expect(placements.get(source.sessionId)?.turnClaim).toMatchObject({
        claimId: "replacement-device-claim",
        runId: "replacement-device-run",
      });
    }
  });

  it("keeps an ordinary offline move reconcile-first", async () => {
    const harness = createHarness(placements);
    const active = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active);
    vi.mocked(harness.environments.startTunnel).mockRejectedValueOnce(
      new Error("device worker node is not connected; reconnect it before retrying"),
    );

    await expect(harness.service.move(requestFor(active, false))).rejects.toThrow(
      "reconnect it before retrying",
    );
    expect(placements.get(active.sessionId)).toMatchObject({ state: "draining" });
    expect(placements.getPlacementMove(active.sessionId)).toMatchObject({
      abandonSource: false,
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it.each([
    { name: "available", available: true, providerId: "device", error: "use Move session" },
    { name: "unknown", available: false, providerId: "test", error: "known runner binding" },
  ])("rejects a $name abandonment source before draining", async (scenario) => {
    const harness = createHarness(placements, { deviceRunnerAvailable: scenario.available });
    const active = await harness.service.dispatch(REQUEST);
    if (scenario.providerId === "device") {
      harness.markEnvironmentNodeDeviceId("device-1");
    }
    seedEnvironment(active, scenario.providerId);

    await expect(harness.service.move(requestFor(active))).rejects.toThrow(scenario.error);
    expect(placements.get(active.sessionId)).toMatchObject({ state: "active" });
    expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("retains the durable decision when authorization closes after teardown", async () => {
    const harness = createHarness(placements);
    const active = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active);
    let checks = 0;

    await expect(
      harness.service.move(requestFor(active), undefined, () => {
        checks += 1;
        if (checks === 2) {
          throw new Error("session access revoked after teardown");
        }
      }),
    ).rejects.toThrow("session access revoked after teardown");

    expect(placements.get(active.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: "Worker result abandoned by forced operator teardown",
    });
    expect(placements.getPlacementMove(active.sessionId)).toMatchObject({
      abandonSource: true,
      lastError: "session access revoked after teardown",
    });
    await harness.service.reconcile();
    expect(placements.get(active.sessionId)).toMatchObject({ state: "local" });
  });

  it("recovers a crash after the durable drain without remote reconciliation", async () => {
    const harness = createHarness(placements, { failMoveAfterBegin: true });
    const active = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active);

    await expect(harness.service.move(requestFor(active))).rejects.toThrow(
      "move barrier interrupted",
    );
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = createHarness(restartedStore);
    restarted.markEnvironmentNodeDeviceId("device-1");
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(restarted.log).not.toContain("workspace:reconcile");
  });
});
