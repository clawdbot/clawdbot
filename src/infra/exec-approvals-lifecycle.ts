// Classifies OpenClaw self-lifecycle mutations before generic exec trust can apply.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { unwrapKnownDispatchWrapperInvocation } from "./dispatch-wrapper-resolution.js";
import { resolveLifecycleXargsArgv } from "./exec-approvals-lifecycle-carriers.js";
import {
  expandLifecycleEnvironmentArgv,
  unresolvedEnvironmentMayHideLifecycle,
} from "./exec-approvals-lifecycle-env.js";
import { resolveNodeOpenClawArgv } from "./exec-approvals-lifecycle-node.js";
import { isOpenClawExecutablePattern } from "./exec-approvals-lifecycle-patterns.js";
import { resolveLifecyclePackageRunnerArgv } from "./exec-approvals-lifecycle-runners.js";
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
const GATEWAY_OPTIONS = new Set([
  "--auth",
  "--bind",
  "--container",
  "--log-level",
  "--port",
  "--profile",
]);
const GATEWAY_READ_ONLY = new Set([
  "diagnostics",
  "discover",
  "health",
  "probe",
  "stability",
  "status",
  "usage-cost",
]);
const LIFECYCLE_RPC_METHODS = new Set([
  "config.apply",
  "config.patch",
  "gateway.restart.request",
  "update.run",
]);
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
  "bind",
  "cancel",
  "disable",
  "edit",
  "enable",
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
  "set-service",
  "start-service",
  "stop-process",
  "stop-service",
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

function hasHelpOrVersion(argv: readonly string[]): boolean {
  return argv.some((token) => HELP_OR_VERSION_FLAGS.has(token.trim()));
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

function classifyGatewayArgv(argv: readonly string[], start: number): boolean {
  if (hasHelpOrVersion(argv.slice(start))) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, start, GATEWAY_OPTIONS);
  const action = normalizedToken(argv[actionIndex]);
  if (!action) {
    // Bare `openclaw gateway` starts the foreground gateway.
    return true;
  }
  if (action === "call") {
    const methodIndex = scanFirstPositional(
      argv,
      actionIndex + 1,
      new Set(["--params", "--password", "--timeout", "--token", "--url"]),
    );
    return LIFECYCLE_RPC_METHODS.has(normalizedToken(argv[methodIndex]));
  }
  if (GATEWAY_READ_ONLY.has(action)) {
    return false;
  }
  // Unknown gateway forms stay protected because a value-taking runtime option
  // can otherwise be mistaken for a subcommand and hide foreground startup.
  return true;
}

function classifyUpdateArgv(argv: readonly string[], start: number): boolean {
  if (hasHelpOrVersion(argv.slice(start))) {
    return false;
  }
  const positionalIndex = scanFirstPositional(
    argv,
    start,
    new Set(["--channel", "--tag", "--timeout"]),
  );
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
    case "daemon":
    case "gateway":
      return classifyGatewayArgv(argv, index + 1);
    case "uninstall":
      return (
        !hasHelpOrVersion(argv.slice(index + 1)) &&
        !argv.slice(index + 1).some((token) => normalizedToken(token) === "--dry-run")
      );
    case "update":
      return classifyUpdateArgv(argv, index + 1);
    case "configure":
    case "onboard":
    case "setup":
      return argv.slice(index + 1).some((token) => optionName(token) === "--install-daemon");
    default:
      return false;
  }
}

function classifyLaunchctl(argv: readonly string[], raw: string, depth: number): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, new Set(["-d", "-s"]));
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
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      return false;
    }
    const lower = normalizedToken(token);
    if (
      lower === "-0" ||
      lower === "-s0" ||
      lower === "--signal=0" ||
      ((lower === "-s" || lower === "--signal") && normalizedToken(argv[index + 1]) === "0")
    ) {
      return true;
    }
  }
  return false;
}

function classifySystemctl(argv: readonly string[]): boolean {
  const endOfOptions = argv.indexOf("--");
  if (hasHelpOrVersion(endOfOptions === -1 ? argv : argv.slice(0, endOfOptions))) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[actionIndex]);
  if (!SYSTEMCTL_MUTATIONS.has(action)) {
    const concealedMutation = argv
      .slice(actionIndex + 1)
      .some((token) => SYSTEMCTL_MUTATIONS.has(normalizedToken(token)));
    const optionBeforeAction = argv.slice(1, actionIndex).some((token) => token.startsWith("-"));
    return optionBeforeAction && concealedMutation && argv.some(looksLikeOpenClaw);
  }
  if (action === "kill" && argvUsesSignalZero(argv)) {
    return false;
  }
  return argv.slice(actionIndex + 1).some(looksLikeOpenClaw);
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
      ["config", "create", "delete", "start", "stop"].includes(
        normalizedToken(argv[actionIndex]),
      ) && argv.slice(actionIndex + 1).some(looksLikeOpenClaw)
    );
  }
  if (executable === "net") {
    return (
      ["start", "stop"].includes(normalizedToken(argv[1])) && argv.slice(2).some(looksLikeOpenClaw)
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
    return argv.slice(1).some(looksLikeOpenClaw);
  }
  if (executable === "taskkill") {
    return !argv.some((token) => normalizedToken(token) === "/?") && argv.some(looksLikeOpenClaw);
  }
  if (executable === "kill") {
    if (shellContext === "powershell") {
      return argv.slice(1).some(looksLikeOpenClaw);
    }
    if (
      hasHelpOrVersion(argv) ||
      argvUsesSignalZero(argv) ||
      argv.some((token) => normalizedToken(token) === "-l")
    ) {
      return false;
    }
    return (
      /\b(?:pgrep|pidof)\b[\s\S]{0,120}\bopenclaw\b/iu.test(raw) ||
      /\$\([^)]*\bopenclaw\b[^)]*\)|`[^`]*\bopenclaw\b[^`]*`/iu.test(raw)
    );
  }
  if (POWERSHELL_SERVICE_MUTATIONS.has(executable)) {
    return argv.slice(1).some(looksLikeOpenClaw);
  }
  return false;
}

function splitCommandText(command: string, delimiters: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let parenDepth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" || char === "^" || char === "`") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (parenDepth === 0 && delimiters.has(char)) {
      const part = command.slice(start, index).trim();
      if (part) {
        parts.push(part);
      }
      while (command[index + 1] === char) {
        index += 1;
      }
      start = index + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}

function splitInlineCommands(command: string): string[] {
  return splitCommandText(command, new Set([";", "|", "&", "\n", "\r"]));
}

function isPowerShellSelection(argv: readonly string[]): boolean {
  return (
    ["get-process", "get-service", "gps", "gsv", "ps"].includes(
      normalizeExecutableToken(argv[0] ?? ""),
    ) && argv.slice(1).some(looksLikeOpenClaw)
  );
}

function isPowerShellPipelineMutation(argv: readonly string[]): boolean {
  return [
    "kill",
    "remove-service",
    "restart-service",
    "sasv",
    "set-service",
    "start-service",
    "stop-process",
    "stop-service",
    "spps",
    "spsv",
  ].includes(normalizeExecutableToken(argv[0] ?? ""));
}

function commandHasPowerShellLifecyclePipeline(command: string): boolean {
  const stages = splitCommandText(command, new Set(["|"]));
  if (stages.length < 2) {
    return false;
  }
  let selectedOpenClaw = false;
  for (const stage of stages) {
    const argv = splitShellArgs(stage);
    if (!argv) {
      return false;
    }
    if (isPowerShellSelection(argv)) {
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
): boolean {
  const scan = extractShellSubstitutionCommands(command);
  if (scan.uncertain) {
    return true;
  }
  return scan.commands.some((nested) =>
    splitInlineCommands(nested).some((part) => {
      const argv = splitShellArgs(part);
      return argv ? classifyArgv(argv, part, depth + 1, shellContext) : true;
    }),
  );
}

function classifyArgv(
  argv: string[],
  raw: string,
  depth: number,
  shellContext?: ShellContext,
): boolean {
  if (argv.length === 0) {
    return false;
  }
  if (depth >= MAX_NESTED_COMMAND_DEPTH) {
    return true;
  }
  if (lifecycleSubstitutionResultMayHideLifecycle(argv)) {
    return true;
  }
  if (isOpenClawExecutable(argv[0])) {
    return classifyOpenClawArgv(["openclaw", ...argv.slice(1)]);
  }

  const carried = resolveCarrierCommandArgv(argv, depth, { includeExec: true });
  if (carried?.length) {
    return classifyArgv(carried, carried.join(" "), depth + 1, shellContext);
  }
  const dispatch = unwrapKnownDispatchWrapperInvocation(argv);
  if (dispatch.kind === "unwrapped" && dispatch.argv.length > 0) {
    return classifyArgv(dispatch.argv, dispatch.argv.join(" "), depth + 1, shellContext);
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
    if (commandHasLifecycleSubstitution(inline, depth, nestedShellContext)) {
      return true;
    }
    const positionalArgv = resolveLifecyclePosixShellPositionals(argv);
    return splitInlineCommands(inline).some((part) => {
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
      return classifyArgv(boundArgv, part, depth + 1, nestedShellContext);
    });
  }

  const xargs = resolveLifecycleXargsArgv(argv);
  if (xargs.kind === "approval-required") {
    return true;
  }
  if (xargs.kind === "argv") {
    return classifyArgv(xargs.argv, xargs.argv.join(" "), depth + 1, shellContext);
  }

  const packageRunner = resolveLifecyclePackageRunnerArgv(argv);
  if (packageRunner.kind === "approval-required") {
    return true;
  }
  if (packageRunner.kind === "argv") {
    return classifyArgv(packageRunner.argv, packageRunner.argv.join(" "), depth + 1, shellContext);
  }
  const nodeArgv = resolveNodeOpenClawArgv(argv);
  if (nodeArgv) {
    return classifyOpenClawArgv(nodeArgv);
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
  segments: LifecycleSegment[];
}): boolean {
  const envComplete = params.envComplete ?? params.env !== undefined;
  if (
    commandHasPowerShellLifecyclePipeline(params.command) ||
    commandHasLifecycleSubstitution(params.command, 0)
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
        });
        return (
          ((expanded.unresolved || expanded.fieldSplitUncertain) &&
            unresolvedEnvironmentMayHideLifecycle(argv)) ||
          classifyArgv(expanded.argv, segment.raw ?? params.command, 0)
        );
      })
    ) {
      return true;
    }
  }
  if (params.segments.length > 0) {
    return false;
  }
  return splitInlineCommands(params.command).some((part) => {
    const argv = splitShellArgs(part);
    return argv ? classifyArgv(argv, part, 0) : false;
  });
}
