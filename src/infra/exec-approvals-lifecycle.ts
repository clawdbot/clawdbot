// Classifies OpenClaw self-lifecycle mutations before generic exec trust can apply.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { unwrapKnownDispatchWrapperInvocation } from "./dispatch-wrapper-resolution.js";
import type { ExecCommandSegment } from "./exec-command-analysis-types.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "./shell-inline-command.js";
import {
  extractShellWrapperInlineCommand,
  POSIX_PARSEABLE_SHELL_WRAPPERS,
} from "./shell-wrapper-resolution.js";

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
const LIFECYCLE_RPC_METHODS = new Set(["gateway.restart.request", "update.run"]);
const LAUNCHCTL_MUTATIONS = new Set([
  "attach",
  "bootstrap",
  "bootout",
  "debug",
  "disable",
  "enable",
  "kickstart",
  "kill",
  "remove",
  "start",
  "stop",
  "submit",
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
  const executable = normalizeExecutableToken(value ?? "");
  return executable === "openclaw" || executable.startsWith("openclaw@");
}

function hasHelpOrVersion(argv: readonly string[]): boolean {
  return argv.some((token) => HELP_OR_VERSION_FLAGS.has(normalizedToken(token)));
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
      new Set(["--params", "--timeout"]),
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

function classifyLaunchctl(argv: readonly string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, new Set(["-d", "-s"]));
  const action = normalizedToken(argv[actionIndex]);
  if (!LAUNCHCTL_MUTATIONS.has(action)) {
    return false;
  }
  return argv.slice(actionIndex + 1).some(looksLikeOpenClaw);
}

function systemctlUsesSignalZero(argv: readonly string[]): boolean {
  return argv.some((token, index) => {
    const lower = normalizedToken(token);
    return (
      lower === "-s0" ||
      lower === "--signal=0" ||
      ((lower === "-s" || lower === "--signal") && normalizedToken(argv[index + 1]) === "0")
    );
  });
}

function classifySystemctl(argv: readonly string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[actionIndex]);
  if (!SYSTEMCTL_MUTATIONS.has(action)) {
    return false;
  }
  if (action === "kill" && systemctlUsesSignalZero(argv)) {
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
    return (
      ["config", "create", "delete", "start", "stop"].includes(normalizedToken(argv[1])) &&
      argv.slice(2).some(looksLikeOpenClaw)
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
      argv.some((token) => ["-0", "-l", "--list", "--signal=0"].includes(normalizedToken(token)))
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
      argv.some((token) => ["-0", "-l", "-s0", "--signal=0"].includes(normalizedToken(token)))
    ) {
      return false;
    }
    return /\b(?:pgrep|pidof)\b[\s\S]{0,120}\bopenclaw\b/iu.test(raw);
  }
  if (POWERSHELL_SERVICE_MUTATIONS.has(executable)) {
    return argv.slice(1).some(looksLikeOpenClaw);
  }
  return false;
}

function resolvePackageRunnerArgv(argv: readonly string[]): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "corepack") {
    return argv.length > 1 ? argv.slice(1) : null;
  }
  if (executable === "pnpm" && normalizedToken(argv[1]) === "dlx") {
    const index = scanFirstPositional(argv, 2, new Set(["--package"]));
    return index < argv.length ? [argv[index] ?? "", ...argv.slice(index + 1)] : null;
  }
  if (["bunx", "npx"].includes(executable)) {
    const commandFlag = argv.findIndex(
      (token, index) => index > 0 && ["-c", "--call"].includes(optionName(token)),
    );
    if (commandFlag !== -1) {
      return null;
    }
    const index = scanFirstPositional(argv, 1, new Set(["-p", "--package"]));
    return index < argv.length ? [argv[index] ?? "", ...argv.slice(index + 1)] : null;
  }
  if (["pnpm", "yarn"].includes(executable)) {
    const index = scanFirstPositional(argv, 1, new Set(["-c", "--cwd", "--dir"]));
    return index < argv.length ? argv.slice(index) : null;
  }
  return null;
}

function resolveNodeOpenClawArgv(argv: readonly string[]): string[] | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "node") {
    return null;
  }
  const scriptIndex = scanFirstPositional(argv, 1, new Set(["--conditions", "--require"]));
  const script = normalizedToken(argv[scriptIndex]);
  if (
    !looksLikeOpenClaw(script) ||
    !/(?:^|[/\\])(?:openclaw\.mjs|(?:dist[/\\])?(?:entry|index)\.(?:c?js|mjs))$/u.test(script)
  ) {
    return null;
  }
  return ["openclaw", ...argv.slice(scriptIndex + 1)];
}

function splitCommandText(command: string, delimiters: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let parenDepth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" || char === "^" || char === "`") {
      escaped = true;
      continue;
    }
    if (quote) {
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

function bindPosixShellPositionals(argv: string[], positionalArgv: readonly string[]): string[] {
  const bound: string[] = [];
  for (const token of argv) {
    if (/^\$(?:@|\*|\{@\}|\{\*\})$/u.test(token)) {
      bound.push(...positionalArgv.slice(1));
      continue;
    }
    const replaced = token.replace(
      /\$(?:\{([0-9]+)\}|([0-9]+))/gu,
      (_match, bracedIndex: string | undefined, bareIndex: string | undefined) => {
        const index = Number.parseInt(bracedIndex ?? bareIndex ?? "", 10);
        return Number.isSafeInteger(index) ? (positionalArgv[index] ?? "") : "";
      },
    );
    if (replaced) {
      bound.push(replaced);
    }
  }
  return bound;
}

function resolvePosixShellPositionals(argv: string[]): readonly string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!POSIX_PARSEABLE_SHELL_WRAPPERS.has(executable)) {
    return null;
  }
  const inlineMatch = resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  return inlineMatch.valueTokenIndex === null ? null : argv.slice(inlineMatch.valueTokenIndex + 1);
}

function isPowerShellSelection(argv: readonly string[]): boolean {
  return (
    ["get-process", "get-service", "gps", "gsv"].includes(
      normalizeExecutableToken(argv[0] ?? ""),
    ) && argv.slice(1).some(looksLikeOpenClaw)
  );
}

function isPowerShellPipelineMutation(argv: readonly string[]): boolean {
  return ["restart-service", "stop-process", "stop-service", "spps", "spsv"].includes(
    normalizeExecutableToken(argv[0] ?? ""),
  );
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

function classifyArgv(
  argv: string[],
  raw: string,
  depth: number,
  shellContext?: ShellContext,
): boolean {
  if (argv.length === 0 || depth >= MAX_NESTED_COMMAND_DEPTH) {
    return false;
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
    const positionalArgv = resolvePosixShellPositionals(argv);
    return splitInlineCommands(inline).some((part) => {
      const nestedArgv = splitShellArgs(part);
      if (!nestedArgv) {
        return false;
      }
      const boundArgv =
        positionalArgv === null
          ? nestedArgv
          : bindPosixShellPositionals(nestedArgv, positionalArgv);
      return classifyArgv(boundArgv, part, depth + 1, nestedShellContext);
    });
  }

  const packageArgv = resolvePackageRunnerArgv(argv);
  if (packageArgv) {
    return classifyArgv(packageArgv, packageArgv.join(" "), depth + 1, shellContext);
  }
  const nodeArgv = resolveNodeOpenClawArgv(argv);
  if (nodeArgv) {
    return classifyOpenClawArgv(nodeArgv);
  }

  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "launchctl") {
    return classifyLaunchctl(argv);
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
  if (commandHasPowerShellLifecyclePipeline(params.command)) {
    return true;
  }
  for (const segment of params.segments) {
    const candidates = [segment.resolution?.effectiveArgv, segment.sourceArgv, segment.argv].filter(
      (argv): argv is string[] => Array.isArray(argv) && argv.length > 0,
    );
    const resolvedExecutable =
      segment.resolution?.execution.resolvedRealPath ??
      segment.resolution?.execution.resolvedPath ??
      "";
    if (resolvedExecutable && isOpenClawExecutable(resolvedExecutable)) {
      const effective = segment.resolution?.effectiveArgv ?? segment.argv;
      if (classifyOpenClawArgv(["openclaw", ...effective.slice(1)])) {
        return true;
      }
    }
    if (candidates.some((argv) => classifyArgv(argv, segment.raw ?? params.command, 0))) {
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
