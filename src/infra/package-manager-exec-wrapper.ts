// Parses package-manager exec wrappers that delegate to a concrete command.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { parseInlineOptionToken } from "./inline-option-token.js";

const NPM_EXEC_OPTIONS_WITH_VALUE = new Set([
  "--cache",
  "--loglevel",
  "--package",
  "--prefix",
  "--script-shell",
  "--userconfig",
  "--workspace",
  "-p",
  "-w",
]);

const NPM_EXEC_CONTEXT_OPTIONS_WITH_VALUE = new Set([
  "--cache",
  "--package",
  "--prefix",
  "--script-shell",
  "--userconfig",
  "--workspace",
  "-p",
  "-w",
]);

const NPM_EXEC_FLAG_OPTIONS = new Set([
  "--no",
  "--quiet",
  "--ws",
  "--workspaces",
  "--yes",
  "-q",
  "-y",
]);

const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x"]);

export const PNPM_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--dir",
  "--filter",
  "--reporter",
  "--stream",
  "--test-pattern",
  "--workspace-concurrency",
]);

export const PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE = new Set(["-C"]);

export const PNPM_FLAG_OPTIONS = new Set([
  "--aggregate-output",
  "--color",
  "--parallel",
  "--recursive",
  "--silent",
  "--workspace-root",
  "-r",
  "-s",
  "-w",
]);

export const PNPM_DLX_OPTIONS_WITH_VALUE = new Set(["--allow-build", "--package", "-p"]);
const PNPM_EXEC_CONTEXT_OPTIONS_WITH_VALUE = new Set([
  "--allow-build",
  "--config",
  "--dir",
  "--filter",
  "--package",
  "-p",
]);

const PNPM_EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "node"]);
const PNPM_SCRIPT_RUN_SUBCOMMANDS = new Set(["restart", "run", "start", "stop", "test"]);
const PNPM_BUILTIN_NON_EXEC_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "bin",
  "config",
  "dedupe",
  "deploy",
  "help",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "outdated",
  "patch",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "root",
  "server",
  "store",
  "unlink",
  "update",
  "view",
  "why",
]);

const YARN_OPTIONS_WITH_VALUE = new Set(["--cwd"]);
const YARN_FLAG_OPTIONS = new Set(["--immutable", "--silent", "-s"]);
const YARN_DLX_OPTIONS_WITH_VALUE = new Set(["--package", "-p"]);
const YARN_DLX_FLAG_OPTIONS = new Set(["--quiet", "-q"]);
const YARN_EXEC_SUBCOMMANDS = new Set(["exec", "dlx"]);
const YARN_BUILTIN_NON_EXEC_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "autoclean",
  "bin",
  "cache",
  "check",
  "config",
  "create",
  "dedupe",
  "generate-lock-entry",
  "global",
  "help",
  "import",
  "info",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "login",
  "logout",
  "outdated",
  "owner",
  "pack",
  "policies",
  "prune",
  "publish",
  "remove",
  "self-update",
  "tag",
  "team",
  "unlink",
  "upgrade",
  "upgrade-interactive",
  "version",
  "versions",
  "why",
  "workspace",
]);

type PackageManagerOptions = {
  optionsWithValue: ReadonlySet<string>;
  caseSensitiveOptionsWithValue?: ReadonlySet<string>;
  flagOptions: ReadonlySet<string>;
};

type PackageManagerContextOptions = PackageManagerOptions & {
  contextOptionsWithValue: ReadonlySet<string>;
  contextCaseSensitiveOptionsWithValue?: ReadonlySet<string>;
  contextFlagOptions?: ReadonlySet<string>;
};

const NPM_DIRECT_EXEC_OPTIONS: PackageManagerOptions = {
  optionsWithValue: NPM_EXEC_OPTIONS_WITH_VALUE,
  flagOptions: NPM_EXEC_FLAG_OPTIONS,
};

const NPM_EXEC_OPTIONS: PackageManagerContextOptions = {
  ...NPM_DIRECT_EXEC_OPTIONS,
  caseSensitiveOptionsWithValue: new Set(["-C"]),
  contextOptionsWithValue: NPM_EXEC_CONTEXT_OPTIONS_WITH_VALUE,
  contextCaseSensitiveOptionsWithValue: new Set(["-C"]),
  contextFlagOptions: new Set(["--ws", "--workspaces"]),
};

const PNPM_EXEC_OPTIONS: PackageManagerContextOptions = {
  optionsWithValue: new Set([...PNPM_OPTIONS_WITH_VALUE, ...PNPM_DLX_OPTIONS_WITH_VALUE]),
  caseSensitiveOptionsWithValue: PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE,
  flagOptions: PNPM_FLAG_OPTIONS,
  contextOptionsWithValue: PNPM_EXEC_CONTEXT_OPTIONS_WITH_VALUE,
  contextCaseSensitiveOptionsWithValue: PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE,
  contextFlagOptions: new Set(["--recursive", "--workspace-root", "-r", "-w"]),
};

// dlx keeps both -c and -C outside its allowed options, unlike leading pnpm options.
const PNPM_DLX_OPTIONS: PackageManagerOptions = {
  optionsWithValue: PNPM_EXEC_OPTIONS.optionsWithValue,
  flagOptions: PNPM_FLAG_OPTIONS,
};

const YARN_EXEC_OPTIONS: PackageManagerContextOptions = {
  optionsWithValue: new Set([...YARN_OPTIONS_WITH_VALUE, ...YARN_DLX_OPTIONS_WITH_VALUE]),
  flagOptions: new Set([...YARN_FLAG_OPTIONS, ...YARN_DLX_FLAG_OPTIONS]),
  contextOptionsWithValue: YARN_OPTIONS_WITH_VALUE,
};

const YARN_DLX_OPTIONS: PackageManagerContextOptions = {
  optionsWithValue: YARN_DLX_OPTIONS_WITH_VALUE,
  flagOptions: YARN_DLX_FLAG_OPTIONS,
  contextOptionsWithValue: YARN_DLX_OPTIONS_WITH_VALUE,
};

function normalizeOptionFlag(token: string): string {
  return normalizeLowercaseStringOrEmpty(parseInlineOptionToken(token).name);
}

function findFirstNonOptionIndex(
  argv: string[],
  startIdx: number,
  params: PackageManagerOptions,
  terminator: "skip" | "stop" | "reject" = "skip",
): number | null {
  let idx = startIdx;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      if (terminator === "reject") {
        return null;
      }
      if (terminator === "stop") {
        return idx + 1 < argv.length ? idx + 1 : null;
      }
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      return idx;
    }
    const parsedOption = parseInlineOptionToken(token);
    if (params.caseSensitiveOptionsWithValue?.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (params.optionsWithValue.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (params.flagOptions.has(flag)) {
      idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function hasContextOption(
  argv: string[],
  startIdx: number,
  params: PackageManagerContextOptions,
  scope: "leading" | "before-terminator" = "leading",
): boolean {
  let idx = startIdx;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      if (scope === "before-terminator") {
        return false;
      }
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (scope === "leading") {
        return false;
      }
      idx += 1;
      continue;
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (
      params.contextCaseSensitiveOptionsWithValue?.has(parsedOption.name) ||
      params.contextOptionsWithValue.has(flag) ||
      params.contextFlagOptions?.has(flag)
    ) {
      return true;
    }
    if (params.caseSensitiveOptionsWithValue?.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (params.optionsWithValue.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (params.flagOptions.has(flag)) {
      idx += 1;
      continue;
    }
    if (scope === "leading") {
      return false;
    }
    idx += 1;
  }
  return false;
}

export function hasKnownPackageManagerExecContextOptions(argv: string[]): boolean {
  const executable = normalizePackageManagerExecToken(argv[0] ?? "");
  switch (executable) {
    case "npm": {
      if (hasContextOption(argv, 1, NPM_EXEC_OPTIONS)) {
        return true;
      }
      const subcommandIdx = findFirstNonOptionIndex(argv, 1, NPM_EXEC_OPTIONS);
      // npm also consumes context options after the command, up to the first `--`.
      return subcommandIdx !== null && NPM_EXEC_SUBCOMMANDS.has(argv[subcommandIdx] ?? "")
        ? hasContextOption(argv, subcommandIdx + 1, NPM_EXEC_OPTIONS, "before-terminator")
        : false;
    }
    case "npx":
    case "bunx":
      return hasContextOption(argv, 1, NPM_EXEC_OPTIONS);
    case "pnpm": {
      if (hasContextOption(argv, 1, PNPM_EXEC_OPTIONS)) {
        return true;
      }
      const subcommandIdx = findFirstNonOptionIndex(argv, 1, PNPM_EXEC_OPTIONS);
      return argv[subcommandIdx ?? -1] === "dlx"
        ? hasContextOption(argv, (subcommandIdx ?? 0) + 1, PNPM_EXEC_OPTIONS)
        : false;
    }
    case "yarn": {
      if (hasContextOption(argv, 1, YARN_EXEC_OPTIONS)) {
        return true;
      }
      const subcommandIdx = findFirstNonOptionIndex(argv, 1, YARN_EXEC_OPTIONS);
      return argv[subcommandIdx ?? -1] === "dlx"
        ? hasContextOption(argv, (subcommandIdx ?? 0) + 1, YARN_DLX_OPTIONS)
        : false;
    }
    default:
      return false;
  }
}

function containsSubcommandToken(argv: string[], subcommands: ReadonlySet<string>): boolean {
  return argv.some((token) => subcommands.has(normalizeLowercaseStringOrEmpty(token)));
}

export function normalizePackageManagerExecToken(token: string): string {
  return normalizeExecutableToken(token).replace(/\.(?:c|m)?js$/i, "");
}

type PackageManagerExecInvocation =
  | { kind: "not-package-manager" }
  | { kind: "not-exec" }
  | { kind: "unsafe-exec" }
  | { kind: "unwrapped"; argv: string[] };

function firstSubcommandAfterOptions(argv: string[], params: PackageManagerOptions): string | null {
  const idx = findFirstNonOptionIndex(argv, 1, params);
  return idx === null ? null : normalizeLowercaseStringOrEmpty(argv[idx] ?? "");
}

function unwrapPnpmExecInvocation(argv: string[]): string[] | null {
  const idx = findFirstNonOptionIndex(argv, 1, PNPM_EXEC_OPTIONS);
  if (idx === null) {
    return null;
  }
  const token = argv[idx]?.trim();
  if (token === "exec") {
    const tail = argv.slice(idx + 1);
    const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
    const firstExecArg = normalizeOptionFlag(normalizedTail[0] ?? "");
    if (firstExecArg === "-c" || firstExecArg === "--shell-mode") {
      return null;
    }
    return normalizedTail.length > 0 ? normalizedTail : null;
  }
  if (token === "dlx") {
    return unwrapPackageExecArguments(argv, idx + 1, PNPM_DLX_OPTIONS, "stop");
  }
  if (token === "node") {
    const tail = argv.slice(idx + 1);
    const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
    return ["node", ...normalizedTail];
  }
  return null;
}

function unwrapPackageExecArguments(
  argv: string[],
  startIdx: number,
  params: PackageManagerOptions,
  terminator: "stop" | "reject",
): string[] | null {
  const idx = findFirstNonOptionIndex(argv, startIdx, params, terminator);
  return idx === null ? null : argv.slice(idx);
}

function unwrapNpmExecInvocation(argv: string[]): string[] | null {
  const idx = findFirstNonOptionIndex(argv, 1, NPM_EXEC_OPTIONS, "reject");
  if (idx === null || !NPM_EXEC_SUBCOMMANDS.has(argv[idx]?.trim() ?? "")) {
    return null;
  }
  const tail = argv.slice(idx + 1);
  if (tail[0] === "--") {
    return tail.length > 1 ? tail.slice(1) : null;
  }
  return unwrapPackageExecArguments(argv, idx + 1, NPM_DIRECT_EXEC_OPTIONS, "reject");
}

function unwrapYarnExecInvocation(argv: string[]): string[] | null {
  const idx = findFirstNonOptionIndex(argv, 1, {
    optionsWithValue: YARN_OPTIONS_WITH_VALUE,
    flagOptions: YARN_FLAG_OPTIONS,
  });
  if (idx === null) {
    return null;
  }
  const token = argv[idx]?.trim();
  if (token === "exec") {
    const tail = argv.slice(idx + 1);
    const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
    return normalizedTail.length > 0 ? normalizedTail : null;
  }
  if (token === "dlx") {
    return unwrapPackageExecArguments(argv, idx + 1, YARN_DLX_OPTIONS, "stop");
  }
  return null;
}

export function unwrapKnownPackageManagerExecInvocation(argv: string[]): string[] | null {
  const resolution = resolveKnownPackageManagerExecInvocation(argv);
  return resolution.kind === "unwrapped" ? resolution.argv : null;
}

export function resolveKnownPackageManagerExecInvocation(
  argv: string[],
): PackageManagerExecInvocation {
  const executable = normalizePackageManagerExecToken(argv[0] ?? "");
  switch (executable) {
    case "npm": {
      const unwrapped = unwrapNpmExecInvocation(argv);
      if (unwrapped) {
        return { kind: "unwrapped", argv: unwrapped };
      }
      const firstSubcommand = firstSubcommandAfterOptions(argv, NPM_EXEC_OPTIONS);
      return NPM_EXEC_SUBCOMMANDS.has(firstSubcommand ?? "")
        ? { kind: "unsafe-exec" }
        : firstSubcommand === null && containsSubcommandToken(argv.slice(1), NPM_EXEC_SUBCOMMANDS)
          ? { kind: "unsafe-exec" }
          : { kind: "not-exec" };
    }
    case "npx":
    case "bunx": {
      const unwrapped = unwrapPackageExecArguments(argv, 1, NPM_DIRECT_EXEC_OPTIONS, "reject");
      return unwrapped ? { kind: "unwrapped", argv: unwrapped } : { kind: "unsafe-exec" };
    }
    case "pnpm": {
      const unwrapped = unwrapPnpmExecInvocation(argv);
      if (unwrapped) {
        return { kind: "unwrapped", argv: unwrapped };
      }
      const firstSubcommand = firstSubcommandAfterOptions(argv, PNPM_EXEC_OPTIONS);
      const detectedKnownExec = PNPM_EXEC_SUBCOMMANDS.has(firstSubcommand ?? "");
      const hiddenKnownExec =
        firstSubcommand === null && containsSubcommandToken(argv.slice(1), PNPM_EXEC_SUBCOMMANDS);
      const implicitExecShorthand =
        firstSubcommand !== null &&
        !PNPM_SCRIPT_RUN_SUBCOMMANDS.has(firstSubcommand) &&
        !PNPM_BUILTIN_NON_EXEC_SUBCOMMANDS.has(firstSubcommand);
      return detectedKnownExec || hiddenKnownExec || implicitExecShorthand
        ? { kind: "unsafe-exec" }
        : { kind: "not-exec" };
    }
    case "yarn": {
      const unwrapped = unwrapYarnExecInvocation(argv);
      if (unwrapped) {
        return { kind: "unwrapped", argv: unwrapped };
      }
      const firstSubcommand = firstSubcommandAfterOptions(argv, YARN_EXEC_OPTIONS);
      const detectedKnownExec = YARN_EXEC_SUBCOMMANDS.has(firstSubcommand ?? "");
      const hiddenKnownExec =
        firstSubcommand === null && containsSubcommandToken(argv.slice(1), YARN_EXEC_SUBCOMMANDS);
      const implicitRunOrBin =
        firstSubcommand !== null &&
        (firstSubcommand === "run" || !YARN_BUILTIN_NON_EXEC_SUBCOMMANDS.has(firstSubcommand));
      return detectedKnownExec || hiddenKnownExec || implicitRunOrBin
        ? { kind: "unsafe-exec" }
        : { kind: "not-exec" };
    }
    default:
      return { kind: "not-package-manager" };
  }
}
