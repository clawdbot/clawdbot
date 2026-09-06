import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  closeSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  REQUEST as FIXTURE_REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import * as support from "./worker-environments/service.test-support.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";

const REQUEST = {
  ...FIXTURE_REQUEST,
  profileId: "development",
  executionMode: "remote-exec" as const,
};

describe("dispatch Stop before provider allocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import("./worker-environments/placement-dispatch.js")
    >("./worker-environments/placement-dispatch.js");
    runtimeFactoryMocks.createDispatch.mockImplementation(
      actual.createWorkerPlacementDispatchService,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });
    const entry = {
      sessionId: REQUEST.sessionId,
      lifecycleRevision: "original",
      worktree: { id: "workspace" },
    };
    const target = {
      agentId: REQUEST.agentId,
      canonicalKey: REQUEST.sessionKey,
      store: { [REQUEST.sessionKey]: entry },
      storeKeys: [REQUEST.sessionKey],
      storePath: `${support.testState.root}/sessions.sqlite`,
    };
    const worktree = { id: "workspace", ownerId: REQUEST.sessionKey, path: support.testState.root };
    moveDestinationMocks.getRuntimeConfig.mockReturnValue(support.testState.config);
    moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
    moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
    moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
    moveDestinationMocks.resolveSessionTarget.mockReturnValue({
      config: support.testState.config,
      target,
      entry,
      worktree,
      workspace: { kind: "local", path: worktree.path },
    });
  });

  it.each([
    { targetKind: "profile", outcome: "cancel" },
    { targetKind: "device", outcome: "cancel" },
    { targetKind: "profile", outcome: "preflight-error" },
    { targetKind: "profile", outcome: "canceled-preflight-error" },
    { targetKind: "profile", outcome: "replacement" },
    { targetKind: "profile", outcome: "incarnation" },
    { targetKind: "profile", outcome: "published" },
  ] as const)(
    "Stop settles Move at destination admission ($targetKind, $outcome)",
    async ({ targetKind, outcome }) => {
      const actual = await vi.importActual<
        typeof import("./worker-environments/placement-dispatch.js")
      >("./worker-environments/placement-dispatch.js");
      const targetOwner = await vi.importActual<
        typeof import("./server-worker-placement-session-target.js")
      >("./server-worker-placement-session-target.js");
      moveDestinationMocks.resolveSessionTarget.mockImplementation(
        targetOwner.resolveWorkerPlacementSessionTarget,
      );
      runtimeFactoryMocks.createDispatch.mockImplementation((options) =>
        actual.createWorkerPlacementDispatchService({
          ...options,
          resolveMoveDestination: async (_identity, target) =>
            target.kind === "gateway"
              ? undefined
              : {
                  profileId:
                    target.kind === "profile" ? target.profileId : `device:${target.deviceId}`,
                  executionMode: "remote-exec",
                  ...(target.kind === "device" ? { deviceId: target.deviceId } : {}),
                },
        }),
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const interrupted = createDeferredCore();
      let destinationSignal: AbortSignal | undefined;
      workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        if (outcome === "published") {
          return;
        }
        destinationSignal = signal;
        entered.resolve();
        await release.promise;
        if (outcome === "preflight-error" || outcome === "canceled-preflight-error") {
          throw new Error("destination preflight rejected");
        }
        signal?.throwIfAborted();
      });
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = createHarness(placements, { workspacePath: support.testState.root });
      const active = harness.placements.seedActive(2, "remote-exec");
      if (active.state !== "active") {
        throw new Error("Move fixture requires an active source");
      }
      harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      support.testState.stateDb.db
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
      if (outcome === "published") {
        vi.mocked(harness.environments.create).mockImplementation(
          async (_profile, _key, _machine, _mode, _path, signal) => {
            destinationSignal = signal;
            entered.resolve();
            await release.promise;
            signal?.throwIfAborted();
            throw new Error("published destination must be canceled");
          },
        );
      }
      const environments = {
        ...support.createService(support.createProvider()),
        ...harness.environments,
      };
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: async (request) => {
          request.assertCurrent();
          request.onCancellationStarted?.();
          interrupted.resolve();
        },
        revokeSessionAuthority: vi.fn(),
      });
      const sessionTarget = moveDestinationMocks.resolveGatewaySessionTarget();
      const sourceEntry = moveDestinationMocks.resolveCanonicalSession();
      const transitions: Array<{ state: string; generation: number }> = [];
      const moving = runtime.dispatchService
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
                ? { kind: "profile", profileId: "development" }
                : { kind: "device", deviceId: "destination-device" },
          },
          (placement) =>
            transitions.push({ state: placement.state, generation: placement.generation }),
        )
        .catch((error: unknown) => error);
      let stopping: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([
          entered.promise,
          moving.then((result) => {
            throw result;
          }),
        ]);
        const local = transitions.find((placement) => placement.state === "local");
        expect(local).toBeDefined();
        expect(placements.get(REQUEST.sessionId)?.state).toBe(
          outcome === "published" ? "provisioning" : "local",
        );
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
        if (outcome !== "preflight-error") {
          stopping = runtime.dispatchService.reclaim(REQUEST).catch((error: unknown) => error);
          await Promise.race([
            interrupted.promise,
            stopping.then((result) => {
              throw result;
            }),
          ]);
          expect(destinationSignal?.aborted).toBe(true);
          if (outcome === "replacement") {
            placements.startDispatch(REQUEST);
          } else if (outcome === "incarnation") {
            sourceEntry.sessionId = "replacement-session";
          }
        }
        release.resolve();
        const moved = await moving;
        const stopped = await stopping;
        if (outcome === "cancel" || outcome === "incarnation") {
          expect.soft(moved).toMatchObject({ state: "local", generation: local?.generation });
          expect.soft(placements.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
          if (outcome === "incarnation") {
            // Move reports the old source's committed cleanup; Stop cannot use that
            // completion as authority over the replacement session incarnation.
            expect(stopped).toMatchObject({ code: "invalid_state" });
            expect(sourceEntry.sessionId).toBe("replacement-session");
            expect(placements.get("replacement-session")).toBeUndefined();
          } else {
            expect.soft(stopped).toMatchObject({ state: "local", generation: local?.generation });
          }
        } else {
          expect(moved).toBeInstanceOf(Error);
          if (outcome === "preflight-error" || outcome === "canceled-preflight-error") {
            expect(moved).toMatchObject({ message: "destination preflight rejected" });
            expect(placements.getPlacementMove(REQUEST.sessionId)?.lastError).toBe(
              "destination preflight rejected",
            );
            if (outcome === "canceled-preflight-error") {
              expect(stopped).toBeInstanceOf(Error);
              expect(moved).not.toBe(destinationSignal?.reason);
            }
          } else if (outcome === "published") {
            expect(stopped).toMatchObject({ state: "local" });
            expect(placements.get(REQUEST.sessionId)!.generation).toBeGreaterThan(
              local!.generation,
            );
          } else {
            expect(stopped).toBeInstanceOf(Error);
          }
        }
        expect(harness.environments.create).toHaveBeenCalledTimes(outcome === "published" ? 1 : 0);
        expect(placements.listPendingWorkspaceResults()).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([moving, stopping]);
        await runExclusiveSessionLifecycleMutation({
          scope: sessionTarget.storePath,
          identities: [REQUEST.sessionKey, REQUEST.sessionId],
          run: async () => {},
        });
      }
    },
  );

  it("cancels the exact preflight owner without admitting a later provider", async () => {
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    let preflightSignal: AbortSignal | undefined;
    workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      preflightSignal = signal;
      entered.resolve();
      await settled.promise;
      signal?.throwIfAborted();
    });
    const provision = vi.fn(async () => {
      throw new Error("unexpected provider entry");
    });
    const environments = support.createService(support.createProvider({ provision }));
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      warn: vi.fn(),
      cancelSessionWork: vi.fn(async () => {}),
      revokeSessionAuthority: vi.fn(),
    });
    const dispatch = runtime.dispatchService.dispatch(REQUEST).catch((error: unknown) => error);
    await entered.promise;
    expect(placements.get(REQUEST.sessionId)).toBeUndefined();
    const stopping = runtime.dispatchService.reclaim(REQUEST);
    let stopped = false;
    void stopping.then(
      () => {
        stopped = true;
      },
      () => {},
    );
    try {
      await setImmediate();
      await setImmediate();
      expect(preflightSignal?.aborted).toBe(true);
      expect(stopped).toBe(false);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      settled.resolve();
      await dispatch;
      await stopping.catch(() => undefined);
    }
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });
  it.each(["missing", "reclaimed"] as const)(
    "cancels queued redispatch before the %s placement can allocate",
    async (state) => {
      workspace.preflight.mockResolvedValue(undefined);
      const environments = support.createService(support.createProvider());
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      if (state === "reclaimed") {
        const active = seedActivePlacement(placements, {
          environmentId: "old-environment",
          ownerEpoch: 1,
          executionMode: "remote-exec",
        });
        const draining = placements.startDrain({
          sessionId: REQUEST.sessionId,
          environmentId: "old-environment",
          ownerEpoch: 1,
          expectedGeneration: active.generation,
        });
        placements.startReconcile({
          sessionId: REQUEST.sessionId,
          environmentId: "old-environment",
          ownerEpoch: 1,
          expectedGeneration: draining.generation,
        });
        const current = placements.get(REQUEST.sessionId)!;
        placements.transition({
          sessionId: REQUEST.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: current.generation,
        });
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(environments, "reconcileOnce").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const create = vi.spyOn(environments, "create");
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: vi.fn(async () => {}),
        revokeSessionAuthority: vi.fn(),
      });
      const sweep = runtime.dispatchService.reconcileActive();
      await entered.promise;
      const dispatch = runtime.dispatchService.dispatch(REQUEST).then(
        () => "active",
        () => "cancelled",
      );
      const stopping = runtime.dispatchService.reclaim(REQUEST).then(
        (value) => value,
        (error: unknown) => error,
      );
      await setImmediate();
      release.resolve();
      await sweep;
      expect(await dispatch).toBe("cancelled");
      const result = await stopping;
      if (state === "reclaimed") {
        expect(result).toMatchObject({ state: "reclaimed" });
      } else {
        expect(result).toBeInstanceOf(Error);
      }
      expect(create).not.toHaveBeenCalled();
      expect(support.testState.store.list()).toEqual([]);
    },
  );

  it("does not cancel an ordinary local session without an in-flight dispatch", async () => {
    const environments = support.createService(support.createProvider());
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const interrupted = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: `${support.testState.root}/sessions.sqlite`,
      identities: [REQUEST.sessionKey, REQUEST.sessionId],
      assertAllowed: () => {},
      onInterrupt: interrupted,
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      warn: vi.fn(),
      cancelSessionWork: vi.fn(async () => {}),
      revokeSessionAuthority: vi.fn(),
    });
    try {
      await expect(runtime.dispatchService.reclaim(REQUEST)).rejects.toThrow();
      expect(interrupted).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  });

  it.each(["local", "recovery", "activation", "move"] as const)(
    "releases admitted %s queued behind an interrupting lifecycle owner",
    async (phase) => {
      const actual = await vi.importActual<
        typeof import("./worker-environments/placement-dispatch.js")
      >("./worker-environments/placement-dispatch.js");
      const beforeBarrier = createDeferredCore();
      const enterBarrier = createDeferredCore();
      const queued = createDeferredCore();
      const mutationEntered = createDeferredCore();
      const interrupt = createDeferredCore();
      const releaseMutation = createDeferredCore();
      const events: string[] = [];
      let observeQueue = false;
      const target = moveDestinationMocks.resolveGatewaySessionTarget();
      moveDestinationMocks.resolveGatewaySessionTarget.mockImplementation(() => {
        if (observeQueue) {
          queued.resolve();
        }
        return target;
      });
      const pause = async <T>(run: () => Promise<T>): Promise<T> => {
        beforeBarrier.resolve();
        await enterBarrier.promise;
        return await run();
      };
      runtimeFactoryMocks.createDispatch.mockImplementation((options) =>
        actual.createWorkerPlacementDispatchService({
          ...options,
          runLocalBarrier: (request) =>
            phase === "local"
              ? pause(() =>
                  options.runLocalBarrier({
                    ...request,
                    startDispatch: () => {
                      events.push("phase-started");
                      return request.startDispatch();
                    },
                  }),
                )
              : options.runLocalBarrier(request),
          runRecoveryBarrier: (request) =>
            pause(() =>
              options.runRecoveryBarrier({
                ...request,
                run: async (recoveryWorkspace: WorkerSessionWorkspace) => {
                  events.push("phase-started");
                  await request.run(recoveryWorkspace);
                },
              }),
            ),
          runActivationBarrier: (request) =>
            phase === "activation"
              ? pause(() =>
                  options.runActivationBarrier({
                    ...request,
                    activate: () => {
                      events.push("phase-started");
                      return request.activate();
                    },
                  }),
                )
              : options.runActivationBarrier(request),
          runMoveBarrier: (request) =>
            pause(() =>
              options.runMoveBarrier({
                ...request,
                begin: async (prepareNew?: (runId: string) => Promise<void>) => {
                  events.push("phase-started");
                  return await request.begin(prepareNew);
                },
              }),
            ),
        }),
      );
      workspace.preflight.mockResolvedValue(undefined);
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = createHarness(placements);
      const environments = {
        ...support.createService(support.createProvider()),
        ...harness.environments,
      };
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: vi.fn(async () => {}),
        revokeSessionAuthority: vi.fn(),
      });
      const initial =
        phase === "recovery"
          ? harness.placements.seedProvisioning("remote-exec")
          : phase === "move"
            ? harness.placements.seedActive(2, "remote-exec")
            : undefined;
      const operation = (
        phase === "recovery" && initial?.state === "provisioning"
          ? runtime.dispatchService.resumeProvisioning(initial, async () => {})
          : phase === "move" && initial?.state === "active"
            ? runtime.dispatchService.move({
                ...REQUEST,
                source: {
                  generation: initial.generation,
                  environmentId: initial.environmentId,
                  ownerEpoch: initial.activeOwnerEpoch,
                },
                target: { kind: "gateway" },
              })
            : runtime.dispatchService.dispatch(REQUEST)
      ).catch((error: unknown) => error);
      await Promise.race([
        beforeBarrier.promise,
        operation.then(() => {
          throw new Error("Placement operation ended before its lifecycle barrier");
        }),
      ]);
      const identity = {
        scope: target.storePath,
        identities: [REQUEST.sessionKey, REQUEST.sessionId],
      };
      // A task kill acquires this mutation outside the admitted operation's ALS,
      // then drains admissions while its own lifecycle mutation remains active.
      const mutation = runExclusiveSessionLifecycleMutation({
        ...identity,
        prepare: async () => {
          mutationEntered.resolve();
          await interrupt.promise;
          const { released } = startSessionWorkAdmissionInterruption(identity);
          void released.then(() => events.push("admission-released"));
          await Promise.race([released, releaseMutation.promise]);
          await releaseMutation.promise;
        },
        run: async () => events.push("mutation-finished"),
      });
      try {
        await mutationEntered.promise;
        observeQueue = true;
        enterBarrier.resolve();
        await queued.promise;
        interrupt.resolve();
        await support.waitForFast(() => expect(events).toEqual(["admission-released"]));
        expect(harness.log).not.toContain("placement:active");
      } finally {
        enterBarrier.resolve();
        interrupt.resolve();
        releaseMutation.resolve();
        await Promise.allSettled([operation, mutation]);
        // Flush the canceled contender: it must never execute after its predecessor releases.
        await runExclusiveSessionLifecycleMutation({ ...identity, run: async () => {} });
      }
      expect(events).toEqual(["admission-released", "mutation-finished"]);
    },
  );

  it.each([
    "replaced",
    "archived",
    "archived-behind-exclusive",
    "shutdown",
    "closed-ingress",
    "started-failure",
  ] as const)(
    "preserves the exact recovery cleanup owner after %s admission refusal",
    async (reason) => {
      const destroyEntered = createDeferredCore();
      const releaseDestroy = createDeferredCore();
      const exclusiveEntered = createDeferredCore();
      const releaseExclusive = createDeferredCore();
      const admissionChecked = createDeferredCore();
      const invalidOwner = reason === "replaced" || reason.startsWith("archived");
      const destroy = vi.fn(
        async ({
          leaseId,
        }: Parameters<ReturnType<typeof support.createProvider>["destroy"]>[0]) => {
          if (leaseId === "lease:environment-prior-exclusive") {
            exclusiveEntered.resolve();
            await releaseExclusive.promise;
            return;
          }
          destroyEntered.resolve();
          await releaseDestroy.promise;
        },
      );
      const provision = vi.fn(async () => {
        throw new Error("Refused recovery must not replay provisioning");
      });
      const environments = support.createService(support.createProvider({ provision, destroy }));
      const environment = support.seedBootstrapping("environment-refused-recovery");
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const requested = placements.startDispatch(REQUEST);
      placements.transition({
        sessionId: REQUEST.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: environment.environmentId },
      });
      const entry = {
        sessionId: reason === "replaced" ? "replacement-session" : REQUEST.sessionId,
        lifecycleRevision: "original",
        worktree: { id: "workspace" },
        ...(reason.startsWith("archived") ? { archivedAt: 1 } : {}),
      };
      let admissionReads = 0;
      moveDestinationMocks.resolveCanonicalSession.mockImplementation(() => {
        if (++admissionReads >= 2) {
          admissionChecked.resolve();
        }
        return entry;
      });
      if (reason === "started-failure") {
        vi.mocked(support.testState.bootstrapWorker).mockRejectedValueOnce(
          new Error("Bootstrap failed"),
        );
      }
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: vi.fn(async () => {}),
        revokeSessionAuthority: vi.fn(),
      });
      const uninstall = installWorkerPlacementReconcileGuard({
        placements,
        environments,
        dispatch: runtime.dispatchService,
        isStopping: () => false,
      });
      let exclusive: Promise<unknown> = Promise.resolve();
      if (reason === "archived-behind-exclusive") {
        support.seedReady("environment-prior-exclusive");
        exclusive = runtime.dispatchService.forceDestroyEnvironment("environment-prior-exclusive");
        await Promise.race([
          exclusiveEntered.promise,
          exclusive.then(() => {
            throw new Error("Prior exclusive operation ended before its held provider");
          }),
        ]);
      }
      const releaseIngress =
        reason === "closed-ingress"
          ? closeSessionWorkAdmissions({
              scope: `${support.testState.root}/sessions.sqlite`,
              identities: [REQUEST.sessionKey, REQUEST.sessionId],
              reason: new Error("session cancellation owns ingress"),
            })
          : () => {};
      if (reason === "shutdown") {
        markGatewayRestartDraining();
      }
      let settled = false;
      const recovery = environments.reconcileEnvironment(environment.environmentId).then(
        () => {
          settled = true;
          return "recovered";
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        if (reason === "archived-behind-exclusive") {
          await admissionChecked.promise;
          await setImmediate();
          expect(destroy).toHaveBeenCalledExactlyOnceWith({
            leaseId: "lease:environment-prior-exclusive",
            profile: { region: "test" },
          });
          expect(settled).toBe(false);
          releaseExclusive.resolve();
          await exclusive;
        }
        const first = await Promise.race([
          destroyEntered.promise.then(() => "destroy-started"),
          recovery,
        ]);
        expect(provision).not.toHaveBeenCalled();
        if (reason !== "started-failure") {
          expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
        }
        if (invalidOwner || reason === "started-failure") {
          expect(first).toBe("destroy-started");
          expect(settled).toBe(false);
          expect(
            destroy.mock.calls.filter(([lease]) => lease.leaseId === environment.leaseId),
          ).toEqual([[{ leaseId: environment.leaseId, profile: { region: "test" } }]]);
          const interruption = startSessionWorkAdmissionInterruption({
            scope: `${support.testState.root}/sessions.sqlite`,
            identities: [REQUEST.sessionKey, REQUEST.sessionId],
          });
          const admissionReleased = vi.fn();
          void interruption.released.then(admissionReleased);
          if (reason === "started-failure") {
            await setImmediate();
            expect(admissionReleased).not.toHaveBeenCalled();
          }
          releaseDestroy.resolve();
          await recovery;
          await interruption.released;
          expect(placements.get(REQUEST.sessionId)).toMatchObject({
            state: "failed",
            environmentId: environment.environmentId,
          });
          expect(support.testState.store.get(environment.environmentId)?.state).toBe(
            reason === "started-failure" ? "failed" : "destroyed",
          );
        } else {
          expect(first).toBeInstanceOf(reason === "shutdown" ? GatewayDrainingError : Error);
          expect(destroy).not.toHaveBeenCalled();
          expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
          expect(support.testState.store.get(environment.environmentId)).toMatchObject({
            state: "bootstrapping",
            leaseId: environment.leaseId,
            destroyRequestedAtMs: null,
          });
        }
      } finally {
        releaseExclusive.resolve();
        releaseDestroy.resolve();
        releaseIngress();
        resetGatewayWorkAdmission();
        await Promise.allSettled([recovery, exclusive]);
        await uninstall();
      }
    },
  );

  it.each(["targeted", "sweep", "idle", "late-sweep", "timeout"] as const)(
    "Stop owns steady-state provisioning through %s recovery ordering",
    async (mode) => {
      const replayEntered = createDeferredCore();
      const childClosed = createDeferredCore();
      const stopPrepared = createDeferredCore();
      const sweepEntered = createDeferredCore();
      const enterSweep = createDeferredCore();
      let providerSignal: AbortSignal | undefined;
      let provisionCalls = 0;
      const events: string[] = [];
      const destroy = vi.fn(async () => {
        events.push("destroy");
      });
      const environments = support.createService(
        support.createProvider({
          provision: async (_profile, _operation, options) => {
            provisionCalls += 1;
            if (provisionCalls <= 2) {
              throw new Error("provider reply unavailable after allocation");
            }
            providerSignal = options?.signal;
            events.push("replay");
            replayEntered.resolve();
            await childClosed.promise;
            events.push("child-closed");
            return { leaseId: "lease-recovery-stop", ssh: support.SSH_ENDPOINT, sharedHost: false };
          },
          resolveAllocation: async () => ({ leaseId: "lease-recovery-stop", sharedHost: false }),
          destroy,
        }),
        mode === "timeout" ? { providerCallTimeoutMs: 20 } : {},
      );
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const requested = placements.startDispatch(REQUEST);
      const key = `session-dispatch:${REQUEST.sessionId}:${requested.generation}`;
      const intent = deriveEnvironmentIntent(key);
      placements.transition({
        sessionId: REQUEST.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: intent.environmentId },
      });
      await expect(
        environments.create("development", key, undefined, REQUEST.executionMode),
      ).rejects.toMatchObject({ code: "provider_failure" });
      const cancelSessionWork = vi.fn(
        async (
          request: Parameters<
            Parameters<typeof createGatewayWorkerPlacementRuntime>[0]["cancelSessionWork"]
          >[0],
        ) => {
          request.assertCurrent();
          request.onCancellationStarted?.();
        },
      );
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork,
        revokeSessionAuthority: vi.fn(),
      });
      const uninstallGuard = installWorkerPlacementReconcileGuard({
        placements,
        environments,
        dispatch: runtime.dispatchService,
        isStopping: () => false,
      });
      // A completed recovery pass leaves this durable operation retryable. This is the
      // same installed guard used after startup unlocks, not an RPC through the startup gate.
      await environments.reconcileEnvironment(intent.environmentId);
      expect(provisionCalls).toBe(2);
      expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
      if (mode === "late-sweep") {
        const reconcileOnce = environments.reconcileOnce.bind(environments);
        vi.spyOn(environments, "reconcileOnce").mockImplementationOnce(async () => {
          sweepEntered.resolve();
          await enterSweep.promise;
          await reconcileOnce();
        });
      }
      const recovery =
        mode === "idle"
          ? Promise.resolve()
          : mode === "targeted"
            ? environments.reconcileEnvironment(intent.environmentId)
            : runtime.dispatchService.reconcileActive();
      if (mode !== "idle") {
        await Promise.race([
          mode === "late-sweep" ? sweepEntered.promise : replayEntered.promise,
          recovery.then(() => {
            throw new Error("Recovery returned before its held boundary");
          }),
        ]);
      }
      if (mode === "timeout") {
        // Startup and sweep completion use the caller result, but Stop must still
        // reach the actual provider that outlives that timeout.
        await recovery;
        expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
        expect(events).toEqual(["replay"]);
      }
      const attach = vi.spyOn(environments, "attachSession");
      let stopped = false;
      const stopping = runtime.dispatchService
        .reclaim(REQUEST, undefined, () => stopPrepared.resolve())
        .then(
          (value) => {
            stopped = true;
            return value;
          },
          (error: unknown) => {
            stopped = true;
            return error;
          },
        );
      try {
        await Promise.race([
          stopPrepared.promise,
          stopping.then(() => {
            throw new Error("Stop ended before preparation");
          }),
        ]);
        if (mode === "idle" || mode === "late-sweep") {
          // Stop has closed ingress before the older sweep discovers its recovery.
          // That recovery cannot wait for this Stop or allocate after it completes.
          enterSweep.resolve();
          await support.waitForFast(() => expect(stopped).toBe(true));
          expect(await stopping).toMatchObject({ state: "local" });
          expect(provisionCalls).toBe(2);
        } else {
          await support.waitForFast(() => expect(providerSignal?.aborted).toBe(true));
          expect(cancelSessionWork).toHaveBeenCalledOnce();
          expect(stopped).toBe(false);
          expect(destroy).not.toHaveBeenCalled();
          expect(
            support.testState.store.get(intent.environmentId)?.destroyRequestedAtMs,
          ).not.toBeNull();
        }
      } finally {
        enterSweep.resolve();
        childClosed.resolve();
        await Promise.allSettled([recovery, stopping]);
        await uninstallGuard();
      }
      expect(await stopping).toMatchObject({ state: "local" });
      expect(events).toEqual(
        mode === "idle" || mode === "late-sweep"
          ? ["destroy"]
          : ["replay", "child-closed", "destroy"],
      );
      expect(attach).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-recovery-stop",
      });
    },
  );
});
