// Argv tests cover CLI argument parsing helpers and platform-specific normalization.
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPositionalsWithRootOptions,
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
  isRootVersionInvocation,
  isSimpleCommandHelpInvocation,
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    [
      "known command group help command help flag",
      ["node", "openclaw", "backup", "help", "--help"],
      ["node", "openclaw", "backup", "help"],
    ],
    [
      "known command group help command short help flag",
      ["node", "openclaw", "--profile", "work", "backup", "help", "-h"],
      ["node", "openclaw", "--profile", "work", "backup", "help"],
    ],
    [
      "leaf positional help remains untouched",
      ["node", "openclaw", "docs", "help", "--help"],
      ["node", "openclaw", "docs", "help", "--help"],
    ],
    [
      "known command group help target",
      ["node", "openclaw", "plugins", "help", "list"],
      ["node", "openclaw", "plugins", "list", "--help"],
    ],
    [
      "known command group help target help flag",
      ["node", "openclaw", "plugins", "help", "list", "--help"],
      ["node", "openclaw", "plugins", "list", "--help"],
    ],
    [
      "unknown plugin command group help target",
      ["node", "openclaw", "external-plugin", "help", "inspect"],
      ["node", "openclaw", "external-plugin", "inspect", "--help"],
    ],
    [
      "unknown plugin command group help target help flag",
      ["node", "openclaw", "external-plugin", "help", "inspect", "--help"],
      ["node", "openclaw", "external-plugin", "inspect", "--help"],
    ],
    [
      "generated help target with trailing root option",
      ["node", "openclaw", "memory", "help", "status", "--no-color"],
      ["node", "openclaw", "--no-color", "memory", "status", "--help"],
    ],
    [
      "extra help positionals remain untouched",
      ["node", "openclaw", "backup", "help", "missing", "extra", "--help"],
      ["node", "openclaw", "backup", "help", "missing", "extra", "--help"],
    ],
    [
      "terminator help flag remains untouched",
      ["node", "openclaw", "backup", "help", "--", "--help"],
      ["node", "openclaw", "backup", "help", "--", "--help"],
    ],
  ])("normalizes generated help commands: %s", (_name, argv, expected) => {
    expect(normalizeGeneratedHelpCommandArgv(argv)).toEqual(expected);
  });

  it.each([
    [
      "root help target",
      ["node", "openclaw", "help", "plugins"],
      ["node", "openclaw", "plugins", "--help"],
    ],
    [
      "root help target with help flag",
      ["node", "openclaw", "help", "plugins", "--help"],
      ["node", "openclaw", "plugins", "--help"],
    ],
    [
      "root option before help target",
      ["node", "openclaw", "--profile", "work", "help", "memory"],
      ["node", "openclaw", "--profile", "work", "memory", "--help"],
    ],
    [
      "bare root help remains untouched",
      ["node", "openclaw", "help"],
      ["node", "openclaw", "help"],
    ],
    [
      "root help self-help remains untouched",
      ["node", "openclaw", "help", "--help"],
      ["node", "openclaw", "help", "--help"],
    ],
    [
      "nested root help target",
      ["node", "openclaw", "help", "plugins", "list"],
      ["node", "openclaw", "plugins", "list", "--help"],
    ],
    [
      "nested root help target with help flag",
      ["node", "openclaw", "help", "plugins", "list", "--help"],
      ["node", "openclaw", "plugins", "list", "--help"],
    ],
    [
      "nested root help target with trailing root option",
      ["node", "openclaw", "help", "memory", "status", "--no-color"],
      ["node", "openclaw", "--no-color", "memory", "status", "--help"],
    ],
  ])("normalizes root help targets: %s", (_name, argv, expected) => {
    expect(normalizeRootHelpTargetArgv(argv)).toEqual(expected);
  });

  it.each([
    [
      "subcommand trailing no-color",
      ["node", "openclaw", "doctor", "--no-color", "--post-upgrade", "--json"],
      ["node", "openclaw", "--no-color", "doctor", "--post-upgrade", "--json"],
    ],
    [
      "keeps existing root options first",
      ["node", "openclaw", "--profile", "work", "doctor", "--no-color", "--lint", "--json"],
      ["node", "openclaw", "--profile", "work", "--no-color", "doctor", "--lint", "--json"],
    ],
    [
      "keeps no-color after possible command option value",
      ["node", "openclaw", "doctor", "--lint", "--json", "--no-color"],
      ["node", "openclaw", "doctor", "--lint", "--json", "--no-color"],
    ],
    [
      "flag terminator leaves no-color positional",
      ["node", "openclaw", "doctor", "--", "--no-color"],
      ["node", "openclaw", "doctor", "--", "--no-color"],
    ],
    [
      "command option value remains literal",
      ["node", "openclaw", "agent", "--message", "--no-color"],
      ["node", "openclaw", "agent", "--message", "--no-color"],
    ],
    [
      "assigned command option value does not block no-color",
      ["node", "openclaw", "agent", "--message=hello", "--no-color"],
      ["node", "openclaw", "--no-color", "agent", "--message=hello"],
    ],
  ])("normalizes root --no-color before command parsing: %s", (_name, argv, expected) => {
    expect(normalizeRootNoColorArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift no-color after boolean command flags", () => {
    const argv = ["node", "openclaw", "doctor", "--lint", "--json", "--no-color"];

    expect(
      normalizeRootNoColorArgv(argv, {
        shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
          remainingArgs[noColorIndex - 1] === "--message",
      }),
    ).toEqual(["node", "openclaw", "--no-color", "doctor", "--lint", "--json"]);
  });

  it.each([
    [
      "subcommand trailing log-level",
      ["node", "openclaw", "doctor", "--log-level", "debug", "--json"],
      ["node", "openclaw", "--log-level", "debug", "doctor", "--json"],
    ],
    [
      "subcommand trailing log-level equals form",
      ["node", "openclaw", "doctor", "--log-level=trace", "--json"],
      ["node", "openclaw", "--log-level=trace", "doctor", "--json"],
    ],
    [
      "keeps existing root options first",
      ["node", "openclaw", "--profile", "work", "doctor", "--log-level", "debug"],
      ["node", "openclaw", "--profile", "work", "--log-level", "debug", "doctor"],
    ],
    [
      "keeps log-level after possible command option value",
      ["node", "openclaw", "agent", "--message", "--log-level", "debug"],
      ["node", "openclaw", "agent", "--message", "--log-level", "debug"],
    ],
    [
      "flag terminator leaves log-level positional",
      ["node", "openclaw", "nodes", "run", "--", "--log-level", "debug"],
      ["node", "openclaw", "nodes", "run", "--", "--log-level", "debug"],
    ],
    [
      "missing value remains command scoped",
      ["node", "openclaw", "doctor", "--log-level", "--json"],
      ["node", "openclaw", "doctor", "--log-level", "--json"],
    ],
  ])("normalizes root --log-level before command parsing: %s", (_name, argv, expected) => {
    expect(normalizeRootLogLevelArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift log-level after boolean command flags", () => {
    const argv = ["node", "openclaw", "doctor", "--lint", "--json", "--log-level", "debug"];

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex - 1] === "--message",
      }),
    ).toEqual(["node", "openclaw", "--log-level", "debug", "doctor", "--lint", "--json"]);
  });

  it("preserves log-level when final command metadata owns the option", () => {
    const argv = ["node", "openclaw", "plugin-cmd", "--log-level", "debug"];

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex] === "--log-level",
      }),
    ).toEqual(argv);
  });

  it.each([
    ["root help command", ["node", "openclaw", "help"], true],
    ["root help command with target", ["node", "openclaw", "help", "matrix"], true],
    ["nested help command", ["node", "openclaw", "matrix", "encryption", "help"], true],
    ["known subcommand root help command", ["node", "openclaw", "config", "help"], true],
    ["known leaf command positional help", ["node", "openclaw", "docs", "help"], false],
    [
      "known subcommand leaf positional help",
      ["node", "openclaw", "config", "set", "some.path", "help"],
      false,
    ],
    ["unknown plugin command help", ["node", "openclaw", "external-plugin", "tools", "help"], true],
    ["help flag", ["node", "openclaw", "matrix", "encryption", "--help"], true],
    ["help as option value", ["node", "openclaw", "agent", "--message", "help"], false],
    ["help after terminator", ["node", "openclaw", "nodes", "invoke", "--", "help"], false],
    [
      "implicit root help command after terminator",
      ["node", "openclaw", "--", "help", "config"],
      true,
    ],
    [
      "implicit parent help command after terminator",
      ["node", "openclaw", "config", "--", "help"],
      true,
    ],
    ["literal root help-looking command", ["node", "openclaw", "--", "--help"], false],
    ["literal parent help-looking command", ["node", "openclaw", "--", "config", "--help"], false],
    ["help flag after terminator", ["node", "openclaw", "nodes", "invoke", "--", "--help"], false],
    [
      "version flag after terminator",
      ["node", "openclaw", "nodes", "invoke", "--", "--version"],
      false,
    ],
    ["root version flag", ["node", "openclaw", "--version"], true],
    ["root short version flag", ["node", "openclaw", "-V"], true],
    ["root version alias after profile", ["node", "openclaw", "--profile", "work", "-v"], true],
    [
      "root version flag after profile",
      ["node", "openclaw", "--profile", "work", "--version"],
      true,
    ],
    [
      "version-pinned skill install",
      ["node", "openclaw", "skills", "install", "@owner/weather", "--version", "1.2.3"],
      false,
    ],
    [
      "version-pinned skill verification",
      ["node", "openclaw", "skills", "verify", "@owner/weather", "--version", "1.2.3"],
      false,
    ],
    [
      "equals-form version-pinned skill install",
      ["node", "openclaw", "skills", "install", "@owner/weather", "--version=1.2.3"],
      false,
    ],
    [
      "profiled version-pinned skill verification",
      [
        "node",
        "openclaw",
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ],
      false,
    ],
    [
      "help for a version-pinned skill command",
      ["node", "openclaw", "skills", "verify", "@owner/weather", "--version", "1.2.3", "--help"],
      true,
    ],
    [
      "unknown root option does not turn version into root help",
      ["node", "openclaw", "--unknown", "--version"],
      false,
    ],
  ])("detects help/version invocations: %s", (_name, argv, expected) => {
    expect(isHelpOrVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    { path: ["skills", "verify"], option: "tag" },
    { path: ["skills", "verify"], option: "version" },
    { path: ["models", "list"], option: "provider" },
    { path: ["agent"], option: "message" },
  ])("keeps actual help after a root-looking $option value on $path", async ({ path, option }) => {
    const program = new Command()
      .name("openclaw")
      .enablePositionalOptions()
      .option("--log-level <level>")
      .exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const leaf = path.reduce((parent, name) => parent.command(name), program);
    leaf.option(`--${option} <value>`);
    const argv = ["node", "openclaw", ...path, `--${option}`, "--log-level", "--help"];

    await expect(program.parseAsync(argv)).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0,
    });
    expect(leaf.opts()[option]).toBe("--log-level");
    expect(isHelpOrVersionInvocation(argv)).toBe(true);
  });

  it.each([
    ["root --version", ["node", "openclaw", "--version"], true],
    ["root -V", ["node", "openclaw", "-V"], true],
    ["root -v alias with profile", ["node", "openclaw", "--profile", "work", "-v"], true],
    ["subcommand version flag", ["node", "openclaw", "status", "--version"], false],
    ["unknown root flag with version", ["node", "openclaw", "--unknown", "--version"], false],
  ])("detects root-only version invocations: %s", (_name, argv, expected) => {
    expect(isRootVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    ["root --help", ["node", "openclaw", "--help"], true],
    ["root -h", ["node", "openclaw", "-h"], true],
    ["root --help with profile", ["node", "openclaw", "--profile", "work", "--help"], true],
    ["subcommand --help", ["node", "openclaw", "status", "--help"], false],
    ["help before subcommand token", ["node", "openclaw", "--help", "status"], false],
    [
      "help after -- terminator",
      ["node", "openclaw", "nodes", "invoke", "--", "device.status", "--help"],
      false,
    ],
    ["unknown root flag before help", ["node", "openclaw", "--unknown", "--help"], false],
    ["unknown root flag after help", ["node", "openclaw", "--help", "--unknown"], false],
  ])("detects root-only help invocations: %s", (_name, argv, expected) => {
    expect(isRootHelpInvocation(argv)).toBe(expected);
  });

  it.each([
    ["single command with trailing flag", ["node", "openclaw", "status", "--json"], ["status"]],
    ["two-part command", ["node", "openclaw", "agents", "list"], ["agents", "list"]],
    ["terminator cuts parsing", ["node", "openclaw", "status", "--", "ignored"], ["status"]],
  ])("extracts command path: %s", (_name, argv, expected) => {
    expect(getCommandPathWithRootOptions(argv, 2)).toEqual(expected);
  });

  it("extracts command path while skipping known root option values", () => {
    expect(
      getCommandPathWithRootOptions(
        [
          "node",
          "openclaw",
          "--profile",
          "work",
          "--container",
          "demo",
          "--no-color",
          "config",
          "validate",
        ],
        2,
      ),
    ).toEqual(["config", "validate"]);
  });

  it("limits simple help fast paths to root options, a command, and help", () => {
    const commands = new Set(["setup"]);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "openclaw", "--profile", "work", "setup", "--help"],
        commands,
      ),
    ).toBe(true);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "openclaw", "setup", "--workspace", "--help"],
        commands,
      ),
    ).toBe(false);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "openclaw", "setup", "--profile", "work", "--help"],
        commands,
      ),
    ).toBe(false);
    expect(isSimpleCommandHelpInvocation(["node", "openclaw", "--help", "setup"], commands)).toBe(
      false,
    );
  });

  it("extracts routed config get positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "openclaw", "config", "get", "--log-level", "debug", "update.channel", "--json"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("extracts routed config unset positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "openclaw", "config", "unset", "--profile", "work", "update.channel"],
        {
          commandPath: ["config", "unset"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("returns null when routed command sees unknown options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "openclaw", "config", "get", "--mystery", "value", "update.channel"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toBeNull();
  });

  it.each([
    ["returns first command token", ["node", "openclaw", "agents", "list"], "agents"],
    ["returns null when no command exists", ["node", "openclaw"], null],
    [
      "skips known root option values",
      ["node", "openclaw", "--log-level", "debug", "status"],
      "status",
    ],
  ])("returns primary command: %s", (_name, argv, expected) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    ["detects flag before terminator", ["node", "openclaw", "status", "--json"], "--json", true],
    ["ignores flag after terminator", ["node", "openclaw", "--", "--json"], "--json", false],
  ])("parses boolean flags: %s", (_name, argv, flag, expected) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    ["value in next token", ["node", "openclaw", "status", "--timeout", "5000"], "5000"],
    ["value in equals form", ["node", "openclaw", "status", "--timeout=2500"], "2500"],
    ["missing value", ["node", "openclaw", "status", "--timeout"], null],
    ["next token is another flag", ["node", "openclaw", "status", "--timeout", "--json"], null],
    ["flag appears after terminator", ["node", "openclaw", "--", "--timeout=99"], undefined],
    [
      "repeated flag uses final value",
      ["node", "openclaw", "status", "--timeout", "100", "--timeout=200"],
      "200",
    ],
    [
      "missing repeated value remains invalid",
      ["node", "openclaw", "status", "--timeout", "--timeout", "200"],
      null,
    ],
  ])("extracts flag values: %s", (_name, argv, expected) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "openclaw", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    ["missing flag", ["node", "openclaw", "status"], undefined],
    ["missing value", ["node", "openclaw", "status", "--timeout"], null],
    ["valid positive integer", ["node", "openclaw", "status", "--timeout", "5000"], 5000],
    [
      "valid signed decimal positive integer",
      ["node", "openclaw", "status", "--timeout", "+5000"],
      5000,
    ],
    ["invalid integer", ["node", "openclaw", "status", "--timeout", "nope"], null],
    ["non-decimal integer", ["node", "openclaw", "status", "--timeout", "0x10"], null],
    ["partial integer", ["node", "openclaw", "status", "--timeout", "5s"], null],
    ["zero", ["node", "openclaw", "status", "--timeout", "0"], null],
    ["negative integer", ["node", "openclaw", "status", "--timeout", "-5"], null],
    [
      "repeated value uses final valid integer",
      ["node", "openclaw", "status", "--timeout", "nope", "--timeout", "5000"],
      5000,
    ],
    [
      "repeated value rejects final invalid integer",
      ["node", "openclaw", "status", "--timeout", "5000", "--timeout", "nope"],
      null,
    ],
  ])("parses positive integer flag values: %s", (_name, argv, expected) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it.each([
    ["keeps plain node argv", ["node", "openclaw", "status"], ["node", "openclaw", "status"]],
    [
      "keeps version-suffixed node binary",
      ["node-22", "openclaw", "status"],
      ["node-22", "openclaw", "status"],
    ],
    [
      "keeps windows versioned node exe",
      ["node-22.2.0.exe", "openclaw", "status"],
      ["node-22.2.0.exe", "openclaw", "status"],
    ],
    [
      "keeps dotted node binary",
      ["node-22.2", "openclaw", "status"],
      ["node-22.2", "openclaw", "status"],
    ],
    [
      "keeps dotted node exe",
      ["node-22.2.exe", "openclaw", "status"],
      ["node-22.2.exe", "openclaw", "status"],
    ],
    [
      "keeps absolute versioned node path",
      ["/usr/bin/node-22.2.0", "openclaw", "status"],
      ["/usr/bin/node-22.2.0", "openclaw", "status"],
    ],
    ["keeps node24 shorthand", ["node24", "openclaw", "status"], ["node24", "openclaw", "status"]],
    [
      "keeps absolute node24 shorthand",
      ["/usr/bin/node24", "openclaw", "status"],
      ["/usr/bin/node24", "openclaw", "status"],
    ],
    [
      "keeps windows node24 exe",
      ["node24.exe", "openclaw", "status"],
      ["node24.exe", "openclaw", "status"],
    ],
    ["keeps nodejs binary", ["nodejs", "openclaw", "status"], ["nodejs", "openclaw", "status"]],
    [
      "prefixes fallback when first arg is not a node launcher",
      ["node-dev", "openclaw", "status"],
      ["node", "openclaw", "node-dev", "openclaw", "status"],
    ],
    [
      "prefixes fallback when raw args start at program name",
      ["openclaw", "status"],
      ["node", "openclaw", "status"],
    ],
    [
      "keeps bun execution argv",
      ["bun", "src/entry.ts", "status"],
      ["bun", "src/entry.ts", "status"],
    ],
  ] as const)("builds parse argv from raw args: %s", (_name, rawArgs, expected) => {
    const parsed = buildParseArgv([...rawArgs]);
    expect(parsed).toEqual([...expected]);
  });
});
