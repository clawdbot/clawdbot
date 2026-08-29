import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

describe("worker allocation cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("cancels a requested environment without resolving a provider", async () => {
    const intent = support.testState.store.createIntent({
      environmentId: "never-provisioned",
      providerId: "unavailable",
      profileId: "removed",
      profileSnapshot: { settings: {} },
      provisionOperationId: "never-started",
    });
    support.testState.providersEnabled = false;
    const service = support.createService(support.createProvider());
    await expect(service.destroy(intent.environmentId)).resolves.toMatchObject({
      state: "failed",
      leaseId: null,
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.store.getCredential(intent.environmentId)).toBeUndefined();
  });

  it.each([
    { leaseId: "", sharedHost: false },
    { leaseId: "unattested-host" },
    { leaseId: "unattested-host", sharedHost: "false" },
  ])("retains cleanup intent for an invalid allocation identity %j", async (allocation) => {
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provision: async () => {
        throw new Error("response lost");
      },
      // Exercise the untyped plugin result boundary without changing the public contract.
      resolveAllocation: async () => allocation as never,
      destroy,
    });
    const service = support.createService(provider);
    await expect(service.create("development", "invalid-allocation")).rejects.toMatchObject({
      code: "provider_failure",
    });
    const pending = expectDefined(support.testState.store.list()[0], "invalid allocation intent");
    await expect(service.destroy(pending.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(support.testState.store.get(pending.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      sharedHost: null,
      destroyRequestedAtMs: expect.any(Number),
      lastError: "Worker provider returned an invalid allocation identity",
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each(
    ["destroy", "restart"].flatMap((entrance) =>
      ["still refused", "repaired"].map((preflight) => ({ entrance, preflight })),
    ),
  )(
    "does not replay provisioning when preflight is $preflight during $entrance cleanup",
    async ({ entrance, preflight }) => {
      let preflightFails = true;
      const allocate = vi.fn();
      const setup = vi.fn();
      const provision = vi.fn(async () => {
        if (preflightFails) {
          throw new Error("preflight failed before allocation");
        }
        allocate();
        setup();
        return { leaseId: "operation-cleanup", ssh: support.SSH_ENDPOINT };
      });
      const resolveAllocation = vi.fn(async () => ({
        leaseId: "operation-cleanup",
        sharedHost: false,
      }));
      const destroy = vi.fn(async () => {});
      const provider = {
        ...support.createProvider({ provisionBeforeInstallation: true, provision, destroy }),
        resolveAllocation,
      };
      let service = support.createService(provider);
      await expect(service.create("development", "preflight-cleanup")).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(support.testState.store.list()[0], "failed preflight intent");
      expect(pending).toMatchObject({ state: "provisioning", leaseId: null });
      support.testState.store.requestDestroy({
        environmentId: pending.environmentId,
        state: pending.state,
      });
      preflightFails = preflight === "still refused";
      // Cleanup must use the persisted profile even after the operator removes it.
      support.testState.config.cloudWorkers!.profiles = {};
      if (entrance === "restart") {
        await support.reopenWorkerEnvironmentStore();
        service = support.createService(provider);
        await service.reconcileOnce();
      } else {
        await service.destroy(pending.environmentId);
      }

      const terminal = expectDefined(service.get(pending.environmentId), "terminal environment");
      await expect(service.destroy(pending.environmentId)).resolves.toEqual(terminal);
      await service.reconcileOnce();
      await support.reopenWorkerEnvironmentStore();
      service = support.createService(provider);
      await service.reconcileOnce();
      await expect(service.destroy(pending.environmentId)).resolves.toEqual(terminal);

      expect(allocate).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
      expect(provision).toHaveBeenCalledOnce();
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
        { region: "test" },
        pending.provisionOperationId,
      );
      expect(destroy).toHaveBeenCalledExactlyOnceWith({
        leaseId: "operation-cleanup",
        profile: { region: "test" },
      });
      expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(support.testState.store.getCredential(pending.environmentId)).toBeUndefined();
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "operation-cleanup",
        sharedHost: false,
        sshEndpoint: null,
        nodeDeviceId: null,
        bootstrapReceipt: null,
        ownerEpoch: 0,
      });
    },
  );

  it.each(["destroyed", "failed"] as const)(
    "retains an unreported allocation across failed teardown and restart (%s)",
    async (terminalState) => {
      const physicalLeases = new Set<string>();
      const leaseId = "lost-response-allocation";
      const provision = vi.fn(async () => {
        physicalLeases.add(leaseId);
        throw new Error("allocation response lost");
      });
      const resolveAllocation = vi.fn(async () => ({ leaseId, sharedHost: false }));
      const destroy = vi
        .fn(async () => {
          physicalLeases.delete(leaseId);
        })
        .mockRejectedValueOnce(new Error("release outcome unknown"));
      const provider = support.createProvider({ provision, resolveAllocation, destroy });
      const first = support.createService(provider);
      await expect(first.create("development", "lost-allocation")).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(support.testState.store.list()[0], "unreported allocation");
      support.testState.store.requestDestroy({
        environmentId: pending.environmentId,
        state: pending.state,
        terminalState,
        lastError: "allocation response lost",
      });
      await support.reopenWorkerEnvironmentStore();
      await expect(
        support.createService(provider).destroy(pending.environmentId),
      ).rejects.toMatchObject({
        code: "provider_failure",
      });
      expect(physicalLeases).toEqual(new Set([leaseId]));
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "destroying",
        leaseId,
        teardownTerminalState: terminalState,
      });
      await support.reopenWorkerEnvironmentStore();
      await support.createService(provider).reconcileOnce();
      expect(provision).toHaveBeenCalledOnce();
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
        { region: "test" },
        pending.provisionOperationId,
      );
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(physicalLeases.size).toBe(0);
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: terminalState,
        leaseId: terminalState === "failed" ? null : leaseId,
        ...(terminalState === "failed" ? { lastError: "allocation response lost" } : {}),
      });
    },
  );

  it.each(["queued", "resolving"] as const)(
    "fences a replaced cleanup owner while allocation resolution is %s",
    async (phase) => {
      const provisionPending = createDeferredCore();
      const resolutionPending = createDeferredCore();
      const resolveAllocation = vi.fn(async () => {
        await resolutionPending.promise;
        return { leaseId: "old-allocation", sharedHost: false };
      });
      const provision = vi.fn(async () => {
        if (phase === "queued") {
          await provisionPending.promise;
        }
        throw new Error("provision response lost");
      });
      const destroy = vi.fn(async () => {});
      const service = support.createService(
        support.createProvider({
          provision,
          resolveAllocation,
          destroy,
          resolveProvisionTimeoutMs: () => 20,
        }),
      );
      await expect(service.create("development", "owner-race")).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(support.testState.store.list()[0], "pending owner");
      const teardown = service.destroy(pending.environmentId);
      const rejected = expect(teardown).rejects.toMatchObject({ code: "invalid_state" });
      try {
        await support.waitForFast(() =>
          expect(
            support.testState.store.get(pending.environmentId)?.destroyRequestedAtMs,
          ).not.toBeNull(),
        );
        if (phase === "resolving") {
          await support.waitForFast(() => expect(resolveAllocation).toHaveBeenCalledOnce());
        }
        const replacement = support.testState.store.transition({
          environmentId: pending.environmentId,
          from: "provisioning",
          to: "draining",
          patch: {
            leaseId: "replacement-allocation",
            sharedHost: true,
            lastError: "replacement owner",
          },
        });
        provisionPending.resolve();
        resolutionPending.resolve();
        await rejected;
        expect(support.testState.store.get(pending.environmentId)).toEqual(replacement);
        expect(resolveAllocation).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
        expect(provision).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        provisionPending.resolve();
        resolutionPending.resolve();
        await teardown.catch(() => undefined);
      }
    },
  );

  it("keeps timed-out allocation resolution owned until settlement, including shutdown", async () => {
    const resolutionPending = createDeferredCore();
    const resolveAllocation = vi.fn(async () => {
      await resolutionPending.promise;
      return { leaseId: "late-allocation", sharedHost: false };
    });
    const provision = vi.fn(async () => {
      throw new Error("preflight failed");
    });
    const destroy = vi.fn(async () => {});
    const service = support.createService(
      support.createProvider({ provision, resolveAllocation, destroy }),
      {
        providerCallTimeoutMs: 20,
      },
    );
    await expect(service.create("development", "resolution-timeout")).rejects.toMatchObject({
      code: "provider_failure",
    });
    const pending = expectDefined(support.testState.store.list()[0], "pending resolution");
    await expect(service.destroy(pending.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    });
    const retry = service.destroy(pending.environmentId);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    try {
      // The retry and shutdown have been admitted, but neither can release the provider queue.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(resolveAllocation).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        destroyRequestedAtMs: expect.any(Number),
      });
    } finally {
      resolutionPending.resolve();
      await retry;
      await stopping;
    }
    expect(resolveAllocation).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);
    expect(support.testState.store.get(pending.environmentId)?.state).toBe("destroyed");
  });
});
