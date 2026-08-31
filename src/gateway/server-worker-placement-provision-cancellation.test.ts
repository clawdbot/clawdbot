import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  REQUEST as FIXTURE_REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as support from "./worker-environments/service.test-support.js";

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
    });
  });

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
});
