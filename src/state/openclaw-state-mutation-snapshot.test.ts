import { AsyncResource } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeTrackedStateDatabase, openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

function options(env: NodeJS.ProcessEnv) {
  return {
    scope: "core:test-mutation-snapshot",
    key: "global",
    database: { scope: "shared" as const, options: { env } },
    leaseMs: 30_000,
    waitMs: 0,
  };
}
const snapshot = (pathname: string) =>
  prepareSqliteReadOnlyLocation(pathname, {
    preserveSourceArtifacts: true,
  });
async function rows(pathname: string) {
  const prepared = await snapshot(pathname);
  try {
    const db = new DatabaseSync(prepared.location, { readOnly: true });
    try {
      return db
        .prepare("SELECT state_key FROM config_machine_state WHERE state_key='candidate.snapshot'")
        .all();
    } finally {
      db.close();
    }
  } finally {
    expect(prepared.cleanup()).toBe(true);
  }
}

it("snapshots the drained source and committed WAL through its native mutation owner", async () => {
  await withOpenClawTestState({ label: "mutation-snapshot-owned" }, async (state) => {
    const pathname = openOpenClawStateDatabase({ env: state.env }).path;
    const outsider = new AsyncResource("foreign-snapshot-reader");
    try {
      await withOpenClawStateLease(options(state.env), async (lease) => {
        if (!lease.withDatabaseFileMutation) {
          throw new Error("Missing mutation owner");
        }
        await lease.withDatabaseFileMutation({
          assertCurrent: () => lease.assertOwned(),
          async mutate() {
            expect(await rows(pathname)).toEqual([]);
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                db.prepare(
                  "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES ('candidate.snapshot','true',1)",
                ).run();
              },
              { env: state.env },
            );
            const owner = openOpenClawStateDatabase({ env: state.env });
            expect(await rows(pathname)).toEqual([{ state_key: "candidate.snapshot" }]);
            expect(owner.db.isOpen).toBe(true);
            expect(openOpenClawStateDatabase({ env: state.env })).toBe(owner);
            await expect(outsider.runInAsyncScope(() => snapshot(pathname))).rejects.toThrow(
              /state-handles/,
            );
            lease.assertOwned();
          },
          async capture() {
            expect(await rows(pathname)).toEqual([{ state_key: "candidate.snapshot" }]);
          },
          bind() {
            return undefined;
          },
        });
      });
    } finally {
      outsider.emitDestroy();
    }
  });
});

it("refuses inspection inside a transaction without releasing its real SQLite writer lock", async () => {
  await withOpenClawTestState({ label: "mutation-snapshot-transaction" }, async (state) => {
    const pathname = openOpenClawStateDatabase({ env: state.env }).path;
    await withOpenClawStateLease(options(state.env), async (lease) => {
      if (!lease.withDatabaseFileMutation) {
        throw new Error("Missing mutation owner");
      }
      await lease.withDatabaseFileMutation({
        assertCurrent: () => lease.assertOwned(),
        async mutate() {
          const owner = openOpenClawStateDatabase({ env: state.env });
          owner.db.exec("BEGIN IMMEDIATE");
          try {
            await expect(snapshot(pathname)).rejects.toThrow(/outside a transaction/);
            const competing = spawnSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `
              import { DatabaseSync } from 'node:sqlite';
              const db = new DatabaseSync(process.argv[1], { timeout: 0 });
              try {
                db.exec('BEGIN IMMEDIATE');
                db.exec('ROLLBACK');
                process.exitCode = 2;
              } catch (error) {
                if (!String(error).includes('locked')) throw error;
                process.stdout.write('writer refused');
              } finally { db.close(); }
            `,
                pathname,
              ],
              { encoding: "utf8", timeout: 5_000 },
            );
            expect(competing.error).toBeUndefined();
            expect(competing.status).toBe(0);
            expect(competing.stdout).toBe("writer refused");
            expect(owner.db.isOpen).toBe(true);
            expect(owner.db.isTransaction).toBe(true);
          } finally {
            owner.db.exec("ROLLBACK");
          }
          expect(await rows(pathname)).toEqual([]);
        },
        async capture() {},
        bind() {
          return undefined;
        },
      });
    });
  });
});

it("refuses an uncached source handle and an escaped mutation inspection context", async () => {
  await withOpenClawTestState({ label: "mutation-snapshot-closed" }, async (state) => {
    const pathname = openOpenClawStateDatabase({ env: state.env }).path;
    let escaped: (() => ReturnType<typeof snapshot>) | undefined;
    await withOpenClawStateLease(options(state.env), async (lease) => {
      if (!lease.withDatabaseFileMutation) {
        throw new Error("Missing mutation owner");
      }
      await lease.withDatabaseFileMutation({
        assertCurrent: () => lease.assertOwned(),
        async mutate() {
          escaped = AsyncResource.bind(() => snapshot(pathname));
          const handle = openTrackedStateDatabase(pathname, { existingOnly: true });
          try {
            await expect(snapshot(pathname)).rejects.toThrow(/drained source handles/);
            expect(handle.isOpen).toBe(true);
          } finally {
            closeTrackedStateDatabase(handle);
          }
          expect(await rows(pathname)).toEqual([]);
        },
        async capture() {
          await expect(escaped?.()).rejects.toThrow(/scope is closed/);
        },
        bind() {
          return undefined;
        },
      });
    });
    await expect(escaped?.()).rejects.toThrow(/scope is closed/);
  });
});
