import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatCliProcessFailure, runCliProcessChild } from "../cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(
  new URL("./update-command-schema-handoff.test-support.ts", import.meta.url),
);

describe("update schema finalization process ownership", () => {
  it.each(["success", "doctor-error"])(
    "settles %s without old-process reads after migration",
    async (scenario) => {
      const root = tempDirs.make("openclaw-schema-handoff-");
      const state = path.join(root, "state");
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_POST_CORE: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        HANDOFF_SCENARIO: scenario,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
      };
      const result = await runCliProcessChild({ nodeArgs: ["--import", "tsx", fixture], env });
      const failure = formatCliProcessFailure({ reason: scenario, ...result });
      expect(result.code, failure).toBe(0);
      expect(result.signal, failure).toBeNull();
      const report = JSON.parse(await fs.readFile(path.join(root, "parent-report.json"), "utf8"));
      expect(report.transferred).toBe(true);
      expect(report.outcome, failure).toBe(
        scenario === "success"
          ? "ok"
          : "Updated OpenClaw finalization failed; keep the updated build installed and inspect the update diagnostics.",
      );
      const db = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(report.nextSchema);
        const run = db
          .prepare("SELECT status, steps_json FROM update_runs WHERE run_id = ?")
          .get(report.runId);
        expect(run?.status, failure).toBe(scenario === "success" ? "succeeded" : "failed");
        expect(JSON.parse(String(run?.steps_json)), failure).toContainEqual(
          expect.objectContaining({
            step: "openclaw doctor",
            status: scenario === "success" ? "completed" : "failed",
          }),
        );
      } finally {
        db.close();
      }
      expect(report.recoveryEvents, failure).toContainEqual({
        event: scenario === "success" ? "restore" : "complete",
        safe: scenario === "success",
      });
    },
  );
});
