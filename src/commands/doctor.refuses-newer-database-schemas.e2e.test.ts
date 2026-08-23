import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  autoMigrateLegacyStateDir,
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  readConfigFileSnapshot,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runGatewayUpdate,
} from "./doctor.e2e-harness.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor database schema preflight", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ doctorCommand } = await import("./doctor.js"));
    vi.clearAllMocks();
  });

  it("lets a successful interactive update replace the stale doctor", async () => {
    writeStateSchemaVersion(OPENCLAW_STATE_SCHEMA_VERSION + 1);
    mockDoctorConfigSnapshot();
    mockInteractiveGitUpdate("ok");

    await expect(doctorCommand(createDoctorRuntime())).resolves.toBeUndefined();

    expect(runGatewayUpdate).toHaveBeenCalledOnce();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("refuses after an interactive update does not handle doctor", async () => {
    writeStateSchemaVersion(OPENCLAW_STATE_SCHEMA_VERSION + 1);
    mockDoctorConfigSnapshot();
    mockInteractiveGitUpdate("skipped");

    await expect(doctorCommand(createDoctorRuntime())).rejects.toThrow(
      /Doctor refused to continue.*database schema.*newer than this build/iu,
    );

    expect(runGatewayUpdate).toHaveBeenCalledOnce();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("refuses before config repair flows when updates are disabled", async () => {
    writeStateSchemaVersion(OPENCLAW_STATE_SCHEMA_VERSION + 1);
    mockDoctorConfigSnapshot();

    await expect(doctorCommand(createDoctorRuntime(), { nonInteractive: true })).rejects.toThrow(
      /Doctor refused to continue.*database schema.*newer than this build/iu,
    );

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });
});

function mockInteractiveGitUpdate(status: "ok" | "skipped"): void {
  delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  resolveOpenClawPackageRoot.mockResolvedValue("/repo");
  runCommandWithTimeout.mockResolvedValue({
    stdout: "/repo\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });
  runGatewayUpdate.mockResolvedValue({
    status,
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 0,
  });
}

function writeStateSchemaVersion(version: number): void {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(statePath);
  try {
    database.exec(`PRAGMA user_version = ${version};`);
  } finally {
    database.close();
  }
}
