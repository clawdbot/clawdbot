import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  acquireStateDatabaseHandleLease,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "./openclaw-agent-db.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  isOpenClawStateDatabaseOpen,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
function source(holdAgent = false) {
  const root = dirs.make("state-lease-before-migration-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const pathname = openOpenClawStateDatabase({ env }).path;
  const agent = holdAgent ? openOpenClawAgentDatabase({ agentId: "worker", env }) : undefined;
  closeOpenClawStateDatabaseForTest();
  const db = openNodeSqliteDatabase(pathname);
  try {
    db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS skill_workshop_proposal_events;
      DROP TABLE IF EXISTS skill_workshop_proposal_rollbacks;
      DROP TABLE IF EXISTS skill_workshop_collection_reviews;
      DROP TABLE IF EXISTS skill_workshop_proposals;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  } finally {
    db.close();
  }
  const options = { env, schemaPolicy: "existing" as const };
  const lease = {
    scope: "core:test-premigration",
    key: "global",
    database: { scope: "shared" as const, options: { env }, schemaPolicy: "existing" as const },
    leaseMs: 30_000,
    waitMs: 0,
  };
  return { root, pathname, options, lease, agent };
}
function inspect(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      schema: db
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
      metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
      leases: db.prepare("SELECT * FROM state_leases").all(),
    };
  } finally {
    db.close();
  }
}
it("acquires, verifies, renews and releases an actual lease without migrating", async () => {
  const f = source();
  const before = inspect(f.pathname);
  let entered: ReturnType<typeof inspect> | undefined;
  await withOpenClawStateLease(f.lease, async (lease) => {
    lease.assertOwned();
    lease.renew?.();
    entered = inspect(f.pathname);
  });
  expect(entered?.version).toEqual(before.version);
  expect(entered?.schema).toEqual(before.schema);
  expect(entered?.leases).toHaveLength(1);
  expect(inspect(f.pathname)).toEqual(before);
});
it("takes plugin and agent writer ownership before allowing the candidate migration", async () => {
  const f = source();
  let atEntry: ReturnType<typeof inspect> | undefined;
  await withPluginLifecycleLease(f.options, () =>
    withAgentDatabaseMaintenanceLease(f.options, async (maintenance) => {
      maintenance.assertOwned();
      atEntry = inspect(f.pathname);
    }),
  );
  expect(atEntry?.version).toEqual({ user_version: 15 });
  expect(atEntry?.leases).toHaveLength(2);
  expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).leases).toEqual([]);
});
it("refuses a competing owner and preserves a replacement lease on cleanup", async () => {
  const f = source();
  const outside = new AsyncResource("premigration-competing-owner");
  let competingEntered = false;
  try {
    await expect(
      withOpenClawStateLease(f.lease, async (held) => {
        await expect(
          outside.runInAsyncScope(() =>
            withOpenClawStateLease(f.lease, async () => {
              competingEntered = true;
            }),
          ),
        ).rejects.toThrow(/timed out/);
        const db = openNodeSqliteDatabase(f.pathname);
        try {
          db.prepare("UPDATE state_leases SET owner='replacement' WHERE scope=?").run(
            f.lease.scope,
          );
        } finally {
          db.close();
        }
        held.assertOwned();
      }),
    ).rejects.toThrow(/lost/);
  } finally {
    outside.emitDestroy();
  }
  expect(competingEntered).toBe(false);
  expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).leases).toEqual([expect.objectContaining({ owner: "replacement" })]);
});
it("retains the actual heartbeat through physical capture and resumes without migration", async () => {
  const f = source();
  const before = inspect(f.pathname);
  let captured = false;
  await withOpenClawStateLease({ ...f.lease, heartbeat: "worker" }, async (lease) => {
    await lease.withDatabaseFileExclusion?.(async (assertCurrent) => {
      assertCurrent();
      captured = true;
    });
    lease.assertOwned();
  });
  expect(captured).toBe(true);
  expect(inspect(f.pathname)).toEqual(before);
});
it("does not create missing existing-only lease state", async () => {
  const root = dirs.make("state-lease-missing-");
  const pathname = path.join(root, "missing.sqlite");
  await expect(
    withOpenClawStateLease(
      {
        scope: "test",
        key: "missing",
        leaseMs: 30_000,
        waitMs: 0,
        database: { scope: "shared", options: { path: pathname }, schemaPolicy: "existing" },
      },
      async () => {},
    ),
  ).rejects.toThrow();
  expect(fs.existsSync(pathname)).toBe(false);
});
it("keeps the maintenance lease live across an explicitly owned migration", async () => {
  const f = source();
  const ready = createDeferred();
  const release = createDeferred();
  let beforeMigration: ReturnType<typeof inspect>["version"] | undefined;
  const run = withOpenClawStateLease(f.lease, async (lease) => {
    beforeMigration = inspect(f.pathname).version;
    ready.resolve();
    await release.promise;
    lease.assertOwned();
    openOpenClawStateDatabase(f.options);
    lease.assertOwned();
  });
  try {
    await withTestTimeout(ready.promise, 10_000, "lease admission did not complete");
  } finally {
    release.resolve();
  }
  await run;
  expect(beforeMigration).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).version).toEqual({ user_version: 16 });
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("drains an existing agent handle without migrating while its lease is released", async () => {
  const f = source(true);
  let atEntry: ReturnType<typeof inspect> | undefined;
  await withAgentDatabaseMaintenanceLease(f.options, async (lease) => {
    lease.assertOwned();
    atEntry = inspect(f.pathname);
  });
  expect(f.agent?.db.isOpen).toBe(false);
  expect(atEntry?.version).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
});

it("drains cached agent handles from another profile using their own lease database", async () => {
  const target = source(true);
  const otherRoot = dirs.make("state-lease-other-profile-");
  const otherEnv = { HOME: otherRoot, OPENCLAW_STATE_DIR: otherRoot };
  const otherState = openOpenClawStateDatabase({ env: otherEnv }).path;
  const otherAgent = openOpenClawAgentDatabase({ agentId: "other", env: otherEnv });
  const otherBefore = inspect(otherState);
  let entered = false;
  await withAgentDatabaseMaintenanceLease(target.options, async (lease) => {
    lease.assertOwned();
    entered = true;
    expect(target.agent?.db.isOpen).toBe(false);
    expect(otherAgent.db.isOpen).toBe(false);
  });
  expect(entered).toBe(true);
  expect(inspect(target.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(otherState)).toEqual(otherBefore);
  const otherDb = openNodeSqliteDatabase(otherState, { readOnly: true });
  try {
    expect(otherDb.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
  } finally {
    otherDb.close();
  }
});

it("does not recreate state displaced before the existing-schema heartbeat opens", async () => {
  const f = source();
  const displaced = `${f.pathname}.displaced`;
  let moved = false;
  let entered = false;
  const onWorker = () => {
    const held = acquireStateDatabaseCoordinator({ databasePath: f.pathname, busyTimeoutMs: 0 });
    try {
      fs.renameSync(f.pathname, displaced);
      moved = true;
    } finally {
      held.release();
    }
  };
  process.once("worker", onWorker);
  try {
    await expect(
      withOpenClawStateLease({ ...f.lease, heartbeat: "worker" }, async () => {
        entered = true;
      }),
    ).rejects.toThrow();
  } finally {
    process.removeListener("worker", onWorker);
  }
  expect(moved).toBe(true);
  expect(entered).toBe(false);
  expect(fs.existsSync(displaced)).toBe(true);
  expect(fs.existsSync(f.pathname)).toBe(false);
});

it("reenters the same real maintenance owner without acquiring or migrating state", async () => {
  const f = source();
  const before = inspect(f.pathname);
  let nested: ReturnType<typeof inspect> | undefined;
  let stale: OpenClawStateLeaseContext | undefined;
  await withAgentDatabaseMaintenanceLease(f.options, async (outer) => {
    await withAgentDatabaseMaintenanceLease(f.options, async (inner) => {
      inner.assertOwned();
      outer.assertOwned();
      stale = inner;
      nested = inspect(f.pathname);
    });
    expect(() => stale?.assertOwned()).toThrow(/closed/);
    outer.assertOwned();
  });
  expect(nested?.leases).toHaveLength(1);
  expect(nested?.version).toEqual(before.version);
  expect(inspect(f.pathname)).toEqual(before);
});

it("refuses nested maintenance redirection before creating another database", async () => {
  const f = source();
  const other = dirs.make("maintenance-other-root-");
  let entered = false;
  await withAgentDatabaseMaintenanceLease(f.options, async (outer) => {
    await expect(
      withAgentDatabaseMaintenanceLease(
        { env: { HOME: other, OPENCLAW_STATE_DIR: other } },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toThrow(/switch/);
    outer.assertOwned();
  });
  expect(entered).toBe(false);
  expect(fs.readdirSync(other)).toEqual([]);
});

it("joins nested maintenance work before releasing the actual durable lease", async () => {
  const f = source();
  const entered = createDeferred();
  const release = createDeferred();
  const outside = new AsyncResource("outside-maintenance-root");
  let settled = false;
  let outer: OpenClawStateLeaseContext | undefined;
  const run = withAgentDatabaseMaintenanceLease(f.options, async (owner) => {
    outer = owner;
    void withAgentDatabaseMaintenanceLease(f.options, async (inner) => {
      entered.resolve();
      await release.promise;
      inner.assertOwned();
      inner.renew?.();
      await inner.withDatabaseFileExclusion?.(async (assertCurrent) => {
        assertCurrent();
        inner.assertOwned();
      });
    });
  }).finally(() => {
    settled = true;
  });
  void run.catch(() => undefined);
  try {
    await withTestTimeout(entered.promise, 10_000, "nested maintenance did not enter");
    expect(settled).toBe(false);
    // The outer callback has returned. Already-admitted children may finish,
    // but the escaped outer capability cannot admit another effect.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    let lateEntered = false;
    let lateFailure: unknown;
    try {
      await outer?.withDatabaseFileExclusion?.(async () => {
        lateEntered = true;
      });
    } catch (error) {
      lateFailure = error;
    }
    expect(lateEntered).toBe(false);
    expect(lateFailure).toBeInstanceOf(Error);
    expect(String(lateFailure)).toContain("closed");
    await expect(
      outside.runInAsyncScope(() =>
        withOpenClawStateLease({ ...f.lease, ...AGENT_DATABASE_MAINTENANCE_LEASE }, async () => {
          throw new Error("competitor was admitted");
        }),
      ),
    ).rejects.toThrow(/timed out/);
  } finally {
    release.resolve();
    await run;
    outside.emitDestroy();
  }
  expect(settled).toBe(true);
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("reports a failed detached maintenance child before releasing its real owner", async () => {
  const f = source();
  const failure = new Error("detached migration failed");
  await expect(
    withAgentDatabaseMaintenanceLease(f.options, async () => {
      void withAgentDatabaseMaintenanceLease(f.options, async () => {
        await Promise.resolve();
        throw failure;
      });
    }),
  ).rejects.toBe(failure);
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("mutates under the real nested file owner before read-only capture and durable binding", async () => {
  const f = source();
  const outside = new AsyncResource("foreign-canonical-writer");
  const steps: string[] = [];
  const write = (key: string) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES (?,?,?)",
      ).run(key, '"owned"', 1);
    }, f.options);
  try {
    await withPluginLifecycleLease(f.options, (plugin) =>
      withAgentDatabaseMaintenanceLease(f.options, async (maintenance) => {
        const mutation = maintenance.withDatabaseFileMutation;
        if (!mutation) {
          throw new Error("Missing live mutation owner");
        }
        const result = await mutation({
          assertCurrent: () => maintenance.assertOwned(),
          async mutate(assertCurrent) {
            assertCurrent();
            steps.push("mutation");
            runOpenClawStateWriteTransaction(({ db }) => {
              plugin.assertOwnedInTransaction(db);
              maintenance.assertOwnedInTransaction(db);
              db.prepare(
                "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES (?,?,?)",
              ).run("candidate.mutation", '"owned"', 1);
            }, f.options);
            expect(() => outside.runInAsyncScope(() => write("foreign.mutation"))).toThrow(
              /state-handles/,
            );
            return "candidate-output";
          },
          async capture(value, assertCurrent) {
            assertCurrent();
            steps.push("capture");
            expect(value).toBe("candidate-output");
            expect(isOpenClawStateDatabaseOpen(f.pathname)).toBe(false);
            expect(
              withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
                ({ db }) => db.prepare("PRAGMA user_version").get(),
                { path: f.pathname },
              ),
            ).toEqual({ user_version: 16 });
            expect(() => write("capture.write")).toThrow(/state-handles/);
            return "sealed-output";
          },
          bind(value, assertCurrent) {
            assertCurrent();
            steps.push("bind");
            expect(value).toBe("sealed-output");
            write("candidate.binding");
            return undefined;
          },
        });
        expect(result).toBe("sealed-output");
        maintenance.assertOwned();
        plugin.assertOwned();
      }),
    );
  } finally {
    outside.emitDestroy();
  }
  expect(steps).toEqual(["mutation", "capture", "bind"]);
  const db = openNodeSqliteDatabase(f.pathname, { readOnly: true });
  try {
    expect(
      db
        .prepare(
          "SELECT state_key FROM config_machine_state WHERE state_key LIKE 'candidate.%' ORDER BY state_key",
        )
        .all(),
    ).toEqual([{ state_key: "candidate.binding" }, { state_key: "candidate.mutation" }]);
  } finally {
    db.close();
  }
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("revokes inherited canonical writes after the mutation callback closes", async () => {
  const f = source();
  let late: (() => void) | undefined;
  const write = () => runOpenClawStateWriteTransaction(() => {}, f.options);
  await withOpenClawStateLease(f.lease, async (lease) => {
    const mutation = lease.withDatabaseFileMutation;
    if (!mutation) {
      throw new Error("Missing live mutation owner");
    }
    await mutation({
      assertCurrent: () => lease.assertOwned(),
      async mutate() {
        late = AsyncResource.bind(write);
        write();
      },
      async capture() {
        expect(() => late?.()).toThrow(/scope is (closed|no longer current)/);
      },
      bind() {
        return undefined;
      },
    });
  });
  expect(() => late?.()).toThrow(/scope is (closed|no longer current)/);
});

it("refuses the next canonical write when live mutation authority is revoked", async () => {
  const f = source();
  const before = inspect(f.pathname);
  const revoked = new Error("candidate executor revoked");
  let current = true;
  let captured = false;
  await expect(
    withOpenClawStateLease(f.lease, async (lease) => {
      const mutation = lease.withDatabaseFileMutation;
      if (!mutation) {
        throw new Error("Missing live mutation owner");
      }
      await mutation({
        assertCurrent() {
          if (!current) {
            throw revoked;
          }
        },
        async mutate() {
          await Promise.resolve();
          current = false;
          runOpenClawStateWriteTransaction(() => {}, f.options);
        },
        async capture() {
          captured = true;
        },
        bind() {
          throw new Error("revoked binding entered");
        },
      });
    }),
  ).rejects.toThrow(/candidate executor revoked/);
  expect(captured).toBe(false);
  expect(inspect(f.pathname)).toEqual(before);
});

it("does not acknowledge mutation while an uncached participating handle remains open", async () => {
  const f = source();
  let leaked: ReturnType<typeof openTrackedStateDatabase> | undefined;
  let captured = false;
  try {
    await expect(
      withOpenClawStateLease(f.lease, async (lease) => {
        const mutation = lease.withDatabaseFileMutation;
        if (!mutation) {
          throw new Error("Missing live mutation owner");
        }
        await mutation({
          assertCurrent: () => lease.assertOwned(),
          async mutate() {
            leaked = openTrackedStateDatabase(f.pathname, { existingOnly: true });
          },
          async capture() {
            captured = true;
          },
          bind() {
            return undefined;
          },
        });
      }),
    ).rejects.toThrow();
    expect(captured).toBe(false);
    expect(leaked?.isOpen).toBe(true);
    expect(() =>
      acquireStateDatabaseHandleLease({ databasePath: f.pathname, busyTimeoutMs: 0 }),
    ).toThrow(/state-handles/);
  } finally {
    if (leaked) {
      closeTrackedStateDatabase(leaked);
    }
  }
  const admitted = acquireStateDatabaseHandleLease({ databasePath: f.pathname, busyTimeoutMs: 0 });
  admitted.release();
});

it.each(["capture", "mutation"])(
  "does not clean up leases in a replaced %s source",
  async (mode) => {
    const f = source();
    let replacement: ReturnType<typeof family> | undefined;
    const family = () =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => {
        const file = f.pathname + suffix;
        return {
          suffix,
          sha256: fs.existsSync(file)
            ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
            : null,
        };
      });
    const replace = async () => {
      const next = f.pathname + ".replacement";
      fs.copyFileSync(f.pathname, next);
      fs.renameSync(next, f.pathname);
      replacement = family();
    };
    await expect(
      withOpenClawStateLease(f.lease, async (lease) => {
        if (mode === "capture") {
          if (!lease.withDatabaseFileExclusion) {
            throw new Error("Missing capture owner");
          }
          await lease.withDatabaseFileExclusion(replace);
        } else {
          if (!lease.withDatabaseFileMutation) {
            throw new Error("Missing mutation owner");
          }
          await lease.withDatabaseFileMutation({
            assertCurrent: () => lease.assertOwned(),
            mutate: replace,
            async capture() {
              throw new Error("Replaced source reached capture");
            },
            bind() {
              return undefined;
            },
          });
        }
      }),
    ).rejects.toThrow();
    expect(replacement).toBeDefined();
    expect(family()).toEqual(replacement);
  },
);
