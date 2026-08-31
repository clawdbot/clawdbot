// Error output tests cover program-level error display and exit messaging.
import { CommanderError, InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { createCronOutputCommand, isCronMachineOutput } from "../cron-cli/output-mode.js";
import { isDevicesMachineOutput } from "../devices-output-mode.js";
import { ExpectedCliError, formatCliJsonFailure } from "../failure-output.js";
import {
  isJsonOutputModeActive,
  withConsoleLogsRoutedToStderrForJson,
} from "../json-output-mode.js";
import { isNodesMachineOutput } from "../nodes-cli/output-mode.js";
import { isProxyMachineOutput } from "../proxy-output-mode.js";
import { isSkillsMachineOutput } from "../skills-output-mode.js";
import { isSystemMachineOutput } from "../system-output-mode.js";
import {
  getCommanderErrorCommandNames,
  getCommanderErrorCommandPath,
} from "./commander-parse-facts.js";
import {
  createCliParseError,
  createCliUnknownCommandError,
  formatCliParseErrorOutput,
} from "./error-output.js";
import { setCommandJsonMode } from "./json-mode.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerLazyCommand } from "./register-lazy-command.js";

async function parseLazyGroupError(params: {
  argv: string[];
  group: string;
  subcommands: Array<{ name: string; aliases?: string[] }>;
}): Promise<{ error: CommanderError; output: string; stdout: string }> {
  const originalArgv = process.argv;
  process.argv = ["node", "openclaw", ...params.argv];
  let output = "";
  let stdout = "";
  try {
    const program = new OpenClawCommand().name("openclaw").exitOverride();
    program.configureOutput({
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        output += value;
      },
      outputError: (value, write) => {
        write(
          formatCliParseErrorOutput(value, {
            argv: process.argv,
            commandPath: getCommanderErrorCommandPath(program),
            commandNames: getCommanderErrorCommandNames(program),
          }),
        );
      },
    });
    registerLazyCommand({
      program,
      name: params.group,
      description: `${params.group} commands`,
      register: () => {
        const group = program.command(params.group).action(() => {});
        for (const subcommand of params.subcommands) {
          const command = group.command(subcommand.name).action(() => {});
          for (const alias of subcommand.aliases ?? []) {
            command.alias(alias);
          }
        }
      },
    });

    const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommanderError);
    return { error: error as CommanderError, output, stdout };
  } finally {
    process.argv = originalArgv;
  }
}

describe("formatCliParseErrorOutput", () => {
  it.each([
    {
      name: "automation lookup",
      args: ["cron", "get"],
      root: "cron",
      children: ["get"],
      argument: "<id>",
      message: 'Missing required argument "id".',
      machineOutput: isCronMachineOutput,
    },
    {
      name: "profiled automation alias",
      args: ["--profile", "work", "automations", "runs"],
      root: "cron",
      alias: "automations",
      children: ["runs"],
      requiredOption: "--id <id>",
      message: 'Missing required option "--id <id>".',
      machineOutput: isCronMachineOutput,
    },
    {
      name: "raw automation scratch",
      args: ["cron", "scratch"],
      root: "cron",
      children: ["scratch"],
      argument: "<id>",
      message: 'Missing required argument "id".',
      machineOutput: isCronMachineOutput,
    },
    {
      name: "skill verification",
      args: ["skills", "verify"],
      root: "skills",
      children: ["verify"],
      argument: "<ref>",
      message: 'Missing required argument "ref".',
      machineOutput: isSkillsMachineOutput,
    },
    {
      name: "node invocation",
      args: ["nodes", "invoke"],
      root: "nodes",
      children: ["invoke"],
      requiredOption: "--node <id>",
      message: 'Missing required option "--node <id>".',
      machineOutput: isNodesMachineOutput,
    },
    {
      name: "node approval",
      args: ["nodes", "approve"],
      root: "nodes",
      children: ["approve"],
      argument: "<requestId>",
      message: 'Missing required argument "requestId".',
      machineOutput: isNodesMachineOutput,
    },
    {
      name: "device rotation",
      args: ["devices", "rotate"],
      root: "devices",
      children: ["rotate"],
      requiredOption: "--device <id>",
      message: 'Missing required option "--device <id>".',
      machineOutput: isDevicesMachineOutput,
    },
    {
      name: "raw proxy blob",
      args: ["proxy", "blob"],
      root: "proxy",
      children: ["blob"],
      argument: "<blobId>",
      message: 'Missing required argument "blobId".',
      machineOutput: isProxyMachineOutput,
    },
    {
      name: "nested system heartbeat",
      args: ["system", "heartbeat", "last", "--unknown"],
      root: "system",
      children: ["heartbeat", "last"],
      message: 'OpenClaw does not recognize option "--unknown".',
      machineOutput: isSystemMachineOutput,
    },
  ])("keeps $name parse failures machine-readable by default", async (testCase) => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", ...testCase.args];
    try {
      const program = new OpenClawCommand()
        .name("openclaw")
        .enablePositionalOptions()
        .option("--profile <name>")
        .exitOverride();
      program.configureOutput({ writeErr: () => {} });
      const root = program.command(testCase.root);
      if (testCase.alias) {
        root.alias(testCase.alias);
      }
      setCommandJsonMode(root, "output", ({ argv }) => testCase.machineOutput(argv));

      let command = root;
      for (const child of testCase.children) {
        command =
          testCase.root === "cron"
            ? createCronOutputCommand(command, child as "get" | "runs" | "scratch")
            : command.command(child).option("--json");
      }
      if (testCase.argument) {
        command.argument(testCase.argument);
      }
      if (testCase.requiredOption) {
        command.requiredOption(testCase.requiredOption);
      }
      command.action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(true);
          expect(formatCliJsonFailure(error)).toEqual({
            ok: false,
            error: {
              type: "cli_error",
              message: expect.stringContaining(testCase.message),
            },
          });
        },
        { machineOutput: testCase.machineOutput(process.argv), restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("keeps a consumed JSON spelling machine-readable when the command owns JSON by default", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "cron", "status", "--limit", "--json"];
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({ writeErr: () => {} });
      const cron = program.command("cron");
      setCommandJsonMode(cron, "output", ({ argv }) => isCronMachineOutput(argv));
      createCronOutputCommand(cron, "status")
        .option("--limit <value>", "Result limit", () => {
          throw new InvalidArgumentError("--limit must be a positive integer.");
        })
        .action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(true);
          expect((error as ExpectedCliError).message).toContain(
            "--limit must be a positive integer.",
          );
        },
        { machineOutput: true, restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    { name: "human automation", args: ["cron", "show"], root: "cron", child: "show" },
    {
      name: "parse-only config",
      args: ["config", "set", "gateway.port", "--json"],
      root: "config",
      child: "set",
    },
    {
      name: "human skill card",
      args: ["skills", "verify", "--card"],
      root: "skills",
      child: "verify",
    },
  ])("keeps $name parse failures on the human error path", async (testCase) => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", ...testCase.args];
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({ writeErr: () => {} });
      const root = program.command(testCase.root);
      if (testCase.root === "cron") {
        setCommandJsonMode(root, "output", ({ argv }) => isCronMachineOutput(argv));
      } else if (testCase.root === "skills") {
        setCommandJsonMode(root, "output", ({ argv }) => isSkillsMachineOutput(argv));
      }
      const command = root.command(testCase.child).argument("<id>").option("--json");
      if (testCase.root === "config") {
        command.argument("<value>");
        setCommandJsonMode(command, "parse-only", () => true);
      } else if (testCase.root === "skills") {
        command.option("--card");
      }
      command.action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(CommanderError);
          expect(error).not.toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(false);
        },
        { restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("keeps successful machine-command help outside the JSON failure path", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "cron", "get", "--help"];
    let stdout = "";
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({
        writeOut: (output) => {
          stdout += output;
        },
        writeErr: () => {},
      });
      const cron = program.command("cron");
      setCommandJsonMode(cron, "output", ({ argv }) => isCronMachineOutput(argv));
      createCronOutputCommand(cron, "get")
        .argument("<id>")
        .action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(CommanderError);
          expect((error as CommanderError).exitCode).toBe(0);
          expect(stdout).toContain("Usage: openclaw cron get");
          expect(isJsonOutputModeActive(process.argv)).toBe(false);
        },
        { machineOutput: true, restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    { label: "JSON spelling", value: "--json", supportsJson: true },
    { label: "true-valued JSON spelling", value: "--json=true", supportsJson: true },
    { label: "false-valued JSON spelling", value: "--json=false", supportsJson: true },
    { label: "command without JSON output", value: "--json", supportsJson: false },
    {
      label: "JSON spelling before a positional terminator",
      value: "--json",
      supportsJson: true,
      suffix: ["--", "--json"],
    },
    {
      label: "JSON spelling after a short option alias",
      value: "--json",
      supportsJson: true,
      flag: "-l",
    },
  ])("keeps a consumed $label as a human parse error", async (testCase) => {
    const { value, supportsJson } = testCase;
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "openclaw",
      "--profile",
      "work",
      "p",
      "s",
      testCase.flag ?? "--limit",
      value,
      ...(testCase.suffix ?? []),
    ];
    let stderr = "";
    try {
      const program = new OpenClawCommand()
        .name("openclaw")
        .enablePositionalOptions()
        .option("--profile <name>")
        .exitOverride();
      program.configureOutput({
        writeErr: (output) => {
          stderr += output;
        },
      });
      const command = program
        .command("plugins")
        .alias("p")
        .command("search")
        .alias("s")
        .option("-l, --limit <value>", "Result limit", () => {
          throw new InvalidArgumentError("--limit must be a positive integer.");
        });
      if (supportsJson) {
        command.option("--json", "Output JSON");
      }

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(CommanderError);
          expect(error).not.toBeInstanceOf(ExpectedCliError);
          expect((error as CommanderError).exitCode).toBe(1);
          expect(stderr).toContain("--limit must be a positive integer.");
          expect(isJsonOutputModeActive(process.argv)).toBe(false);
        },
        { restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    { label: "before an invalid value", args: ["--json", "--limit", "bad"] },
    { label: "after an invalid value", args: ["--limit", "bad", "--json"] },
    { label: "before a consumed JSON value", args: ["--json", "--limit", "--json"] },
    { label: "after a consumed JSON value", args: ["--limit", "--json", "--json"] },
    { label: "after a consumed valued JSON token", args: ["--limit", "--json=true", "--json"] },
  ])("preserves a genuine JSON request $label", async ({ args }) => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "plugins", "search", ...args];
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({ writeErr: () => {} });
      program
        .command("plugins")
        .command("search")
        .option("--json", "Output JSON")
        .option("--limit <value>", "Result limit", () => {
          throw new InvalidArgumentError("--limit must be a positive integer.");
        });

      const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ExpectedCliError);
      expect((error as ExpectedCliError).message).toContain("--limit must be a positive integer.");
    } finally {
      process.argv = originalArgv;
    }
  });

  it("preserves JSON diagnostics for an unsupported but genuine output flag", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "fleet", "logs", "--json"];
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({ writeErr: () => {} });
      program
        .command("fleet")
        .command("logs")
        .action(() => {});

      const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ExpectedCliError);
      expect((error as ExpectedCliError).message).toContain("--json");
    } finally {
      process.argv = originalArgv;
    }
  });

  it("uses the same structured root diagnostic as the human renderer", () => {
    const error = createCliUnknownCommandError("pairng", {
      argv: ["node", "openclaw", "pairng", "--json"],
    });

    expect(error.message).toBe('OpenClaw does not know the command "pairng".');
    expect(error.humanOutput).toBe(
      'OpenClaw does not know the command "pairng".\nDid you mean this?\n  openclaw pairing\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("strips Commander framing from structured nested diagnostics", () => {
    const error = createCliParseError("error: unknown command 'lst'", {
      argv: ["node", "openclaw", "sessions", "lst", "--json"],
      commandPath: ["sessions"],
      commandNames: ["list"],
    });

    expect(error.message).toBe('OpenClaw sessions has no command "lst".');
    expect(error.message).not.toMatch(/^error:/i);
    expect(error.humanOutput).toContain("Did you mean this?\n  openclaw sessions list\n");
  });

  it("explains unknown commands with root help and plugin hints", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'wat'\n", {
      argv: ["node", "openclaw", "wat"],
    });

    expect(output).toBe(
      'OpenClaw does not know the command "wat".\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("explains unknown subcommands within the active command tree", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'list'\n", {
      argv: ["node", "openclaw", "webhooks", "list"],
      commandPath: ["webhooks"],
    });

    expect(output).toBe(
      'OpenClaw webhooks has no command "list".\nTry: openclaw webhooks --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("suggests sibling subcommands within the active command tree", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'gmial'\n", {
      argv: ["node", "openclaw", "webhooks", "gmial"],
      commandPath: ["webhooks"],
      commandNames: ["gmail"],
    });

    expect(output).toBe(
      'OpenClaw webhooks has no command "gmial".\nDid you mean this?\n  openclaw webhooks gmail\nTry: openclaw webhooks --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("reports an unmatched lazy subcommand and suggests a live child command", async () => {
    const { error, output } = await parseLazyGroupError({
      argv: ["sessions", "lst"],
      group: "sessions",
      subcommands: [{ name: "list" }, { name: "cleanup" }],
    });

    expect(error.code).toBe("commander.unknownCommand");
    expect(output).toBe(
      'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("suggests a live child command when later arguments follow the typo", async () => {
    const { error, output } = await parseLazyGroupError({
      argv: ["config", "gett", "gateway.port"],
      group: "config",
      subcommands: [{ name: "get" }, { name: "set" }],
    });

    expect(error.code).toBe("commander.unknownCommand");
    expect(output).toBe(
      'OpenClaw config has no command "gett".\nDid you mean this?\n  openclaw config get\nTry: openclaw config --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("reports an unmatched lazy subcommand before --help can hide it", async () => {
    const { error, output, stdout } = await parseLazyGroupError({
      argv: ["sessions", "lst", "--help"],
      group: "sessions",
      subcommands: [{ name: "list" }, { name: "cleanup" }],
    });

    expect(error.code).toBe("commander.unknownCommand");
    expect(error.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(output).toBe(
      'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("loads a real lazy subcommand before showing its help", async () => {
    const { error, output, stdout } = await parseLazyGroupError({
      argv: ["sessions", "list", "--help"],
      group: "sessions",
      subcommands: [{ name: "list" }, { name: "cleanup" }],
    });

    expect(error.code).toBe("commander.helpDisplayed");
    expect(error.exitCode).toBe(0);
    expect(output).toBe("");
    expect(stdout).toContain("Usage: openclaw sessions list [options]");
  });

  it("suggests aliases from the live child command tree", async () => {
    const { error, output } = await parseLazyGroupError({
      argv: ["cron", "remov"],
      group: "cron",
      subcommands: [{ name: "rm", aliases: ["remove", "delete"] }, { name: "edit" }],
    });

    expect(error.code).toBe("commander.unknownCommand");
    expect(output).toContain("Did you mean this?\n  openclaw cron remove\n");
  });

  it("keeps excess arguments on a matched lazy subcommand", async () => {
    const { error, output } = await parseLazyGroupError({
      argv: ["sessions", "list", "extra1", "extra2"],
      group: "sessions",
      subcommands: [{ name: "list" }],
    });

    expect(error.code).toBe("commander.excessArguments");
    expect(output).toBe(
      "Too many arguments for this command.\nTry: openclaw sessions list --help\n",
    );
  });

  it("suggests close known commands for unknown commands", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upate'\n", {
      argv: ["node", "openclaw", "upate"],
    });

    expect(output).toBe(
      'OpenClaw does not know the command "upate".\nDid you mean this?\n  openclaw update\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("suggests explicit aliases for common adjacent terminology", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upgrade'\n", {
      argv: ["node", "openclaw", "upgrade"],
    });

    expect(output).toContain("Did you mean this?\n  openclaw update\n");
  });

  it("preserves active profile context in command suggestions", () => {
    const originalProfile = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "work";
    try {
      const output = formatCliParseErrorOutput("error: unknown command 'doctr'\n", {
        argv: ["node", "openclaw", "doctr"],
      });

      expect(output).toContain("Did you mean this?\n  openclaw --profile work doctor\n");
    } finally {
      if (originalProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = originalProfile;
      }
    }
  });

  it("points unknown options at the active command help", () => {
    const output = formatCliParseErrorOutput("error: unknown option '--wat'\n", {
      argv: ["node", "openclaw", "channels", "status", "--wat"],
    });

    expect(output).toBe(
      'OpenClaw does not recognize option "--wat".\nTry: openclaw channels status --help\n',
    );
  });

  it("points missing required arguments at command help", () => {
    const output = formatCliParseErrorOutput("error: missing required argument 'name'\n", {
      argv: ["node", "openclaw", "plugins", "install"],
    });

    expect(output).toBe(
      'Missing required argument "name".\nTry: openclaw plugins install --help\n',
    );
  });

  it("prefers the parsed Commander path over option-like argv values", () => {
    const output = formatCliParseErrorOutput("error: unknown option '--wat'\n", {
      argv: ["node", "openclaw", "plugins", "--source", "install", "list", "--wat"],
      commandPath: ["plugins", "list"],
    });

    expect(output).toBe(
      'OpenClaw does not recognize option "--wat".\nTry: openclaw plugins list --help\n',
    );
  });
});
