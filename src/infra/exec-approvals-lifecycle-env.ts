// Expands known shell environment references used in lifecycle-sensitive argv.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { resolveLifecycleXargsArgv } from "./exec-approvals-lifecycle-carriers.js";
import {
  classifyOpenClawGatewayArgv,
  unresolvedGatewayMethodMayHideLifecycle,
} from "./exec-approvals-lifecycle-gateway.js";
import { unresolvedOpenClawNodeServiceActionMayMutate } from "./exec-approvals-lifecycle-node-service.js";
import { unresolvedNodeEntryMayHideLifecycle } from "./exec-approvals-lifecycle-node.js";
import { unresolvedPowerShellStartProcessMayHideLifecycle } from "./exec-approvals-lifecycle-powershell.js";
import {
  resolveLifecyclePackageRunnerArgv,
  unresolvedPackageMutationMayTargetOpenClaw,
} from "./exec-approvals-lifecycle-runners.js";
import {
  type LifecycleShellDialect,
  splitLifecycleInlineCommands,
} from "./exec-approvals-lifecycle-shell.js";
import { lifecycleBooleanOptionValueMayBeDynamic } from "./exec-approvals-lifecycle-tokens.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";
const POSIX_VARIABLE_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;
const POSIX_SPECIAL_PARAMETER_RE = /\$(?:[@*#?$!-]|[0-9]+|\{(?:[@*#?$!-]|[0-9]+)\})/u;
const POWERSHELL_VARIABLE_RE = /\$env:([A-Za-z_][A-Za-z0-9_]*)/giu;
const CMD_VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/gu;
const CMD_MODIFIED_VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*):[^%]*%/u;
const CMD_DELAYED_VARIABLE_RE = /!([A-Za-z_][A-Za-z0-9_]*)!/gu;
const CMD_DELAYED_MODIFIED_VARIABLE_RE = /!([A-Za-z_][A-Za-z0-9_]*):[^!]*!/u;
const POWERSHELL_LOCAL_VARIABLE_REFERENCE_RE = /\$(?!env:)[A-Za-z_][A-Za-z0-9_]*/iu;
const POWERSHELL_SPLATTED_VARIABLE_REFERENCE_RE = /@[A-Za-z_][A-Za-z0-9_]*/iu;
const VARIABLE_REFERENCE_RE =
  /\$\{[^}]+\}|\$(?:[@*#?$!-]|[0-9]+|[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)|@[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*(?::[^%]*)?%|![A-Za-z_][A-Za-z0-9_]*(?::[^!]*)?!/iu;
const POSIX_PARAMETER_OPERATOR_RE = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})[^}]+\}/u;
const ASSIGNMENT_TOKEN_RE = /^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=/iu;
const POWERSHELL_ENV_NAME_RE = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/iu;
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);
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

type LifecycleEnvironmentExpansion = {
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

/** Resolve command-level quoting rules from its explicit wrapper and host platform. */
export function lifecycleCommandShellDialect(
  executableToken: string | undefined,
  platform: NodeJS.Platform,
): LifecycleShellDialect {
  const executable = normalizedExecutable(executableToken);
  if (executable === "cmd") {
    return "cmd";
  }
  if (["powershell", "pwsh"].includes(executable)) {
    return "powershell";
  }
  if (["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"].includes(executable)) {
    return "posix";
  }
  return platform === "win32" ? "powershell" : "posix";
}

/** Return true when POSIX expansion can split an unquoted environment reference into argv. */
export function lifecycleCommandHasUnquotedEnvironmentReference(
  command: string,
  dialect: LifecycleShellDialect,
): boolean {
  if (dialect !== "posix") {
    return false;
  }
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null && char === "$") {
      const suffix = command.slice(index);
      if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/u.test(suffix)) {
        return true;
      }
    }
  }
  return false;
}

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function isVariableReference(value: string | undefined): boolean {
  return VARIABLE_REFERENCE_RE.test(value ?? "");
}

function collectShellBinderKeys(command: string, keys: Set<string>): void {
  for (const match of command.matchAll(/\b(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gu)) {
    keys.add((match[1] ?? "").toLowerCase());
  }
  for (const match of command.matchAll(/\bfor\s*\(\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gu)) {
    keys.add((match[1] ?? "").toLowerCase());
  }
  for (const match of command.matchAll(/\b(?:mapfile|read|readarray)\b([^;&|}\n]*)/gu)) {
    const tokens = splitShellArgs(match[1] ?? "") ?? [];
    for (const token of tokens) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(token)) {
        keys.add(token.toLowerCase());
      }
    }
  }
  for (const match of command.matchAll(
    /\bgetopts\s+(?:"[^"]*"|'[^']*'|\S+)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
  )) {
    keys.add((match[1] ?? "").toLowerCase());
  }
}

function collectAssignedEnvironmentKeys(command: string, keys: Set<string>, depth: number): void {
  if (depth > 8) {
    return;
  }
  const opaqueProcessEnvironmentWrite =
    /\[(?:System\.)?Environment\]\s*::\s*SetEnvironmentVariable\s*\(|\b(?:clear|new|remove|rename|set)-item\b[^;&|\n]*\benv:/iu.test(
      command,
    );
  for (const match of command.matchAll(
    /\[(?:System\.)?Environment\]\s*::\s*SetEnvironmentVariable\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1/giu,
  )) {
    keys.add((match[2] ?? "").toLowerCase());
  }
  for (const match of command.matchAll(
    /\b(?:clear|new|remove|rename|set)-item\b[^;&|\n]*\benv:\s*["']?([A-Za-z_][A-Za-z0-9_]*)/giu,
  )) {
    keys.add((match[1] ?? "").toLowerCase());
  }
  if (opaqueProcessEnvironmentWrite) {
    for (const match of command.matchAll(POWERSHELL_VARIABLE_RE)) {
      keys.add((match[1] ?? "").toLowerCase());
    }
  }
  collectShellBinderKeys(command, keys);
  for (const part of splitLifecycleInlineCommands(command)) {
    const argv = splitShellArgs(part);
    if (!argv?.length) {
      continue;
    }
    const inline = extractShellWrapperInlineCommand(argv);
    if (inline !== null) {
      collectAssignedEnvironmentKeys(inline, keys, depth + 1);
    }
    let index = 0;
    const leadingAssignments: string[] = [];
    for (; index < argv.length; index += 1) {
      const match = ASSIGNMENT_TOKEN_RE.exec(argv[index] ?? "");
      if (!match) {
        break;
      }
      leadingAssignments.push((match[1] ?? "").toLowerCase());
    }
    if (index === argv.length) {
      for (const key of leadingAssignments) {
        keys.add(key);
      }
    }
    const executable = normalizedExecutable(argv[index]);
    if (["declare", "export", "local", "readonly", "set", "typeset"].includes(executable)) {
      for (const token of argv.slice(index + 1)) {
        const match = ASSIGNMENT_TOKEN_RE.exec(token);
        if (match) {
          keys.add((match[1] ?? "").toLowerCase());
        }
      }
    }
    for (let tokenIndex = 0; tokenIndex + 1 < argv.length; tokenIndex += 1) {
      const match = POWERSHELL_ENV_NAME_RE.exec(argv[tokenIndex] ?? "");
      if (match && argv[tokenIndex + 1] === "=") {
        keys.add((match[1] ?? "").toLowerCase());
      }
    }
  }
}

/** Collect environment names assigned by the command before later references are expanded. */
export function lifecycleAssignedEnvironmentKeys(command: string): ReadonlySet<string> {
  const keys = new Set<string>();
  collectAssignedEnvironmentKeys(command, keys, 0);
  return keys;
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

/** Return true when dynamic text can fill a lifecycle-sensitive argv position. */
export function lifecycleDynamicArgvMayHideLifecycle(
  argv: readonly string[],
  isDynamic: (value: string | undefined) => boolean,
): boolean {
  if (!argv.some(isDynamic)) {
    return false;
  }
  if (isDynamic(argv[0])) {
    return true;
  }
  const executable = normalizedExecutable(argv[0]);
  const tokens = argv.map((token) => token.trim().toLowerCase());
  if (["&", "."].includes(executable)) {
    return argv.length > 1 ? lifecycleDynamicArgvMayHideLifecycle(argv.slice(1), isDynamic) : false;
  }
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
    const command = tokens[commandIndex] ?? "";
    if (isDynamic(argv[commandIndex])) {
      return true;
    }
    if (["daemon", "gateway"].includes(command)) {
      return (
        classifyOpenClawGatewayArgv(argv, commandIndex + 1) ||
        unresolvedGatewayMethodMayHideLifecycle(argv, commandIndex + 1, isDynamic)
      );
    }
    if (command === "node") {
      return unresolvedOpenClawNodeServiceActionMayMutate(argv, commandIndex + 1, isDynamic);
    }
    if (command === "uninstall") {
      return lifecycleBooleanOptionValueMayBeDynamic(
        argv,
        commandIndex + 1,
        DRY_RUN_OPTION,
        isDynamic,
      );
    }
    return false;
  }
  if (
    ["ash", "bash", "cmd", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh"].includes(
      executable,
    )
  ) {
    const inline = extractShellWrapperInlineCommand([...argv]);
    if (inline === null) {
      return false;
    }
    const dialect =
      executable === "cmd"
        ? "cmd"
        : ["powershell", "pwsh"].includes(executable)
          ? "powershell"
          : "posix";
    return splitLifecycleInlineCommands(inline, dialect).some((part) => {
      const nestedArgv = splitShellArgs(part);
      return nestedArgv ? lifecycleDynamicArgvMayHideLifecycle(nestedArgv, isDynamic) : true;
    });
  }
  const packageRunner = resolveLifecyclePackageRunnerArgv(argv);
  if (packageRunner.kind === "approval-required") {
    return true;
  }
  if (packageRunner.kind === "argv") {
    return lifecycleDynamicArgvMayHideLifecycle(packageRunner.argv, isDynamic);
  }
  if (unresolvedPackageMutationMayTargetOpenClaw(argv, isDynamic)) {
    return true;
  }
  if (unresolvedNodeEntryMayHideLifecycle(argv, isDynamic)) {
    return true;
  }
  if (unresolvedPowerShellStartProcessMayHideLifecycle(argv, isDynamic)) {
    return true;
  }
  if (executable === "xargs") {
    const xargs = resolveLifecycleXargsArgv(argv);
    if (xargs.kind === "approval-required") {
      return true;
    }
    return xargs.kind === "argv"
      ? lifecycleDynamicArgvMayHideLifecycle(xargs.argv, isDynamic)
      : false;
  }
  if (executable === "env") {
    const carried = resolveCarrierCommandArgv([...argv], 0, { includeExec: true });
    return carried ? lifecycleDynamicArgvMayHideLifecycle(carried, isDynamic) : false;
  }
  return [
    "",
    "kill",
    "killall",
    "pkill",
    "remove-service",
    "restart-service",
    "resume-service",
    "schtasks",
    "service",
    "set-service",
    "start-service",
    "stop-process",
    "stop-service",
    "suspend-service",
    "taskkill",
  ].includes(executable);
}

/** Return true when a partial environment can fill a lifecycle-sensitive argv position. */
export function unresolvedEnvironmentMayHideLifecycle(argv: readonly string[]): boolean {
  return lifecycleDynamicArgvMayHideLifecycle(argv, isVariableReference);
}

/** Return true when PowerShell expressions can fill a lifecycle-sensitive argv position. */
export function powerShellCalculatedArgvMayHideLifecycle(argv: readonly string[]): boolean {
  return lifecycleDynamicArgvMayHideLifecycle(argv, (value) => {
    const token = (value ?? "").trim();
    return /^(?:[$@]?\(|[$@[{])|[+{}]|::/u.test(token) || token.toLowerCase() === "-f";
  });
}

function readEnvironmentValue(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (!env) {
    return undefined;
  }
  if (Object.hasOwn(env, key)) {
    return env[key];
  }
  if (platform !== "win32") {
    return undefined;
  }
  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey === undefined ? undefined : env[matchedKey];
}

/** Expand variables whose environment value is known and report partial-env uncertainty. */
export function expandLifecycleEnvironmentArgv(params: {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  envComplete: boolean;
  dialect?: LifecycleShellDialect;
  platform?: NodeJS.Platform;
  shadowedKeys?: ReadonlySet<string>;
}): LifecycleEnvironmentExpansion {
  let fieldSplitUncertain = false;
  const dialect = params.dialect ?? "posix";
  let unresolved =
    dialect === "posix" &&
    params.argv.some(
      (token) => POSIX_PARAMETER_OPERATOR_RE.test(token) || POSIX_SPECIAL_PARAMETER_RE.test(token),
    );
  const replaceVariable = (key: string): string => {
    if (params.shadowedKeys?.has(key.toLowerCase())) {
      unresolved = true;
      return "";
    }
    const value = readEnvironmentValue(params.env, key, params.platform ?? process.platform);
    if (value !== undefined) {
      fieldSplitUncertain ||= value.length === 0 || /\s/u.test(value);
      return value;
    }
    if (!params.envComplete) {
      unresolved = true;
    }
    return "";
  };
  const argv = params.argv.map((token) => {
    if (dialect === "powershell") {
      unresolved ||=
        POWERSHELL_LOCAL_VARIABLE_REFERENCE_RE.test(token) ||
        POWERSHELL_SPLATTED_VARIABLE_REFERENCE_RE.test(token);
      return token.replace(POWERSHELL_VARIABLE_RE, (_match, key: string) => replaceVariable(key));
    }
    if (dialect === "cmd") {
      unresolved ||=
        CMD_MODIFIED_VARIABLE_RE.test(token) || CMD_DELAYED_MODIFIED_VARIABLE_RE.test(token);
      return token
        .replace(CMD_VARIABLE_RE, (_match, key: string) => replaceVariable(key))
        .replace(CMD_DELAYED_VARIABLE_RE, (_match, key: string) => replaceVariable(key));
    }
    return token.replace(
      POSIX_VARIABLE_RE,
      (_match, braced: string | undefined, bare: string | undefined) =>
        replaceVariable(braced ?? bare ?? ""),
    );
  });
  return { argv, fieldSplitUncertain, unresolved };
}
