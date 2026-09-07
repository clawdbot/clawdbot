import { once } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acquireOpenClawStateDatabaseFileExclusion,
  closeOpenClawStateDatabaseByPath,
} from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

function block(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function options(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return {
    scope: "core:test-maintenance",
    key: "maintenance",
    database: { scope: "shared" as const, options: { env } },
    leaseMs: 1_000,
    waitMs: 0,
    heartbeat: "worker" as const,
    signal,
  };
}

function readLease(env: NodeJS.ProcessEnv) {
  return openOpenClawStateDatabase({ env })
    .db.prepare(
      "SELECT owner, expires_at, heartbeat_at FROM state_leases WHERE scope = ? AND lease_key = ?",
    )
    .get("core:test-maintenance", "maintenance");
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("maintenance lease heartbeat", () => {
  it("does not open after its original lease deadline while parent callbacks are blocked", async () => {
    await withOpenClawTestState({ label: "maintenance-child-open-expired" }, async (state) => {
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      const onWorker = () => {
        const held = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
        try {
          block(1_200);
        } finally {
          held.release();
        }
      };
      process.once("worker", onWorker);
      let entered = false;
      try {
        await expect(
          withOpenClawStateLease(options(state.env), async () => {
            entered = true;
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(entered).toBe(false);
        expect(readLease(state.env)).toBeUndefined();
      } finally {
        process.removeListener("worker", onWorker);
      }
    });
  });

  it("retries transient lifecycle contention before opening the real heartbeat", async () => {
    await withOpenClawTestState({ label: "maintenance-child-open-contention" }, async (state) => {
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      let held: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      const onWorker = () => {
        held = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
        releaseTimer = setTimeout(() => {
          held?.release();
          held = undefined;
        }, 800);
      };
      process.once("worker", onWorker);
      try {
        await withOpenClawStateLease({ ...options(state.env), leaseMs: 5_000 }, async (lease) => {
          expect(held).toBeUndefined();
          lease.assertOwned();
        });
      } finally {
        process.removeListener("worker", onWorker);
        clearTimeout(releaseTimer);
        held?.release();
      }
    });
  });

  it("keeps file replacement excluded until the real heartbeat child has settled", async () => {
    await withOpenClawTestState({ label: "maintenance-child-handle" }, async (state) => {
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
        closeOpenClawStateDatabaseByPath(databasePath);
        let exclusion: ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion> | undefined;
        try {
          expect(() => {
            exclusion = acquireOpenClawStateDatabaseFileExclusion(databasePath);
          }).toThrow(/state-handles/);
        } finally {
          exclusion?.release();
        }
        lease.assertOwned();
      });
      // withOpenClawStateLease joins the real worker, then releases its durable row.
      const exclusion = acquireOpenClawStateDatabaseFileExclusion(databasePath);
      exclusion.release();
    });
  });

  it("does not renew through lifecycle exclusion and resumes after its release", async () => {
    await withOpenClawTestState({ label: "maintenance-child-write" }, async (state) => {
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 3_000 }, async (lease) => {
        const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
        const before = readLease(state.env);
        const exclusion = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
        try {
          block(1_200);
          expect(readLease(state.env)).toEqual(before);
          // A fresh response is not renewal: persisted expiry must remain unchanged.
          lease.assertOwned();
        } finally {
          exclusion.release();
        }
        await expect
          .poll(() => Number(readLease(state.env)?.heartbeat_at))
          .toBeGreaterThan(Number(before?.heartbeat_at));
        lease.assertOwned();
      });
    });
  });

  it("retains ownership while synchronous maintenance exceeds the lease duration", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-blocked" }, async (state) => {
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
        block(10_250);
        expect(() => lease.renew?.()).not.toThrow();
        expect(() => lease.assertOwned()).not.toThrow();
        expect(lease.signal.aborted).toBe(false);
      });
    });
  });

  it("acknowledges ownership checks while the parent holds a state write transaction", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-transaction" }, async (state) => {
      // This control checks liveness during a transaction, not the one-second
      // expiry boundary. Allow a cold worker to start under parallel checking.
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            lease.assertOwnedInTransaction(db);
            block(450);
            lease.assertOwnedInTransaction(db);
          },
          { env: state.env },
        );
      });
    });
  });

  it("rejects a terminated worker before its queued exit event reaches the parent", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-worker-loss" }, async (state) => {
      const spawned = once(process, "worker") as Promise<[Worker]>;
      await expect(
        withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
          const [worker] = await spawned;
          void worker.terminate();
          block(100);
          const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
          closeOpenClawStateDatabaseByPath(databasePath);
          let exclusion: ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion> | undefined;
          try {
            expect(() => {
              exclusion = acquireOpenClawStateDatabaseFileExclusion(databasePath);
            }).toThrow(/state-handles/);
          } finally {
            exclusion?.release();
          }
          expect(Number(readLease(state.env)?.expires_at)).toBeGreaterThan(Date.now());
          expect(() => lease.assertOwned()).toThrowError(
            expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
          );
          // The database alone still grants the old lease: only fresh worker
          // liveness can reject this assertion before the queued exit callback.
          expect(Number(readLease(state.env)?.expires_at)).toBeGreaterThan(Date.now());
        }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(readLease(state.env)).toBeUndefined();
    });
  });

  it("does not enter maintenance when its heartbeat exits before readiness", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-startup-loss" }, async (state) => {
      const terminate = (worker: Worker) => {
        void worker.terminate();
      };
      process.once("worker", terminate);
      let entered = false;
      try {
        await expect(
          withOpenClawStateLease(options(state.env), async () => {
            entered = true;
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(entered).toBe(false);
        expect(readLease(state.env)).toBeUndefined();
      } finally {
        process.removeListener("worker", terminate);
      }
    });
  });

  it("accepts published readiness when the parent notification is withheld", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-delayed-ready" }, async (state) => {
      const spawned = new Promise<Worker>((resolve) => {
        process.once("worker", resolve);
      });
      const operation = withOpenClawStateLease(
        { ...options(state.env), leaseMs: 10_000 },
        async (lease) => {
          lease.assertOwned();
          return "maintained";
        },
      );
      const worker = await spawned;
      try {
        expect(worker.listenerCount("message")).toBe(1);
        // Withhold only the owner's notification; the real worker still renews
        // and publishes ready before our observer sees its startup message.
        worker.removeAllListeners("message");
        await Promise.race([once(worker, "message"), operation]);
        await expect(operation).resolves.toBe("maintained");
        expect(readLease(state.env)).toBeUndefined();
      } finally {
        await worker.terminate();
        await operation.catch(() => {});
      }
    });
  });

  it.each(["replacement", "expiry", "deletion"] as const)(
    "does not resurrect ownership after %s",
    async (failure) => {
      await withOpenClawTestState({ label: `maintenance-lease-${failure}` }, async (state) => {
        let changed: ReturnType<typeof readLease>;
        await expect(
          withOpenClawStateLease(options(state.env), async (lease) => {
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                if (failure === "deletion") {
                  db.prepare("DELETE FROM state_leases WHERE scope = ?").run(
                    "core:test-maintenance",
                  );
                } else {
                  db.prepare(
                    `UPDATE state_leases SET ${failure === "replacement" ? "owner = 'successor'" : "expires_at = 0"} WHERE scope = ?`,
                  ).run("core:test-maintenance");
                }
              },
              { env: state.env },
            );
            changed = readLease(state.env);
            block(450);
            expect(() => lease.assertOwned()).toThrowError(
              expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
            );
            expect(readLease(state.env)).toEqual(changed);
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(readLease(state.env)).toEqual(failure === "replacement" ? changed : undefined);
      });
    },
  );

  it.each(["return", "throw", "abort"] as const)(
    "stops renewal and retained callbacks when an operation ends by %s",
    async (ending) => {
      await withOpenClawTestState({ label: `maintenance-lease-${ending}` }, async (state) => {
        const controller = new AbortController();
        const spawned = once(process, "worker") as Promise<[Worker]>;
        let retained: OpenClawStateLeaseContext | undefined;
        const operation = withOpenClawStateLease(
          { ...options(state.env, controller.signal), leaseMs: 10_000 },
          async (lease) => {
            retained = lease;
            if (ending === "abort") {
              const [worker] = await spawned;
              controller.abort();
              await once(worker, "exit");
              const stopped = readLease(state.env);
              await new Promise((resolve) => {
                setTimeout(resolve, 450);
              });
              expect(readLease(state.env)).toEqual(stopped);
            } else if (ending === "throw") {
              throw new Error("operation failed");
            }
            return "completed";
          },
        );
        if (ending === "return") {
          await expect(operation).resolves.toBe("completed");
        } else {
          await expect(operation).rejects.toThrow(
            ending === "throw" ? "operation failed" : "was aborted",
          );
        }
        const [worker] = await spawned;
        expect(worker.threadId).toBe(-1);
        expect(readLease(state.env)).toBeUndefined();
        expect(retained).toBeDefined();
        expect(() => retained?.assertOwned()).toThrow();
        expect(() => retained?.renew?.()).toThrow();
      });
    },
  );
});
