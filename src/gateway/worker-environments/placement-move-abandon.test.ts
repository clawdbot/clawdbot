import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../../worker/node-workspace-protocol.js";
import { environmentsHandlers } from "../server-methods/environments.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { BUILD, transport, workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerEnvironmentService } from "./service.js";
import { BUNDLE_ARTIFACT, createProvider } from "./service.test-support.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";
import { createWorkerEnvironmentStore } from "./store.js";

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

  async function deviceTeardown(liveTunnel: boolean, providerId = "device", sharedHost = true) {
    const harness = createHarness(placements);
    const active = await harness.service.dispatch(REQUEST);
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active, providerId);
    database.db
      .prepare(
        "UPDATE worker_environments SET profile_snapshot_json = ?, shared_host = ?, node_device_id = 'device-1' WHERE environment_id = ?",
      )
      .run(
        JSON.stringify({ settings: {}, executionMode: "worker-turn" }),
        Number(sharedHost),
        active.environmentId,
      );
    const store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    let connected = false;
    const nodeTransport = transport();
    const nodes = await nodeTransport.listCurrentNodes();
    for (const node of nodes) {
      node.nodeId = "device-1";
    }
    nodeTransport.listCurrentNodes = async () => (connected ? nodes : []);
    const invoke = vi.spyOn(nodeTransport, "invoke");
    const transfer = { ...workspaceTransfer(), closeAll: vi.fn(async () => {}) };
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: (id) => store.get(id),
      listEnvironments: () => store.list(),
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
      workspaceTransfer: transfer,
    });
    if (liveTunnel) {
      await manager.start({
        executionMode: "worker-turn",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        deviceId: "device-1",
        sessionId: active.sessionId,
        expectedBuild: BUILD,
      });
    }
    const provider = createProvider({ id: providerId, destroy: vi.fn(async () => {}) });
    const environments = createWorkerEnvironmentService({
      store,
      getConfig: () => ({}),
      resolveProvider: () => provider,
      prepareInstallation: async () => BUNDLE_ARTIFACT,
      bootstrapWorker: async () => BUILD,
      executeInference: vi.fn(),
      nodeTunnelManager: manager,
      now: () => 1_000,
    });
    vi.mocked(harness.environments.get).mockImplementation(environments.get);
    vi.mocked(harness.environments.destroy).mockImplementation(environments.destroy);
    onTestFinished(async () => {
      connected = true;
      await environments.stop();
    });
    return {
      harness,
      active,
      environments,
      manager,
      transfer,
      invoke,
      provider,
      reconnect: () => {
        connected = true;
      },
    };
  }

  function expectRetainedDeviceCleanup(fixture: Awaited<ReturnType<typeof deviceTeardown>>) {
    expect(fixture.environments.get(fixture.active.environmentId)).toMatchObject({
      state: "attached",
      leaseId: "lease-device",
      nodeDeviceId: "device-1",
      ownerEpoch: fixture.active.activeOwnerEpoch,
      attachedSessionIds: [fixture.active.sessionId],
      destroyRequestedAtMs: 1_000,
      teardownTerminalState: "failed",
      lastError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    expect(fixture.provider.destroy).not.toHaveBeenCalled();
  }

  async function finishDeviceCleanup(fixture: Awaited<ReturnType<typeof deviceTeardown>>) {
    fixture.reconnect();
    await fixture.environments.destroy(fixture.active.environmentId);
    expect(fixture.environments.get(fixture.active.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      nodeDeviceId: null,
      attachedSessionIds: [],
      lastError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    expect(fixture.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
        params: expect.objectContaining({
          environmentId: fixture.active.environmentId,
          sessionId: fixture.active.sessionId,
          ownerEpoch: fixture.active.activeOwnerEpoch,
        }),
      }),
    );
    expect(fixture.invoke).toHaveBeenNthCalledWith(
      fixture.invoke.mock.calls.length - 1,
      expect.objectContaining({
        command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
        params: expect.objectContaining({
          environmentId: fixture.active.environmentId,
          sessionId: fixture.active.sessionId,
          generation: fixture.active.activeOwnerEpoch,
          argv: [NODE_WORKSPACE_DRAIN_COMMAND],
        }),
      }),
    );
    expect(fixture.provider.destroy).toHaveBeenCalledOnce();
  }

  it.each([false, true])(
    "abandons an unreachable device through real teardown (live tunnel: %s)",
    async (liveTunnel) => {
      const fixture = await deviceTeardown(liveTunnel);
      const { harness, active, transfer, invoke } = fixture;
      const fail = vi.spyOn(placements, "fail");
      await expect(harness.service.move(requestFor(active))).resolves.toMatchObject({
        state: "local",
      });
      expectRetainedDeviceCleanup(fixture);
      expect(fail).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryError: FORCED_WORKER_ABANDONMENT_ERROR }),
      );
      expect(transfer.close).toHaveBeenCalledWith(active.environmentId);
      expect(invoke).not.toHaveBeenCalled();
      expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
      await finishDeviceCleanup(fixture);
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );

  it("abandons a device whose supervisor proof disappears after discovery", async () => {
    const fixture = await deviceTeardown(false);
    const { harness, active, reconnect, invoke } = fixture;
    reconnect();
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: "PRIVATE_DIALECT_UNAVAILABLE" },
    });

    await expect(harness.service.move(requestFor(active))).resolves.toMatchObject({
      state: "local",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expectRetainedDeviceCleanup(fixture);
    await finishDeviceCleanup(fixture);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("force destroys an unreachable device and accepts its already fenced placement for abandonment", async () => {
    const fixture = await deviceTeardown(false);
    const { harness, active, environments } = fixture;
    const respond = vi.fn();
    await environmentsHandlers["environments.destroy"]!({
      params: { environmentId: active.environmentId, force: true },
      respond,
      context: {
        workerEnvironmentService: environments,
        workerPlacementDispatchService: harness.service,
        logGateway: { warn: vi.fn() },
      },
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ worker: expect.objectContaining({ state: "attached" }) }),
      undefined,
    );
    const failed = placements.get(active.sessionId);
    expect(failed).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    if (failed?.state !== "failed") {
      throw new Error("placement was not fenced");
    }
    expect(
      isFailedWorkerPlacementEnvironmentGone({
        environmentService: environments,
        placement: failed,
      }),
    ).toBe(false);
    expectRetainedDeviceCleanup(fixture);
    await expect(
      harness.service.move({
        ...requestFor(active),
        source: { ...requestFor(active).source, generation: failed.generation },
      }),
    ).resolves.toMatchObject({ state: "local" });
    await finishDeviceCleanup(fixture);
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    expect(
      isFailedWorkerPlacementEnvironmentGone({
        environmentService: environments,
        placement: failed,
      }),
    ).toBe(true);
  });

  it("retries abandonment after an earlier forced attempt fenced the placement but failed to stop", async () => {
    const { harness, active } = await deviceTeardown(false);
    const destroy = vi.mocked(harness.environments.destroy);
    destroy.mockRejectedValueOnce(
      new Error("device worker node is not connected with the supervisor dialect"),
    );
    const request = requestFor(active);
    await expect(harness.service.move(request)).rejects.toThrow("not connected");
    expect(placements.get(active.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    await expect(harness.service.move(request)).resolves.toMatchObject({ state: "local" });
  });

  it.each([false, true])(
    "still remotely stops a connected device during forced destruction (live tunnel: %s)",
    async (liveTunnel) => {
      const { harness, active, reconnect, invoke, provider } = await deviceTeardown(liveTunnel);
      reconnect();
      await expect(
        harness.service.forceDestroyEnvironment(active.environmentId),
      ).resolves.toMatchObject({ state: "failed", leaseId: null });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(provider.destroy).toHaveBeenCalledOnce();
    },
  );

  it("keeps ordinary device destruction waiting for its remote stop", async () => {
    const { active, environments, provider } = await deviceTeardown(false);
    await expect(environments.destroy(active.environmentId)).rejects.toThrow(
      "not connected with the supervisor dialect",
    );
    expect(environments.get(active.environmentId)).toMatchObject({
      state: "attached",
      ownerEpoch: active.activeOwnerEpoch,
    });
    expect(placements.get(active.sessionId)).toMatchObject({ state: "active" });
    expect(provider.destroy).not.toHaveBeenCalled();
  });

  it("keeps forced cloud destruction owned by the dedicated provider", async () => {
    const { harness, active, invoke, provider } = await deviceTeardown(false, "crabbox", false);
    await expect(
      harness.service.forceDestroyEnvironment(active.environmentId),
    ).resolves.toMatchObject({ state: "destroyed" });
    expect(invoke).not.toHaveBeenCalled();
    expect(provider.destroy).toHaveBeenCalledOnce();
  });

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

  it("forces an offline remote-exec device onto the Gateway without waiting for its local claim", async () => {
    const harness = createHarness(placements);
    const active = await harness.service.dispatch({ ...REQUEST, executionMode: "remote-exec" });
    harness.markEnvironmentNodeDeviceId("device-1");
    seedEnvironment(active);
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "offline-remote-exec-claim",
      runId: "offline-remote-exec-run",
      owner: {
        kind: "local",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const closeToolState = vi.spyOn(placements, "closeWorkerTurnToolState");
    const closed = vi.fn();
    const unregister = placements.registerTurnClaimClosedHandler(closed);
    vi.mocked(harness.environments.startTunnel).mockClear();

    await expect(harness.service.move(requestFor(active))).resolves.toMatchObject({
      state: "local",
      turnClaim: null,
    });

    expect(closeToolState).toHaveBeenCalledExactlyOnceWith(claim);
    expect(closed).toHaveBeenCalledExactlyOnceWith(claim);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.log).not.toContain("workspace:reconcile");
    expect(placements.validateTurnClaim(claim)).toBe(false);
    expect(placements.listPendingWorkspaceResults()).toEqual([]);
    expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(() =>
      placements.startReconcile({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation + 1,
      }),
    ).toThrow("Cannot reconcile stale worker placement");
    expect(() => placements.releaseTurn(claim)).toThrow("turn claim changed before release");
    expect(closeToolState).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    unregister();
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

    // The existing durable decision skips new preparation, but still rejects a different
    // source, destination, or abandonment disposition before an exact retry can resume.
    const conflictingRequests = [
      { ...request, source: { ...request.source, generation: request.source.generation + 1 } },
      {
        ...REQUEST,
        source: request.source,
        target: { kind: "profile" as const, profileId: "other" },
      },
      { ...REQUEST, source: request.source, target: { kind: "gateway" as const } },
    ];
    for (const conflicting of conflictingRequests) {
      await expect(harness.service.move(conflicting)).rejects.toThrow(
        "already has a conflicting placement move",
      );
    }
    expect(beforeMoveBegin).toHaveBeenCalledOnce();

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
