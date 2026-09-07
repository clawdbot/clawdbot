import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureUpdateCheckpoint } from "../infra/update-checkpoint.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
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
