import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/capability-provider.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

describe("worker provisioning cancellation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["prepared", "pending"] as const)(
    "revokes a %s runtime grant without releasing its provider before settlement",
    async (phase) => {
      const entered = createDeferredCore();
      const grantReleased = createDeferredCore();
      const childExited = createDeferredCore();
      const controller = new AbortController();
      const runtimeController = new AbortController();
      const runtime = { nodeBootstrap: support.NODE_BOOTSTRAP, signal: runtimeController.signal };
      const closeNodeRuntime = vi.fn(() => runtimeController.abort());
      const prepareNodeEnrollment = vi.fn();
      const destroy = vi.fn(async () => {});
      let operationSignal: AbortSignal | undefined;
      let settled = false;
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn"],
          requiresNodeEnrollment: true,
          provisionBeforeInstallation: true,
          provision: async (_profile, _operationId, options) => {
            await options!.prepareNodeRuntime!();
            entered.resolve();
            await childExited.promise;
            options?.signal?.throwIfAborted();
            throw new Error("Canceled runtime preparation unexpectedly completed");
          },
          destroy,
        }),
        {
          prepareNodeRuntime: async (_record, signal) => {
            operationSignal = signal;
            if (phase === "pending") {
              entered.resolve();
              await grantReleased.promise;
            }
            return runtime;
          },
          closeNodeRuntime,
          prepareNodeEnrollment,
        },
      );
      const creation = service
        .create(
          "development",
          `runtime-stop-${phase}`,
          undefined,
          "worker-turn",
          undefined,
          controller.signal,
        )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      controller.abort(new DOMException("Stop runtime preparation", "AbortError"));
      const teardown = service.destroy(support.testState.store.list()[0]!.environmentId);
      try {
        await setImmediate();
        expect(operationSignal?.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(closeNodeRuntime).toHaveBeenCalledTimes(phase === "prepared" ? 1 : 0);
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        grantReleased.resolve();
        childExited.resolve();
        await creation;
        await teardown;
      }
      expect(await creation).toMatchObject({ name: "AbortError" });
      expect(closeNodeRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
      expect(prepareNodeEnrollment).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["cancelled", "late-success", "profile-error"] as const)(
    "retains allocation cleanup after cancellation with a %s provider result",
    async (result) => {
      const started = createDeferredCore();
      const childClosed = createDeferredCore();
      const events: string[] = [];
      let providerSignal: AbortSignal | undefined;
      const controller = new AbortController();
      const reason = new Error("cloud worker stopped");
      const provider = support.createProvider({
        provision: async (_profile, _operationId, options) => {
          providerSignal = options?.signal;
          providerSignal?.addEventListener("abort", () => events.push("abort"), { once: true });
          events.push("provision");
          started.resolve();
          await childClosed.promise;
          events.push("child-closed");
          if (result === "profile-error") {
            throw new WorkerProviderError("late provider rejection");
          }
          if (result === "cancelled") {
            providerSignal?.throwIfAborted();
          }
          return { leaseId: "lease-cancelled", sharedHost: false, ssh: support.SSH_ENDPOINT };
        },
        resolveAllocation: async () => {
          events.push("resolve");
          return { leaseId: "lease-cancelled", sharedHost: false };
        },
        destroy: async ({ leaseId }) => {
          expect(leaseId).toBe("lease-cancelled");
          events.push("destroy");
        },
      });
      const service = support.createService(provider);
      const creation = service
        .create(
          "development",
          "cancelled-provision",
          undefined,
          undefined,
          undefined,
          controller.signal,
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await started.promise;
      const record = support.testState.store.list()[0]!;
      let teardown: ReturnType<typeof service.destroy> | undefined;
      try {
        controller.abort(reason);
        teardown = service.destroy(record.environmentId);
        await setImmediate();
        expect(providerSignal?.aborted).toBe(true);
        expect(support.testState.store.get(record.environmentId)).toMatchObject({
          state: "provisioning",
          destroyRequestedAtMs: support.testState.nowMs,
        });
        expect(events).toEqual(["provision", "abort"]);
        expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      } finally {
        childClosed.resolve();
        await creation;
        await teardown;
      }
      expect(await creation).toMatchObject({ ok: false });
      expect(events.indexOf("destroy")).toBeGreaterThan(events.indexOf("child-closed"));
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(support.testState.store.get(record.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-cancelled",
      });
    },
  );

  it("does not allocate after Stop interrupts preparation before provider entry", async () => {
    const preparing = createDeferredCore();
    const prepared = createDeferredCore();
    const controller = new AbortController();
    support.testState.prepareInstallation = vi.fn(async () => {
      preparing.resolve();
      await prepared.promise;
      return support.BUNDLE_ARTIFACT;
    });
    const provision = vi.fn(async () => ({
      leaseId: "lease-unexpected",
      sharedHost: false,
      ssh: support.SSH_ENDPOINT,
    }));
    const service = support.createService(support.createProvider({ provision }));
    const creation = service
      .create(
        "development",
        "cancelled-preparation",
        undefined,
        undefined,
        undefined,
        controller.signal,
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await preparing.promise;
    controller.abort(new Error("cloud worker stopped"));
    prepared.resolve();
    const outcome = await creation;
    const record = support.testState.store.list()[0]!;
    await service.destroy(record.environmentId);
    expect(outcome).toMatchObject({ ok: false });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });
  it("retains cancellation after the caller timeout until the real provider exits", async () => {
    const entered = createDeferredCore();
    const exited = createDeferredCore();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provision: async (_profile, _operation, options) => {
        signal = options?.signal;
        entered.resolve();
        await exited.promise;
        signal?.throwIfAborted();
        return { leaseId: "lease-1", sharedHost: false, ssh: support.SSH_ENDPOINT };
      },
      destroy,
    });
    const service = support.createService(provider, { providerCallTimeoutMs: 20 });
    const creation = service
      .create("development", "timeout-cancel", undefined, undefined, undefined, controller.signal)
      .catch((error: unknown) => error);
    await entered.promise;
    await creation;
    const record = support.testState.store.list()[0]!;
    controller.abort(new Error("Stop after provider timeout"));
    const teardown = service.destroy(record.environmentId);
    try {
      await setImmediate();
      expect(signal?.aborted).toBe(true);
      expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toBe(
        support.testState.nowMs,
      );
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      exited.resolve();
      await teardown;
    }
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.get(record.environmentId)?.state).toBe("destroyed");
  });

  it("closes only the cancelled enrollment while preserving provider cleanup", async () => {
    const waiting = createDeferredCore();
    const controller = new AbortController();
    const enrollmentController = new AbortController();
    const enrollmentClosed = new Error("enrollment closed");
    const enrollment = {
      mode: "connect" as const,
      setupCode: "setup-code",
      setupId: "setup-id",
      openclawVersion: "2026.8.1",
      nodeBootstrap: support.NODE_BOOTSTRAP,
      displayName: "fixture",
      signal: enrollmentController.signal,
      waitForDeviceId: async () => {
        waiting.resolve();
        return await new Promise<string>((_resolve, reject) => {
          enrollmentController.signal.addEventListener("abort", () => reject(enrollmentClosed), {
            once: true,
          });
        });
      },
    };
    const destroy = vi.fn(async () => {});
    const closeNodeEnrollment = vi.fn(() => enrollmentController.abort(enrollmentClosed));
    const service = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        requiresNodeEnrollment: true,
        provisionBeforeInstallation: true,
        provision: async (_profile, _operation, options) => {
          const prepared = await options!.beginNodeEnrollment!();
          await prepared.waitForDeviceId();
          throw new Error("cancelled enrollment unexpectedly completed");
        },
        destroy,
      }),
      { prepareNodeEnrollment: async () => enrollment, closeNodeEnrollment },
    );
    const creation = service
      .create(
        "development",
        "enrollment-cancel",
        undefined,
        "worker-turn",
        undefined,
        controller.signal,
      )
      .catch((error: unknown) => error);
    await waiting.promise;
    controller.abort(new Error("Stop enrollment"));
    await creation;
    await service.destroy(support.testState.store.list()[0]!.environmentId);
    expect(closeNodeEnrollment).toHaveBeenCalledExactlyOnceWith(enrollment);
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });
});
