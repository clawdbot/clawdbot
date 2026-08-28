import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inspectQaExecutionIdentityStorage } from "./execution-identity-storage-inspection.js";

describe("inspectQaExecutionIdentityStorage", () => {
  it("returns only context and decision counts from the isolated QA database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-identity-counts-"));
    try {
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE execution_identity_contexts (context_id TEXT PRIMARY KEY);
        CREATE TABLE execution_decision_facts (
          receipt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          action_family TEXT NOT NULL,
          reason_code TEXT NOT NULL
        );
        INSERT INTO execution_identity_contexts VALUES ('context-1'), ('context-2');
        INSERT INTO execution_decision_facts VALUES
          ('receipt-1', 'run-1', 'message', 'message_suppressed_inbound_metadata_echo'),
          ('receipt-2', 'run-1', 'model-routing', 'model_route_selected');
      `);
      database.close();

      expect(
        inspectQaExecutionIdentityStorage({
          gateway: {
            runtimeEnv: { OPENCLAW_STATE_DIR: stateDir },
          } as never,
        }),
      ).toEqual({ contextCount: 2, decisionCount: 2 });
      expect(
        inspectQaExecutionIdentityStorage(
          {
            gateway: {
              runtimeEnv: { OPENCLAW_STATE_DIR: stateDir },
            } as never,
          },
          {
            runId: "run-1",
            actionFamily: "message",
            reasonCode: "message_suppressed_inbound_metadata_echo",
          },
        ),
      ).toEqual({ contextCount: 2, decisionCount: 1 });
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });
});
