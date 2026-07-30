// Classifies direct OpenClaw config reads, dry-runs, and persistent writes.
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const CONFIG_OPTIONS_WITH_VALUE = new Set([
  "--batch-file",
  "--batch-json",
  "--file",
  "--provider-allowlist",
  "--provider-arg",
  "--provider-command",
  "--provider-env",
  "--provider-max-bytes",
  "--provider-max-output-bytes",
  "--provider-mode",
  "--provider-no-output-timeout-ms",
  "--provider-pass-env",
  "--provider-path",
  "--provider-source",
  "--provider-timeout-ms",
  "--provider-trusted-dir",
  "--ref-id",
  "--ref-provider",
  "--ref-source",
  "--replace-path",
  "--section",
]);
const CONFIG_READ_ONLY = new Set(["file", "get", "schema", "validate"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

function optionName(token: string): string {
  return normalizedToken(token).split("=", 1)[0] ?? "";
}

function isEffectiveDryRun(token: string): boolean {
  const value = token.includes("=") ? token.slice(token.indexOf("=") + 1).toLowerCase() : "true";
  return !FALSE_VALUES.has(value);
}

/** Return true when config argv can persist changes to the active configuration. */
export function classifyOpenClawConfigArgv(argv: readonly string[], start: number): boolean {
  let action: string | undefined;
  let endOfOptions = false;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--" && !endOfOptions) {
      endOfOptions = true;
      continue;
    }
    const name = optionName(token);
    if (
      !endOfOptions &&
      (HELP_OR_VERSION_FLAGS.has(token) || (name === "--dry-run" && isEffectiveDryRun(token)))
    ) {
      return false;
    }
    if (!endOfOptions && CONFIG_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (endOfOptions || !token.startsWith("-") || token === "-") {
      action ??= normalizedToken(token);
    }
  }
  return !CONFIG_READ_ONLY.has(action ?? "");
}

/** Return true when an unresolved reference occupies the config action position. */
export function unresolvedOpenClawConfigActionMayMutate(
  argv: readonly string[],
  start: number,
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  let endOfOptions = false;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--" && !endOfOptions) {
      endOfOptions = true;
      continue;
    }
    const name = optionName(token);
    if (
      !endOfOptions &&
      (HELP_OR_VERSION_FLAGS.has(token) || (name === "--dry-run" && isEffectiveDryRun(token)))
    ) {
      return false;
    }
    if (!endOfOptions && CONFIG_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (endOfOptions || !token.startsWith("-") || token === "-") {
      return isUnresolved(token);
    }
  }
  return false;
}
