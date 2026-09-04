import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";

const directories = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  directories.cleanup();
});

describe("update restart verification ownership", () => {
  it.each(["validating", "activating", "restarting", "verifying"] as const)(
    "does not let sentinel expiry finish the orchestrator during %s",
    (phase) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-boot-owner-"));
      const run = createUpdateRun({
        trigger: "cli",
        target: { version: resolveRuntimeServiceVersion() },
      });
      recordUpdateRunPhase(run.runId, phase);
      const observed = finalizeRestartUpdateRun(
        {
          kind: "update",
          status: "skipped",
          ts: Date.now(),
          stats: { runId: run.runId, reason: "restart-health-pending" },
        },
        true,
      );
      expect(observed).toMatchObject({
        status: "running",
        phase,
        confirmedAtMs: null,
        verification: { booted: true },
      });
    },
  );
});
