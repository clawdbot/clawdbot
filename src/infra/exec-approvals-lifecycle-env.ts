// Expands known shell environment references used in lifecycle-sensitive argv.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { unresolvedOpenClawConfigActionMayMutate } from "./exec-approvals-lifecycle-config.js";
import {
  classifyOpenClawGatewayArgv,
  unresolvedGatewayMethodMayHideLifecycle,
} from "./exec-approvals-lifecycle-gateway.js";
import { unresolvedNodeEntryMayHideLifecycle } from "./exec-approvals-lifecycle-node.js";
import { unresolvedOpenClawApprovalPolicyActionMayMutate } from "./exec-approvals-lifecycle-policy.js";
import { unresolvedPowerShellStartProcessMayHideLifecycle } from "./exec-approvals-lifecycle-powershell.js";
import {
  resolveLifecyclePackageRunnerArgv,
  unresolvedPackageMutationMayTargetOpenClaw,
} from "./exec-approvals-lifecycle-runners.js";
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
const UPDATE_OPTIONS_WITH_VALUE = new Set(["--channel", "--tag", "--timeout"]);
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

function isVariableReference(value: string | undefined): boolean {
  return VARIABLE_REFERENCE_RE.test(value ?? "");
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
    if (command === "update") {
      const actionIndex = scanFirstPositional(argv, commandIndex + 1, UPDATE_OPTIONS_WITH_VALUE);
      return isVariableReference(argv[actionIndex]);
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
