import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  autoMigrateLegacyStateDir,
  confirm,
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

  it("refuses a newer shared database before offering an interactive update", async () => {
    writeStateSchemaVersion(OPENCLAW_STATE_SCHEMA_VERSION + 1);
    mockDoctorConfigSnapshot();
    mockInteractiveGitUpdate({ status: "ok" });
    const statePath = resolveOpenClawStateSqlitePath(process.env);
    const original = fs.readFileSync(statePath);

    await expect(doctorCommand(createDoctorRuntime())).rejects.toThrow(
      /Doctor refused to continue.*database schema.*newer than this build/iu,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath)).toEqual(original);
    expect(fs.readdirSync(path.dirname(statePath))).toEqual([path.basename(statePath)]);
  });

  it("lets a successful interactive update replace Doctor with newer agent schemas", async () => {
    writeNewerAgentSchema();
    mockDoctorConfigSnapshot();
    mockInteractiveGitUpdate({ status: "ok" });

    await expect(doctorCommand(createDoctorRuntime())).resolves.toBeUndefined();

    expect(runGatewayUpdate).toHaveBeenCalledOnce();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("refuses newer agent schemas after an interactive update reports already-current", async () => {
    writeNewerAgentSchema();
    mockDoctorConfigSnapshot();
    mockInteractiveGitUpdate({ status: "skipped", reason: "already-current" });

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
    const statePath = resolveOpenClawStateSqlitePath(process.env);
    const original = fs.readFileSync(statePath);

    await expect(doctorCommand(createDoctorRuntime(), { nonInteractive: true })).rejects.toThrow(
      /Doctor refused to continue.*database schema.*newer than this build/iu,
    );

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath)).toEqual(original);
    expect(fs.readdirSync(path.dirname(statePath))).toEqual([path.basename(statePath)]);
  });

  it.each([
    ["plain doctor", { nonInteractive: true }],
    ["doctor --fix", { nonInteractive: true, repair: true }],
  ])("diagnoses an unreadable shared state database for %s", async (_label, options) => {
    const statePath = resolveOpenClawStateSqlitePath(process.env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "not a sqlite database");
    mockDoctorConfigSnapshot();

    const failure = await doctorCommand(createDoctorRuntime(), options).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(statePath);
    expect((failure as Error).message).toMatch(/file is not a database/iu);
    expect((failure as Error).message).toContain("left unchanged");
    expect((failure as Error).message).toContain("restore this file from a verified backup");
    expect((failure as Error).message).toContain("Stop OpenClaw processes");
    expect((failure as Error).message).not.toContain("openclaw doctor --fix");
    expect(fs.readFileSync(statePath, "utf8")).toBe("not a sqlite database");
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });
});

function mockInteractiveGitUpdate(
  outcome: { status: "ok" } | { status: "skipped"; reason: "already-current" },
): void {
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
    ...outcome,
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 0,
  });
}

function writeStateSchemaVersion(version: number): void {
  writeSchemaVersion(resolveOpenClawStateSqlitePath(process.env), version);
}

function writeNewerAgentSchema(): void {
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  writeSchemaVersion(agentPath, OPENCLAW_AGENT_SCHEMA_VERSION + 1);
  registerOpenClawAgentDatabase({ agentId: "main", path: agentPath });
}

function writeSchemaVersion(statePath: string, version: number): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(statePath);
  try {
    database.exec(`PRAGMA user_version = ${version};`);
  } finally {
    database.close();
  }
}
