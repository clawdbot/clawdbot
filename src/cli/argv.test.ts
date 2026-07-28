// Argv tests cover CLI argument parsing helpers and platform-specific normalization.
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
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "known command group help command help flag",
      argv: ["node", "openclaw", "backup", "help", "--help"],
      expected: ["node", "openclaw", "backup", "help"],
    },
    {
      name: "known command group help command short help flag",
      argv: ["node", "openclaw", "--profile", "work", "backup", "help", "-h"],
      expected: ["node", "openclaw", "--profile", "work", "backup", "help"],
    },
    {
      name: "leaf positional help remains untouched",
      argv: ["node", "openclaw", "docs", "help", "--help"],
      expected: ["node", "openclaw", "docs", "help", "--help"],
    },
    {
      name: "known command group help target",
      argv: ["node", "openclaw", "plugins", "help", "list"],
      expected: ["node", "openclaw", "plugins", "list", "--help"],
    },
    {
      name: "known command group help target help flag",
      argv: ["node", "openclaw", "plugins", "help", "list", "--help"],
      expected: ["node", "openclaw", "plugins", "list", "--help"],
    },
    {
      name: "unknown plugin command group help target",
      argv: ["node", "openclaw", "external-plugin", "help", "inspect"],
      expected: ["node", "openclaw", "external-plugin", "inspect", "--help"],
    },
    {
      name: "unknown plugin command group help target help flag",
      argv: ["node", "openclaw", "external-plugin", "help", "inspect", "--help"],
      expected: ["node", "openclaw", "external-plugin", "inspect", "--help"],
    },
    {
      name: "generated help target with trailing root option",
      argv: ["node", "openclaw", "memory", "help", "status", "--no-color"],
      expected: ["node", "openclaw", "--no-color", "memory", "status", "--help"],
    },
    {
      name: "extra help positionals remain untouched",
      argv: ["node", "openclaw", "backup", "help", "missing", "extra", "--help"],
      expected: ["node", "openclaw", "backup", "help", "missing", "extra", "--help"],
    },
    {
      name: "terminator help flag remains untouched",
      argv: ["node", "openclaw", "backup", "help", "--", "--help"],
      expected: ["node", "openclaw", "backup", "help", "--", "--help"],
    },
  ])("normalizes generated help commands: $name", ({ argv, expected }) => {
    expect(normalizeGeneratedHelpCommandArgv(argv)).toEqual(expected);
  });

  it.each([
    {
      name: "root help target",
      argv: ["node", "openclaw", "help", "plugins"],
      expected: ["node", "openclaw", "plugins", "--help"],
    },
    {
      name: "root help target with help flag",
      argv: ["node", "openclaw", "help", "plugins", "--help"],
      expected: ["node", "openclaw", "plugins", "--help"],
    },
    {
      name: "root option before help target",
      argv: ["node", "openclaw", "--profile", "work", "help", "memory"],
      expected: ["node", "openclaw", "--profile", "work", "memory", "--help"],
    },
    {
      name: "bare root help remains untouched",
      argv: ["node", "openclaw", "help"],
      expected: ["node", "openclaw", "help"],
    },
    {
      name: "root help self-help remains untouched",
      argv: ["node", "openclaw", "help", "--help"],
      expected: ["node", "openclaw", "help", "--help"],
    },
    {
      name: "nested root help target",
      argv: ["node", "openclaw", "help", "plugins", "list"],
      expected: ["node", "openclaw", "plugins", "list", "--help"],
    },
    {
      name: "nested root help target with help flag",
      argv: ["node", "openclaw", "help", "plugins", "list", "--help"],
      expected: ["node", "openclaw", "plugins", "list", "--help"],
    },
    {
      name: "nested root help target with trailing root option",
      argv: ["node", "openclaw", "help", "memory", "status", "--no-color"],
      expected: ["node", "openclaw", "--no-color", "memory", "status", "--help"],
    },
  ])("normalizes root help targets: $name", ({ argv, expected }) => {
    expect(normalizeRootHelpTargetArgv(argv)).toEqual(expected);
  });

  it.each([
    {
      name: "subcommand trailing no-color",
      argv: ["node", "openclaw", "doctor", "--no-color", "--post-upgrade", "--json"],
      expected: ["node", "openclaw", "--no-color", "doctor", "--post-upgrade", "--json"],
    },
    {
      name: "keeps existing root options first",
      argv: ["node", "openclaw", "--profile", "work", "doctor", "--no-color", "--lint", "--json"],
      expected: [
        "node",
        "openclaw",
        "--profile",
        "work",
        "--no-color",
        "doctor",
        "--lint",
        "--json",
      ],
    },
    {
      name: "keeps no-color after possible command option value",
      argv: ["node", "openclaw", "doctor", "--lint", "--json", "--no-color"],
      expected: ["node", "openclaw", "doctor", "--lint", "--json", "--no-color"],
    },
    {
      name: "flag terminator leaves no-color positional",
      argv: ["node", "openclaw", "doctor", "--", "--no-color"],
      expected: ["node", "openclaw", "doctor", "--", "--no-color"],
    },
    {
      name: "command option value remains literal",
      argv: ["node", "openclaw", "agent", "--message", "--no-color"],
      expected: ["node", "openclaw", "agent", "--message", "--no-color"],
    },
    {
      name: "assigned command option value does not block no-color",
      argv: ["node", "openclaw", "agent", "--message=hello", "--no-color"],
      expected: ["node", "openclaw", "--no-color", "agent", "--message=hello"],
    },
  ])("normalizes root --no-color before command parsing: $name", ({ argv, expected }) => {
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
    {
      name: "subcommand trailing log-level",
      argv: ["node", "openclaw", "doctor", "--log-level", "debug", "--json"],
      expected: ["node", "openclaw", "--log-level", "debug", "doctor", "--json"],
    },
    {
      name: "subcommand trailing log-level equals form",
      argv: ["node", "openclaw", "doctor", "--log-level=trace", "--json"],
      expected: ["node", "openclaw", "--log-level=trace", "doctor", "--json"],
    },
    {
      name: "keeps existing root options first",
      argv: ["node", "openclaw", "--profile", "work", "doctor", "--log-level", "debug"],
      expected: ["node", "openclaw", "--profile", "work", "--log-level", "debug", "doctor"],
    },
    {
      name: "keeps log-level after possible command option value",
      argv: ["node", "openclaw", "agent", "--message", "--log-level", "debug"],
      expected: ["node", "openclaw", "agent", "--message", "--log-level", "debug"],
    },
    {
      name: "flag terminator leaves log-level positional",
      argv: ["node", "openclaw", "nodes", "run", "--", "--log-level", "debug"],
      expected: ["node", "openclaw", "nodes", "run", "--", "--log-level", "debug"],
    },
    {
      name: "missing value remains command scoped",
      argv: ["node", "openclaw", "doctor", "--log-level", "--json"],
      expected: ["node", "openclaw", "doctor", "--log-level", "--json"],
    },
  ])("normalizes root --log-level before command parsing: $name", ({ argv, expected }) => {
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
    {
      name: "root help command",
      argv: ["node", "openclaw", "help"],
      expected: true,
    },
    {
      name: "root help command with target",
      argv: ["node", "openclaw", "help", "matrix"],
      expected: true,
    },
    {
      name: "nested help command",
      argv: ["node", "openclaw", "matrix", "encryption", "help"],
      expected: true,
    },
    {
      name: "known subcommand root help command",
      argv: ["node", "openclaw", "config", "help"],
      expected: true,
    },
    {
      name: "known leaf command positional help",
      argv: ["node", "openclaw", "docs", "help"],
      expected: false,
    },
    {
      name: "known subcommand leaf positional help",
      argv: ["node", "openclaw", "config", "set", "some.path", "help"],
      expected: false,
    },
    {
      name: "unknown plugin command help",
      argv: ["node", "openclaw", "external-plugin", "tools", "help"],
      expected: true,
    },
    {
      name: "help flag",
      argv: ["node", "openclaw", "matrix", "encryption", "--help"],
      expected: true,
    },
    {
      name: "help as option value",
      argv: ["node", "openclaw", "agent", "--message", "help"],
      expected: false,
    },
    {
      name: "help after terminator",
      argv: ["node", "openclaw", "nodes", "invoke", "--", "help"],
      expected: false,
    },
    {
      name: "help flag after terminator",
      argv: ["node", "openclaw", "nodes", "invoke", "--", "--help"],
      expected: false,
    },
    {
      name: "version flag after terminator",
      argv: ["node", "openclaw", "nodes", "invoke", "--", "--version"],
      expected: false,
    },
  ])("detects help/version invocations: $name", ({ argv, expected }) => {
    expect(isHelpOrVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --version",
      argv: ["node", "openclaw", "--version"],
      expected: true,
    },
    {
      name: "root -V",
      argv: ["node", "openclaw", "-V"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "openclaw", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "subcommand version flag",
      argv: ["node", "openclaw", "status", "--version"],
      expected: false,
    },
    {
      name: "unknown root flag with version",
      argv: ["node", "openclaw", "--unknown", "--version"],
      expected: false,
    },
  ])("detects root-only version invocations: $name", ({ argv, expected }) => {
    expect(isRootVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --help",
      argv: ["node", "openclaw", "--help"],
      expected: true,
    },
    {
      name: "root -h",
      argv: ["node", "openclaw", "-h"],
      expected: true,
    },
    {
      name: "root --help with profile",
      argv: ["node", "openclaw", "--profile", "work", "--help"],
      expected: true,
    },
    {
      name: "subcommand --help",
      argv: ["node", "openclaw", "status", "--help"],
      expected: false,
    },
    {
      name: "help before subcommand token",
      argv: ["node", "openclaw", "--help", "status"],
      expected: false,
    },
    {
      name: "help after -- terminator",
      argv: ["node", "openclaw", "nodes", "invoke", "--", "device.status", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag before help",
      argv: ["node", "openclaw", "--unknown", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag after help",
      argv: ["node", "openclaw", "--help", "--unknown"],
      expected: false,
    },
  ])("detects root-only help invocations: $name", ({ argv, expected }) => {
    expect(isRootHelpInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "openclaw", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "openclaw", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "openclaw", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
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
    {
      name: "returns first command token",
      argv: ["node", "openclaw", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "openclaw"],
      expected: null,
    },
    {
      name: "skips known root option values",
      argv: ["node", "openclaw", "--log-level", "debug", "status"],
      expected: "status",
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "openclaw", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "openclaw", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "openclaw", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "openclaw", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "openclaw", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "openclaw", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "openclaw", "--", "--timeout=99"],
      expected: undefined,
    },
    {
      name: "repeated flag uses final value",
      argv: ["node", "openclaw", "status", "--timeout", "100", "--timeout=200"],
      expected: "200",
    },
    {
      name: "missing repeated value remains invalid",
      argv: ["node", "openclaw", "status", "--timeout", "--timeout", "200"],
      expected: null,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
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
    {
      name: "missing flag",
      argv: ["node", "openclaw", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "openclaw", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "openclaw", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "valid signed decimal positive integer",
      argv: ["node", "openclaw", "status", "--timeout", "+5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "openclaw", "status", "--timeout", "nope"],
      expected: null,
    },
    {
      name: "non-decimal integer",
      argv: ["node", "openclaw", "status", "--timeout", "0x10"],
      expected: null,
    },
    {
      name: "partial integer",
      argv: ["node", "openclaw", "status", "--timeout", "5s"],
      expected: null,
    },
    {
      name: "zero",
      argv: ["node", "openclaw", "status", "--timeout", "0"],
      expected: null,
    },
    {
      name: "negative integer",
      argv: ["node", "openclaw", "status", "--timeout", "-5"],
      expected: null,
    },
    {
      name: "repeated value uses final valid integer",
      argv: ["node", "openclaw", "status", "--timeout", "nope", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "repeated value rejects final invalid integer",
      argv: ["node", "openclaw", "status", "--timeout", "5000", "--timeout", "nope"],
      expected: null,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it.each([
    {
      name: "keeps plain node argv",
      rawArgs: ["node", "openclaw", "status"],
      expected: ["node", "openclaw", "status"],
    },
    {
      name: "keeps version-suffixed node binary",
      rawArgs: ["node-22", "openclaw", "status"],
      expected: ["node-22", "openclaw", "status"],
    },
    {
      name: "keeps windows versioned node exe",
      rawArgs: ["node-22.2.0.exe", "openclaw", "status"],
      expected: ["node-22.2.0.exe", "openclaw", "status"],
    },
    {
      name: "keeps dotted node binary",
      rawArgs: ["node-22.2", "openclaw", "status"],
      expected: ["node-22.2", "openclaw", "status"],
    },
    {
      name: "keeps dotted node exe",
      rawArgs: ["node-22.2.exe", "openclaw", "status"],
      expected: ["node-22.2.exe", "openclaw", "status"],
    },
    {
      name: "keeps absolute versioned node path",
      rawArgs: ["/usr/bin/node-22.2.0", "openclaw", "status"],
      expected: ["/usr/bin/node-22.2.0", "openclaw", "status"],
    },
    {
      name: "keeps node24 shorthand",
      rawArgs: ["node24", "openclaw", "status"],
      expected: ["node24", "openclaw", "status"],
    },
    {
      name: "keeps absolute node24 shorthand",
      rawArgs: ["/usr/bin/node24", "openclaw", "status"],
      expected: ["/usr/bin/node24", "openclaw", "status"],
    },
    {
      name: "keeps windows node24 exe",
      rawArgs: ["node24.exe", "openclaw", "status"],
      expected: ["node24.exe", "openclaw", "status"],
    },
    {
      name: "keeps nodejs binary",
      rawArgs: ["nodejs", "openclaw", "status"],
      expected: ["nodejs", "openclaw", "status"],
    },
    {
      name: "prefixes fallback when first arg is not a node launcher",
      rawArgs: ["node-dev", "openclaw", "status"],
      expected: ["node", "openclaw", "node-dev", "openclaw", "status"],
    },
    {
      name: "prefixes fallback when raw args start at program name",
      rawArgs: ["openclaw", "status"],
      expected: ["node", "openclaw", "status"],
    },
    {
      name: "keeps bun execution argv",
      rawArgs: ["bun", "src/entry.ts", "status"],
      expected: ["bun", "src/entry.ts", "status"],
    },
  ] as const)("builds parse argv from raw args: $name", ({ rawArgs, expected }) => {
    const parsed = buildParseArgv([...rawArgs]);
    expect(parsed).toEqual([...expected]);
  });

  it.each([
    { argv: ["node", "openclaw", "status"], expected: true },
    { argv: ["node", "openclaw", "health"], expected: false },
    { argv: ["node", "openclaw", "sessions"], expected: false },
    { argv: ["node", "openclaw", "--profile", "work", "status"], expected: true },
    { argv: ["node", "openclaw", "--log-level=debug", "models", "list"], expected: true },
    { argv: ["node", "openclaw", "config", "get", "update"], expected: false },
    { argv: ["node", "openclaw", "config", "unset", "update"], expected: false },
    { argv: ["node", "openclaw", "models", "list"], expected: true },
    { argv: ["node", "openclaw", "models", "status"], expected: true },
    { argv: ["node", "openclaw", "update", "status", "--json"], expected: false },
    { argv: ["node", "openclaw", "agent", "--message", "hi"], expected: true },
    { argv: ["node", "openclaw", "agents", "list"], expected: true },
    { argv: ["node", "openclaw", "message", "send"], expected: true },
  ] as const)("decides when to migrate state: $argv", ({ argv, expected }) => {
    const commandPath = getCommandPathWithRootOptions([...argv], 2);
    expect(shouldMigrateStateFromPath(commandPath)).toBe(expected);
  });

  it.each([
    { path: ["status"], expected: true },
    { path: ["update", "status"], expected: false },
    { path: ["config", "get"], expected: false },
    { path: ["agent"], expected: true },
    { path: ["models", "status"], expected: true },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
