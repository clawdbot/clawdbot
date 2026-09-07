import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSourceRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Doctor preflight refusal receipts", () => {
  it("propagates the settled preflight receipts without truncating the blocked tail", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-refusal-receipts-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const configRaw = '{"meta":{"lastTouchedAt":"2026-09-03T00:00:00.000Z"}}\n';
    fs.mkdirSync(path.join(stateDir, "tui"), { recursive: true });
    fs.writeFileSync(configPath, configRaw);
    fs.writeFileSync(path.join(stateDir, "tui", "last-session.json"), "not json\n");
    const runtimeRoot = createSourceRuntime(root);
    const { stdout } = await runIsolatedModuleScript(
      {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        NO_COLOR: "1",
      },
      `
      import { runDoctorConfigPreflight } from "./src/commands/doctor-config-preflight.ts";
      try {
        await runDoctorConfigPreflight({ doctorOnlyStateMigrations: true, migrateLegacyConfig: false });
        console.log("RECEIPTS:" + JSON.stringify({ completed: true }));
      } catch (error) {
        console.log("RECEIPTS:" + JSON.stringify({ name: error.name, stepReceipts: error.stepReceipts }));
      }
    `,
      { runtimeRoot, timeoutMs: 60_000 },
    );
    const result = JSON.parse(stdout.split("RECEIPTS:").at(-1) ?? "null") as {
      name: string;
      stepReceipts: import("../infra/state-migrations.types.js").LegacyStateMigrationStepReceipt[];
    };
    expect(result.name).toBe("DoctorStateMigrationRefusalError");
    const receipts = result.stepReceipts;
    const blocker = receipts.findIndex((receipt) => receipt.id === "tui-last-session");
    expect(blocker).toBeGreaterThan(0);
    expect(receipts.slice(0, blocker)).toContainEqual(
      expect.objectContaining({ id: "config-machine-state", outcome: "completed" }),
    );
    expect(receipts[blocker]).toMatchObject({
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    const tail = receipts.slice(blocker + 1);
    expect(tail.map((receipt) => receipt.id)).toEqual([
      "commitments",
      "audit-logs",
      "acp-replay-ledger",
      "managed-outgoing-images",
      "apns-registrations",
      "exec-approvals",
      "mcp-oauth",
      "restart-sentinel",
      "workspace-state",
      "web-push",
      "node-host",
      "subagent-registry",
      "rescue-pending",
      "skill-workshop",
      "channel-pairing",
      "plugin-doctor-state",
      "sessions",
      "acp-session-metadata",
      "agent-dir",
      "plugin-doctor-post-session-state",
    ]);
    for (const receipt of tail) {
      expect(receipt).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    }
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(receipts.length);
    expect(fs.readFileSync(configPath, "utf8")).toBe(configRaw);
    const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'config.lastTouchedAt'",
          )
          .get(),
      ).toEqual({
        value_json: JSON.stringify("2026-09-03T00:00:00.000Z"),
      });
    } finally {
      db.close();
    }
  }, 60_000);
});
