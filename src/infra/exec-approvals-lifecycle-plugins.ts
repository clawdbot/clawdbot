// Classifies plugin and hook commands that persist config, code, or registry state.
import {
  lifecycleHasEffectiveBooleanOption,
  lifecycleOptionName,
} from "./exec-approvals-lifecycle-tokens.js";

const HELP_OPTIONS = new Set(["-h", "--help"]);
const VERSION_OPTIONS = new Set(["--version"]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);
const REFRESH_OPTION = new Set(["--refresh"]);
const CHECK_OPTION = new Set(["--check"]);
const PLUGIN_OPTIONS_WITH_VALUE = new Set([
  "--directory",
  "--entry",
  "--expected-sha256",
  "--feed-profile",
  "--feed-url",
  "--limit",
  "--marketplace",
  "--name",
  "--root",
  "--type",
]);
const HOOK_OPTIONS_WITH_VALUE = new Set([
  "--event",
  "--generation",
  "--pre-tool-use-unavailable",
  "--provider",
  "--relay-id",
  "--state-db",
  "--timeout",
]);
const PLUGIN_READ_ONLY = new Set(["doctor", "info", "inspect", "list", "search", "validate"]);
const HOOK_READ_ONLY = new Set(["check", "info", "list", "relay"]);

function firstPositional(argv: readonly string[], start: number): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
  }
  return argv.length;
}

function hasEffectiveHelpOrVersion(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): boolean {
  return (
    lifecycleHasEffectiveBooleanOption(argv, start, HELP_OPTIONS, optionsWithValue) ||
    lifecycleHasEffectiveBooleanOption(argv, start, VERSION_OPTIONS, optionsWithValue)
  );
}

/** Return true when `openclaw plugins` can persist plugin-related state. */
export function classifyOpenClawPluginsArgv(argv: readonly string[], start: number): boolean {
  if (hasEffectiveHelpOrVersion(argv, start, PLUGIN_OPTIONS_WITH_VALUE)) {
    return false;
  }
  const actionIndex = firstPositional(argv, start);
  const action = lifecycleOptionName(argv[actionIndex] ?? "");
  if (!action || PLUGIN_READ_ONLY.has(action)) {
    return false;
  }
  if (["uninstall", "update"].includes(action)) {
    return !lifecycleHasEffectiveBooleanOption(
      argv,
      actionIndex + 1,
      DRY_RUN_OPTION,
      PLUGIN_OPTIONS_WITH_VALUE,
    );
  }
  if (action === "registry") {
    return lifecycleHasEffectiveBooleanOption(
      argv,
      actionIndex + 1,
      REFRESH_OPTION,
      PLUGIN_OPTIONS_WITH_VALUE,
    );
  }
  if (action === "build") {
    return !lifecycleHasEffectiveBooleanOption(
      argv,
      actionIndex + 1,
      CHECK_OPTION,
      PLUGIN_OPTIONS_WITH_VALUE,
    );
  }
  if (action === "marketplace") {
    const marketplaceActionIndex = firstPositional(argv, actionIndex + 1);
    const marketplaceAction = lifecycleOptionName(argv[marketplaceActionIndex] ?? "");
    return marketplaceAction !== "" && !["entries", "list"].includes(marketplaceAction);
  }
  return true;
}

/** Return true when `openclaw hooks` can persist hook config or installed code. */
export function classifyOpenClawHooksArgv(argv: readonly string[], start: number): boolean {
  if (hasEffectiveHelpOrVersion(argv, start, HOOK_OPTIONS_WITH_VALUE)) {
    return false;
  }
  const actionIndex = firstPositional(argv, start);
  const action = lifecycleOptionName(argv[actionIndex] ?? "");
  if (!action || HOOK_READ_ONLY.has(action)) {
    return false;
  }
  if (action === "update") {
    return !lifecycleHasEffectiveBooleanOption(
      argv,
      actionIndex + 1,
      DRY_RUN_OPTION,
      HOOK_OPTIONS_WITH_VALUE,
    );
  }
  return true;
}
