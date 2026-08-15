// Status shared-state E2E tests enforce the CLI/Gateway SQLite ownership boundary.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

function seedInspectableTask(db: DatabaseSync): void {
  const now = Date.now();
  // Seed through the persisted schema so the CLI must inspect state owned by
  // another process instead of seeing its own in-memory registry.
  db.prepare(
    `INSERT INTO task_runs (
       task_id, runtime, requester_session_key, owner_key, scope_kind,
       child_session_key, agent_id, task, status, delivery_status,
       notify_policy, created_at, last_event_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    // Keep the task inside the reconciliation grace window so status should
    // report the committed running record unchanged.
    "status-read-only-task",
    "subagent",
    "agent:main:main",
    "agent:main:main",
    "session",
    "agent:main:subagent:status-read-only",
    "main",
    "Prove status reads shared task state without joining its write lifecycle",
    "running",
    "pending",
    "done_only",
    now,
    now,
  );
}

describe("status shared-state ownership", () => {
  it.each([
    { name: "text status", args: ["status"] },
    { name: "JSON status", args: ["status", "--json"] },
    { name: "all status", args: ["status", "--all"] },
    { name: "channel probe", args: ["channels", "status", "--probe", "--json"] },
  ])(
    "does not create shared state during $name",
    async ({ name, args }) => {
      const instance = await createOpenClawTestInstance({
        name: `status-read-only-${name.replaceAll(" ", "-")}`,
      });
      const databasePath = path.join(instance.stateDir, "state", "openclaw.sqlite");
      try {
        expect(fs.existsSync(databasePath)).toBe(false);

        const status = await instance.cli(args);

        expect(status.code, status.stderr).toBe(0);
        if (args[0] === "status" && args.includes("--json")) {
          expect(JSON.parse(status.stdout)).toMatchObject({ tasks: { total: 0 } });
        }
        expect(fs.existsSync(databasePath)).toBe(false);
      } finally {
        await instance.cleanup();
      }
    },
    120_000,
  );

  it("reads committed tasks while the Gateway owns state and another writer is active", async () => {
    const instance = await createOpenClawTestInstance({ name: "status-read-only-live-gateway" });
    const databasePath = path.join(instance.stateDir, "state", "openclaw.sqlite");
    let writer: DatabaseSync | undefined;
    try {
      await instance.startGateway();
      writer = new DatabaseSync(databasePath);
      seedInspectableTask(writer);
      // A read-only status path can overlap this writer. Writable schema/bootstrap work cannot.
      writer.exec("BEGIN IMMEDIATE");

      const status = await instance.cli(["status", "--json"], { timeoutMs: 15_000 });

      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ tasks: { total: 1 } });
      expect(instance.child?.exitCode).toBeNull();

      writer.exec("ROLLBACK");
      writer.close();
      writer = undefined;
      await instance.stopGateway();

      const verifier = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(verifier.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        verifier.close();
      }
    } finally {
      if (writer?.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer?.close();
      await instance.cleanup();
    }
  }, 120_000);
});
