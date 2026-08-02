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
  runGatewayUpdate,
} from "./doctor.e2e-harness.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor database schema preflight", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ doctorCommand } = await import("./doctor.js"));
    vi.clearAllMocks();
  });

  it("refuses a newer state schema before update and config repair flows", async () => {
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
