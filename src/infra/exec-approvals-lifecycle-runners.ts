// Resolves package-runner argv without letting supported option layouts hide commands.
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
const PACKAGE_OPTIONS_WITH_VALUE = new Set(["-p", "--package"]);
const PACKAGE_TARGET_OPTIONS_WITH_VALUE = new Set([
  ...PACKAGE_GLOBAL_OPTIONS_WITH_VALUE,
  ...PACKAGE_OPTIONS_WITH_VALUE,
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
const PACKAGE_HELP_OPTIONS = new Set(["-h", "--help"]);
const PACKAGE_VERSION_OPTIONS = new Set(["-v", "--version"]);

export type LifecyclePackageRunnerPlan =
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
    } else {
      ambiguousOption = true;
    }
  }
  return { ambiguousOption, index: argv.length };
}

function resolveInlineCommand(argv: readonly string[], start: number): string[] | null {
  const commandFlag = argv.findIndex(
    (token, index) => index >= start && ["-c", "--call"].includes(optionName(token)),
  );
  if (commandFlag === -1) {
    return null;
  }
  const flag = argv[commandFlag] ?? "";
  const command = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : argv[commandFlag + 1];
  return command ? ["sh", "-c", command] : [];
}

function packageTarget(argv: readonly string[], start: number): string[] | null {
  const index = scanFirstPositional(argv, start, PACKAGE_TARGET_OPTIONS_WITH_VALUE);
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
  if (
    !PACKAGE_MUTATION_ALIASES.has(operation) ||
    hasEffectivePackageNoExecute(argv, subcommandIndex + 1)
  ) {
    return false;
  }
  return packageTargets(argv, subcommandIndex + 1).some(isOpenClawPackageTarget);
}

/** Resolve command argv launched by npm-compatible package runners. */
export function resolveLifecyclePackageRunnerArgv(
  argv: readonly string[],
): LifecyclePackageRunnerPlan {
  const rawExecutable = normalizeExecutableToken(argv[0] ?? "");
  const executable =
    rawExecutable === "pnpx" ? "npx" : rawExecutable === "yarnpkg" ? "yarn" : rawExecutable;
  if (executable === "corepack") {
    const manager = normalizedToken(argv[1]);
    const match = /^(npm|pnpm|yarn)(?:@[^/]+)?$/u.exec(manager);
    return match
      ? { kind: "argv", argv: [match[1] ?? manager, ...argv.slice(2)] }
      : looksLikeUnresolvedLifecycleRunner(argv)
        ? { kind: "approval-required" }
        : { kind: "not-runner" };
  }
  if (hasEffectivePackageNoExecute(argv, 1)) {
    return { kind: "not-runner" };
  }
  if (["bunx", "npx"].includes(executable)) {
    const inline = resolveInlineCommand(argv, 1);
    const resolved = inline ?? packageTarget(argv, 1);
    if (resolved?.length) {
      if (isOpenClawPackageTarget(resolved[0] ?? "")) {
        return { kind: "argv", argv: ["openclaw", ...resolved.slice(1)] };
      }
      return { kind: "argv", argv: resolved };
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
  if (subcommandScan.ambiguousOption && looksLikeUnresolvedLifecycleRunner(argv)) {
    return { kind: "approval-required" };
  }
  if (packageOperationMutatesOpenClaw(argv, subcommandIndex)) {
    return { kind: "approval-required" };
  }
  if (
    executable === "yarn" &&
    subcommand === "global" &&
    packageOperationMutatesOpenClaw(argv, subcommandIndex + 1)
  ) {
    return { kind: "approval-required" };
  }
  if (executable === "bun" && ["run", "x"].includes(subcommand)) {
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
    }
  } else if (executable === "npm" && ["exec", "x"].includes(subcommand)) {
    const inline = resolveInlineCommand(argv, subcommandIndex + 1);
    const resolved = inline ?? packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
    }
  } else if (executable === "npm" && ["run", "run-script", "rum", "urn"].includes(subcommand)) {
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommand === "dlx") {
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommand === "exec") {
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
    }
  } else if (["pnpm", "yarn"].includes(executable) && subcommand === "run") {
    const resolved = packageTarget(argv, subcommandIndex + 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
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
