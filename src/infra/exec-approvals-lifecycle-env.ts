// Expands known shell environment references used in lifecycle-sensitive argv.
import { splitShellArgs } from "../utils/shell-argv.js";
import { classifyOpenClawGatewayArgv } from "./exec-approvals-lifecycle-gateway.js";
import { splitLifecycleInlineCommands } from "./exec-approvals-lifecycle-shell.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";
const POSIX_VARIABLE_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;
const POWERSHELL_VARIABLE_RE = /\$env:([A-Za-z_][A-Za-z0-9_]*)/giu;
const CMD_VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/gu;
const CMD_DELAYED_VARIABLE_RE = /!([A-Za-z_][A-Za-z0-9_]*)!/gu;
const VARIABLE_REFERENCE_RE =
  /\$\{[^}]+\}|\$(?:[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/iu;
const POSIX_PARAMETER_OPERATOR_RE = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})[^}]+\}/u;
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const LIFECYCLE_RUNNERS = new Set([
  "bun",
  "bunx",
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "saps",
  "start",
  "start-process",
  "yarn",
  "yarnpkg",
]);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set([
  "-h",
  "-m",
  "-p",
  "-s",
  "-t",
  "--host",
  "--image-policy",
  "--job-mode",
  "--lines",
  "--machine",
  "--output",
  "--property",
  "--root",
  "--runtime-scope",
  "--signal",
  "--state",
  "--type",
]);

export type LifecycleEnvironmentExpansion = {
  argv: string[];
  fieldSplitUncertain: boolean;
  unresolved: boolean;
};

function normalizedExecutable(value: string | undefined): string {
  return (
    (value ?? "")
      .trim()
      .split(/[\\/]/u)
      .pop()
      ?.toLowerCase()
      .replace(/\.(?:bat|cmd|com|exe)$/u, "") ?? ""
  );
}

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function scanFirstPositional(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
  standaloneOptions: ReadonlySet<string> = new Set(),
): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    const name = optionName(token);
    if (standaloneOptions.has(name)) {
      continue;
    }
    if (optionsWithValue.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
  }
  return argv.length;
}

/** Return true when a partial environment can fill a lifecycle-sensitive argv position. */
export function unresolvedEnvironmentMayHideLifecycle(argv: readonly string[]): boolean {
  if (!argv.some((token) => VARIABLE_REFERENCE_RE.test(token))) {
    return false;
  }
  if (VARIABLE_REFERENCE_RE.test(argv[0] ?? "")) {
    return true;
  }
  const executable = normalizedExecutable(argv[0]);
  const tokens = argv.map((token) => token.trim().toLowerCase());
  if (executable === "launchctl") {
    const actionIndex = scanFirstPositional(argv, 1, new Set(["-d", "-s"]));
    return !["blame", "list", "print", "procinfo"].includes(tokens[actionIndex] ?? "");
  }
  if (executable === "systemctl") {
    const actionIndex = scanFirstPositional(argv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE);
    return !["is-active", "is-enabled", "list-units", "show", "status"].includes(
      tokens[actionIndex] ?? "",
    );
  }
  if (executable === "openclaw") {
    const commandIndex = scanFirstPositional(
      argv,
      1,
      OPENCLAW_GLOBAL_OPTIONS,
      OPENCLAW_GLOBAL_FLAGS,
    );
    if (["daemon", "gateway"].includes(tokens[commandIndex] ?? "")) {
      return classifyOpenClawGatewayArgv(argv, commandIndex + 1);
    }
    return !["--help", "health", "probe", "status", "update.status"].includes(
      tokens[commandIndex] ?? "",
    );
  }
  if (["ash", "bash", "cmd", "dash", "fish", "ksh", "sh", "zsh"].includes(executable)) {
    const inline = extractShellWrapperInlineCommand([...argv]);
    if (inline === null) {
      return false;
    }
    return splitLifecycleInlineCommands(inline, executable === "cmd" ? "cmd" : "posix").some(
      (part) => {
        const nestedArgv = splitShellArgs(part);
        return nestedArgv ? unresolvedEnvironmentMayHideLifecycle(nestedArgv) : true;
      },
    );
  }
  if (LIFECYCLE_RUNNERS.has(executable)) {
    return /\b(?:add|daemon|gateway|install|remove|restart|rm|start|stop|uninstall|update|upgrade)\b/iu.test(
      argv.join(" "),
    );
  }
  return [
    "",
    "kill",
    "killall",
    "env",
    "pkill",
    "powershell",
    "pwsh",
    "schtasks",
    "service",
    "taskkill",
    "xargs",
  ].includes(executable);
}

function readEnvironmentValue(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  if (!env) {
    return undefined;
  }
  if (Object.hasOwn(env, key)) {
    return env[key];
  }
  if (process.platform !== "win32") {
    return undefined;
  }
  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey === undefined ? undefined : env[matchedKey];
}

function expandKnownEnvironmentReferences(
  value: string,
  env: NodeJS.ProcessEnv | undefined,
): string {
  const replaceKnown = (match: string, key: string): string =>
    readEnvironmentValue(env, key) ?? match;
  return value
    .replace(POWERSHELL_VARIABLE_RE, replaceKnown)
    .replace(POSIX_VARIABLE_RE, (match, braced: string | undefined, bare: string | undefined) =>
      replaceKnown(match, braced ?? bare ?? ""),
    )
    .replace(CMD_VARIABLE_RE, replaceKnown)
    .replace(CMD_DELAYED_VARIABLE_RE, replaceKnown);
}

/** Expand known references in executable command text while preserving single-quoted literals. */
export function expandKnownLifecycleEnvironmentCommand(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string {
  return command
    .split(/('[^']*')/u)
    .map((part, index) => (index % 2 === 0 ? expandKnownEnvironmentReferences(part, env) : part))
    .join("");
}

/** Expand variables whose environment value is known and report partial-env uncertainty. */
export function expandLifecycleEnvironmentArgv(params: {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  envComplete: boolean;
}): LifecycleEnvironmentExpansion {
  let fieldSplitUncertain = false;
  let unresolved = params.argv.some((token) => POSIX_PARAMETER_OPERATOR_RE.test(token));
  const replaceVariable = (key: string): string => {
    const value = readEnvironmentValue(params.env, key);
    if (value !== undefined) {
      fieldSplitUncertain ||= /\s/u.test(value);
      return value;
    }
    if (!params.envComplete) {
      unresolved = true;
    }
    return "";
  };
  const argv = params.argv.map((token) =>
    token
      .replace(POWERSHELL_VARIABLE_RE, (_match, key: string) => replaceVariable(key))
      .replace(POSIX_VARIABLE_RE, (_match, braced: string | undefined, bare: string | undefined) =>
        replaceVariable(braced ?? bare ?? ""),
      )
      .replace(CMD_VARIABLE_RE, (_match, key: string) => replaceVariable(key))
      .replace(CMD_DELAYED_VARIABLE_RE, (_match, key: string) => replaceVariable(key)),
  );
  return { argv, fieldSplitUncertain, unresolved };
}
