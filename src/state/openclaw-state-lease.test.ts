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
});
