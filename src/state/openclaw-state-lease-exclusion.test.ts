import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "../infra/update-checkpoint.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

function requiredCapture(lease: OpenClawStateLeaseContext) {
  if (!lease.withDatabaseFileExclusion) {
    throw new Error("maintenance owner has no bounded file-exclusion capability");
  }
  return lease.withDatabaseFileExclusion;
}

function options(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return {
    scope: "core:test-file-exclusion",
    key: "capture",
    database: { scope: "shared" as const, options: { env } },
    leaseMs: 10_000,
    waitMs: 0,
    heartbeat: "worker" as const,
    signal,
  };
}

function rawLeaseEdit(pathname: string, sql: string) {
  // Model owner publication with a changed persisted lease. This is deliberately
  // raw; ordinary canonical writes remain refused inside file exclusion.
  const db = new DatabaseSync(pathname);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("lease-backed file capture", () => {
  it("joins the real maintenance heartbeat, captures, and revalidates before resuming", async () => {
    await withOpenClawTestState({ label: "lease-capture-real" }, async (state) => {
      const workers: Worker[] = [];
      const onWorker = (worker: Worker) => workers.push(worker);
      process.on("worker", onWorker);
      let retained: (() => void) | undefined;
      try {
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
          const pathname = openOpenClawStateDatabase({ env: state.env }).path;
          const first = workers.at(-1);
          expect(first?.threadId).toBeGreaterThan(0);
          const access = {
            artifactRoot: path.join(state.stateDir, "checkpoints"),
            binding: {
              runId: "lease-capture",
              stateDir: state.stateDir,
              configPath: path.join(state.stateDir, "openclaw.json"),
              fromRuntime: {
                root: state.stateDir,
                version: "2026.9.1",
                nodePath: process.execPath,
              },
            },
          };
          const ref = await requiredCapture(lease)(async (assertCurrent) => {
            retained = assertCurrent;
            expect(first?.threadId).toBe(-1);
            expect(() => openOpenClawStateDatabase({ env: state.env })).toThrow(/state-handles/);
            lease.assertOwned();
            lease.renew?.();
            return captureUpdateCheckpoint({
              ...access,
              assertQuiescent: assertCurrent,
              resources: [{ sourcePath: pathname, kind: "sqlite", restore: "replace" }],
              exclusions: [],
            });
          });
          expect(workers.at(-1)).not.toBe(first);
          expect(workers.at(-1)?.threadId).toBeGreaterThan(0);
          lease.assertOwned();
          const artifact = (await reopenUpdateCheckpoint(ref, access)).manifest.resources[0]
            ?.artifact;
          expect(artifact).toBeTruthy();
          expect(() => retained?.()).toThrow(/no longer current/);
          expect(openOpenClawStateDatabase({ env: state.env }).db.isOpen).toBe(true);
        });
        expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      } finally {
        process.removeListener("worker", onWorker);
      }
    });
  });

  it("refuses expired capture completion without reviving the heartbeat", async () => {
    await withOpenClawTestState({ label: "lease-capture-expiry" }, async (state) => {
      const workers: Worker[] = [];
      const onWorker = (worker: Worker) => workers.push(worker);
      process.on("worker", onWorker);
      try {
        await expect(
          withOpenClawStateLease({ ...options(state.env), leaseMs: 1_000 }, async (lease) => {
            await requiredCapture(lease)(async (assertCurrent) => {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
              assertCurrent();
            });
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
      } finally {
        process.removeListener("worker", onWorker);
      }
    });
  });

  it.each(["owner", "expiry"])(
    "refuses a changed persisted %s before resuming renewal",
    async (change) => {
      await withOpenClawTestState({ label: `lease-capture-${change}` }, async (state) => {
        const pathname = openOpenClawStateDatabase({ env: state.env }).path;
        let changedLease: unknown;
        await expect(
          withOpenClawStateLease(options(state.env), async (lease) => {
            await requiredCapture(lease)(async (assertCurrent) => {
              assertCurrent();
              rawLeaseEdit(
                pathname,
                change === "owner"
                  ? "UPDATE state_leases SET owner='replacement' WHERE scope='core:test-file-exclusion'"
                  : "UPDATE state_leases SET expires_at=expires_at+1000 WHERE scope='core:test-file-exclusion'",
              );
              const db = new DatabaseSync(pathname, { readOnly: true });
              try {
                changedLease = db
                  .prepare("SELECT * FROM state_leases WHERE scope='core:test-file-exclusion'")
                  .get();
              } finally {
                db.close();
              }
            });
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        const current = openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT * FROM state_leases WHERE scope='core:test-file-exclusion'")
          .get();
        expect(changedLease).toBeDefined();
        expect(current).toEqual(changedLease);
      });
    },
  );

  it("does not restart renewal after an aborted excluded operation", async () => {
    await withOpenClawTestState({ label: "lease-capture-abort" }, async (state) => {
      const controller = new AbortController();
      await expect(
        withOpenClawStateLease(options(state.env, controller.signal), async (lease) => {
          await requiredCapture(lease)(async (assertCurrent) => {
            controller.abort();
            assertCurrent();
          });
        }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      expect(openOpenClawStateDatabase({ env: state.env }).db.isOpen).toBe(true);
    });
  });

  it("drains admitted capture even when its caller returns without awaiting it", async () => {
    await withOpenClawTestState({ label: "lease-capture-drain" }, async (state) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let finished = false;
      const running = withOpenClawStateLease(options(state.env), async (lease) => {
        void requiredCapture(lease)(async (assertCurrent) => {
          entered.resolve();
          await finish.promise;
          assertCurrent();
        });
      }).then(() => {
        finished = true;
      });
      try {
        await entered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(finished).toBe(false);
      } finally {
        finish.resolve();
        await running;
      }
      expect(finished).toBe(true);
    });
  });

  it("drains a second capture admitted while the first capture settles", async () => {
    await withOpenClawTestState({ label: "lease-capture-chained-drain" }, async (state) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let outcome: "done" | "error" | undefined;
      const running = withOpenClawStateLease(options(state.env), async (lease) => {
        const capture = requiredCapture(lease);
        void capture(async (assertCurrent) => {
          assertCurrent();
        })
          .then(() =>
            capture(async (assertCurrent) => {
              entered.resolve();
              await finish.promise;
              assertCurrent();
            }),
          )
          .catch(() => undefined);
      }).then(
        () => {
          outcome = "done";
        },
        () => {
          outcome = "error";
        },
      );
      try {
        await Promise.race([entered.promise, running]);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
        expect(outcome).toBeUndefined();
      } finally {
        finish.resolve();
        await running;
      }
      expect(outcome).toBe("done");
    });
  });

  it("rejects identical lease bytes on a replacement source inode", async () => {
    await withOpenClawTestState({ label: "lease-capture-identity" }, async (state) => {
      const pathname = openOpenClawStateDatabase({ env: state.env }).path;
      await expect(
        withOpenClawStateLease(options(state.env), async (lease) => {
          await requiredCapture(lease)(async (assertCurrent) => {
            const before = await fs.stat(pathname);
            const replacement = path.join(state.stateDir, "replacement.sqlite");
            await fs.copyFile(pathname, replacement);
            await fs.rename(replacement, pathname);
            expect((await fs.stat(pathname)).ino).not.toBe(before.ino);
            assertCurrent();
          });
        }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    });
  });

  it.each(["assertOwned", "renew"] as const)(
    "refuses %s during heartbeat pause without invalidating the owner",
    async (method) => {
      await withOpenClawTestState({ label: `lease-capture-pause-${method}` }, async (state) => {
        await withOpenClawStateLease(options(state.env), async (lease) => {
          const capture = requiredCapture(lease)(async (assertCurrent) => {
            assertCurrent();
          });
          try {
            expect(() => lease[method]?.()).toThrow(/file exclusion is transitioning/);
            expect(lease.signal.aborted).toBe(false);
          } finally {
            await capture;
          }
          lease.assertOwned();
          lease.renew?.();
          expect(lease.signal.aborted).toBe(false);
        });
      });
    },
  );

  it("does not invalidate the owner when checked during heartbeat restart", async () => {
    await withOpenClawTestState({ label: "lease-capture-restart-check" }, async (state) => {
      let current: OpenClawStateLeaseContext | undefined;
      let workers = 0;
      let checked = false;
      let refusal: unknown;
      const onWorker = () => {
        if (++workers === 2) {
          setImmediate(() => {
            checked = true;
            try {
              current?.assertOwned();
            } catch (error) {
              refusal = error;
            }
          });
        }
      };
      process.on("worker", onWorker);
      try {
        await withOpenClawStateLease(options(state.env), async (lease) => {
          current = lease;
          await requiredCapture(lease)(async (assertCurrent) => {
            assertCurrent();
          });
          expect(checked).toBe(true);
          expect(refusal).toMatchObject({ message: "state lease heartbeat is restarting" });
          lease.assertOwned();
        });
      } finally {
        process.removeListener("worker", onWorker);
      }
    });
  });

  it.each([0, 1, 2, 3])(
    "closes capture admission at the last drain boundary (%s hops)",
    async (hops) => {
      await withOpenClawTestState({ label: `lease-capture-late-${hops}` }, async (state) => {
        const entered = createDeferredCore();
        const finish = createDeferredCore();
        let accepted = false;
        let refused = false;
        let completed = false;
        let outcome: "done" | "error" | undefined;
        let chained: Promise<void> | undefined;
        const running = withOpenClawStateLease(
          { ...options(state.env), heartbeat: undefined },
          async (lease) => {
            const capture = requiredCapture(lease);
            chained = capture(async (assertCurrent) => {
              assertCurrent();
            }).then(async () => {
              for (let i = 0; i < hops; i += 1) {
                await Promise.resolve();
              }
              let pending: Promise<void>;
              try {
                pending = capture(async (assertCurrent) => {
                  entered.resolve();
                  await finish.promise;
                  assertCurrent();
                  completed = true;
                });
                accepted = true;
              } catch {
                refused = true;
                return;
              }
              await pending;
            });
            void chained.catch(() => undefined);
          },
        ).then(
          () => {
            outcome = "done";
          },
          () => {
            outcome = "error";
          },
        );
        try {
          await Promise.race([entered.promise, running]);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          if (accepted) {
            expect(outcome).toBeUndefined();
          }
        } finally {
          finish.resolve();
          await running;
          await chained?.catch(() => undefined);
        }
        expect(outcome).toBe("done");
        expect(accepted ? completed : refused).toBe(true);
      });
    },
  );

  it("preserves the operation error after successful reopen and child settlement", async () => {
    await withOpenClawTestState({ label: "lease-capture-error" }, async (state) => {
      const primary = new Error("checkpoint disk write failed");
      await expect(
        withOpenClawStateLease(options(state.env), async (lease) => {
          await requiredCapture(lease)(async () => {
            throw primary;
          });
        }),
      ).rejects.toBe(primary);
      expect(openOpenClawStateDatabase({ env: state.env }).db.isOpen).toBe(true);
    });
  });
});
