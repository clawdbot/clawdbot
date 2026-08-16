// Resolves package-runner argv without letting supported option layouts hide commands.
import { classifyOpenClawArgv } from "./exec-approvals-lifecycle-cli.js";
import { isOpenClawEntryScriptPath } from "./exec-approvals-lifecycle-patterns.js";
import {
  lifecycleBooleanOptionValueMayBeDynamic,
  lifecycleHasEffectiveBooleanOption,
} from "./exec-approvals-lifecycle-tokens.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

const PACKAGE_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-w",
  "--cache",
  "--color",
  "--cwd",
  "--dir",
  "--filter",
  "--global-dir",
  "--globalconfig",
  "--loglevel",
  "--location",
  "--node-options",
  "--prefix",
  "--registry",
  "--script-shell",
  "--shell",
  "--userconfig",
  "--workspace",
]);
const PACKAGE_OPTIONS_WITH_VALUE = new Set(["--package"]);
const PACKAGE_TARGET_OPTIONS_WITH_VALUE = new Set([
  ...PACKAGE_GLOBAL_OPTIONS_WITH_VALUE,
  ...PACKAGE_OPTIONS_WITH_VALUE,
]);
const PACKAGE_EXEC_TARGET_OPTIONS_WITH_VALUE = new Set([
  ...PACKAGE_TARGET_OPTIONS_WITH_VALUE,
  "-p",
]);
const YARN_WORKSPACES_FOREACH_OPTIONS_WITH_VALUE = new Set([
  "-j",
  "--exclude",
  "--from",
  "--include",
  "--jobs",
  "--since",
]);
const PACKAGE_MUTATION_ALIASES = new Set([
  "add",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "install",
  "install-test",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "it",
  "link",
  "r",
  "rebuild",
  "remove",
  "rm",
  "un",
  "uninstall",
  "unlink",
  "up",
  "update",
  "upgrade",
]);
const PACKAGE_DRY_RUN_OPTION = new Set(["--dry-run"]);
const PACKAGE_DRY_RUN_SCAN_OPTIONS = new Set(["--dry-run", "--no-dry-run"]);
const PACKAGE_HELP_OPTIONS = new Set(["-h", "--help"]);
const PACKAGE_VERSION_OPTIONS = new Set(["-v", "--version"]);
const PACKAGE_INFO_ONLY_OPTIONS = new Set([...PACKAGE_HELP_OPTIONS, ...PACKAGE_VERSION_OPTIONS]);
const PACKAGE_NO_EXECUTE_SCAN_OPTIONS = new Set([
  ...PACKAGE_DRY_RUN_SCAN_OPTIONS,
  ...PACKAGE_INFO_ONLY_OPTIONS,
]);
const JAVASCRIPT_EXECUTABLE_RUNNERS = new Set([
  "babel-node",
  "bun",
  "esbuild-runner",
  "esno",
  "jiti",
  "node",
  "nodejs",
  "ts-node",
  "ts-node-esm",
  "tsx",
  "vite-node",
]);

export function lifecycleIsJavaScriptExecutableRunner(value: string | undefined): boolean {
  return JAVASCRIPT_EXECUTABLE_RUNNERS.has(normalizeExecutableToken(value ?? ""));
}

type LifecyclePackageRunnerPlan =
  | { kind: "not-runner" }
  | { kind: "approval-required" }
  | { kind: "argv"; argv: string[] };

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function optionName(token: string): string {
  return normalizedToken(token).split("=", 1)[0] ?? "";
}

function scanFirstPositional(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    if (optionsWithValue.has(optionName(token)) && !token.includes("=")) {
      index += 1;
    }
  }
  return argv.length;
}

function scanPackageSubcommand(
  argv: readonly string[],
  start: number,
): { ambiguousOption: boolean; index: number } {
  let ambiguousOption = false;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return { ambiguousOption, index: index + 1 };
    }
    if (!token.startsWith("-") || token === "-") {
      return { ambiguousOption, index };
    }
    const name = optionName(token);
    if (PACKAGE_GLOBAL_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
    } else if (!PACKAGE_DRY_RUN_SCAN_OPTIONS.has(name)) {
      ambiguousOption = true;
    }
  }
  return { ambiguousOption, index: argv.length };
}

function resolveInlineCommand(argv: readonly string[], start: number): string[] | null {
  for (let commandFlag = start; commandFlag < argv.length; commandFlag += 1) {
    const token = argv[commandFlag] ?? "";
    if (token === "--") {
      break;
    }
    if (!["-c", "--call"].includes(optionName(token))) {
      continue;
    }
    const command = token.includes("=")
      ? token.slice(token.indexOf("=") + 1)
      : argv[commandFlag + 1];
    return command ? ["sh", "-c", command] : [];
  }
  return null;
}

function packageTarget(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string> = PACKAGE_TARGET_OPTIONS_WITH_VALUE,
): string[] | null {
  const index = scanFirstPositional(argv, start, optionsWithValue);
  return index < argv.length ? [argv[index] ?? "", ...argv.slice(index + 1)] : null;
}

function packageTargets(argv: readonly string[], start: number): string[] {
  const targets: string[] = [];
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      targets.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      const name = optionName(token);
      if (PACKAGE_TARGET_OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
        index += 1;
      }
      continue;
    }
    targets.push(token);
  }
  return targets;
}

function looksLikeUnresolvedLifecycleRunner(argv: readonly string[]): boolean {
  const targetIndex = argv.findIndex(isOpenClawPackageTarget);
  if (targetIndex !== -1 && classifyOpenClawArgv(["openclaw", ...argv.slice(targetIndex + 1)])) {
    return true;
  }
  const text = argv.join(" ").toLowerCase();
  return (
    text.includes("openclaw") &&
    /\b(?:add|daemon|gateway|install|link|rebuild|remove|restart|rm|start|stop|uninstall|unlink|update|upgrade)\b/u.test(
      text,
    )
  );
}

function isOpenClawPackageTarget(token: string): boolean {
  return /^(?:openclaw|[^@\s]+@npm:openclaw)(?:@|$)|(?:^|[/\\:@])openclaw(?:[/\\.@#:]|$)/iu.test(
    token.trim(),
  );
}

function resolveJavaScriptOpenClawRunnerArgv(argv: readonly string[]): string[] | null {
  if (lifecycleIsJavaScriptExecutableRunner(argv[0])) {
    const entryIndex = argv.findIndex(
      (token, index) => index > 0 && isOpenClawEntryScriptPath(token),
    );
    if (entryIndex !== -1) {
      return ["openclaw", ...argv.slice(entryIndex + 1)];
    }
  }
  return null;
}

function resolvedPackageRunnerPlan(argv: string[]): LifecyclePackageRunnerPlan {
  if (isOpenClawPackageTarget(argv[0] ?? "")) {
    return { kind: "argv", argv: ["openclaw", ...argv.slice(1)] };
  }
  const runnerArgv = resolveJavaScriptOpenClawRunnerArgv(argv);
  if (runnerArgv) {
    return { kind: "argv", argv: runnerArgv };
  }
  return { kind: "argv", argv };
}

function hasEffectivePackageNoExecute(argv: readonly string[], start: number): boolean {
  return (
    lifecycleHasEffectiveBooleanOption(
      argv,
      start,
      PACKAGE_HELP_OPTIONS,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    ) ||
    lifecycleHasEffectiveBooleanOption(
      argv,
      start,
      PACKAGE_VERSION_OPTIONS,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    ) ||
    lifecycleHasEffectiveBooleanOption(
      argv,
      start,
      PACKAGE_DRY_RUN_OPTION,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    )
  );
}

function packageNoExecuteOptionMayBeConsumed(
  argv: readonly string[],
  start: number,
  end = argv.length,
  optionsWithValue: ReadonlySet<string> = PACKAGE_TARGET_OPTIONS_WITH_VALUE,
  noExecuteOptions: ReadonlySet<string> = PACKAGE_NO_EXECUTE_SCAN_OPTIONS,
): boolean {
  for (let index = start; index < end; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = optionName(token);
    if (optionsWithValue.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    const nextName = index + 1 < end ? optionName(argv[index + 1] ?? "") : "";
    if (
      token.startsWith("-") &&
      !token.includes("=") &&
      !noExecuteOptions.has(name) &&
      noExecuteOptions.has(nextName)
    ) {
      return true;
    }
  }
  return false;
}

function hasEffectivePackageInfoOnly(
  argv: readonly string[],
  start: number,
  end = argv.length,
): boolean {
  const optionArgv = argv.slice(start, end);
  return (
    lifecycleHasEffectiveBooleanOption(
      optionArgv,
      0,
      PACKAGE_HELP_OPTIONS,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    ) ||
    lifecycleHasEffectiveBooleanOption(
      optionArgv,
      0,
      PACKAGE_VERSION_OPTIONS,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    )
  );
}

function packageRunnerHasInfoOnlyBeforeTarget(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string> = PACKAGE_TARGET_OPTIONS_WITH_VALUE,
): boolean {
  const targetIndex = scanFirstPositional(argv, start, optionsWithValue);
  return (
    !packageNoExecuteOptionMayBeConsumed(
      argv,
      start,
      targetIndex,
      optionsWithValue,
      PACKAGE_INFO_ONLY_OPTIONS,
    ) && hasEffectivePackageInfoOnly(argv, start, targetIndex)
  );
}

function packageNoExecuteOptionValueMayBeDynamic(
  argv: readonly string[],
  start: number,
  isDynamic: (value: string | undefined) => boolean,
): boolean {
  return (
    lifecycleBooleanOptionValueMayBeDynamic(
      argv,
      start,
      PACKAGE_HELP_OPTIONS,
      isDynamic,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    ) ||
    lifecycleBooleanOptionValueMayBeDynamic(
      argv,
      start,
      PACKAGE_VERSION_OPTIONS,
      isDynamic,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    ) ||
    lifecycleBooleanOptionValueMayBeDynamic(
      argv,
      start,
      PACKAGE_DRY_RUN_OPTION,
      isDynamic,
      PACKAGE_TARGET_OPTIONS_WITH_VALUE,
    )
  );
}

function packageOperationMutatesOpenClaw(
  argv: readonly string[],
  subcommandIndex: number,
): boolean {
  const operation = normalizedToken(argv[subcommandIndex]);
  if (!PACKAGE_MUTATION_ALIASES.has(operation)) {
    return false;
  }
  const targetIsOpenClaw = packageTargets(argv, subcommandIndex + 1).some(isOpenClawPackageTarget);
  return (
    targetIsOpenClaw &&
    (packageNoExecuteOptionMayBeConsumed(argv, subcommandIndex + 1) ||
      !hasEffectivePackageNoExecute(argv, 1))
  );
}

/** Resolve command argv launched by npm-compatible package runners. */
export function resolveLifecyclePackageRunnerArgv(
  argv: readonly string[],
): LifecyclePackageRunnerPlan {
  const rawExecutable = normalizeExecutableToken(argv[0] ?? "");
  const executable =
    rawExecutable === "pnpx" ? "npx" : rawExecutable === "yarnpkg" ? "yarn" : rawExecutable;
  const directRunnerArgv = resolveJavaScriptOpenClawRunnerArgv(argv);
  if (directRunnerArgv) {
    return { kind: "argv", argv: directRunnerArgv };
  }
  if (executable === "corepack") {
    const manager = normalizedToken(argv[1]);
    const match = /^(npm|pnpm|yarn)(?:@[^/]+)?$/u.exec(manager);
    return match
      ? { kind: "argv", argv: [match[1] ?? manager, ...argv.slice(2)] }
      : looksLikeUnresolvedLifecycleRunner(argv)
        ? { kind: "approval-required" }
        : { kind: "not-runner" };
  }
  if (["bunx", "npx"].includes(executable)) {
    if (packageRunnerHasInfoOnlyBeforeTarget(argv, 1, PACKAGE_EXEC_TARGET_OPTIONS_WITH_VALUE)) {
      return { kind: "not-runner" };
    }
    const inline = resolveInlineCommand(argv, 1);
    const resolved = inline ?? packageTarget(argv, 1, PACKAGE_EXEC_TARGET_OPTIONS_WITH_VALUE);
    if (resolved?.length) {
      if (isOpenClawPackageTarget(resolved[0] ?? "")) {
        return { kind: "argv", argv: ["openclaw", ...resolved.slice(1)] };
      }
      return resolvedPackageRunnerPlan(resolved);
    }
    return looksLikeUnresolvedLifecycleRunner(argv)
      ? { kind: "approval-required" }
      : { kind: "not-runner" };
  }
  if (!["bun", "npm", "pnpm", "yarn"].includes(executable)) {
    return { kind: "not-runner" };
  }

  const subcommandScan = scanPackageSubcommand(argv, 1);
  const subcommandIndex = subcommandScan.index;
  const subcommand = normalizedToken(argv[subcommandIndex]);
  if (
    hasEffectivePackageInfoOnly(argv, 1, subcommandIndex) &&
    !packageNoExecuteOptionMayBeConsumed(
      argv,
      1,
      subcommandIndex,
      PACKAGE_GLOBAL_OPTIONS_WITH_VALUE,
      PACKAGE_INFO_ONLY_OPTIONS,
    )
  ) {
    return { kind: "not-runner" };
  }
  if (subcommandScan.ambiguousOption && looksLikeUnresolvedLifecycleRunner(argv)) {
    return { kind: "approval-required" };
  }
  if (packageOperationMutatesOpenClaw(argv, subcommandIndex)) {
    return { kind: "approval-required" };
  }
  if (executable === "yarn" && subcommand === "workspace") {
    const workspaceArgv = packageTarget(argv, subcommandIndex + 1);
    return workspaceArgv && workspaceArgv.length > 1
      ? { kind: "argv", argv: ["yarn", ...workspaceArgv.slice(1)] }
      : looksLikeUnresolvedLifecycleRunner(argv)
        ? { kind: "approval-required" }
        : { kind: "not-runner" };
  }
  if (
    executable === "yarn" &&
    subcommand === "workspaces" &&
    normalizedToken(argv[subcommandIndex + 1]) === "foreach"
  ) {
    const commandArgv = packageTarget(
      argv,
      subcommandIndex + 2,
      YARN_WORKSPACES_FOREACH_OPTIONS_WITH_VALUE,
    );
    return commandArgv?.length
      ? { kind: "argv", argv: ["yarn", ...commandArgv] }
      : looksLikeUnresolvedLifecycleRunner(argv)
        ? { kind: "approval-required" }
        : { kind: "not-runner" };
  }
  if (
    executable === "yarn" &&
    subcommand === "global" &&
    packageOperationMutatesOpenClaw(argv, subcommandIndex + 1)
  ) {
    return { kind: "approval-required" };
  }
  if (executable === "bun" && ["run", "x"].includes(subcommand)) {
    if (packageRunnerHasInfoOnlyBeforeTarget(argv, subcommandIndex + 1)) {
      return { kind: "not-runner" };
    }
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return resolvedPackageRunnerPlan(resolved);
    }
  } else if (executable === "npm" && ["exec", "x"].includes(subcommand)) {
    if (
      packageRunnerHasInfoOnlyBeforeTarget(
        argv,
        subcommandIndex + 1,
        PACKAGE_EXEC_TARGET_OPTIONS_WITH_VALUE,
      )
    ) {
      return { kind: "not-runner" };
    }
    const inline = resolveInlineCommand(argv, subcommandIndex + 1);
    const resolved =
      inline ?? packageTarget(argv, subcommandIndex + 1, PACKAGE_EXEC_TARGET_OPTIONS_WITH_VALUE);
    if (resolved?.length) {
      return resolvedPackageRunnerPlan(resolved);
    }
  } else if (executable === "npm" && ["run", "run-script", "rum", "urn"].includes(subcommand)) {
    if (packageRunnerHasInfoOnlyBeforeTarget(argv, subcommandIndex + 1)) {
      return { kind: "not-runner" };
    }
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return resolvedPackageRunnerPlan(resolved);
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommand === "dlx") {
    if (packageRunnerHasInfoOnlyBeforeTarget(argv, subcommandIndex + 1)) {
      return { kind: "not-runner" };
    }
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return resolvedPackageRunnerPlan(resolved);
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommand === "exec") {
    if (packageRunnerHasInfoOnlyBeforeTarget(argv, subcommandIndex + 1)) {
      return { kind: "not-runner" };
    }
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return resolvedPackageRunnerPlan(resolved);
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommand === "run") {
    if (packageRunnerHasInfoOnlyBeforeTarget(argv, subcommandIndex + 1)) {
      return { kind: "not-runner" };
    }
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return resolvedPackageRunnerPlan(resolved);
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommandIndex < argv.length) {
    return { kind: "argv", argv: argv.slice(subcommandIndex) };
  }

  return { kind: "not-runner" };
}

/** Return true when a dynamic package target could mutate the OpenClaw installation. */
export function unresolvedPackageMutationMayTargetOpenClaw(
  argv: readonly string[],
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  const rawExecutable = normalizeExecutableToken(argv[0] ?? "");
  if (rawExecutable === "corepack") {
    const manager = normalizedToken(argv[1]);
    const match = /^(npm|pnpm|yarn)(?:@[^/]+)?$/u.exec(manager);
    return match
      ? unresolvedPackageMutationMayTargetOpenClaw(
          [match[1] ?? manager, ...argv.slice(2)],
          isUnresolved,
        )
      : looksLikeUnresolvedLifecycleRunner(argv);
  }
  const executable =
    rawExecutable === "pnpx" ? "npx" : rawExecutable === "yarnpkg" ? "yarn" : rawExecutable;
  if (!["bun", "npm", "pnpm", "yarn"].includes(executable)) {
    return false;
  }
  const subcommandScan = scanPackageSubcommand(argv, 1);
  const subcommandIndex = subcommandScan.index;
  const subcommand = normalizedToken(argv[subcommandIndex]);
  if (
    packageNoExecuteOptionValueMayBeDynamic(argv, subcommandIndex + 1, isUnresolved) &&
    looksLikeUnresolvedLifecycleRunner(argv)
  ) {
    return true;
  }
  if (hasEffectivePackageNoExecute(argv, subcommandIndex + 1)) {
    return false;
  }
  if (subcommandScan.ambiguousOption && looksLikeUnresolvedLifecycleRunner(argv)) {
    return true;
  }
  if (isUnresolved(argv[subcommandIndex])) {
    return argv
      .slice(subcommandIndex + 1)
      .some((token) => isUnresolved(token) || isOpenClawPackageTarget(token));
  }
  if (PACKAGE_MUTATION_ALIASES.has(subcommand)) {
    return packageTargets(argv, subcommandIndex + 1).some(isUnresolved);
  }
  return (
    executable === "yarn" &&
    subcommand === "global" &&
    (isUnresolved(argv[subcommandIndex + 1]) ||
      (PACKAGE_MUTATION_ALIASES.has(normalizedToken(argv[subcommandIndex + 1])) &&
        packageTargets(argv, subcommandIndex + 2).some(isUnresolved)))
  );
}
