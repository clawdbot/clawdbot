// Help tests cover command help generation and inherited help options.
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { OpenClawCommand } from "./openclaw-command.js";

const hasEmittedCliBannerMock = vi.hoisted(() => vi.fn(() => false));
const formatCliBannerLineMock = vi.hoisted(() => vi.fn(() => "BANNER-LINE"));
const formatDocsLinkMock = vi.hoisted(() =>
  vi.fn((_path: string, full: string) => `https://${full}`),
);
const resolveCommitHashMock = vi.hoisted(() => vi.fn<() => string | null>(() => "abc1234"));

vi.mock("../../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: formatDocsLinkMock,
}));

vi.mock("../../../packages/terminal-core/src/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (s: string) => s,
    muted: (s: string) => s,
    option: (s: string) => s,
    command: (s: string) => s,
    error: (s: string) => s,
  },
}));

vi.mock("../banner.js", () => ({
  formatCliBannerLine: formatCliBannerLineMock,
  hasEmittedCliBanner: hasEmittedCliBannerMock,
}));

vi.mock("../../infra/git-commit.js", () => ({
  resolveCommitHash: resolveCommitHashMock,
}));

vi.mock("./command-registry.js", () => ({
  getCoreCliCommandsWithSubcommands: () => ["models", "message"],
}));

vi.mock("./register.subclis.js", () => ({
  getSubCliCommandsWithSubcommands: () => ["gateway"],
}));

const testProgramContext: ProgramContext = {
  programVersion: "9.9.9-test",
  channelOptions: ["quietchat"],
  messageChannelOptions: "quietchat",
  agentChannelOptions: "last|quietchat",
};

describe("configureProgramHelp", () => {
  let originalArgv: string[];
  let originalSuppressHelpBanner: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    originalSuppressHelpBanner = process.env.OPENCLAW_SUPPRESS_HELP_BANNER;
    hasEmittedCliBannerMock.mockReturnValue(false);
    resolveCommitHashMock.mockReturnValue("abc1234");
    delete process.env.OPENCLAW_SUPPRESS_HELP_BANNER;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalSuppressHelpBanner === undefined) {
      delete process.env.OPENCLAW_SUPPRESS_HELP_BANNER;
    } else {
      process.env.OPENCLAW_SUPPRESS_HELP_BANNER = originalSuppressHelpBanner;
    }
  });

  function makeProgramWithCommands() {
    const program = new Command();
    program.command("models").description("models");
    program.command("status").description("status");
    return program;
  }

  function captureHelpOutput(program: Command): string {
    let output = "";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      program.outputHelp();
      return output;
    } finally {
      writeSpy.mockRestore();
    }
  }

  function expectVersionExit(params: { expectedVersion: string }) {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ""}`);
    }) as typeof process.exit);

    try {
      const program = makeProgramWithCommands();
      expect(() => configureProgramHelp(program, testProgramContext)).toThrow("exit:0");
      expect(logSpy).toHaveBeenCalledWith(params.expectedVersion);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }

  async function parseHelp(argv: string[]) {
    process.argv = ["node", "openclaw", ...argv];
    let stdout = "";
    let stderr = "";
    const program = new OpenClawCommand().enablePositionalOptions().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.configureOutput({
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    });
    const plugins = program.command("plugins").description("Manage plugins");
    plugins
      .command("list")
      .description("List plugins")
      .action(() => {});

    const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommanderError);
    return { error: error as CommanderError, stderr, stdout };
  }

  it("adds root help hint and marks commands with subcommands", () => {
    process.argv = ["node", "openclaw", "--help"];
    const program = makeProgramWithCommands();
    configureProgramHelp(program, testProgramContext);

    const help = captureHelpOutput(program);
    expect(help).toContain("Hint: commands suffixed with * have subcommands");
    expect(help).toContain("models *");
    expect(help).toContain("status");
    expect(help).not.toContain("status *");
  });

  it("includes banner and docs/examples in root help output", () => {
    process.argv = ["node", "openclaw", "--help"];
    const program = makeProgramWithCommands();
    configureProgramHelp(program, testProgramContext);

    const help = captureHelpOutput(program);
    expect(help).toContain("BANNER-LINE");
    const [version, options] = (formatCliBannerLineMock.mock.calls[0] as unknown as
      | [string, { mode?: string }]
      | undefined) ?? [undefined, undefined];
    expect(version).toBe(testProgramContext.programVersion);
    expect(options?.mode).toBe("default");
    expect(help).toContain("Examples:");
    expect(help).toContain("https://docs.openclaw.ai/cli");
  });

  it("keeps valid root, group, subcommand, short, and help-command output successful", async () => {
    const rootHelp = await parseHelp(["--help"]);
    const shortHelp = await parseHelp(["-h"]);
    const groupHelp = await parseHelp(["plugins", "--help"]);
    const subcommandHelp = await parseHelp(["plugins", "list", "--help"]);
    const helpCommand = await parseHelp(["help", "plugins"]);

    for (const result of [rootHelp, shortHelp, groupHelp, subcommandHelp, helpCommand]) {
      expect(result.error.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(rootHelp.error.code).toBe("commander.helpDisplayed");
    expect(shortHelp.stdout).toBe(rootHelp.stdout);
    expect(groupHelp.stdout).toContain("Usage: openclaw plugins [options] [command]");
    expect(subcommandHelp.stdout).toContain("Usage: openclaw plugins list [options]");
    expect(helpCommand.stdout).toBe(groupHelp.stdout);
  });

  it("formats parse errors from the exact Commander command path", async () => {
    let stderr = "";
    process.argv = ["node", "openclaw", "plugins", "--source", "list", "list", "--wat"];
    const program = new OpenClawCommand().enablePositionalOptions().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.configureOutput({
      writeErr: (value) => {
        stderr += value;
      },
    });
    program
      .command("plugins")
      .option("--source <source>")
      .command("list")
      .action(() => {});

    const firstError = await program.parseAsync(process.argv).catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(CommanderError);
    process.argv = ["node", "openclaw", "plugins", "list", "--still-wat"];
    const secondError = await program.parseAsync(process.argv).catch((error: unknown) => error);
    expect(secondError).toBeInstanceOf(CommanderError);
    process.argv = ["node", "openclaw", "plugins", "lis"];
    const thirdError = await program.parseAsync(process.argv).catch((error: unknown) => error);
    expect(thirdError).toBeInstanceOf(CommanderError);

    expect(stderr.match(/Try: openclaw plugins list --help/g)).toHaveLength(2);
    expect(stderr).not.toContain("openclaw plugins list list --help");
    expect(stderr).toContain("Did you mean this?\n  openclaw plugins list\n");
  });

  it("suppresses banner formatting when parent default help requests it", () => {
    process.argv = ["node", "openclaw", "channels"];
    process.env.OPENCLAW_SUPPRESS_HELP_BANNER = "1";
    const program = makeProgramWithCommands();
    configureProgramHelp(program, testProgramContext);

    const help = captureHelpOutput(program);
    expect(help).not.toContain("BANNER-LINE");
    expect(formatCliBannerLineMock).not.toHaveBeenCalled();
  });

  it("prints version and exits immediately when version flags are present", () => {
    process.argv = ["node", "openclaw", "--version"];
    expectVersionExit({ expectedVersion: "OpenClaw 9.9.9-test (abc1234)" });
  });

  it("prints version and exits immediately without commit metadata", () => {
    process.argv = ["node", "openclaw", "--version"];
    resolveCommitHashMock.mockReturnValue(null);
    expectVersionExit({ expectedVersion: "OpenClaw 9.9.9-test" });
  });

  it("does not treat subcommand --version options as root version requests", () => {
    process.argv = ["node", "openclaw", "skills", "verify", "discrawl", "--version", "1.0.0"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ""}`);
    }) as typeof process.exit);

    try {
      const program = makeProgramWithCommands();
      expect(() => configureProgramHelp(program, testProgramContext)).not.toThrow();
      expect(logSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
