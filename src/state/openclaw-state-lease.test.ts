import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

type LeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("OpenClaw state lease", () => {
  it("releases ownership when a CLI exits from inside the leased operation", async () => {
    await withOpenClawTestState({ label: "core-state-lease-process-exit" }, async (state) => {
      const leaseModuleUrl = pathToFileURL(path.resolve("src/state/openclaw-state-lease.ts")).href;
      const childScript = await state.writeText(
        "lease-process-exit-child.mts",
        `
          import { withOpenClawStateLease } from ${JSON.stringify(leaseModuleUrl)};
          const stateDir = process.argv[2];
          await withOpenClawStateLease({
            scope: "core:test",
            key: "process-exit",
            database: { scope: "shared", options: { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } },
            leaseMs: 300_000,
            waitMs: 0,
          }, async () => process.exit(23));
        `,
      );

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", childScript, state.stateDir], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 23) {
            reject(new Error(`lease child exited ${code}: ${output}`));
            return;
          }
          resolve(code);
        });
      });
      expect(exitCode).toBe(23);

      let reacquired = false;
      await withOpenClawStateLease(
        {
          scope: "core:test",
          key: "process-exit",
          database: { scope: "shared", options: { env: state.env } },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => {
          reacquired = true;
        },
      );
      expect(reacquired).toBe(true);
    });
  });

  it("keeps state database exit-cleanup diagnostics off stdout for machine-readable output", async () => {
    await withOpenClawTestState({ label: "core-state-lease-exit-stdout" }, async (state) => {
      const leaseModuleUrl = pathToFileURL(path.resolve("src/state/openclaw-state-lease.ts")).href;
      const stateDbModuleUrl = pathToFileURL(path.resolve("src/state/openclaw-state-db.ts")).href;
      const loggingStateModuleUrl = pathToFileURL(path.resolve("src/logging/state.ts")).href;
      const childScript = await state.writeText(
        "lease-exit-stdout-child.mts",
        `
          import { withOpenClawStateLease } from ${JSON.stringify(leaseModuleUrl)};
          import {
            closeOpenClawStateDatabaseForTest,
            openOpenClawStateDatabase,
          } from ${JSON.stringify(stateDbModuleUrl)};
          import { loggingState } from ${JSON.stringify(loggingStateModuleUrl)};
          const stateDir = process.argv[2];
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          // Simulate --json console routing being active for the command.
          loggingState.forceConsoleToStderr = true;
          await withOpenClawStateLease({
            scope: "core:test",
            key: "exit-stdout",
            database: { scope: "shared", options: { env } },
            leaseMs: 300_000,
            waitMs: 0,
          }, async () => {
            // Recreate the pending-migration condition for the exit-time reopen.
            const { db } = openOpenClawStateDatabase({ env });
            db.exec("PRAGMA user_version = 0;");
            closeOpenClawStateDatabaseForTest();
            // Simulate the JSON envelope followed by restored output routing.
            // Await the write callback — stdout is piped in the test harness, so
            // a bare write() can drop the data before process.exit flushes.
            await new Promise<void>((resolve) => {
              process.stdout.write(JSON.stringify({ ok: true }) + "\\n", resolve);
            });
            loggingState.forceConsoleToStderr = false;
            process.exit(23);
          });
        `,
      );

      const childResult = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", childScript, state.stateDir], {
          // Keep console logging enabled in the child despite the inherited VITEST env.
          env: { ...process.env, OPENCLAW_TEST_CONSOLE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      expect(
        childResult.code,
        `lease child exited ${childResult.code}: ${childResult.stderr}`,
      ).toBe(23);
      // The exit-time lease release reopens the state database and hits the
      // pending-migration diagnostic; stdout must stay machine-readable.
      expect(childResult.stdout).toBe(`${JSON.stringify({ ok: true })}\n`);
      expect(childResult.stderr).toContain("state database schema migration pending");
    });
  }, 60_000);

  it("rechecks exact ownership inside the caller's write transaction", async () => {
    await withOpenClawTestState({ label: "core-state-lease" }, async () => {
      await expect(
        withOpenClawStateLease(
          {
            scope: "core:test",
            key: "credential-write",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async (lease) => {
            runOpenClawStateWriteTransaction(({ db }) => {
              lease.assertOwnedInTransaction(db);
              executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<LeaseDatabase>(db)
                  .updateTable("state_leases")
                  .set({ owner: "successor" })
                  .where("scope", "=", "core:test")
                  .where("lease_key", "=", "credential-write"),
              );
              expect(() => lease.assertOwnedInTransaction(db)).toThrowError(
                expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
              );
            });
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    });
  });

  it("never transfers an expired lease away from its live process owner", async () => {
    await withOpenClawTestState({ label: "core-state-process-lease-live-owner" }, async () => {
      const processOwner = {
        pid: process.pid,
        startTime: null,
        isAlive: (pid: number) => pid === process.pid,
        readStartTime: () => null,
      };
      const options = {
        scope: "core:test",
        key: "live-process-owner",
        database: { scope: "shared" as const },
        leaseMs: 1_000,
        waitMs: 500,
        processOwner,
      };

      await withOpenClawStateLease(options, async (owner) => {
        runOpenClawStateWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ expires_at: Date.now() - 1 })
              .where("scope", "=", options.scope)
              .where("lease_key", "=", options.key),
          );
        });

        await expect(
          withOpenClawStateLease({ ...options, waitMs: 5 }, async () => undefined),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_TIMEOUT" });
        expect(() => owner.assertOwned()).not.toThrow();
      });
    });
  });

  it.each([
    { label: "dead", alive: false, observedStartTime: 123 },
    { label: "recycled", alive: true, observedStartTime: 456 },
  ])("reclaims a $label process-owned lease before its TTL", async (scenario) => {
    await withOpenClawTestState(
      { label: `core-state-process-lease-${scenario.label}` },
      async () => {
        const now = Date.now();
        runOpenClawStateWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .insertInto("state_leases")
              .values({
                scope: "core:test",
                lease_key: "stale-process-owner",
                owner: "previous-owner",
                expires_at: now + 300_000,
                heartbeat_at: now,
                payload_json: JSON.stringify({ pid: process.pid, starttime: 123 }),
                created_at: now,
                updated_at: now,
              }),
          );
        });

        await withOpenClawStateLease(
          {
            scope: "core:test",
            key: "stale-process-owner",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
            processOwner: {
              pid: process.pid,
              startTime: 456,
              isAlive: () => scenario.alive,
              readStartTime: () => scenario.observedStartTime,
            },
          },
          async (lease) => lease.assertOwned(),
        );
      },
    );
  });
});
