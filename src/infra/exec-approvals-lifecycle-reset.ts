// Classifies destructive OpenClaw reset operations and their preview mode.
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const OPTIONS_WITH_VALUE = new Set(["--scope"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

/** Return true when reset argv can remove active OpenClaw state. */
export function classifyOpenClawResetArgv(argv: readonly string[], start: number): boolean {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = optionName(token);
    if (HELP_OR_VERSION_FLAGS.has(name)) {
      return false;
    }
    if (name === "--dry-run") {
      const value = token.includes("=")
        ? token.slice(token.indexOf("=") + 1).toLowerCase()
        : "true";
      if (!FALSE_VALUES.has(value)) {
        return false;
      }
    }
    if (OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return true;
}
