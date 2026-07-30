// Classifies destructive OpenClaw reset operations and their preview mode.
import {
  lifecycleBooleanOptionValueMayBeDynamic,
  lifecycleHasEffectiveBooleanOption,
} from "./exec-approvals-lifecycle-tokens.js";

const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const OPTIONS_WITH_VALUE = new Set(["--scope"]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

/** Return true when reset argv can remove active OpenClaw state. */
export function classifyOpenClawResetArgv(argv: readonly string[], start: number): boolean {
  const dryRun = lifecycleHasEffectiveBooleanOption(
    argv,
    start,
    DRY_RUN_OPTION,
    OPTIONS_WITH_VALUE,
  );
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = optionName(token);
    if (HELP_OR_VERSION_FLAGS.has(name)) {
      return false;
    }
    if (OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return !dryRun;
}

/** Return true when runtime expansion can disable reset preview mode. */
export function unresolvedOpenClawResetArgvMayMutate(
  argv: readonly string[],
  start: number,
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  return lifecycleBooleanOptionValueMayBeDynamic(
    argv,
    start,
    DRY_RUN_OPTION,
    isUnresolved,
    OPTIONS_WITH_VALUE,
  );
}
