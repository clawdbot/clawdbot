import type { EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  leaseHeartbeatState as state,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseHeartbeat } from "./openclaw-state-lease-heartbeat.js";

const { workers } = vi.hoisted(() => ({
  workers: [] as (EventEmitter & { shared: BigInt64Array })[],
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      shared: BigInt64Array;
      stdout = { resume() {} };
      stderr = { resume() {} };

      constructor(_url: URL, options: { workerData: LeaseHeartbeatWorkerData }) {
        super();
        this.shared = new BigInt64Array(options.workerData.shared);
        workers.push(this);
      }

      async terminate() {
        return 0;
      }
    },
  };
});

beforeEach(() => {
  workers.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("state lease heartbeat startup diagnostics", () => {
  it.each([
    { status: "starting", trigger: "timeout", remainingMs: 60_000, elapsedMs: 5_000 },
    { status: "lost", trigger: "timeout", remainingMs: 60_000, elapsedMs: 5_000 },
    { status: "lost", trigger: "message", remainingMs: 60_000, elapsedMs: 25 },
    { status: "starting", trigger: "timeout", remainingMs: 750, elapsedMs: 750 },
  ] as const)(
    "reports $status at $trigger after $elapsedMs ms (remaining lease $remainingMs ms)",
    async ({ status, trigger, remainingMs, elapsedMs }) => {
      const onLost = vi.fn();
      const heartbeat = startOpenClawStateLeaseHeartbeat({
        path: "/synthetic-private-state/lease.sqlite",
        identity: {
          scope: "synthetic-private-scope",
          key: "synthetic-private-key",
          owner: "synthetic-owner-token",
        },
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        expiresAt: Date.now() + remainingMs,
        onLost,
      });
      const outcome = heartbeat.ready.catch((error: unknown) => error);
      const worker = workers[0];
      try {
        assert(worker, "Expected the heartbeat worker to be constructed");
        Atomics.store(worker.shared, state.status, state[status]);
        await vi.advanceTimersByTimeAsync(elapsedMs - 1);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        if (trigger === "message") {
          worker.emit("message", null);
        }
        const error = await outcome;
        expect(error).toEqual(
          new Error(
            `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${elapsedMs}, timeoutMs=${Math.min(5_000, remainingMs)})`,
          ),
        );
        expect(onLost).toHaveBeenCalledExactlyOnceWith(error);
        expect(Atomics.load(worker.shared, state.status)).toBe(state.lost);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await heartbeat.stop();
      }
    },
  );
});
