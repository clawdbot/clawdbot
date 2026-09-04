import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { updateCleanupCommand } from "./cleanup.js";

const retirement = vi.hoisted(() => vi.fn());
vi.mock("../../commands/doctor-session-sqlite-retirement.js", () => ({
  retireSessionSqliteRecovery: retirement,
}));

const directories = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  directories.cleanup();
});

describe("update cleanup ownership", () => {
  it("does not retire rollback originals while an update run is active", async () => {
    const stateDir = directories.make("update-cleanup-active-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${stateDir}/openclaw.json`);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    const run = createUpdateRun({ trigger: "cli" });

    await updateCleanupCommand({ yes: true, json: true });

    expect(retirement).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked" }), 2);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).not.toHaveBeenCalled();
    finishUpdateRun(run.runId, { status: "failed", reason: "doctor-failed" });
  });
});
