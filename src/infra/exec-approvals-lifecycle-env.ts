// Expands known shell environment references used in lifecycle-sensitive argv.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { resolveLifecycleXargsArgv } from "./exec-approvals-lifecycle-carriers.js";
import { unresolvedOpenClawConfigActionMayMutate } from "./exec-approvals-lifecycle-config.js";
import {
  classifyOpenClawGatewayArgv,
  unresolvedGatewayMethodMayHideLifecycle,
} from "./exec-approvals-lifecycle-gateway.js";
import { unresolvedOpenClawNodeServiceActionMayMutate } from "./exec-approvals-lifecycle-node-service.js";
import { unresolvedNodeEntryMayHideLifecycle } from "./exec-approvals-lifecycle-node.js";
import {
  unresolvedOpenClawHooksActionMayMutate,
  unresolvedOpenClawPluginsActionMayMutate,
} from "./exec-approvals-lifecycle-plugins.js";
import { unresolvedOpenClawApprovalPolicyActionMayMutate } from "./exec-approvals-lifecycle-policy.js";
import { unresolvedPowerShellStartProcessMayHideLifecycle } from "./exec-approvals-lifecycle-powershell.js";
import { unresolvedOpenClawResetArgvMayMutate } from "./exec-approvals-lifecycle-reset.js";
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
const POWERSHELL_VARIABLE_RE = /\$env:([A-Za-z_][A-Za-z0-9_]*)/giu;
const CMD_VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/gu;
const CMD_DELAYED_VARIABLE_RE = /!([A-Za-z_][A-Za-z0-9_]*)!/gu;
const POWERSHELL_LOCAL_VARIABLE_REFERENCE_RE = /\$(?!env:)[A-Za-z_][A-Za-z0-9_]*/iu;
const VARIABLE_REFERENCE_RE =
  /\$\{[^}]+\}|\$(?:[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/iu;
const POSIX_PARAMETER_OPERATOR_RE = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})[^}]+\}/u;
const ASSIGNMENT_TOKEN_RE = /^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=/iu;
const POWERSHELL_ENV_NAME_RE = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/iu;
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const UPDATE_OPTIONS_WITH_VALUE = new Set(["--channel", "--tag", "--timeout"]);
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

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function isVariableReference(value: string | undefined): boolean {
  return VARIABLE_REFERENCE_RE.test(value ?? "");
}

function collectAssignedEnvironmentKeys(command: string, keys: Set<string>, depth: number): void {
  if (depth > 8) {
    return;
  }
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

/** Return true when a partial environment can fill a lifecycle-sensitive argv position. */
export function unresolvedEnvironmentMayHideLifecycle(argv: readonly string[]): boolean {
  if (!argv.some(isVariableReference)) {
    return false;
  }
  if (isVariableReference(argv[0])) {
    return true;
  }
  const executable = normalizedExecutable(argv[0]);
  const tokens = argv.map((token) => token.trim().toLowerCase());
  if (["&", "."].includes(executable)) {
    return argv.length > 1 ? unresolvedEnvironmentMayHideLifecycle(argv.slice(1)) : false;
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
    if (isVariableReference(argv[commandIndex])) {
      return true;
    }
    if (["daemon", "gateway"].includes(command)) {
      return (
        classifyOpenClawGatewayArgv(argv, commandIndex + 1) ||
        unresolvedGatewayMethodMayHideLifecycle(argv, commandIndex + 1, isVariableReference)
      );
    }
    if (command === "config") {
      return unresolvedOpenClawConfigActionMayMutate(argv, commandIndex + 1, isVariableReference);
    }
    if (["approvals", "exec-approvals", "exec-policy"].includes(command)) {
      return unresolvedOpenClawApprovalPolicyActionMayMutate(
        command,
        argv,
        commandIndex + 1,
        isVariableReference,
      );
    }
    if (command === "node") {
      return unresolvedOpenClawNodeServiceActionMayMutate(
        argv,
        commandIndex + 1,
        isVariableReference,
      );
    }
    if (command === "plugins") {
      return unresolvedOpenClawPluginsActionMayMutate(argv, commandIndex + 1, isVariableReference);
    }
    if (command === "hooks") {
      return unresolvedOpenClawHooksActionMayMutate(argv, commandIndex + 1, isVariableReference);
    }
    if (command === "reset") {
      return unresolvedOpenClawResetArgvMayMutate(argv, commandIndex + 1, isVariableReference);
    }
    if (command === "update") {
      const actionIndex = scanFirstPositional(argv, commandIndex + 1, UPDATE_OPTIONS_WITH_VALUE);
      return (
        isVariableReference(argv[actionIndex]) ||
        lifecycleBooleanOptionValueMayBeDynamic(
          argv,
          commandIndex + 1,
          DRY_RUN_OPTION,
          isVariableReference,
          UPDATE_OPTIONS_WITH_VALUE,
        )
      );
    }
    if (command === "uninstall") {
      return lifecycleBooleanOptionValueMayBeDynamic(
        argv,
        commandIndex + 1,
        DRY_RUN_OPTION,
        isVariableReference,
      );
    }
    return ["configure", "doctor", "onboard", "setup"].includes(command);
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
      return nestedArgv ? unresolvedEnvironmentMayHideLifecycle(nestedArgv) : true;
    });
  }
  const packageRunner = resolveLifecyclePackageRunnerArgv(argv);
  if (packageRunner.kind === "approval-required") {
    return true;
  }
  if (packageRunner.kind === "argv") {
    return unresolvedEnvironmentMayHideLifecycle(packageRunner.argv);
  }
  if (unresolvedPackageMutationMayTargetOpenClaw(argv, isVariableReference)) {
    return true;
  }
  if (unresolvedNodeEntryMayHideLifecycle(argv, isVariableReference)) {
    return true;
  }
  if (unresolvedPowerShellStartProcessMayHideLifecycle(argv, isVariableReference)) {
    return true;
  }
  if (executable === "xargs") {
    const xargs = resolveLifecycleXargsArgv(argv);
    if (xargs.kind === "approval-required") {
      return true;
    }
    return xargs.kind === "argv" ? unresolvedEnvironmentMayHideLifecycle(xargs.argv) : false;
  }
  if (executable === "env") {
    const carried = resolveCarrierCommandArgv([...argv], 0, { includeExec: true });
    return carried ? unresolvedEnvironmentMayHideLifecycle(carried) : false;
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
  shadowedKeys: ReadonlySet<string>,
  dialect: LifecycleShellDialect,
): string {
  const replaceKnown = (match: string, key: string): string =>
    shadowedKeys.has(key.toLowerCase()) ? match : (readEnvironmentValue(env, key) ?? match);
  if (dialect === "powershell") {
    return value.replace(POWERSHELL_VARIABLE_RE, replaceKnown);
  }
  if (dialect === "cmd") {
    return value
      .replace(CMD_VARIABLE_RE, replaceKnown)
      .replace(CMD_DELAYED_VARIABLE_RE, replaceKnown);
  }
  return value.replace(
    POSIX_VARIABLE_RE,
    (match, braced: string | undefined, bare: string | undefined) =>
      replaceKnown(match, braced ?? bare ?? ""),
  );
}

/** Expand known references in executable command text while preserving single-quoted literals. */
export function expandKnownLifecycleEnvironmentCommand(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  shadowedKeys: ReadonlySet<string> = new Set(),
  dialect: LifecycleShellDialect = "posix",
): string {
  if (dialect === "cmd") {
    return expandKnownEnvironmentReferences(command, env, shadowedKeys, dialect);
  }
  // POSIX shells and PowerShell both suppress environment expansion inside
  // single-quoted strings. cmd.exe does not and is handled above.
  return command
    .split(/('[^']*')/u)
    .map((part, index) =>
      index % 2 === 0 ? expandKnownEnvironmentReferences(part, env, shadowedKeys, dialect) : part,
    )
    .join("");
}

/** Expand variables whose environment value is known and report partial-env uncertainty. */
export function expandLifecycleEnvironmentArgv(params: {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  envComplete: boolean;
  dialect?: LifecycleShellDialect;
  shadowedKeys?: ReadonlySet<string>;
}): LifecycleEnvironmentExpansion {
  let fieldSplitUncertain = false;
  const dialect = params.dialect ?? "posix";
  let unresolved =
    dialect === "posix" && params.argv.some((token) => POSIX_PARAMETER_OPERATOR_RE.test(token));
  const replaceVariable = (key: string): string => {
    if (params.shadowedKeys?.has(key.toLowerCase())) {
      unresolved = true;
      return "";
    }
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
  const argv = params.argv.map((token) => {
    if (dialect === "powershell") {
      unresolved ||= POWERSHELL_LOCAL_VARIABLE_REFERENCE_RE.test(token);
      return token.replace(POWERSHELL_VARIABLE_RE, (_match, key: string) => replaceVariable(key));
    }
    if (dialect === "cmd") {
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
