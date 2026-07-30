// Classifies OpenClaw self-lifecycle mutations before generic exec trust can apply.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { unwrapKnownDispatchWrapperInvocation } from "./dispatch-wrapper-resolution.js";
import { resolveLifecycleXargsArgv } from "./exec-approvals-lifecycle-carriers.js";
import { classifyOpenClawConfigArgv } from "./exec-approvals-lifecycle-config.js";
import { classifyOpenClawDoctorArgv } from "./exec-approvals-lifecycle-doctor.js";
import {
  expandKnownLifecycleEnvironmentCommand,
  expandLifecycleEnvironmentArgv,
  lifecycleAssignedEnvironmentKeys,
  unresolvedEnvironmentMayHideLifecycle,
} from "./exec-approvals-lifecycle-env.js";
import { classifyOpenClawGatewayArgv } from "./exec-approvals-lifecycle-gateway.js";
import { classifyOpenClawNodeServiceArgv } from "./exec-approvals-lifecycle-node-service.js";
import { resolveNodeOpenClawArgv } from "./exec-approvals-lifecycle-node.js";
import {
  isOpenClawExecutablePattern,
  matchesOpenClawProcessPattern,
  matchesOpenClawUnitPattern,
} from "./exec-approvals-lifecycle-patterns.js";
import { classifyOpenClawApprovalPolicyArgv } from "./exec-approvals-lifecycle-policy.js";
import { resolvePowerShellStartProcessOpenClawArgv } from "./exec-approvals-lifecycle-powershell.js";
import { resolveLifecyclePackageRunnerArgv } from "./exec-approvals-lifecycle-runners.js";
import {
  splitLifecycleCommandText,
  splitLifecycleInlineCommands,
  stripLifecyclePosixAssignments,
} from "./exec-approvals-lifecycle-shell.js";
import {
  bindLifecyclePosixShellPositionals,
  extractShellSubstitutionCommands,
  lifecyclePositionalBindingRequiresApproval,
  lifecycleSubstitutionResultMayHideLifecycle,
  resolveLifecyclePosixShellPositionals,
} from "./exec-approvals-lifecycle-substitutions.js";
import type { ExecCommandSegment } from "./exec-command-analysis-types.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";

const MAX_NESTED_COMMAND_DEPTH = 8;
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const UPDATE_OPTIONS_WITH_VALUE = new Set(["--channel", "--tag", "--timeout"]);
const LAUNCHCTL_MUTATIONS = new Set([
  "attach",
  "bootstrap",
  "bootout",
  "debug",
  "disable",
  "enable",
  "kickstart",
  "kill",
  "load",
  "remove",
  "start",
  "stop",
  "submit",
  "unload",
]);
const SYSTEMCTL_MUTATIONS = new Set([
  "add-requires",
  "add-wants",
  "bind",
  "cancel",
  "clean",
  "disable",
  "edit",
  "enable",
  "force-reload",
  "freeze",
  "import-environment",
  "isolate",
  "kill",
  "link",
  "mask",
  "preset",
  "reenable",
  "reload",
  "reload-or-restart",
  "reload-or-try-restart",
  "reset-failed",
  "remove-requires",
  "remove-wants",
  "restart",
  "revert",
  "set-default",
  "set-environment",
  "set-property",
  "start",
  "stop",
  "thaw",
  "try-reload-or-restart",
  "try-restart",
  "unmask",
  "unset-environment",
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
const POWERSHELL_SERVICE_MUTATIONS = new Set([
  "new-service",
  "remove-service",
  "restart-service",
  "resume-service",
  "set-service",
  "start-service",
  "stop-process",
  "stop-service",
  "suspend-service",
  "spps",
  "spsv",
  "sasv",
]);

type LifecycleSegment = Pick<ExecCommandSegment, "argv"> &
  Partial<Pick<ExecCommandSegment, "raw" | "resolution" | "sourceArgv">>;

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

function looksLikeOpenClaw(value: string | undefined): boolean {
  const normalized = normalizedToken(value)
    .replace(/\[([a-z0-9])\]/giu, "$1")
    .replace(/["']/gu, "");
  return normalized.includes("openclaw") || /opencla[?*]/u.test(normalized);
}

function isOpenClawExecutable(value: string | undefined): boolean {
  return isOpenClawExecutablePattern(value);
}

function unresolvedDepthMayHideLifecycle(argv: readonly string[]): boolean {
  return (
    argv.some(looksLikeOpenClaw) &&
    /\b(?:daemon|gateway|install|kill|remove|restart|start|stop|uninstall|update)\b/iu.test(
      argv.join(" "),
    )
  );
}

function hasHelpOrVersion(argv: readonly string[]): boolean {
  return argv.some((token) => HELP_OR_VERSION_FLAGS.has(token.trim()));
}

function hasEffectiveHelpOrVersion(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): boolean {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = optionName(token);
    if (HELP_OR_VERSION_FLAGS.has(token)) {
      return true;
    }
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return false;
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
    const name = optionName(token);
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return argv.length;
}

function classifyUpdateArgv(argv: readonly string[], start: number): boolean {
  if (hasEffectiveHelpOrVersion(argv, start, UPDATE_OPTIONS_WITH_VALUE)) {
    return false;
  }
  const positionalIndex = scanFirstPositional(argv, start, UPDATE_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[positionalIndex]);
  if (action === "status") {
    return false;
  }
  if (
    argv.slice(start).some((token) => normalizedToken(token) === "--dry-run") &&
    !["finalize", "repair", "wizard"].includes(action)
  ) {
    return false;
  }
  return true;
}

function classifyOpenClawArgv(argv: readonly string[]): boolean {
  let index = 1;
  for (; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const lower = normalizedToken(token);
    if (HELP_OR_VERSION_FLAGS.has(token)) {
      return false;
    }
    if (lower === "--update") {
      return classifyUpdateArgv(argv, index + 1);
    }
    if (OPENCLAW_GLOBAL_FLAGS.has(lower)) {
      continue;
    }
    const name = optionName(token);
    if (OPENCLAW_GLOBAL_OPTIONS.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    break;
  }

  const command = normalizedToken(argv[index]);
  switch (command) {
    case "approvals":
    case "exec-approvals":
    case "exec-policy":
      return classifyOpenClawApprovalPolicyArgv(command, argv, index + 1);
    case "config":
      return classifyOpenClawConfigArgv(argv, index + 1);
    case "daemon":
    case "gateway":
      return classifyOpenClawGatewayArgv(argv, index + 1);
    case "uninstall":
      return (
        !hasHelpOrVersion(argv.slice(index + 1)) &&
        !argv.slice(index + 1).some((token) => normalizedToken(token) === "--dry-run")
      );
    case "update":
      return classifyUpdateArgv(argv, index + 1);
    case "doctor":
      return classifyOpenClawDoctorArgv(argv, index + 1);
    case "node":
      return classifyOpenClawNodeServiceArgv(argv, index + 1);
    case "configure":
    case "onboard":
    case "setup":
      return !HELP_OR_VERSION_FLAGS.has(argv[index + 1]?.trim() ?? "");
    default:
      return false;
  }
}

function classifyLaunchctl(argv: readonly string[], raw: string, depth: number): boolean {
  const optionsWithValue = new Set(["-d", "-s"]);
  if (hasEffectiveHelpOrVersion(argv, 1, optionsWithValue)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, optionsWithValue);
  const action = normalizedToken(argv[actionIndex]);
  if (["asuser", "bsexec"].includes(action)) {
    const commandArgv = argv.slice(actionIndex + 2);
    return commandArgv.length > 0 && classifyArgv(commandArgv, raw, depth + 1);
  }
  if (!LAUNCHCTL_MUTATIONS.has(action)) {
    return false;
  }
  return argv.slice(actionIndex + 1).some(looksLikeOpenClaw);
}

function argvUsesSignalZero(argv: readonly string[]): boolean {
  let effectiveSignal: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    const lower = normalizedToken(token);
    if (lower === "-0") {
      effectiveSignal = "0";
    } else if (lower.startsWith("-s") && lower.length > 2) {
      effectiveSignal = lower.slice(2);
    } else if (lower.startsWith("--signal=")) {
      effectiveSignal = lower.slice("--signal=".length);
    } else if (lower === "-s" || lower === "--signal") {
      effectiveSignal = normalizedToken(argv[index + 1]);
      index += 1;
    } else if (effectiveSignal !== undefined && lower.startsWith("-")) {
      // A later option may override or otherwise alter signal delivery; fail closed.
      effectiveSignal = undefined;
    }
  }
  return effectiveSignal === "0";
}

function classifySystemctl(argv: readonly string[]): boolean {
  const endOfOptions = argv.indexOf("--");
  const preSeparatorArgv = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);
  if (hasEffectiveHelpOrVersion(preSeparatorArgv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[actionIndex]);
  if (!SYSTEMCTL_MUTATIONS.has(action)) {
    const concealedMutation = argv
      .slice(actionIndex + 1)
      .some((token) => SYSTEMCTL_MUTATIONS.has(normalizedToken(token)));
    const optionBeforeAction = argv.slice(1, actionIndex).some((token) => token.startsWith("-"));
    return optionBeforeAction && concealedMutation && argv.some(matchesOpenClawUnitPattern);
  }
  if (action === "kill" && argvUsesSignalZero(argv)) {
    return false;
  }
  return argv.slice(actionIndex + 1).some(matchesOpenClawUnitPattern);
}

function classifyServiceManager(argv: readonly string[]): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "service") {
    return (
      looksLikeOpenClaw(argv[1]) &&
      ["force-reload", "reload", "restart", "start", "stop", "try-restart"].includes(
        normalizedToken(argv[2]),
      )
    );
  }
  if (executable === "sc") {
    const actionIndex = argv[1]?.startsWith("\\\\") ? 2 : 1;
    return (
      [
        "config",
        "continue",
        "control",
        "create",
        "delete",
        "description",
        "failure",
        "failureflag",
        "managedaccount",
        "pause",
        "preferrednode",
        "privs",
        "sdset",
        "sidtype",
        "start",
        "stop",
        "triggerinfo",
      ].includes(normalizedToken(argv[actionIndex])) &&
      argv.slice(actionIndex + 1).some(looksLikeOpenClaw)
    );
  }
  if (executable === "net") {
    return (
      ["continue", "pause", "start", "stop"].includes(normalizedToken(argv[1])) &&
      argv.slice(2).some(looksLikeOpenClaw)
    );
  }
  return false;
}

function classifyScheduledTask(argv: readonly string[]): boolean {
  if (hasHelpOrVersion(argv) || argv.some((token) => normalizedToken(token) === "/?")) {
    return false;
  }
  const mutation = argv.some((token) =>
    ["/change", "/create", "/delete", "/end", "/run"].includes(optionName(token)),
  );
  return mutation && argv.some(looksLikeOpenClaw);
}

type ShellContext = "powershell" | undefined;

function classifyProcessMutation(
  argv: readonly string[],
  raw: string,
  shellContext: ShellContext,
): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (["killall", "pkill"].includes(executable)) {
    if (
      hasHelpOrVersion(argv) ||
      argvUsesSignalZero(argv) ||
      argv.some((token) => ["-l", "--list"].includes(normalizedToken(token)))
    ) {
      return false;
    }
    return argv.slice(1).some(matchesOpenClawProcessPattern);
  }
  if (executable === "taskkill") {
    return (
      !argv.some((token) => normalizedToken(token) === "/?") &&
      argv.some(matchesOpenClawProcessPattern)
    );
  }
  if (executable === "kill") {
    if (shellContext === "powershell") {
      return argv.slice(1).some(matchesOpenClawProcessPattern);
    }
    if (
      hasHelpOrVersion(argv) ||
      argvUsesSignalZero(argv) ||
      argv.some((token) => normalizedToken(token) === "-l")
    ) {
      return false;
    }
    const normalizedRaw = raw
      .replace(/\[([a-z0-9])\]/giu, "$1")
      .replace(/''|""/gu, "")
      .replace(/\\([a-z0-9])/giu, "$1");
    const substitutionSelectsOpenClaw = extractShellSubstitutionCommands(raw).commands.some(
      (nested) =>
        splitLifecycleInlineCommands(nested).some((part) => {
          const nestedArgv = splitShellArgs(part);
          return (
            nestedArgv !== null &&
            ["pgrep", "pidof"].includes(normalizeExecutableToken(nestedArgv[0] ?? "")) &&
            nestedArgv.slice(1).some(matchesOpenClawProcessPattern)
          );
        }),
    );
    return (
      substitutionSelectsOpenClaw ||
      /\b(?:pgrep|pidof)\b[\s\S]{0,120}\bopenclaw\b/iu.test(normalizedRaw) ||
      /\$\([^)]*\bopenclaw\b[^)]*\)|`[^`]*\bopenclaw\b[^`]*`/iu.test(normalizedRaw)
    );
  }
  if (POWERSHELL_SERVICE_MUTATIONS.has(executable)) {
    return argv.slice(1).some(matchesOpenClawProcessPattern);
  }
  return false;
}

function isPowerShellSelection(argv: readonly string[], allowUnresolved: boolean): boolean {
  return (
    ["get-process", "get-service", "gps", "gsv", "ps"].includes(
      normalizeExecutableToken(argv[0] ?? ""),
    ) &&
    argv
      .slice(1)
      .some(
        (token) =>
          looksLikeOpenClaw(token) ||
          (allowUnresolved && /\$env:[A-Za-z_][A-Za-z0-9_]*/iu.test(token)),
      )
  );
}

function isPowerShellPipelineMutation(argv: readonly string[]): boolean {
  return [
    "kill",
    "remove-service",
    "restart-service",
    "resume-service",
    "sasv",
    "set-service",
    "start-service",
    "stop-process",
    "stop-service",
    "suspend-service",
    "spps",
    "spsv",
  ].includes(normalizeExecutableToken(argv[0] ?? ""));
}

function commandHasPowerShellLifecyclePipeline(command: string, allowUnresolved = false): boolean {
  const stages = splitLifecycleCommandText(command, new Set(["|"]), "powershell");
  if (stages.length < 2) {
    return false;
  }
  let selectedOpenClaw = false;
  for (const stage of stages) {
    const normalizedStage = stage.trim().replace(/^[({\s]+|[)}\s]+$/gu, "");
    const argv = splitShellArgs(normalizedStage);
    if (!argv) {
      return false;
    }
    if (isPowerShellSelection(argv, allowUnresolved)) {
      selectedOpenClaw = true;
      continue;
    }
    if (selectedOpenClaw && isPowerShellPipelineMutation(argv)) {
      return true;
    }
  }
  return false;
}

function commandHasLifecycleSubstitution(
  command: string,
  depth: number,
  shellContext?: ShellContext,
  cwd?: string,
): boolean {
  const scan = extractShellSubstitutionCommands(command);
  if (scan.uncertain) {
    return true;
  }
  return scan.commands.some((nested) =>
    splitLifecycleInlineCommands(
      nested,
      shellContext === "powershell" ? "powershell" : "posix",
    ).some((part) => {
      const argv = splitShellArgs(part);
      return argv ? classifyArgv(argv, part, depth + 1, shellContext, cwd) : true;
    }),
  );
}

function classifyArgv(
  argv: string[],
  raw: string,
  depth: number,
  shellContext?: ShellContext,
  cwd?: string,
): boolean {
  if (argv.length === 0) {
    return false;
  }
  if (shellContext !== "powershell") {
    const commandArgv = stripLifecyclePosixAssignments(argv);
    if (commandArgv?.length === 0) {
      return false;
    }
    if (commandArgv) {
      return classifyArgv(commandArgv, raw, depth, shellContext, cwd);
    }
  }
  if (lifecycleSubstitutionResultMayHideLifecycle(argv)) {
    return true;
  }
  if (isOpenClawExecutable(argv[0])) {
    return classifyOpenClawArgv(["openclaw", ...argv.slice(1)]);
  }
  if (depth >= MAX_NESTED_COMMAND_DEPTH) {
    return unresolvedDepthMayHideLifecycle(argv);
  }

  const carried = resolveCarrierCommandArgv(argv, depth, { includeExec: true });
  if (carried?.length) {
    return classifyArgv(carried, carried.join(" "), depth + 1, shellContext, cwd);
  }
  const dispatch = unwrapKnownDispatchWrapperInvocation(argv);
  if (dispatch.kind === "unwrapped" && dispatch.argv.length > 0) {
    return classifyArgv(dispatch.argv, dispatch.argv.join(" "), depth + 1, shellContext, cwd);
  }

  const inline = extractShellWrapperInlineCommand(argv);
  if (inline !== null) {
    const wrapper = normalizeExecutableToken(argv[0] ?? "");
    const nestedShellContext: ShellContext = ["powershell", "pwsh"].includes(wrapper)
      ? "powershell"
      : undefined;
    if (nestedShellContext === "powershell" && commandHasPowerShellLifecyclePipeline(inline)) {
      return true;
    }
    if (commandHasLifecycleSubstitution(inline, depth, nestedShellContext, cwd)) {
      return true;
    }
    const positionalArgv = resolveLifecyclePosixShellPositionals(argv);
    const nestedDialect =
      wrapper === "cmd" ? "cmd" : nestedShellContext === "powershell" ? "powershell" : "posix";
    return splitLifecycleInlineCommands(inline, nestedDialect).some((part) => {
      const nestedArgv = splitShellArgs(part);
      if (!nestedArgv) {
        return false;
      }
      if (
        positionalArgv !== null &&
        lifecyclePositionalBindingRequiresApproval(part, positionalArgv)
      ) {
        return true;
      }
      const boundArgv =
        positionalArgv === null
          ? nestedArgv
          : bindLifecyclePosixShellPositionals(nestedArgv, positionalArgv);
      return classifyArgv(boundArgv, part, depth + 1, nestedShellContext, cwd);
    });
  }

  const xargs = resolveLifecycleXargsArgv(argv);
  if (xargs.kind === "approval-required") {
    return true;
  }
  if (xargs.kind === "argv") {
    return classifyArgv(xargs.argv, xargs.argv.join(" "), depth + 1, shellContext, cwd);
  }

  const packageRunner = resolveLifecyclePackageRunnerArgv(argv);
  if (packageRunner.kind === "approval-required") {
    return true;
  }
  if (packageRunner.kind === "argv") {
    return classifyArgv(
      packageRunner.argv,
      packageRunner.argv.join(" "),
      depth + 1,
      shellContext,
      cwd,
    );
  }
  const nodeArgv = resolveNodeOpenClawArgv(argv, cwd);
  if (nodeArgv) {
    return classifyOpenClawArgv(nodeArgv);
  }
  const powerShellStartArgv =
    shellContext === "powershell" ? resolvePowerShellStartProcessOpenClawArgv(argv) : null;
  if (powerShellStartArgv) {
    return classifyOpenClawArgv(powerShellStartArgv);
  }

  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "launchctl") {
    return classifyLaunchctl(argv, raw, depth);
  }
  if (executable === "systemctl") {
    return classifySystemctl(argv);
  }
  if (executable === "schtasks") {
    return classifyScheduledTask(argv);
  }
  return classifyServiceManager(argv) || classifyProcessMutation(argv, raw, shellContext);
}

/** Return true when generic exec trust must not authorize an OpenClaw self-mutation. */
export function commandRequiresOpenClawLifecycleApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envComplete?: boolean;
  platform?: NodeJS.Platform;
  segments: LifecycleSegment[];
}): boolean {
  const envComplete = params.envComplete ?? params.env !== undefined;
  const shadowedKeys = lifecycleAssignedEnvironmentKeys(params.command);
  const expandedCommand = expandKnownLifecycleEnvironmentCommand(
    params.command,
    params.env,
    shadowedKeys,
  );
  const shellContext: ShellContext =
    (params.platform ?? process.platform) === "win32" ? "powershell" : undefined;
  if (
    commandHasPowerShellLifecyclePipeline(expandedCommand, !envComplete) ||
    commandHasLifecycleSubstitution(expandedCommand, 0, shellContext, params.cwd)
  ) {
    return true;
  }
  for (const segment of params.segments) {
    const resolvedExecutable =
      segment.resolution?.execution.resolvedRealPath ??
      segment.resolution?.execution.resolvedPath ??
      "";
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    const resolvedArgv = resolvedExecutable
      ? [resolvedExecutable, ...effectiveArgv.slice(1)]
      : undefined;
    const candidates = [
      resolvedArgv,
      segment.resolution?.effectiveArgv,
      segment.sourceArgv,
      segment.argv,
    ].filter((argv): argv is string[] => Array.isArray(argv) && argv.length > 0);
    if (resolvedExecutable && isOpenClawExecutable(resolvedExecutable)) {
      if (classifyOpenClawArgv(["openclaw", ...effectiveArgv.slice(1)])) {
        return true;
      }
    }
    if (
      candidates.some((argv) => {
        const expanded = expandLifecycleEnvironmentArgv({
          argv,
          env: params.env,
          envComplete,
          shadowedKeys,
        });
        return (
          ((expanded.unresolved || expanded.fieldSplitUncertain) &&
            unresolvedEnvironmentMayHideLifecycle(argv)) ||
          classifyArgv(expanded.argv, expandedCommand, 0, shellContext, params.cwd)
        );
      })
    ) {
      return true;
    }
  }
  if (params.segments.length > 0) {
    return false;
  }
  return splitLifecycleInlineCommands(
    expandedCommand,
    shellContext === "powershell" ? "powershell" : "posix",
  ).some((part) => {
    const argv = splitShellArgs(part);
    return argv ? classifyArgv(argv, part, 0, shellContext, params.cwd) : false;
  });
}
