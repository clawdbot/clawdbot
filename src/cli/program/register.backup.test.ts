import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  backupVerifyCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const backupCreateCommand = mocks.backupCreateCommand;
const backupVerifyCommand = mocks.backupVerifyCommand;
const runtime = mocks.runtime;

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand: mocks.backupVerifyCommand,
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
});
