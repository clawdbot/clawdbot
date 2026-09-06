import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "keeps restored-generation completion with its helper across CLI unwind (handoff=%s)",
  (handoff) => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-rollback-owner-") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const result = {
      status: "error" as const,
      mode: "npm" as const,
      durationMs: 1,
      steps: [],
      reason: "restart-unhealthy",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.1" },
      recovery: {
        serviceRestartSafe: true as const,
        packageRollbackVerified: true as const,
        version: "2026.9.1",
      },
    };
    completeUpdateCommandRun(result, run);
    completeUpdateCommandRun(result, run);
    expect(getUpdateRun(run.runId, { env })).toMatchObject({
      status: handoff ? "running" : "failed",
      after: { version: "2026.9.1" },
    });
    if (handoff) {
      finishUpdateRun(run.runId, { status: "rolled-back", reason: result.reason }, { env });
      completeUpdateCommandRun(result, run);
      expect(getUpdateRun(run.runId, { env })?.status).toBe("rolled-back");
    }
  },
);
