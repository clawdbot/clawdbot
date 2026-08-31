import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { WorkerProviderError } from "../../plugins/capability-provider.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

describe("worker provisioning cancellation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["bootstrapping", "ready", "idle"] as const)(
    "cancels persisted SSH bootstrap from %s while retaining its child and lease cleanup",
    async (state) => {
      let record = support.seedBootstrapping(`worker-persisted-bootstrap-stop-${state}`);
      if (state !== "bootstrapping") {
        record = support.testState.store.transition({
          environmentId: record.environmentId,
          from: record.state,
          to: "ready",
          patch: support.readyPatch(record.environmentId, {
            ...support.BOOTSTRAP_RECEIPT,
            bundleHash: "b".repeat(64),
          }),
        });
        if (state === "idle") {
          record = support.testState.store.transition({
            environmentId: record.environmentId,
            from: record.state,
            to: "idle",
          });
        }
      }
      const entered = createDeferredCore();
      const childClosed = createDeferredCore();
      const controller = new AbortController();
      const events: string[] = [];
      let bootstrapSignal: AbortSignal | undefined;
      support.testState.bootstrapWorker = vi.fn(async ({ signal }) => {
        bootstrapSignal = signal;
        events.push("bootstrap");
        entered.resolve();
        await childClosed.promise;
        events.push("child-closed");
        signal?.throwIfAborted();
        return support.BOOTSTRAP_RECEIPT;
      });
      const destroy = vi.fn(async () => {
        events.push("destroy");
      });
      const service = support.createService(support.createProvider({ destroy }));
      const uninstall = service.installReconcileEnvironmentGuard(async (_environmentId, core) => {
        await core(controller.signal);
      });
      let settled = false;
      const recovery = service.reconcileEnvironment(record.environmentId).finally(() => {
        settled = true;
      });
      let teardown: ReturnType<typeof service.destroy> | undefined;
      try {
        await Promise.race([
          entered.promise,
          recovery.then(() => {
            throw new Error("Recovery ended before bootstrap");
          }),
        ]);
        if (state !== "bootstrapping") {
          expect(support.testState.store.get(record.environmentId)?.ownerEpoch).toBeGreaterThan(
            record.ownerEpoch,
          );
        }
        controller.abort(new DOMException("Stop persisted bootstrap", "AbortError"));
        teardown = service.destroy(record.environmentId);
        await support.waitForFast(() => expect(bootstrapSignal?.aborted).toBe(true));
        expect(settled).toBe(false);
        expect(destroy).not.toHaveBeenCalled();
        expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toEqual(
          expect.any(Number),
        );
      } finally {
        childClosed.resolve();
        await Promise.allSettled([recovery, teardown]);
        await uninstall();
      }
      expect(events).toEqual(["bootstrap", "child-closed", "destroy"]);
      expect(destroy).toHaveBeenCalledOnce();
      // Explicit Stop owns the first durable intent; bootstrap failure cannot replace it.
      expect(support.testState.store.get(record.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: record.leaseId,
        teardownTerminalState: "destroyed",
      });
    },
  );

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

  it.each(["bundle", "npm"] as const)(
    "releases a cancelled fresh %s preparation consumer while shutdown retains the producer",
    async (install) => {
      const preparing = createDeferredCore();
      const prepared = createDeferredCore();
      const controller = new AbortController();
      support.getDevelopmentProfile().install = install;
      support.testState.prepareInstallation = vi.fn(async () => {
        preparing.resolve();
        await prepared.promise;
        return install === "bundle" ? support.BUNDLE_ARTIFACT : support.NPM_ARTIFACT;
      });
      const provision = vi.fn(async () => ({
        leaseId: "lease-unexpected",
        sharedHost: false,
        ssh: support.SSH_ENDPOINT,
      }));
      const service = support.createService(support.createProvider({ provision }));
      let creationSettled = false;
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
        )
        .finally(() => {
          creationSettled = true;
        });
      await Promise.race([
        preparing.promise,
        creation.then(() => {
          throw new Error("Creation ended before installation preparation");
        }),
      ]);
      const record = support.testState.store.list()[0]!;
      controller.abort(new Error("cloud worker stopped"));
      const teardown = service.destroy(record.environmentId);
      let shutdown: Promise<void> | undefined;
      let shutdownSettled = false;
      try {
        await support.waitForFast(() => expect(creationSettled).toBe(true));
        await expect(teardown).resolves.toMatchObject({ state: "failed" });
        shutdown = service.stop().then(() => {
          shutdownSettled = true;
        });
        await setImmediate();
        expect(shutdownSettled).toBe(false);
        expect(provision).not.toHaveBeenCalled();
      } finally {
        prepared.resolve();
        await Promise.allSettled([creation, teardown, shutdown]);
      }
      expect(await creation).toMatchObject({ ok: false });
      expect(provision).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(shutdownSettled).toBe(true);
    },
  );

  it("cancels node preflight before provider allocation", async () => {
    const preparing = createDeferredCore();
    const prepared = createDeferredCore();
    const controller = new AbortController();
    const provision = vi.fn(async () => ({
      leaseId: "unexpected",
      node: { deviceId: "unexpected" },
    }));
    const service = support.createService(
      support.createProvider({
        requiresNodeEnrollment: true,
        provisionBeforeInstallation: true,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      {
        prepareNodeBootstrap: async (_record, signal?: AbortSignal) => {
          preparing.resolve();
          await racePromiseWithAbortSignal(prepared.promise, signal);
        },
      },
    );
    let settled = false;
    const creation = service
      .create(
        "development",
        "node-preflight-stop",
        undefined,
        "worker-turn",
        undefined,
        controller.signal,
      )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await Promise.race([
      preparing.promise,
      creation.then(() => {
        throw new Error("Creation ended before node preflight");
      }),
    ]);
    const record = support.testState.store.list()[0]!;
    controller.abort(new DOMException("Stop node preflight", "AbortError"));
    const teardown = service.destroy(record.environmentId);
    try {
      await support.waitForFast(() => expect(settled).toBe(true));
      await expect(teardown).resolves.toMatchObject({ state: "failed" });
      expect(provision).not.toHaveBeenCalled();
    } finally {
      prepared.resolve();
      await Promise.allSettled([creation, teardown]);
    }
    expect(await creation).toMatchObject({ name: "AbortError" });
    expect(provision).not.toHaveBeenCalled();
  });

  it.each(["bundle", "npm"] as const)(
    "cleans an adopted replay lease while cancelled %s preparation is still running",
    async (install) => {
      const preparing = createDeferredCore();
      const prepared = createDeferredCore();
      const controller = new AbortController();
      support.getDevelopmentProfile().install = install;
      let replay = false;
      support.testState.prepareInstallation = vi.fn(async () => {
        if (replay) {
          preparing.resolve();
          await prepared.promise;
        }
        return install === "bundle" ? support.BUNDLE_ARTIFACT : support.NPM_ARTIFACT;
      });
      const events: string[] = [];
      const destroy = vi.fn(async () => {
        events.push("destroy");
      });
      const service = support.createService(
        support.createProvider({
          provision: async () => {
            events.push("provision");
            if (!replay) {
              throw new Error("reply lost after allocation");
            }
            return { leaseId: "lease-replayed", sharedHost: false, ssh: support.SSH_ENDPOINT };
          },
          destroy,
        }),
      );
      await expect(service.create("development", "replay-preparation-stop")).rejects.toMatchObject({
        code: "provider_failure",
      });
      replay = true;
      let settled = false;
      const creation = service
        .create(
          "development",
          "replay-preparation-stop",
          undefined,
          undefined,
          undefined,
          controller.signal,
        )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await Promise.race([
        preparing.promise,
        creation.then(() => {
          throw new Error("Replay ended before installation preparation");
        }),
      ]);
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "bootstrapping",
        leaseId: "lease-replayed",
      });
      controller.abort(new DOMException("Stop replay packaging", "AbortError"));
      let shutdown: Promise<void> | undefined;
      let shutdownSettled = false;
      try {
        await support.waitForFast(() => expect(settled).toBe(true));
        expect(destroy).toHaveBeenCalledExactlyOnceWith({
          leaseId: "lease-replayed",
          profile: { region: "test" },
        });
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "destroyed",
          leaseId: "lease-replayed",
          teardownTerminalState: "destroyed",
        });
        shutdown = service.stop().then(() => {
          shutdownSettled = true;
        });
        await setImmediate();
        expect(shutdownSettled).toBe(false);
      } finally {
        prepared.resolve();
        await Promise.allSettled([creation, shutdown]);
      }
      expect(events).toEqual(["provision", "provision", "destroy"]);
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    },
  );
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

  it("cancels the allocated node installer and joins it before destroying the lease", async () => {
    const entered = createDeferredCore();
    const installerClosed = createDeferredCore();
    const controller = new AbortController();
    let installerSignal: AbortSignal | undefined;
    const events: string[] = [];
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const service = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provision: async () => ({
          leaseId: "lease-node-install",
          node: { deviceId: "device-install" },
          sharedHost: false,
        }),
        destroy,
      }),
      {
        ensureNodeWorkerBundle: async ({ signal }) => {
          installerSignal = signal;
          entered.resolve();
          await installerClosed.promise;
          events.push("installer-closed");
          signal?.throwIfAborted();
          return support.BOOTSTRAP_RECEIPT;
        },
      },
    );
    let settled = false;
    const creation = service
      .create(
        "development",
        "node-install-stop",
        undefined,
        "worker-turn",
        undefined,
        controller.signal,
      )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await Promise.race([
      entered.promise,
      creation.then(() => {
        throw new Error("Creation ended before node installer");
      }),
    ]);
    controller.abort(new DOMException("Stop node installation", "AbortError"));
    try {
      expect(installerSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      installerClosed.resolve();
      await creation;
    }
    expect(events).toEqual(["installer-closed", "destroy"]);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "destroyed",
      leaseId: "lease-node-install",
      teardownTerminalState: "destroyed",
    });
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
