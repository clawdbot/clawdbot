// Classifies direct OpenClaw config reads, dry-runs, and persistent writes.
import {
  lifecycleBooleanOptionValueMayBeDynamic,
  lifecycleHasEffectiveBooleanOption,
  lifecycleOptionName,
} from "./exec-approvals-lifecycle-tokens.js";

const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);
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

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

function optionName(token: string): string {
  return lifecycleOptionName(token);
}

/** Return true when config argv can persist changes to the active configuration. */
export function classifyOpenClawConfigArgv(argv: readonly string[], start: number): boolean {
  const dryRun = lifecycleHasEffectiveBooleanOption(
    argv,
    start,
    DRY_RUN_OPTION,
    CONFIG_OPTIONS_WITH_VALUE,
  );
  let action: string | undefined;
  let endOfOptions = false;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--" && !endOfOptions) {
      endOfOptions = true;
      continue;
    }
    const name = optionName(token);
    if (!endOfOptions && HELP_OR_VERSION_FLAGS.has(token)) {
      return false;
    }
    if (!endOfOptions && name === "--dry-run") {
      continue;
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
  return !dryRun && !CONFIG_READ_ONLY.has(action ?? "");
}

/** Return true when an unresolved reference occupies the config action position. */
export function unresolvedOpenClawConfigActionMayMutate(
  argv: readonly string[],
  start: number,
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  if (
    lifecycleBooleanOptionValueMayBeDynamic(
      argv,
      start,
      DRY_RUN_OPTION,
      isUnresolved,
      CONFIG_OPTIONS_WITH_VALUE,
    )
  ) {
    return true;
  }
  const dryRun = lifecycleHasEffectiveBooleanOption(
    argv,
    start,
    DRY_RUN_OPTION,
    CONFIG_OPTIONS_WITH_VALUE,
  );
  let action: string | undefined;
  let endOfOptions = false;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--" && !endOfOptions) {
      endOfOptions = true;
      continue;
    }
    const name = optionName(token);
    if (!endOfOptions && HELP_OR_VERSION_FLAGS.has(token)) {
      return false;
    }
    if (!endOfOptions && name === "--dry-run") {
      continue;
    }
    if (!endOfOptions && CONFIG_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (endOfOptions || !token.startsWith("-") || token === "-") {
      action ??= token;
    }
  }
  return !dryRun && isUnresolved(action);
}
