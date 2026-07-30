// Resolves package-runner argv without letting supported option layouts hide commands.
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
  "--node-options",
  "--prefix",
  "--registry",
  "--script-shell",
  "--userconfig",
  "--workspace",
]);
const PACKAGE_OPTIONS_WITH_VALUE = new Set(["-p", "--package"]);
const PACKAGE_TARGET_OPTIONS_WITH_VALUE = new Set([
  ...PACKAGE_GLOBAL_OPTIONS_WITH_VALUE,
  ...PACKAGE_OPTIONS_WITH_VALUE,
]);

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

function looksLikeUnresolvedLifecycleRunner(argv: readonly string[]): boolean {
  const text = argv.join(" ").toLowerCase();
  return text.includes("openclaw") && /\b(?:daemon|gateway|uninstall|update)\b/u.test(text);
}

function packageOperationMutatesOpenClaw(
  argv: readonly string[],
  subcommandIndex: number,
): boolean {
  const operation = normalizedToken(argv[subcommandIndex]);
  if (!["add", "i", "install", "remove", "uninstall", "up", "update"].includes(operation)) {
    return false;
  }
  return argv.slice(subcommandIndex + 1).some((token) => /^openclaw(?:@|$)/iu.test(token.trim()));
}

/** Resolve command argv launched by npm-compatible package runners. */
export function resolveLifecyclePackageRunnerArgv(
  argv: readonly string[],
): LifecyclePackageRunnerPlan {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "corepack") {
    return argv.length > 1 ? { kind: "argv", argv: argv.slice(1) } : { kind: "not-runner" };
  }
  if (["bunx", "npx"].includes(executable)) {
    const inline = resolveInlineCommand(argv, 1);
    const resolved = inline ?? packageTarget(argv, 1);
    if (resolved?.length) {
      return { kind: "argv", argv: resolved };
    }
    return looksLikeUnresolvedLifecycleRunner(argv)
      ? { kind: "approval-required" }
      : { kind: "not-runner" };
  }
  if (!["npm", "pnpm", "yarn"].includes(executable)) {
    return { kind: "not-runner" };
  }

  const subcommandIndex = scanFirstPositional(argv, 1, PACKAGE_GLOBAL_OPTIONS_WITH_VALUE);
  const subcommand = normalizedToken(argv[subcommandIndex]);
  if (packageOperationMutatesOpenClaw(argv, subcommandIndex)) {
    return { kind: "approval-required" };
  }
  if (executable === "npm" && ["exec", "x"].includes(subcommand)) {
    const inline = resolveInlineCommand(argv, subcommandIndex + 1);
    const resolved = inline ?? packageTarget(argv, subcommandIndex + 1);
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
  } else if (["pnpm", "yarn"].includes(executable) && subcommandIndex < argv.length) {
    return { kind: "argv", argv: argv.slice(subcommandIndex) };
  }

  return looksLikeUnresolvedLifecycleRunner(argv)
    ? { kind: "approval-required" }
    : { kind: "not-runner" };
}
