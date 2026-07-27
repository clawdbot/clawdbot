// Register backup tests cover backup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  backupSqliteCreateCommand: vi.fn(),
  backupSqliteListCommand: vi.fn(),
  backupSqliteRestoreCommand: vi.fn(),
  backupSqliteVerifyCommand: vi.fn(),
  backupVerifyCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const backupCreateCommand = mocks.backupCreateCommand;
const backupSqliteCreateCommand = mocks.backupSqliteCreateCommand;
const backupSqliteListCommand = mocks.backupSqliteListCommand;
const backupSqliteRestoreCommand = mocks.backupSqliteRestoreCommand;
const backupSqliteVerifyCommand = mocks.backupSqliteVerifyCommand;
const backupVerifyCommand = mocks.backupVerifyCommand;
const runtime = mocks.runtime;

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand: mocks.backupVerifyCommand,
}));

vi.mock("../../commands/backup-sqlite.js", () => ({
  backupSqliteCreateCommand: mocks.backupSqliteCreateCommand,
  backupSqliteListCommand: mocks.backupSqliteListCommand,
  backupSqliteRestoreCommand: mocks.backupSqliteRestoreCommand,
  backupSqliteVerifyCommand: mocks.backupSqliteVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerBackupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    backupCreateCommand.mockResolvedValue(undefined);
    backupSqliteCreateCommand.mockResolvedValue(undefined);
    backupSqliteListCommand.mockResolvedValue(undefined);
    backupSqliteRestoreCommand.mockResolvedValue(undefined);
    backupSqliteVerifyCommand.mockResolvedValue(undefined);
    backupVerifyCommand.mockResolvedValue(undefined);
  });

  function expectForwardedOptions(command: typeof backupCreateCommand): Record<string, unknown> {
    expect(command).toHaveBeenCalledTimes(1);
    const call = command.mock.calls[0];
    if (!call) {
      throw new Error("expected backup command call");
    }
    const [runtimeArg, options] = call as unknown as [typeof runtime, Record<string, unknown>];
    expect(runtimeArg).toBe(runtime);
    return options;
  }

  it("runs backup create with forwarded options", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups", "--json", "--dry-run"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.output).toBe("/tmp/backups");
    expect(options.json).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.verify).toBe(false);
    expect(options.onlyConfig).toBe(false);
    expect(options.includeWorkspace).toBe(true);
  });

  it("honors --no-include-workspace", async () => {
    await runCli(["backup", "create", "--no-include-workspace"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.includeWorkspace).toBe(false);
  });

  it("forwards --verify to backup create", async () => {
    await runCli(["backup", "create", "--verify"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.verify).toBe(true);
  });

  it("forwards --only-config to backup create", async () => {
    await runCli(["backup", "create", "--only-config"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.onlyConfig).toBe(true);
  });

  it("runs backup verify with forwarded options", async () => {
    await runCli(["backup", "verify", "/tmp/openclaw-backup.tar.gz", "--json"]);

    const options = expectForwardedOptions(backupVerifyCommand);
    expect(options.archive).toBe("/tmp/openclaw-backup.tar.gz");
    expect(options.json).toBe(true);
  });

  it("registers the SQLite snapshot command group", () => {
    const program = new Command();

    registerBackupCommand(program);

    const backup = program.commands.find((command) => command.name() === "backup");
    const sqlite = backup?.commands.find((command) => command.name() === "sqlite");
    expect(sqlite?.commands.map((command) => command.name()).toSorted()).toEqual([
      "create",
      "list",
      "restore",
      "verify",
    ]);
  });

  it("runs SQLite snapshot create for named OpenClaw databases", async () => {
    await runCli([
      "backup",
      "sqlite",
      "create",
      "--global",
      "--repository",
      "/tmp/snapshots",
      "--json",
    ]);

    expect(backupSqliteCreateCommand).toHaveBeenCalledWith(runtime, {
      global: true,
      agent: undefined,
      repository: "/tmp/snapshots",
      json: true,
    });

    await runCli([
      "backup",
      "sqlite",
      "create",
      "--agent",
      "main",
      "--repository",
      "/tmp/snapshots",
    ]);

    expect(backupSqliteCreateCommand).toHaveBeenLastCalledWith(runtime, {
      global: false,
      agent: "main",
      repository: "/tmp/snapshots",
      json: false,
    });
  });

  it("runs SQLite snapshot list, verify, and restore", async () => {
    await runCli(["backup", "sqlite", "list", "--repository", "/tmp/snapshots", "--json"]);
    expect(backupSqliteListCommand).toHaveBeenCalledWith(runtime, {
      repository: "/tmp/snapshots",
      json: true,
    });

    await runCli([
      "backup",
      "sqlite",
      "verify",
      "/tmp/snapshots/one",
      "--scratch",
      "/tmp/private-scratch",
      "--json",
    ]);
    expect(backupSqliteVerifyCommand).toHaveBeenCalledWith(runtime, "/tmp/snapshots/one", {
      scratch: "/tmp/private-scratch",
      json: true,
    });

    await runCli([
      "backup",
      "sqlite",
      "restore",
      "/tmp/snapshots/one",
      "--target",
      "/tmp/restored.sqlite",
      "--json",
    ]);
    expect(backupSqliteRestoreCommand).toHaveBeenCalledWith(runtime, "/tmp/snapshots/one", {
      target: "/tmp/restored.sqlite",
      json: true,
    });
  });
});
