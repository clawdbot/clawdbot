import { Worker } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  leaseHeartbeatState as state,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";

const WORKER_START_TIMEOUT_MS = 5_000;
const WORKER_RESPONSE_TIMEOUT_MS = 1_000;

export function startOpenClawStateLeaseHeartbeat(
  params: Omit<LeaseHeartbeatWorkerData, "shared"> & {
    expiresAt: number;
    onLost: (error: Error) => void;
  },
) {
  const startedAt = performance.now();
  const shared = new BigInt64Array(new SharedArrayBuffer(3 * BigInt64Array.BYTES_PER_ELEMENT));
  const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  const worker = new Worker(url, {
    workerData: {
      path: params.path,
      identity: {
        scope: params.identity.scope,
        key: params.identity.key,
        owner: params.identity.owner,
      },
      leaseMs: params.leaseMs,
      heartbeatMs: params.heartbeatMs,
      shared: shared.buffer,
    } satisfies LeaseHeartbeatWorkerData,
    env: {},
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
    stdout: true,
    stderr: true,
  });
  // Worker stdio uses parent message delivery, which maintenance can block.
  // The heartbeat emits no normal output; drain runtime bootstrap diagnostics.
  worker.stdout.resume();
  worker.stderr.resume();
  const ready = createDeferredCore();
  const fail = (error: Error) => {
    if (Atomics.load(shared, state.status) === state.closed) {
      return;
    }
    Atomics.store(shared, state.status, state.lost);
    Atomics.notify(shared, state.ack);
    clearTimeout(startTimer);
    ready.reject(error);
    params.onLost(error);
  };
  const settleStartup = (trigger: "timeout" | "message") => {
    clearTimeout(startTimer);
    // Readiness precedes notification delivery. A delayed parent must not
    // overwrite ready; callback entry still requires a fresh acknowledgement.
    const observedStatus = Atomics.compareExchange(
      shared,
      state.status,
      state.starting,
      state.lost,
    );
    if (observedStatus === state.ready) {
      ready.resolve();
    } else {
      // Report the status before our transition, not the lost state it writes.
      const status =
        observedStatus === state.starting
          ? "starting"
          : observedStatus === state.lost
            ? "lost"
            : "closed";
      fail(
        new Error(
          `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${Math.round(performance.now() - startedAt)}, timeoutMs=${startupTimeoutMs})`,
        ),
      );
    }
  };
  const startupTimeoutMs = Math.max(
    1,
    Math.min(WORKER_START_TIMEOUT_MS, params.expiresAt - Date.now()),
  );
  const startTimer = setTimeout(() => settleStartup("timeout"), startupTimeoutMs);
  worker.once("error", fail);
  worker.once("exit", () => fail(new Error("state lease heartbeat exited")));
  worker.once("message", () => settleStartup("message"));
  let stopping: Promise<number> | undefined;
  const close = () => {
    Atomics.store(shared, state.status, state.closed);
    Atomics.notify(shared, state.ack);
    clearTimeout(startTimer);
    ready.reject(new Error("state lease heartbeat closed"));
  };
  return {
    ready: ready.promise,
    close,
    stop() {
      close();
      return (stopping ??= worker.terminate());
    },
    assertResponsive(expiresAt: number) {
      const deadline =
        performance.now() + Math.min(WORKER_RESPONSE_TIMEOUT_MS, expiresAt - Date.now());
      const request = Atomics.add(shared, state.request, 1n) + 1n;
      worker.postMessage(null, []);
      // Exit/error callbacks may be queued behind a synchronous SQLite phase.
      // Require a fresh acknowledgement, never a cached ready/alive observation.
      while (Atomics.load(shared, state.status) === state.ready) {
        const ack = Atomics.load(shared, state.ack);
        if (ack === request && Atomics.load(shared, state.status) === state.ready) {
          return;
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          break;
        }
        Atomics.wait(shared, state.ack, ack, remainingMs);
      }
      const error = new Error("state lease heartbeat is not responsive");
      fail(error);
      throw error;
    },
  };
}
