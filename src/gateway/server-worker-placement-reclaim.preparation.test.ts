import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  admitWorkerStopChat,
  createWorkerStopChatContext,
} from "./server-worker-placement.test-harness.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const lookup = vi.hoisted(() => ({
  value: undefined as ReturnType<typeof import("./session-utils.js").loadSessionEntry> | undefined,
}));
vi.mock("./session-utils.js", () => ({ loadSessionEntry: () => lookup.value }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));
const roots: string[] = [];
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  lookup.value = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function fixture(name: string, state: "active" | "failed" | "local" | "reclaimed" = "active") {
  const request = {
    sessionId: `session-${name}`,
    sessionKey: `agent:main:${name}`,
    agentId: "main",
  };
  const entry = { sessionId: request.sessionId, lifecycleRevision: "original", updatedAt: 1 };
  const target = {
    storePath: `/fixture/reclaim-preparation-${name}.sqlite`,
    canonicalKey: request.sessionKey,
    storeKeys: [request.sessionKey],
    agentId: request.agentId,
    store: { [request.sessionKey]: entry },
  };
  const placement = {
    ...request,
    state,
    generation: 4,
    environmentId: "worker",
    activeOwnerEpoch: 7,
  };
  const cancel = vi.fn(async (input: { assertCurrent: () => void }) => input.assertCurrent());
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: { get: () => ({ ...placement }) as never, waitForTurnClaimRelease: async () => {} },
    loadSessionRuntime: async () => ({
      managedWorktrees: { findLiveByOwner: () => undefined },
      resolveGatewaySessionStoreTargetWithStore: () => target,
      resolveCanonicalSessionEntryFromStoreKeys: () => entry,
    }),
    cancelSessionWork: cancel,
    revokeSessionAuthority: vi.fn(),
  });
  const run = vi.fn(async () => ({ ...placement, state: "reclaimed" as const }) as never);
  const admit = (onInterrupt?: () => void) =>
    beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [request.sessionKey, request.sessionId],
      assertAllowed: () => {},
      onInterrupt,
    });
  return {
    ...request,
    entry,
    placement,
    cancel,
    run,
    admit,
    prepare: (options: Partial<Parameters<typeof barriers.runReclaimPreparation>[0]> = {}) =>
      barriers.runReclaimPreparation({ ...request, run, ...options }),
  };
}

it("one failed Stop cannot reopen ingress while another Stop still owns its closure", async () => {
  const f = fixture("overlap");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let calls = 0;
  f.cancel.mockImplementation(async ({ assertCurrent }) => {
    assertCurrent();
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    } else {
      throw new Error("second cancellation failed");
    }
  });
  const first = f.prepare();
  await entered.promise;
  try {
    await expect(f.prepare()).rejects.toThrow("second cancellation failed");
    await expect(f.admit()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await first;
  }
  const fresh = await f.admit();
  fresh.release();
});

it.each(["authorization", "incarnation"] as const)(
  "rejects changed %s after cancellation and reopens admission on failure",
  async (change) => {
    const f = fixture(`changed-${change}`);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let authorized = true;
    const interrupted = vi.fn();
    const acquired = await f.admit(() => {
      interrupted();
      acquired.release();
    });
    f.cancel.mockImplementation(async ({ assertCurrent }) => {
      assertCurrent();
      entered.resolve();
      await release.promise;
    });
    try {
      const stop = f.prepare({
        authorize: () => {
          if (!authorized) {
            throw new Error("access revoked");
          }
        },
      });
      const rejected = expect(stop).rejects.toThrow(
        change === "authorization" ? "access revoked" : "Session",
      );
      await entered.promise;
      if (change === "authorization") {
        authorized = false;
      } else {
        f.entry.lifecycleRevision = "replacement-with-same-session-id";
      }
      release.resolve();
      await rejected;
      expect(interrupted).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
      const fresh = await f.admit();
      fresh.release();
    } finally {
      release.resolve();
      acquired.release();
    }
  },
);

it("rechecks the exact worker owner after asynchronous cancellation setup", async () => {
  const f = fixture("changed-worker");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const signalled = vi.fn();
  f.cancel.mockImplementation(async ({ assertCurrent }) => {
    entered.resolve();
    await release.promise;
    assertCurrent();
    signalled();
  });
  const stop = f.prepare();
  const rejected = expect(stop).rejects.toThrow("worker changed before cancellation");
  await entered.promise;
  // The store returns immutable snapshots; replacement must not mutate the captured owner.
  const priorGeneration = f.placement.generation;
  f.placement.generation = priorGeneration + 1;
  release.resolve();
  await rejected;
  expect(signalled).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});

it.each(["local", "reclaimed"] as const)(
  "does not cancel fresh work on an already %s placement",
  async (state) => {
    const f = fixture(`idempotent-${state}`, state);
    const admitted = await f.admit();
    try {
      await f.prepare();
      expect(f.cancel).not.toHaveBeenCalled();
      expect(admitted.isActive()).toBe(true);
    } finally {
      admitted.release();
    }
  },
);

it("auto-suspend eligibility rejects before closing admission or signalling cancellation", async () => {
  const f = fixture("auto-suspend");
  await expect(
    f.prepare({
      beforeDrain: () => {
        throw new Error("session is busy");
      },
    }),
  ).rejects.toThrow("session is busy");
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  const fresh = await f.admit();
  fresh.release();
});

it("keeps admissions closed while serialized teardown is queued, then revalidates the incarnation", async () => {
  const f = fixture("queued-teardown");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const teardown = vi.fn();
  const stop = f.prepare({
    run: async (authorize) => {
      entered.resolve();
      await release.promise;
      authorize?.();
      teardown();
      return await f.run();
    },
  });
  const rejected = expect(stop).rejects.toThrow("Session");
  await entered.promise;
  await expect(f.admit()).rejects.toThrow();
  f.entry.lifecycleRevision = "new-incarnation";
  release.resolve();
  await rejected;
  expect(teardown).not.toHaveBeenCalled();
});

it("a pending dispatch retains its producer while preparation fences new ingress", async () => {
  const f = fixture("pending-dispatch");
  Object.assign(f.placement, { state: "provisioning" });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const stop = f.prepare({
    run: async () => {
      entered.resolve();
      await release.promise;
      return await f.run();
    },
  });
  await entered.promise;
  try {
    await setImmediate();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    await expect(f.admit()).rejects.toThrow();
  } finally {
    release.resolve();
    await stop;
  }
});

async function cancellationLoadFixture(
  options: NonNullable<Parameters<typeof createHarness>[1]> = {},
  beforeCancellation?: () => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-stop-advance-"));
  roots.push(root);
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database });
  const storePath = path.join(root, "sessions.sqlite");
  const entry = {
    sessionId: REQUEST.sessionId,
    lifecycleRevision: "original",
    worktree: { id: "task-worktree", branch: "test", repoRoot: root },
    updatedAt: Date.now(),
  };
  const target = {
    storePath,
    canonicalKey: REQUEST.sessionKey,
    storeKeys: [REQUEST.sessionKey],
    agentId: REQUEST.agentId,
    store: { [REQUEST.sessionKey]: entry },
  };
  const runtime = {
    managedWorktrees: {
      findLiveByOwner: () => ({
        id: "task-worktree",
        name: "test",
        repoFingerprint: "test",
        repoRoot: root,
        ownerId: REQUEST.sessionKey,
        ownerKind: "session" as const,
        path: root,
        branch: "test",
        baseRef: "main",
        createdAt: 1,
        lastActiveAt: 1,
      }),
    },
    resolveGatewaySessionStoreTargetWithStore: () => target,
    resolveCanonicalSessionEntryFromStoreKeys: () => entry,
  };
  lookup.value = { ...target, cfg: {}, entry, legacyKey: undefined };
  const context = createWorkerStopChatContext();
  let delayCancellation = false;
  const loading = createDeferredCore();
  const loaded = createDeferredCore();
  const cancellationStarted = vi.fn();
  let started = createDeferredCore();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements,
    loadSessionRuntime: async () => runtime,
    cancelSessionWork: async (request) => {
      if (beforeCancellation) {
        await beforeCancellation();
      }
      if (delayCancellation) {
        delayCancellation = false;
        loading.resolve();
        await loaded.promise;
      }
      const cancellation = await import("./server-worker-placement-cancel.js");
      await cancellation.cancelGatewayWorkerSessionWork(context, {
        ...request,
        onCancellationStarted: () => {
          cancellationStarted();
          request.onCancellationStarted?.();
          started.resolve();
        },
      });
    },
    revokeSessionAuthority: vi.fn(),
  });
  const harness = createHarness(placements, {
    workspacePath: root,
    runReclaimPreparation: barriers.runReclaimPreparation,
    runReclaimBarrier: barriers.runReclaimBarrier,
    runFailedReclaimBarrier: barriers.runFailedReclaimBarrier,
    ...options,
  });
  const coordinated = coordinateWorkerPlacementDispatch(
    harness.service,
    createGatewayWorkerDispatchAdmission(async () => runtime),
  );
  return {
    database,
    runtime,
    storePath,
    placements,
    entry,
    context,
    loading,
    loaded,
    cancellationStarted,
    harness,
    coordinated,
    armCancellation: () => {
      delayCancellation = true;
      started = createDeferredCore();
    },
    waitForCancellationStart: async (stopping: Promise<unknown>) => {
      await Promise.race([
        started.promise,
        stopping.then((result) => {
          throw result instanceof Error
            ? result
            : new Error("Stop settled before cancellation started");
        }),
      ]);
    },
  };
}

it.each(["same-owner", "replacement", "incarnation", "authorization"] as const)(
  "a later Stop retains its newer initial owner after captured dispatch completes (%s)",
  async (change) => {
    const provisioning = createDeferredCore();
    const provisioned = createDeferredCore();
    const firstLoading = createDeferredCore();
    const firstLoaded = createDeferredCore();
    const secondLoading = createDeferredCore();
    const secondLoaded = createDeferredCore();
    let loads = 0;
    const f = await cancellationLoadFixture({}, async () => {
      if (++loads === 1) {
        firstLoading.resolve();
        await firstLoaded.promise;
      } else if (loads === 2) {
        secondLoading.resolve();
        await secondLoaded.promise;
      }
    });
    vi.mocked(f.harness.environments.create).mockImplementationOnce(async () => {
      provisioning.resolve();
      await provisioned.promise;
      return f.harness.ready;
    });
    const dispatch = f.coordinated.dispatch(REQUEST).catch((error: unknown) => error);
    await Promise.race([
      provisioning.promise,
      dispatch.then((result) => {
        throw result;
      }),
    ]);
    const first = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([
        firstLoading.promise,
        first.then((result) => {
          throw result;
        }),
      ]);
      const initial = f.placements.get(REQUEST.sessionId);
      expect(initial?.state).toBe("provisioning");
      provisioned.resolve();
      await dispatch;
      const active = f.placements.get(REQUEST.sessionId);
      if (active?.state !== "active" || !initial) {
        throw new Error("Completed dispatch fixture did not establish its newer active owner");
      }
      expect(active.generation).toBeGreaterThan(initial.generation);
      let authorized = true;
      // Awaiting dispatch above also retires its coordinator record. B captures only
      // the older Stop, while its own initial placement is the completed active owner.
      second = f.coordinated
        .reclaim(REQUEST, () => {
          if (!authorized) {
            throw new Error("later caller access revoked");
          }
        })
        .catch((error: unknown) => error);
      await Promise.race([
        secondLoading.promise,
        second.then((result) => {
          throw result;
        }),
      ]);
      if (change === "replacement") {
        f.placements.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      } else if (change === "incarnation") {
        f.entry.lifecycleRevision = "replacement";
      } else if (change === "authorization") {
        authorized = false;
      }
      secondLoaded.resolve();
      if (change === "same-owner") {
        await f.waitForCancellationStart(second);
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
        firstLoaded.resolve();
        expect(await first).toMatchObject({ state: "reclaimed" });
        expect(await second).toEqual(f.placements.get(REQUEST.sessionId));
        expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
      } else {
        expect(await second).toBeInstanceOf(Error);
        expect(f.cancellationStarted).not.toHaveBeenCalled();
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      }
    } finally {
      provisioned.resolve();
      firstLoaded.resolve();
      secondLoaded.resolve();
      await Promise.all([dispatch, first, second]);
      f.context.chatRunState.clear();
    }
  },
);

it.each(["missing", "local", "reclaimed"] as const)(
  "concurrent ordinary %s Stops leave local chat running without dispatch or Move",
  async (state) => {
    const f = await cancellationLoadFixture();
    if (state === "local") {
      const requested = f.placements.startDispatch(REQUEST);
      const failed = f.placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "fixture local placement",
      });
      f.placements.transition({
        sessionId: REQUEST.sessionId,
        from: "failed",
        to: "local",
        expectedGeneration: failed.generation,
      });
    } else if (state === "reclaimed") {
      await f.coordinated.dispatch(REQUEST);
      await f.coordinated.reclaim(REQUEST);
    }
    f.cancellationStarted.mockClear();
    const cancellations = vi.fn();
    f.context.cancelRunBoundApprovals = cancellations;
    const runId = `ordinary-${state}`;
    const admitted = await admitWorkerStopChat({ ...REQUEST, ...f, runId }).promise;
    if (!admitted.ok) {
      throw new Error("Ordinary local chat fixture was not admitted");
    }
    const controller = admitted.value.activeRunAbort.controller;
    controller.signal.addEventListener("abort", () => admitted.value.cleanupAdmittedRun());
    f.context.chatRunState.getOrCreate(runId).buffer = "keep ordinary local output";
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(f.harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const sweep = f.coordinated.reconcileActive();
    await entered.promise;
    const first = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    const prepared = createDeferredCore();
    const second = f.coordinated
      .reclaim(REQUEST, undefined, () => prepared.resolve())
      .catch((error: unknown) => error);
    try {
      await Promise.race([
        prepared.promise,
        second.then((result) => {
          throw result;
        }),
      ]);
      release.resolve();
      const results = await Promise.all([first, second]);
      expect(controller.signal.aborted).toBe(false);
      expect(f.cancellationStarted).not.toHaveBeenCalled();
      expect(cancellations).not.toHaveBeenCalled();
      expect(f.context.chatRunState.getOrCreate(runId).buffer).toBe("keep ordinary local output");
      for (const result of results) {
        if (state === "reclaimed") {
          expect(result).toMatchObject({ state: "reclaimed" });
        } else {
          expect(result).toBeInstanceOf(Error);
        }
      }
    } finally {
      release.resolve();
      await Promise.all([sweep, first, second]);
      admitted.value.cleanupAdmittedRun();
      clearAgentRunContext(runId, admitted.value.lifecycleGeneration);
      f.context.chatRunState.clear();
    }
  },
);

it.each([false, true])(
  "Stop follows Move's synchronous draining owner before barrier return (abandon=%s)",
  async (abandonSource) => {
    const entering = createDeferredCore();
    const begin = createDeferredCore();
    const begun = createDeferredCore();
    const finish = createDeferredCore();
    const f = await cancellationLoadFixture({
      runMoveBarrier: async (request) => {
        const result = await barrier(request);
        begun.resolve();
        await finish.promise;
        return result;
      },
    });
    const barrier = createGatewayWorkerPlacementMoveBarrier({
      placements: f.placements,
      loadSessionRuntime: async () => {
        entering.resolve();
        await begin.promise;
        return f.runtime;
      },
      revokeSessionAuthority: vi.fn(),
    });
    const active = await f.coordinated.dispatch(REQUEST);
    if (abandonSource) {
      f.harness.markEnvironmentNodeDeviceId("device-1");
    }
    f.database.db
      .prepare(`INSERT INTO worker_environments (
      environment_id, provider_id, profile_id, profile_snapshot_json,
      provision_operation_id, lease_id, state, owner_epoch, node_device_id,
      attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
    ) VALUES (?, ?, ?, '{}', ?, 'lease-move', 'attached', ?, ?, ?, 1000, 1000, 1000)`)
      .run(
        active.environmentId,
        abandonSource ? "device" : "test",
        abandonSource ? "device:device-1" : REQUEST.profileId,
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        abandonSource ? "device-1" : null,
        JSON.stringify([active.sessionId]),
      );
    const transitions: string[] = [];
    let transitionsAtFirstYield: string[] | undefined;
    const beginPlacementMove = f.placements.beginPlacementMove.bind(f.placements);
    vi.spyOn(f.placements, "beginPlacementMove").mockImplementation((request) => {
      const result = beginPlacementMove(request);
      queueMicrotask(() => {
        transitionsAtFirstYield = [...transitions];
      });
      return result;
    });
    const moving = f.coordinated
      .move(
        {
          ...REQUEST,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "gateway" },
          ...(abandonSource ? { abandonSource: true as const } : {}),
        },
        (placement) => transitions.push(placement.state),
      )
      .catch((error: unknown) => error);
    await Promise.race([
      entering.promise,
      moving.then((result) => {
        throw result;
      }),
    ]);
    f.armCancellation();
    const stopping = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    try {
      await Promise.race([
        f.loading.promise,
        stopping.then((result) => {
          throw result;
        }),
      ]);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("active");
      begin.resolve();
      await Promise.race([
        begun.promise,
        moving.then((result) => {
          throw result;
        }),
      ]);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("draining");
      expect.soft(transitionsAtFirstYield).toEqual(["draining"]);
      f.loaded.resolve();
      await f.waitForCancellationStart(stopping);
      expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      finish.resolve();
      expect(await moving).toBeInstanceOf(Error);
      expect(await stopping).toMatchObject({ state: abandonSource ? "local" : "reclaimed" });
      expect(transitions.filter((state) => state === "draining")).toHaveLength(1);
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
    } finally {
      begin.resolve();
      finish.resolve();
      f.loaded.resolve();
      await Promise.all([moving, stopping]);
      f.context.chatRunState.clear();
    }
  },
);

it.each(
  (["provisioning", "active"] as const).flatMap((phase) =>
    (["same-owner", "cleanup", "replacement", "incarnation"] as const).map((change) => ({
      phase,
      change,
    })),
  ),
)(
  "concurrent Stops retain their shared $phase cleanup owner ($change)",
  async ({ phase, change }) => {
    const entered = createDeferredCore();
    const released = createDeferredCore();
    const f = await cancellationLoadFixture(
      phase === "active"
        ? {
            afterReconcile: async () => {
              entered.resolve();
              await released.promise;
            },
          }
        : {},
    );
    if (phase === "provisioning") {
      vi.mocked(f.harness.environments.create).mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
        return f.harness.ready;
      });
    }
    const dispatch = f.coordinated.dispatch(REQUEST).catch((error: unknown) => error);
    if (phase === "active") {
      expect(await dispatch).toMatchObject({ state: "active" });
    } else {
      await entered.promise;
    }
    const first = f.coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    await f.waitForCancellationStart(first);
    if (phase === "active") {
      await Promise.race([
        entered.promise,
        first.then((result) => {
          throw result;
        }),
      ]);
    }
    f.armCancellation();
    let secondSettled = false;
    const second = f.coordinated
      .reclaim(REQUEST)
      .catch((error: unknown) => error)
      .finally(() => {
        secondSettled = true;
      });
    try {
      await Promise.race([
        f.loading.promise,
        second.then((result) => {
          throw result;
        }),
      ]);
      if (change === "cleanup") {
        f.loaded.resolve();
        await f.waitForCancellationStart(second);
        expect(secondSettled).toBe(false);
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      }
      released.resolve();
      const completed = await first;
      expect(completed).toMatchObject({ state: phase === "active" ? "reclaimed" : "local" });
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
      const cancellations = f.cancellationStarted.mock.calls.length;
      if (change === "replacement") {
        f.placements.startDispatch(REQUEST);
      } else if (change === "incarnation") {
        f.entry.lifecycleRevision = "replacement";
      }
      f.loaded.resolve();
      const result = await second;
      if (change === "same-owner" || change === "cleanup") {
        expect(result).toEqual(completed);
        expect(f.placements.get(REQUEST.sessionId)).toEqual(completed);
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(f.cancellationStarted).toHaveBeenCalledTimes(cancellations);
      }
      expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      f.loaded.resolve();
      await Promise.all([dispatch, first, second]);
      f.context.chatRunState.clear();
    }
  },
);

it.each(["syncing", "completed", "failed", "replacement", "incarnation", "observer"] as const)(
  "Stop retains captured dispatch authority across cancellation loading (%s)",
  async (advance) => {
    const {
      placements,
      entry,
      context,
      loading,
      loaded,
      cancellationStarted,
      harness,
      coordinated,
      armCancellation,
      waitForCancellationStart,
    } = await cancellationLoadFixture(advance === "failed" ? { failAt: "sync" } : {});
    const provisioning = createDeferredCore();
    const provisioned = createDeferredCore();
    const attaching = createDeferredCore();
    const attached = createDeferredCore();
    let dispatchSignal: AbortSignal | undefined;
    vi.mocked(harness.environments.create).mockImplementationOnce(
      async (_profile, _key, _machine, _mode, _project, signal) => {
        dispatchSignal = signal;
        provisioning.resolve();
        await provisioned.promise;
        return harness.ready;
      },
    );
    if (advance === "syncing") {
      const attach = harness.environments.attachSession;
      harness.environments.attachSession = vi.fn(async (request) => {
        attaching.resolve();
        await attached.promise;
        return await attach(request);
      });
    }
    const dispatch = coordinated
      .dispatch(REQUEST, (placement) => {
        if (advance === "observer" && placement.state === "active") {
          placement.generation += 100;
        }
      })
      .then(
        (result) => result,
        (error: unknown) => error,
      );
    await provisioning.promise;
    armCancellation();
    const stopping = coordinated.reclaim(REQUEST).then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      await loading.promise;
      expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
      expect(dispatchSignal?.aborted).toBe(false);
      provisioned.resolve();
      if (advance === "syncing") {
        await attaching.promise;
        expect(placements.get(REQUEST.sessionId)?.state).toBe("syncing");
      } else {
        await dispatch;
        expect(placements.get(REQUEST.sessionId)?.state).toBe(
          advance === "failed" ? "failed" : "active",
        );
      }
      if (advance === "replacement") {
        const current = placements.get(REQUEST.sessionId);
        if (current?.state !== "active") {
          throw new Error("Replacement fixture requires a completed active dispatch");
        }
        placements.startDrain({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
      } else if (advance === "incarnation") {
        entry.lifecycleRevision = "replacement";
      }
      loaded.resolve();
      if (advance !== "replacement" && advance !== "incarnation") {
        await waitForCancellationStart(stopping);
      }
      if (advance === "syncing") {
        expect(dispatchSignal?.aborted).toBe(true);
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      }
      attached.resolve();
      const result = await stopping;
      if (advance === "replacement" || advance === "incarnation") {
        expect(result).toBeInstanceOf(Error);
        expect(cancellationStarted).not.toHaveBeenCalled();
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          state: advance === "completed" || advance === "observer" ? "reclaimed" : "local",
        });
        expect(cancellationStarted).toHaveBeenCalled();
        expect(harness.environments.get(harness.ready.environmentId)?.state).toBe("destroyed");
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
      }
    } finally {
      loaded.resolve();
      provisioned.resolve();
      attached.resolve();
      await Promise.all([dispatch, stopping]);
      context.chatRunState.clear();
    }
  },
);

it.each([
  { advance: "cleanup", targetKind: "gateway" },
  { advance: "completed", targetKind: "gateway" },
  { advance: "replacement", targetKind: "gateway" },
  { advance: "cleanup", targetKind: "profile" },
  { advance: "cleanup", targetKind: "device" },
] as const)(
  "Stop retains captured Move completion across cancellation loading ($advance, $targetKind)",
  async ({ advance, targetKind }) => {
    const reconciling = createDeferredCore();
    const reconciled = createDeferredCore();
    const cleaning = createDeferredCore();
    const cleaned = createDeferredCore();
    const f = await cancellationLoadFixture({
      runMoveBarrier: async (request) => await barrier(request),
      afterReconcile: async () => {
        reconciling.resolve();
        await reconciled.promise;
      },
      afterStopTunnel: async () => {
        cleaning.resolve();
        await cleaned.promise;
      },
    });
    const barrier = createGatewayWorkerPlacementMoveBarrier({
      placements: f.placements,
      loadSessionRuntime: async () => f.runtime,
      revokeSessionAuthority: vi.fn(),
    });
    const active = await f.coordinated.dispatch(REQUEST);
    // Move validates the durable environment owner as well as the provider projection.
    f.database.db
      .prepare(`INSERT INTO worker_environments (
      environment_id, provider_id, profile_id, profile_snapshot_json,
      provision_operation_id, lease_id, state, owner_epoch,
      attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
    ) VALUES (?, 'test', ?, '{}', ?, 'lease-move', 'attached', ?, ?, 1000, 1000, 1000)`)
      .run(
        active.environmentId,
        REQUEST.profileId,
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        JSON.stringify([active.sessionId]),
      );
    const localGenerations = new Set<number>();
    const moving = f.coordinated
      .move(
        {
          ...REQUEST,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target:
            targetKind === "profile"
              ? { kind: "profile", profileId: "destination-profile" }
              : targetKind === "device"
                ? { kind: "device", deviceId: "destination-device" }
                : { kind: "gateway" },
        },
        (placement) => {
          if (placement.state === "local") {
            localGenerations.add(placement.generation);
          }
        },
      )
      .catch((error: unknown) => error);
    await Promise.race([
      reconciling.promise,
      moving.then(() => {
        throw new Error("Move completed before reconciliation hold");
      }),
    ]);
    expect(f.placements.get(REQUEST.sessionId)?.state).toBe("draining");
    f.cancellationStarted.mockClear();
    f.armCancellation();
    let stopped = false;
    const stopping = f.coordinated.reclaim(REQUEST).then(
      (result) => {
        stopped = true;
        return result;
      },
      (error: unknown) => {
        stopped = true;
        return error;
      },
    );
    try {
      await Promise.race([
        f.loading.promise,
        stopping.then((result) => {
          throw result;
        }),
      ]);
      reconciled.resolve();
      await Promise.race([
        cleaning.promise,
        moving.then(() => {
          throw new Error("Move completed before cleanup hold");
        }),
      ]);
      expect(f.placements.get(REQUEST.sessionId)?.state).toBe("local");
      if (advance !== "cleanup") {
        cleaned.resolve();
        expect.soft(await moving).toMatchObject({ state: "local" });
      }
      if (advance === "replacement") {
        f.placements.startDispatch(REQUEST);
      }
      f.loaded.resolve();
      if (advance !== "replacement") {
        await f.waitForCancellationStart(stopping);
      }
      if (advance === "cleanup") {
        expect(f.cancellationStarted).toHaveBeenCalled();
        expect(stopped).toBe(false);
      }
      cleaned.resolve();
      const result = await stopping;
      if (advance === "replacement") {
        expect(result).toBeInstanceOf(Error);
        expect(f.cancellationStarted).not.toHaveBeenCalled();
        expect(f.placements.get(REQUEST.sessionId)?.state).toBe("requested");
      } else {
        expect.soft(result).toMatchObject({ state: "local" });
        expect.soft(await moving).toMatchObject({ state: "local" });
        expect(localGenerations.size).toBe(1);
        expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
        expect.soft(f.placements.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
        expect(f.placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
        expect(f.placements.listPendingWorkspaceResults()).toEqual([]);
        expect(f.harness.environments.create).toHaveBeenCalledOnce();
        expect(f.harness.log.filter((event) => event === "placement:requested")).toHaveLength(1);
      }
    } finally {
      reconciled.resolve();
      cleaned.resolve();
      f.loaded.resolve();
      await Promise.all([moving, stopping]);
      f.context.chatRunState.clear();
    }
  },
);
