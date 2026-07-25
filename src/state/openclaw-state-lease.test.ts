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
