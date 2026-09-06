import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  beginUpdateRecovery,
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  failUpdateCommandRun,
} from "./update-command-run.js";

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

function pendingRecovery() {
  const root = dirs.make("update-admission-recovery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  // This fixture owns every writer of its disposable state directory.
  const record = beginUpdateRecovery(
    { runId: run.runId, from, to: { ...from, version: "2.0.0" } },
    { assertCurrent() {} },
    { env },
  );
  closeOpenClawStateDatabaseForTest();
  const snapshot = () =>
    fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .toSorted()
      .map((name) => {
        const filename = path.join(root, name);
        const stat = fs.statSync(filename);
        return {
          name,
          ino: stat.ino,
          mtime: stat.mtimeMs,
          mode: stat.mode,
          sha256: stat.isFile()
            ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
            : null,
        };
      });
  return { root, run, record, snapshot };
}

it.each([
  { dryRun: true, reuseRunId: false },
  { dryRun: false, reuseRunId: true },
])(
  "refuses interrupted update admission without touching SQLite ($dryRun, $reuseRunId)",
  async ({ dryRun, reuseRunId }) => {
    const { root, run, record, snapshot } = pendingRecovery();
    if (reuseRunId) {
      vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    }
    const before = snapshot();
    await expect(
      admitUpdateCommandRun({ opts: { dryRun }, root }).then(() => "admitted"),
    ).rejects.toBeInstanceOf(UpdateRecoveryRequiredError);
    expect(snapshot()).toEqual(before);
    expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
  },
);

it.each(["ok", "error"] as const)(
  "does not complete an operationally pending update from diagnostic %s",
  (status) => {
    const { run, record, snapshot } = pendingRecovery();
    const before = snapshot();
    const result = {
      status,
      mode: "npm" as const,
      durationMs: 1,
      steps: [],
      ...(status === "error" ? { reason: "primary-failure" } : {}),
    };
    const completed = completeUpdateCommandRun(result, run);
    expect(completed.status).toBe("error");
    expect(completed.reason).toBe(
      status === "error" ? "primary-failure" : "update-recovery-pending",
    );
    failUpdateCommandRun(new Error("outer unwind"), run);
    expect(snapshot()).toEqual(before);
    expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
  },
);

it("continues normal history admission when no operational update is pending", async () => {
  const root = dirs.make("update-admission-empty-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root });
  expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
});
