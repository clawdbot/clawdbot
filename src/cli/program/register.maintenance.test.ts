// Register maintenance tests cover maintenance command registration in the CLI program.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "./register.maintenance.js";

const mocks = vi.hoisted(() => ({
  doctorCommand: vi.fn(),
  dashboardCommand: vi.fn(),
  resetCommand: vi.fn(),
  uninstallCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
  runDoctorLintCli: vi.fn(),
}));

const {
  doctorCommand,
  dashboardCommand,
  resetCommand,
  uninstallCommand,
  runtime,
  runDoctorLintCli,
} = mocks;

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand: mocks.doctorCommand,
}));

vi.mock("../../commands/dashboard.js", () => ({
  dashboardCommand: mocks.dashboardCommand,
}));

vi.mock("../../commands/reset.js", () => ({
  resetCommand: mocks.resetCommand,
}));

vi.mock("../../commands/uninstall.js", () => ({
  uninstallCommand: mocks.uninstallCommand,
}));

vi.mock("../../commands/doctor-lint.js", () => ({
  runDoctorLintCli: mocks.runDoctorLintCli,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

function commandCall(mock: ReturnType<typeof vi.fn>): [typeof runtime, Record<string, unknown>] {
  const call = mock.mock.calls[0] as [typeof runtime, Record<string, unknown>] | undefined;
  if (!call) {
    throw new Error("expected command call");
  }
  return call;
}

describe("registerMaintenanceCommands doctor action", () => {
  async function runMaintenanceCli(args: string[]) {
    const program = new Command();
    registerMaintenanceCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits with code 0 after successful doctor run", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes", "--allow-exec"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(doctorCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.nonInteractive).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.allowExec).toBe(true);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("enables workspace suggestions by default and allows disabling them", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [, defaultOptions] = commandCall(doctorCommand);
    expect(defaultOptions.workspaceSuggestions).toBe(true);

    vi.clearAllMocks();
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes", "--no-workspace-suggestions"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [, disabledOptions] = commandCall(doctorCommand);
    expect(disabledOptions.workspaceSuggestions).toBe(false);
  });

  it("exits with code 1 when doctor fails", async () => {
    doctorCommand.mockRejectedValue(new Error("doctor failed"));

    await runMaintenanceCli(["doctor"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: doctor failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(0);
  });

  it("writes JSON when Doctor maintenance fails before producing a report", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    doctorCommand.mockRejectedValue(
      new Error(`maintenance failed: Authorization: Bearer ${token}`),
    );

    await runMaintenanceCli(["doctor", "--state-sqlite", "compact", "--json"]);

    expect(runtime.writeJson).toHaveBeenCalledWith({
      error: expect.stringContaining("maintenance failed: Authorization: Bearer"),
    });
    expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain(token);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("maps --fix to repair=true", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--fix"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(doctorCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.repair).toBe(true);
  });

  it("passes session sqlite options to doctor command", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "doctor",
      "--session-sqlite",
      "import",
      "--session-sqlite-store",
      "/tmp/openclaw/sessions.json",
      "--json",
    ]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(doctorCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.sessionSqlite).toBe("import");
    expect(options.sessionSqliteStore).toBe("/tmp/openclaw/sessions.json");
    expect(options.json).toBe(true);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("passes session sqlite recover GitHub issue option to doctor command", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--session-sqlite", "recover", "--github-issue", "--yes"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [, options] = commandCall(doctorCommand);
    expect(options.sessionSqlite).toBe("recover");
    expect(options.sessionSqliteGithubIssue).toBe(true);
    expect(options.yes).toBe(true);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("passes session sqlite compact mode to doctor command", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "doctor",
      "--session-sqlite",
      "compact",
      "--session-sqlite-agent",
      "main",
    ]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [, options] = commandCall(doctorCommand);
    expect(options.sessionSqlite).toBe("compact");
    expect(options.sessionSqliteAgent).toBe("main");
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("passes shared-state sqlite compact mode and JSON output to doctor command", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--state-sqlite", "compact", "--json"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [, options] = commandCall(doctorCommand);
    expect(options.stateSqlite).toBe("compact");
    expect(options.json).toBe(true);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("rejects simultaneous shared-state and session SQLite modes", async () => {
    await runMaintenanceCli(["doctor", "--state-sqlite", "compact", "--session-sqlite", "compact"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor shared-state SQLite maintenance can only be combined with --json.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("writes JSON errors for conflicting shared-state SQLite modes", async () => {
    const message = "doctor shared-state SQLite maintenance can only be combined with --json.";

    await runMaintenanceCli([
      "doctor",
      "--state-sqlite",
      "compact",
      "--session-sqlite",
      "compact",
      "--json",
    ]);

    expect(runtime.writeJson).toHaveBeenCalledWith({ error: message });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("rejects shared-state SQLite maintenance combined with lint mode", async () => {
    await runMaintenanceCli(["doctor", "--state-sqlite", "compact", "--lint"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor shared-state SQLite maintenance can only be combined with --json.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it.each([
    ["workspace suggestions", ["--no-workspace-suggestions"]],
    ["yes mode", ["--yes"]],
    ["repair mode", ["--repair"]],
    ["fix mode", ["--fix"]],
    ["force mode", ["--force"]],
    ["non-interactive mode", ["--non-interactive"]],
    ["gateway token generation", ["--generate-gateway-token"]],
    ["exec secret resolution", ["--allow-exec"]],
    ["deep scans", ["--deep"]],
    ["post-upgrade mode", ["--post-upgrade"]],
    ["session SQLite selectors", ["--session-sqlite-agent", "main"]],
    ["lint selectors", ["--only", "core/example"]],
  ])("rejects shared-state SQLite maintenance combined with %s", async (_label, args) => {
    await runMaintenanceCli(["doctor", "--state-sqlite", "compact", ...args]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor shared-state SQLite maintenance can only be combined with --json.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it.each([
    ["without JSON", false, ["--session-sqlite-agent", "main"]],
    ["with JSON", true, ["--json", "--session-sqlite-agent", "main"]],
  ])(
    "rejects session sqlite selectors without session sqlite mode %s",
    async (_label, json, args) => {
      const message =
        "doctor session SQLite options require --session-sqlite. Use `openclaw doctor --session-sqlite dry-run ...`.";

      await runMaintenanceCli(["doctor", ...args]);

      expect(doctorCommand).not.toHaveBeenCalled();
      expect(runDoctorLintCli).not.toHaveBeenCalled();
      if (json) {
        expect(runtime.writeJson).toHaveBeenCalledWith({ error: message });
        expect(runtime.error).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).toHaveBeenCalledWith(message);
        expect(runtime.writeJson).not.toHaveBeenCalled();
      }
      expect(runtime.exit).toHaveBeenCalledWith(2);
    },
  );

  it("runs doctor lint mode without invoking repair doctor", async () => {
    runDoctorLintCli.mockResolvedValue(1);

    await runMaintenanceCli([
      "doctor",
      "--lint",
      "--json",
      "--severity-min",
      "error",
      "--all",
      "--skip",
      "a",
      "--only",
      "b",
      "--allow-exec",
    ]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).toHaveBeenCalledWith(runtime, {
      json: true,
      severityMin: "error",
      includeAllChecks: true,
      skipIds: ["a"],
      onlyIds: ["b"],
      allowExec: true,
      deep: false,
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps bare --json advisory while preserving machine-readable findings", async () => {
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    runDoctorLintCli.mockImplementationOnce(async () => {
      process.stdout.write(
        '{"ok":false,"checksRun":1,"checksSkipped":0,"findings":[{"checkId":"core/example","severity":"error","message":"broken"}]}\n',
      );
      return 1;
    });

    try {
      await runMaintenanceCli(["doctor", "--json"]);

      expect(doctorCommand).not.toHaveBeenCalled();
      expect(runDoctorLintCli).toHaveBeenCalledWith(runtime, {
        json: true,
        severityMin: undefined,
        includeAllChecks: false,
        skipIds: [],
        onlyIds: [],
        allowExec: false,
        deep: false,
      });
      expect(JSON.parse(output.join(""))).toEqual({
        ok: false,
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          {
            checkId: "core/example",
            severity: "error",
            message: "broken",
          },
        ],
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    } finally {
      writeSpy.mockRestore();
      runDoctorLintCli.mockReset();
    }
  });

  it("rejects JSON repair mode before running doctor", async () => {
    const message =
      "doctor --json runs read-only lint checks and cannot be combined with --repair, --fix, or --force.";

    await runMaintenanceCli(["doctor", "--json", "--repair"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith({ error: message });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("rejects lint selectors outside doctor lint mode", async () => {
    await runMaintenanceCli(["doctor", "--fix", "--only", "policy/channels-denied-provider"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("writes JSON when another Doctor machine mode rejects lint selectors", async () => {
    const message = "doctor lint options require --lint. Use `openclaw doctor --lint ...`.";

    await runMaintenanceCli(["doctor", "--post-upgrade", "--json", "--only", "core/example"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith({ error: message });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("rejects --all outside doctor lint mode", async () => {
    await runMaintenanceCli(["doctor", "--all"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("writes JSON to stdout when doctor JSON mode fails before findings are emitted", async () => {
    runDoctorLintCli.mockRejectedValue(new Error("lint failed"));

    await runMaintenanceCli(["doctor", "--json"]);

    expect(runtime.writeJson).toHaveBeenCalledWith({ error: "lint failed" });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("keeps Doctor lint failures on stderr for an interactive terminal", async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    runDoctorLintCli.mockRejectedValue(new Error("lint failed"));

    try {
      await runMaintenanceCli(["doctor", "--lint"]);

      expect(runtime.error).toHaveBeenCalledWith("lint failed");
      expect(runtime.writeJson).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(2);
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });

  it("rejects lint-only selectors outside lint mode", async () => {
    await runMaintenanceCli(["doctor", "--only", "core/example"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("passes output options to dashboard command", async () => {
    dashboardCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["dashboard", "--no-open", "--json"]);

    expect(dashboardCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(dashboardCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.noOpen).toBe(true);
    expect(options.json).toBe(true);
  });

  it("passes reset options to reset command", async () => {
    resetCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "reset",
      "--scope",
      "full",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(resetCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(resetCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.scope).toBe("full");
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("passes uninstall options to uninstall command", async () => {
    uninstallCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "uninstall",
      "--service",
      "--state",
      "--workspace",
      "--app",
      "--all",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(uninstallCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(uninstallCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.service).toBe(true);
    expect(options.state).toBe(true);
    expect(options.workspace).toBe(true);
    expect(options.app).toBe(true);
    expect(options.all).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("exits with code 1 when dashboard fails", async () => {
    dashboardCommand.mockRejectedValue(new Error("dashboard failed"));

    await runMaintenanceCli(["dashboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: dashboard failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
