import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as support from "./service.test-support.js";

describe("worker provider teardown deadlines", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.for(["destroy", "bootstrap-failure"] as const)(
    "allows provider-owned checkpointing beyond five minutes during %s",
    async (entrance, { signal }) => {
      const started = createDeferred();
      const finish = createDeferred();
      const destroy = vi.fn(async () => {
        started.resolve();
        // A test timeout does not unwind finally; release provider ownership on cancellation.
        await racePromiseWithAbortSignal(finish.promise, signal);
      });
      const resolveDestroyTimeoutMs = vi.fn(() => 10 * 60_000);
      if (entrance === "destroy") {
        support.seedReady("slow-destroy");
      } else {
        support.testState.bootstrapWorker = vi.fn(async () => {
          throw new Error("bootstrap failed before admission");
        });
      }
      const service = support.createService(
        support.createProvider({ destroy, resolveDestroyTimeoutMs }),
      );
      vi.useFakeTimers();
      let settled = false;
      const operation = (
        entrance === "destroy"
          ? service.destroy("slow-destroy")
          : service.create("development", "failed-bootstrap-slow-destroy")
      ).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await support.waitForFast(() => started.promise);
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        expect(settled).toBe(false);
        finish.resolve();
        const result = await operation;
        expect(resolveDestroyTimeoutMs).toHaveBeenCalledExactlyOnceWith({ region: "test" });
        if (entrance === "destroy") {
          expect(result).toMatchObject({ state: "destroyed" });
        } else {
          expect(result).toMatchObject({
            code: "bootstrap_failure",
            message: "Worker bootstrap failed: bootstrap failed before admission",
          });
          expect(support.testState.store.list()[0]).toMatchObject({
            state: "failed",
            leaseId: null,
          });
        }
      } finally {
        finish.resolve();
        vi.useRealTimers();
        await operation;
      }
    },
  );

  it.each(["destroy", "bootstrap-failure"] as const)(
    "honors the service override without evaluating the provider deadline during %s",
    async (entrance) => {
      const resolveDestroyTimeoutMs = vi.fn(() => {
        throw new Error("must not evaluate overridden deadline");
      });
      const destroy = vi.fn(async () => {});
      if (entrance === "destroy") {
        support.seedReady("override-destroy");
      } else {
        support.testState.bootstrapWorker = vi.fn(async () => {
          throw new Error("bootstrap failed");
        });
      }
      const service = support.createService(
        support.createProvider({ destroy, resolveDestroyTimeoutMs }),
        { providerCallTimeoutMs: 1_000 },
      );
      if (entrance === "destroy") {
        await expect(service.destroy("override-destroy")).resolves.toMatchObject({
          state: "destroyed",
        });
      } else {
        await expect(
          service.create("development", "override-bootstrap-cleanup"),
        ).rejects.toMatchObject({ code: "bootstrap_failure" });
        expect(support.testState.store.list()[0]?.state).toBe("failed");
      }
      expect(resolveDestroyTimeoutMs).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, MAX_TIMER_TIMEOUT_MS + 1])(
    "retains teardown intent without invoking the provider for invalid deadline %s",
    async (timeoutMs) => {
      support.seedReady("invalid-destroy-timeout");
      const destroy = vi.fn(async () => {});
      const service = support.createService(
        support.createProvider({ destroy, resolveDestroyTimeoutMs: () => timeoutMs }),
      );

      await expect(service.destroy("invalid-destroy-timeout")).rejects.toMatchObject({
        code: "provider_failure",
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get("invalid-destroy-timeout")).toMatchObject({
        state: "destroying",
        leaseId: "lease:invalid-destroy-timeout",
        destroyRequestedAtMs: support.testState.nowMs,
        lastError: expect.stringContaining("Worker provider destroy timeout must be an integer"),
      });
    },
  );

  it("keeps timed-out teardown queued and rejects a stale owner before retry side effects", async ({
    signal,
  }) => {
    const initial = support.seedReady("timed-out-destroy");
    const started = createDeferred();
    const finish = createDeferred();
    const resolveDestroyTimeoutMs = vi.fn(() => 20);
    const destroy = vi.fn(async () => {
      started.resolve();
      await racePromiseWithAbortSignal(finish.promise, signal);
    });
    const service = support.createService(
      support.createProvider({ destroy, resolveDestroyTimeoutMs }),
    );
    vi.useFakeTimers();
    const first = service.destroy(initial.environmentId).catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await support.waitForFast(() => started.promise);
      await vi.advanceTimersByTimeAsync(21);
      expect(await first).toMatchObject({ code: "provider_failure" });
      expect(support.testState.store.get(initial.environmentId)?.lastError).toBe(
        "Worker provider operation timed out after 20ms",
      );

      await expect(service.requestDestroy(initial.environmentId)).rejects.toMatchObject({
        code: "invalid_state",
        message: expect.stringContaining("Worker provider operation timed out after 20ms"),
      });
      expect(resolveDestroyTimeoutMs).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();

      second = service.destroy(initial.environmentId).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveDestroyTimeoutMs).toHaveBeenCalledTimes(2);
      expect(destroy).toHaveBeenCalledOnce();
      support.testState.store.transition({
        environmentId: initial.environmentId,
        from: "destroying",
        to: "destroyed",
      });
      finish.resolve();
      expect(await second).toMatchObject({
        code: "invalid_state",
        message: "Worker environment owner changed during teardown",
      });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await first;
      await second;
    }
  });
});
