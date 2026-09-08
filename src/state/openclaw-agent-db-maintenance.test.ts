import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertNoOpenClawAgentDatabaseLeases,
  runWithAgentDatabaseMaintenanceAuthority,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  migrateOpenClawAgentDatabaseForMaintenance,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(roots);
});

function fixture() {
  const root = makeTempDir(roots, "agent-maintenance-");
  const env = { OPENCLAW_STATE_DIR: root };
  const database = openOpenClawAgentDatabase({ agentId: "worker", env });
  const options = { agentId: "worker", pathname: database.path };
  database.db.exec(`
    INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
      VALUES ('maintenance','retained','{"retained":true}',100,1);
  `);
  closeOpenClawAgentDatabasesForTest();
  const state = openOpenClawStateDatabase({ env });
  return { env, options, state };
}

function readIndexState(pathname: string) {
  const database = sqlite.openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      index: database
        .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
        .get(),
      integrity: database.prepare("PRAGMA integrity_check;").all(),
      retained: database.prepare("SELECT value_json FROM cache_entries").all(),
    };
  } finally {
    database.close();
  }
}

function installIndexDrift(pathname: string, corrupt: boolean) {
  const database = sqlite.openNodeSqliteDatabase(pathname);
  try {
    database.exec(`
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    if (corrupt) {
      // The claimed definition disagrees with the real b-tree, exercising the
      // Worker's genuine integrity-error path before maintenance resumes.
      database.enableDefensive?.(false);
      database.exec("PRAGMA writable_schema=ON;");
      database
        .prepare("UPDATE sqlite_schema SET sql=? WHERE name='idx_agent_cache_expiry'")
        .run(
          "CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL",
        );
      database.exec("PRAGMA writable_schema=OFF;");
      database.exec(
        `PRAGMA schema_version=${readSqliteNumberPragma(database, "schema_version") + 1};`,
      );
    }
  } finally {
    database.close();
  }
}

function withAbortableMaintenance<T>(
  f: ReturnType<typeof fixture>,
  signal: AbortSignal,
  run: (maintenance: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  // Exercise the existing lease owner's abort signal without adding a production
  // cancellation option or replacing the closure-bound maintenance context.
  return withOpenClawStateLease(
    {
      ...AGENT_DATABASE_MAINTENANCE_LEASE,
      database: { scope: "shared", options: { env: f.env } },
      leaseMs: 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      signal,
    },
    (maintenance) => {
      assertNoOpenClawAgentDatabaseLeases(maintenance, { env: f.env });
      return runWithAgentDatabaseMaintenanceAuthority(maintenance, () => run(maintenance));
    },
  );
}

describe("asynchronous agent database maintenance admission", () => {
  it("yields during real integrity admission while retaining the maintenance fence", async () => {
    const f = fixture();
    const before = readIndexState(f.options.pathname);
    await withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
      let progressed = false;
      const tick = setImmediate(() => {
        progressed = true;
      });
      try {
        await migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance);
        expect(progressed).toBe(true);
        maintenance.assertOwned();
        expect(() => openOpenClawAgentDatabase({ agentId: "worker", env: f.env })).toThrow(
          /maintenance is in progress/,
        );
      } finally {
        clearImmediate(tick);
      }
    });
    expect(readIndexState(f.options.pathname)).toEqual(before);
  });

  it.each(
    [false, true].flatMap((corrupt) =>
      (["expiry", "replacement", "abort"] as const).map((loss) => ({ corrupt, loss })),
    ),
  )("fences Worker resume after $loss (integrity failure=$corrupt)", async ({ corrupt, loss }) => {
    const f = fixture();
    installIndexDrift(f.options.pathname, corrupt);
    const before = readIndexState(f.options.pathname);
    const abort = new AbortController();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const spy = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async (...args) => {
        let failed = false;
        let failure: unknown;
        try {
          await check(...args);
        } catch (error) {
          failed = true;
          failure = error;
        }
        expect(failed).toBe(corrupt);
        if (loss === "abort") {
          abort.abort(new Error("synthetic maintenance abort"));
        } else {
          f.state.db
            .prepare(
              `UPDATE state_leases SET ${loss === "expiry" ? "expires_at=0" : "owner='successor'"}
                WHERE scope=? AND lease_key=?`,
            )
            .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        }
        if (failed) {
          throw failure;
        }
      });
    try {
      await expect(
        withAbortableMaintenance(f, abort.signal, (maintenance) =>
          migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
        ),
      ).rejects.toThrow(/lost|abort/i);
      expect(spy).toHaveBeenCalledOnce();
      expect(readIndexState(f.options.pathname)).toEqual(before);
      if (loss === "replacement") {
        expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toEqual([
          { owner: "successor" },
        ]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it.each(
    [false, true].flatMap((corrupt) =>
      (["owner", "version"] as const).map((changed) => ({ corrupt, changed })),
    ),
  )(
    "refuses changed database $changed before Worker resume repairs indexes (integrity failure=$corrupt)",
    async ({ corrupt, changed }) => {
      const f = fixture();
      installIndexDrift(f.options.pathname, corrupt);
      const before = readIndexState(f.options.pathname);
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      const spy = vi
        .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
        .mockImplementationOnce(async (...args) => {
          let failed = false;
          let failure: unknown;
          try {
            await check(...args);
          } catch (error) {
            failed = true;
            failure = error;
          }
          expect(failed).toBe(corrupt);
          // Change the same file after the real scan, before its result is consumed.
          const database = sqlite.openNodeSqliteDatabase(f.options.pathname);
          try {
            if (changed === "owner") {
              database
                .prepare("UPDATE schema_meta SET agent_id=? WHERE meta_key='primary'")
                .run("other-agent");
            } else {
              database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
            }
          } finally {
            database.close();
          }
          if (failed) {
            throw failure;
          }
        });
      try {
        await expect(
          withAgentDatabaseMaintenanceLease({ env: f.env }, (maintenance) =>
            migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
          ),
        ).rejects.toThrow(changed === "owner" ? /belongs to agent other-agent/ : /newer schema/);
        expect(spy).toHaveBeenCalledOnce();
        expect(readIndexState(f.options.pathname)).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("joins a cancelled real Worker before closing its database or releasing the fence", async () => {
    const f = fixture();
    const abort = new AbortController();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const open = sqlite.openNodeSqliteDatabase;
    let completed = false;
    let native: Promise<void> | undefined;
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
      const database = open(pathname, options);
      if (pathname === f.options.pathname && options?.readOnly !== true) {
        const close = database.close.bind(database);
        database.close = () => {
          try {
            expect(completed).toBe(true);
          } finally {
            close();
          }
        };
      }
      return database;
    });
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
      native = check(...args).finally(() => {
        completed = true;
      });
      abort.abort(new Error("synthetic maintenance abort"));
      expect(completed).toBe(false);
      expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toHaveLength(1);
      return native;
    });
    try {
      await expect(
        withAbortableMaintenance(f, abort.signal, (maintenance) =>
          migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
        ),
      ).rejects.toThrow(/abort/i);
      expect(completed).toBe(true);
      expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toEqual([]);
    } finally {
      await native?.catch(() => {});
    }
  });

  it("rejects a retained closed maintenance context before opening or scanning", async () => {
    const f = fixture();
    let retained: OpenClawStateLeaseContext | undefined;
    await withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
      retained = maintenance;
    });
    expect(retained).toBeDefined();
    const open = vi.spyOn(sqlite, "openNodeSqliteDatabase");
    const scan = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    await expect(migrateOpenClawAgentDatabaseForMaintenance(f.options, retained!)).rejects.toThrow(
      /stopped-writer maintenance/,
    );
    expect(open).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(["outside", "copied"] as const)(
    "requires the exact active maintenance scope when its context is %s",
    async (scope) => {
      const f = fixture();
      const ready = createDeferred<OpenClawStateLeaseContext>();
      const release = createDeferred();
      const scan = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      const running = withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
        if (scope === "copied") {
          await expect(
            migrateOpenClawAgentDatabaseForMaintenance(f.options, { ...maintenance }),
          ).rejects.toThrow(/stopped-writer maintenance/);
          return;
        }
        ready.resolve(maintenance);
        await release.promise;
      });
      try {
        if (scope === "outside") {
          const maintenance = await ready.promise;
          maintenance.assertOwned();
          await expect(
            migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
          ).rejects.toThrow(/stopped-writer maintenance/);
        }
      } finally {
        release.resolve();
        await running;
      }
      expect(scan).not.toHaveBeenCalled();
    },
  );
});
