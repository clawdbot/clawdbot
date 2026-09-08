import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireStateDatabaseHandleLease } from "../infra/state-database-coordinator.js";
import { publicationFixture } from "../infra/update-checkpoint-publication.test-support.js";
import {
  prepareUpdateCheckpointRestore,
  sealUpdateCheckpointRestoreSharedDatabase,
  restoreUpdateCheckpointResource,
  inspectUpdateCheckpointRestoreResource,
  reopenUpdateCheckpointRestorePlan,
} from "../infra/update-checkpoint-restore.js";
import { captureUpdateCheckpoint } from "../infra/update-checkpoint.js";
import {
  prepareUpdateRecoveryCarryForward,
  loadUpdateRecovery,
  recordUpdateRecoveryRestoreProgress,
} from "../infra/update-run-recovery.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

function capture(lease: OpenClawStateLeaseContext) {
  if (!lease.withDatabaseFileExclusion) {
    throw new Error("owner has no file capture capability");
  }
  return lease.withDatabaseFileExclusion;
}

function options(env: NodeJS.ProcessEnv, key: string) {
  return {
    scope: "core:test-nested-file-capture",
    key,
    database: { scope: "shared" as const, options: { env } },
    leaseMs: 10_000,
    waitMs: 0,
    heartbeat: "worker" as const,
  };
}

describe("nested lease-backed capture", () => {
  it("captures through the real plugin and agent-maintenance owners", async () => {
    await withOpenClawTestState({ label: "nested-plugin-maintenance-capture" }, async (state) => {
      const sourcePath = openOpenClawStateDatabase({ env: state.env }).path;
      await withPluginLifecycleLease({ env: state.env }, async (plugin) => {
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async (maintenance) => {
          await capture(maintenance)(async (assertCurrent) => {
            plugin.assertOwned();
            maintenance.assertOwned();
            const checkpoint = await captureUpdateCheckpoint({
              artifactRoot: path.join(state.stateDir, "checkpoints"),
              binding: {
                runId: "nested-owner-capture",
                stateDir: state.stateDir,
                configPath: path.join(state.stateDir, "openclaw.json"),
                fromRuntime: {
                  root: state.stateDir,
                  version: "2026.9.1",
                  nodePath: process.execPath,
                },
              },
              resources: [{ sourcePath, kind: "sqlite", restore: "replace" }],
              exclusions: [],
              assertQuiescent: assertCurrent,
            });
            expect(checkpoint).toBeDefined();
            plugin.assertOwned();
          });
          maintenance.assertOwned();
          plugin.assertOwned();
        });
        plugin.assertOwned();
      });
    });
  });

  it("joins both existing heartbeat workers before entering capture", async () => {
    await withOpenClawTestState({ label: "nested-worker-capture" }, async (state) => {
      let entered = false;
      await withOpenClawStateLease(options(state.env, "outer"), async (outer) => {
        await withOpenClawStateLease(options(state.env, "inner"), async (inner) => {
          await capture(inner)(async (assertCurrent) => {
            entered = true;
            assertCurrent();
            outer.assertOwned();
            inner.assertOwned();
          });
          inner.assertOwned();
          outer.assertOwned();
        });
        outer.assertOwned();
      });
      expect(entered).toBe(true);
    });
  });

  it("bounds all participants by the shortest original durable expiry", async () => {
    await withOpenClawTestState({ label: "nested-capture-expiry" }, async (state) => {
      let entered = false;
      await expect(
        withOpenClawStateLease(
          { ...options(state.env, "outer"), heartbeat: undefined, leaseMs: 1_000 },
          async (outer) => {
            await withOpenClawStateLease(options(state.env, "inner"), async (inner) => {
              await capture(inner)(async (assertCurrent) => {
                entered = true;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
                expect(() => assertCurrent()).toThrow(/expired/);
                expect(outer.signal.aborted).toBe(true);
                expect(inner.signal.aborted).toBe(true);
                assertCurrent();
              });
            });
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(entered).toBe(true);
    });
  });

  it("preserves an ancestor abort through shared capture drainage", async () => {
    await withOpenClawTestState({ label: "nested-capture-abort" }, async (state) => {
      const controller = new AbortController();
      await expect(
        withOpenClawStateLease(
          { ...options(state.env, "outer"), signal: controller.signal },
          async () => {
            await withOpenClawStateLease(options(state.env, "inner"), async (inner) => {
              await capture(inner)(async (assertCurrent) => {
                controller.abort(new Error("cancel nested capture"));
                assertCurrent();
              });
            });
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    });
  });

  it("does not borrow an independent same-database owner's live worker", async () => {
    await withOpenClawTestState({ label: "nested-capture-foreign" }, async (state) => {
      const ready = createDeferredCore();
      const release = createDeferredCore();
      const foreign = withOpenClawStateLease(options(state.env, "foreign"), async (lease) => {
        ready.resolve();
        await release.promise;
        lease.assertOwned();
      });
      let entered = false;
      try {
        await ready.promise;
        await expect(
          withOpenClawStateLease(options(state.env, "outer"), async () => {
            await withOpenClawStateLease(options(state.env, "inner"), async (inner) => {
              await capture(inner)(async () => {
                entered = true;
              });
            });
          }),
        ).rejects.toThrow(/state-handles/);
        expect(entered).toBe(false);
      } finally {
        release.resolve();
        await foreign;
      }
    });
  });

  it("does not pause or exclude an ancestor bound to a different database", async () => {
    await withOpenClawTestState({ label: "nested-capture-different-database" }, async (state) => {
      const otherEnv = { ...state.env, OPENCLAW_STATE_DIR: path.join(state.root, "other-state") };
      await withOpenClawStateLease(options(state.env, "outer"), async (outer) => {
        await withOpenClawStateLease(options(otherEnv, "inner"), async (inner) => {
          await capture(inner)(async (assertCurrent) => {
            assertCurrent();
            outer.assertOwned();
            inner.assertOwned();
          });
        });
        outer.assertOwned();
      });
    });
  });

  it("drains shared capture before an ancestor returns without awaiting its child", async () => {
    await withOpenClawTestState({ label: "nested-capture-parent-drain" }, async (state) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let child: Promise<void> | undefined;
      let parentFinished = false;
      let captured = false;
      const parent = withOpenClawStateLease(options(state.env, "outer"), async () => {
        child = withOpenClawStateLease(options(state.env, "inner"), async (inner) => {
          await capture(inner)(async (assertCurrent) => {
            entered.resolve();
            await finish.promise;
            assertCurrent();
            captured = true;
          });
        });
        await Promise.race([entered.promise, child]);
      }).then(() => {
        parentFinished = true;
      });
      try {
        await Promise.race([entered.promise, parent]);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(parentFinished).toBe(false);
      } finally {
        finish.resolve();
        await parent;
        await child;
      }
      expect(captured).toBe(true);
      expect(parentFinished).toBe(true);
    });
  });
});

const roots: string[] = [];
const workerListeners: Array<(worker: Worker) => void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const listener of workerListeners.splice(0)) {
    process.removeListener("worker", listener);
  }
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function preparePublication(
  f: Awaited<ReturnType<typeof publicationFixture>>,
  assertCurrent: () => void,
) {
  const prepared = await prepareUpdateCheckpointRestore({
    ...f.access,
    checkpointRef: f.checkpointRef,
    afterUpdateRef: f.afterUpdateRef,
    assertQuiescent: assertCurrent,
    prepareSharedDatabase({ sourceDb, stagedDb, planIdentity }) {
      const carried = prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: f.record,
        nextProgress: {
          ...planIdentity,
          planSha256: null,
          resourceCursor: 0,
          phase: "preparing",
        },
        fence: { assertCurrent },
        validateStagedDatabase(db) {
          assertOpenClawStateDatabaseForMaintenance(db, { pathname: f.sharedPath });
        },
      });
      f.record = carried.record;
      return carried;
    },
  });
  if (prepared.status !== "ready") {
    throw new Error("preservation unavailable");
  }
  f.record = await sealUpdateCheckpointRestoreSharedDatabase({
    ...f.access,
    planRef: prepared.planRef,
    assertQuiescent: assertCurrent,
    recoveryRecord: f.record,
    fence: { assertCurrent },
    validateStagedDatabase(db) {
      assertOpenClawStateDatabaseForMaintenance(db, { pathname: f.sharedPath });
    },
  });
  const publication = { ...f.access, planRef: prepared.planRef, recoveryRecord: f.record };
  return publication;
}

it("publishes and rebinds still-live nested worker owners to the exact restored canonical record", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lease-publication-")));
  roots.push(root);
  const f = await publicationFixture(root);
  let displaced = "";
  let displacedBytes: Buffer | undefined;
  await withPluginLifecycleLease({ env: f.options.env }, async (plugin) => {
    await withAgentDatabaseMaintenanceLease({ env: f.options.env }, async (maintenance) => {
      const publish = maintenance.withDatabaseFilePublication;
      if (!publish) {
        throw new Error("missing distinct live-lease publication mode");
      }
      await publish(async (assertCurrent, bindPublishedRecord) => {
        let publication = await preparePublication(f, assertCurrent);
        const request = { ...publication, resourceCursor: 0, assertQuiescent: assertCurrent };
        expect(await restoreUpdateCheckpointResource(request)).toMatchObject({ status: "applied" });
        expect(await inspectUpdateCheckpointRestoreResource(request)).toMatchObject({
          observed: "after",
        });
        const plan = await reopenUpdateCheckpointRestorePlan(publication.planRef, f.access);
        displaced = path.join(plan.plan.resources[0]!.stageDirectory, "displaced");
        displacedBytes = await fs.readFile(displaced);
        publication = await bindPublishedRecord(publication, (assertOwned) =>
          recordUpdateRecoveryRestoreProgress(
            f.record,
            { ...f.record.restore!, phase: "observed" },
            { assertCurrent: assertOwned },
            f.options,
          ),
        );
        f.record = publication.recoveryRecord;
        expect(f.record.restore?.phase).toBe("observed");
        plugin.assertOwned();
        maintenance.assertOwned();
        return { result: publication.planRef, publication };
      });
      // Both independent workers must now be current on the new generation.
      maintenance.assertOwned();
      plugin.assertOwned();
      maintenance.renew?.();
      plugin.renew?.();
      expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
      expect(await fs.readFile(displaced)).toEqual(displacedBytes);
    });
    plugin.assertOwned();
  });
  expect(await fs.readFile(displaced)).toEqual(displacedBytes);
});

// Failed or ambiguous publication must not resume renewal, run normal release,
// or create a missing canonical DB during lease unwind.
it.each([
  "not-published",
  "lost-return",
  "absent-canonical",
  "replaced-claim",
  "wrong-record",
  "changed-generation",
  "rebaselined-expiry",
  "startup-repair",
  "async-record-write",
  "second-resume-failure",
] as const)("does not rebind or clean up an unverified publication: %s", async (failure) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "lease-publication-refuse-")),
  );
  roots.push(root);
  const f = await publicationFixture(
    root,
    false,
    failure === "startup-repair" ? "2026.1.1" : undefined,
  );
  let frozen: Buffer | undefined;
  let leaseRows: unknown;

  let displaced = "";
  let displacedBytes: Buffer | undefined;
  await expect(
    withPluginLifecycleLease({ env: f.options.env }, async (plugin) => {
      await withAgentDatabaseMaintenanceLease({ env: f.options.env }, async (maintenance) => {
        const publish = maintenance.withDatabaseFilePublication;
        if (!publish) {
          throw new Error("no publication owner");
        }
        await publish(async (assertCurrent, bindPublishedRecord) => {
          if (failure === "rebaselined-expiry") {
            const db = new DatabaseSync(f.sharedPath);
            try {
              db.exec("UPDATE state_leases SET expires_at = expires_at + 60000");
            } finally {
              db.close();
            }
          }

          const publication = await preparePublication(f, assertCurrent);
          const request = { ...publication, resourceCursor: 0, assertQuiescent: assertCurrent };
          const plan = await reopenUpdateCheckpointRestorePlan(publication.planRef, f.access);
          displaced = path.join(plan.plan.resources[0]!.stageDirectory, "displaced");
          if (failure === "absent-canonical") {
            const rename = fsSync.renameSync;
            const fault = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
              rename(from, to);
              if (from === f.sharedPath) {
                throw new Error("interrupted publication");
              }
            });
            try {
              await expect(restoreUpdateCheckpointResource(request)).rejects.toThrow(
                "interrupted publication",
              );
            } finally {
              fault.mockRestore();
            }
            displacedBytes = await fs.readFile(displaced);
            throw new Error("interrupted publication");
          }
          if (failure !== "not-published") {
            expect(await restoreUpdateCheckpointResource(request)).toMatchObject({
              status: "applied",
            });
            displacedBytes = await fs.readFile(displaced);
          }
          if (failure === "replaced-claim" || failure === "changed-generation") {
            const db = new DatabaseSync(f.sharedPath);
            try {
              if (failure === "replaced-claim") {
                db.exec("UPDATE state_leases SET owner = 'foreign-owner'");
              } else {
                db.exec("INSERT INTO config_machine_state VALUES('operator.race','newer work',1)");
              }
            } finally {
              db.close();
            }
          }
          frozen = await fs.readFile(f.sharedPath);
          if (failure === "async-record-write") {
            // Exercise untyped/JS callers without a misleading void assignment.
            await Reflect.apply(bindPublishedRecord, undefined, [
              publication,
              async () => {
                await Promise.resolve();
                return f.record;
              },
            ]);
            throw new Error("async canonical write was accepted");
          }
          if (failure === "second-resume-failure") {
            const db = new DatabaseSync(f.sharedPath, { readOnly: true });
            try {
              leaseRows = db
                .prepare("SELECT scope,lease_key,owner FROM state_leases ORDER BY scope,lease_key")
                .all();
            } finally {
              db.close();
            }
            // The plugin's timer heartbeat resumes first; the maintenance
            // owner's real worker is the second participant to resume.
            const onWorker = (worker: Worker) => {
              process.removeListener("worker", onWorker);
              void worker.terminate();
            };
            workerListeners.push(onWorker);
            process.on("worker", onWorker);
          }
          if (failure === "lost-return") {
            throw new Error("publication return lost");
          }
          if (failure === "wrong-record") {
            publication.recoveryRecord = { ...f.record, revision: f.record.revision + 1 };
          }
          plugin.assertOwned();
          maintenance.assertOwned();
          return { result: undefined, publication };
        });
      });
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  if (failure === "absent-canonical") {
    await expect(fs.stat(f.sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
  } else if (failure === "second-resume-failure") {
    const db = new DatabaseSync(f.sharedPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT scope,lease_key,owner FROM state_leases ORDER BY scope,lease_key").all(),
      ).toEqual(leaseRows);
    } finally {
      db.close();
    }
  } else {
    expect(await fs.readFile(f.sharedPath)).toEqual(frozen);
  }
  if (displacedBytes) {
    expect(await fs.readFile(displaced)).toEqual(displacedBytes);
  }
});

it("expires the live publication window without renewal or cleanup", async () => {
  await withOpenClawTestState({ label: "live-publication-expiry" }, async (state) => {
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    let frozen: Buffer | undefined;
    let entered = false;
    await expect(
      withOpenClawStateLease(
        { ...options(state.env, "outer"), heartbeat: undefined, leaseMs: 1_000 },
        async () =>
          withOpenClawStateLease(options(state.env, "inner"), async (inner) => {
            const publish = inner.withDatabaseFilePublication;
            if (!publish) {
              throw new Error("publication capability is missing");
            }
            await publish(async (assertCurrent) => {
              entered = true;
              assertCurrent();
              frozen = fsSync.readFileSync(databasePath);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
              expect(() => assertCurrent()).toThrow(/expired/);
              assertCurrent();
              throw new Error("expired publication unexpectedly continued");
            });
          }),
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    expect(entered).toBe(true);
    expect(await fs.readFile(databasePath)).toEqual(frozen);
  });
});

it("drains an unawaited canonical write before releasing publication custody on failure", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "publication-drain-")));
  roots.push(root);
  const f = await publicationFixture(root);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let escaped: Promise<unknown> | undefined;
  let finished = false;
  const task = withPluginLifecycleLease({ env: f.options.env }, async () =>
    withAgentDatabaseMaintenanceLease({ env: f.options.env }, async (maintenance) => {
      const publish = maintenance.withDatabaseFilePublication;
      if (!publish) {
        throw new Error("publication capability is missing");
      }
      await publish(async (assertCurrent, bindPublishedRecord) => {
        const publication = await preparePublication(f, assertCurrent);
        expect(
          await restoreUpdateCheckpointResource({
            ...publication,
            resourceCursor: 0,
            assertQuiescent: assertCurrent,
          }),
        ).toMatchObject({ status: "applied" });
        escaped = Promise.resolve(
          Reflect.apply(bindPublishedRecord, undefined, [
            publication,
            async () => {
              entered.resolve();
              await release.promise;
              return f.record;
            },
          ]),
        );
        void escaped.catch(() => undefined);
        await entered.promise;
        throw new Error("publication callback failed with an admitted write pending");
      });
    }),
  );
  void task.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    await Promise.race([entered.promise, task]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(finished).toBe(false);
    expect(() => {
      const foreign = acquireStateDatabaseHandleLease({
        databasePath: f.sharedPath,
        busyTimeoutMs: 0,
      });
      foreign.release();
    }).toThrow();
  } finally {
    release.resolve();
    await escaped?.catch(() => undefined);
    await expect(task).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  }
});

it.each([false, true])(
  "joins inner timer owner when retained outer context publishes (interrupted=%s)",
  async (interrupted) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outer-publication-")));
    roots.push(root);
    const f = await publicationFixture(root);
    let displaced: string | undefined;
    let displacedBytes: Buffer | undefined;
    const task = withOpenClawStateLease(
      { ...options(f.options.env, "outer"), leaseMs: 60_000 },
      async (outer) => {
        await withOpenClawStateLease(
          { ...options(f.options.env, "inner"), heartbeat: undefined, leaseMs: 60_000 },
          async (inner) => {
            const publish = outer.withDatabaseFilePublication;
            if (!publish) {
              throw new Error("publication capability is missing");
            }
            await publish(async (assertCurrent) => {
              const publication = await preparePublication(f, assertCurrent);
              const plan = await reopenUpdateCheckpointRestorePlan(publication.planRef, f.access);
              displaced = path.join(plan.plan.resources[0]!.stageDirectory, "displaced");
              const request = { ...publication, resourceCursor: 0, assertQuiescent: assertCurrent };
              if (interrupted) {
                const rename = fsSync.renameSync;
                const fault = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
                  rename(from, to);
                  if (from === f.sharedPath) {
                    throw new Error("publication interrupted after displacement");
                  }
                });
                try {
                  await expect(restoreUpdateCheckpointResource(request)).rejects.toThrow(
                    "publication interrupted after displacement",
                  );
                } finally {
                  fault.mockRestore();
                }
                displacedBytes = await fs.readFile(displaced);
                throw new Error("publication interrupted after displacement");
              }
              expect(await restoreUpdateCheckpointResource(request)).toMatchObject({
                status: "applied",
              });
              return { result: undefined, publication };
            });
            inner.assertOwned();
            outer.assertOwned();
          },
        );
        outer.assertOwned();
      },
    );
    if (interrupted) {
      await expect(task).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(displaced).toBeDefined();
      await expect(fs.stat(f.sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(displaced!)).toEqual(displacedBytes);
    } else {
      await task;
    }
  },
);
