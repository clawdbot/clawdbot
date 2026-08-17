// Error output tests cover program-level error display and exit messaging.
import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";
import {
  getCommanderErrorCommandNames,
  getCommanderErrorCommandPath,
} from "./commander-parse-facts.js";
import {
  createCliParseError,
  createCliUnknownCommandError,
  formatCliParseErrorOutput,
} from "./error-output.js";
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
