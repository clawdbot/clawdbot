/**
 * Exec tool factory and request pipeline.
 * Resolves host/sandbox/node target, policy, approval, env, script preflight,
 * process launch, foreground result, and background session handoff.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatChannelId } from "../channels/ids.js";
import {
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  loadExecApprovals,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  requireValidExecTarget,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
} from "../infra/exec-approvals.js";
import { rejectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeHostOverrideEnvVarKey,
  sanitizeHostExecEnvWithDiagnostics,
} from "../infra/host-env-security.js";
import { OPENCLAW_CLI_ENV_VAR } from "../infra/openclaw-exec-env.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import { stripMalformedXmlArgValueSuffixFromKeys } from "./agent-tools.params.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import { renderExecOutputText } from "./bash-tools.exec-output.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  type ExecProcessHandle,
  type ExecProcessOutcome,
  applyPathPrepend,
  applyShellPath,
  normalizePathPrepend,
  resolveExecTarget,
  resolveApprovalRunningNoticeMs,
  buildExecRuntimeErrorOutcome,
  runExecProcess,
  execSchema,
} from "./bash-tools.exec-runtime.js";
import {
  type BackgroundExecTaskHandle,
  createBackgroundExecTask,
  finalizeBackgroundExecTask,
} from "./bash-tools.exec-task-tracking.js";
import type { ExecToolDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import {
  type ExecWorkdirResolution,
  formatUnavailableWorkdirFailure,
  resolveExecWorkdir,
} from "./bash-tools.exec-workdir.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import type { AgentToolResult } from "./runtime/index.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import { type AgentToolWithMeta, failedTextResult, textResult } from "./tools/common.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

type ExecToolArgs = Record<string, unknown> & {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  yieldMs?: number;
  background?: boolean;
  timeout?: number;
  pty?: boolean;
  elevated?: boolean;
  host?: string;
  security?: string;
  ask?: string;
  node?: string;
};

const CHANNEL_CONTEXT_ENV_KEY = "OPENCLAW_CHANNEL_CONTEXT";

function buildSubprocessChannelContext(
  channelContext: PluginHookChannelContext | undefined,
): PluginHookChannelContext | undefined {
  const senderId = normalizeOptionalString(channelContext?.sender?.id);
  const chatId = normalizeOptionalString(channelContext?.chat?.id);
  const subprocessContext: PluginHookChannelContext = {
    ...(senderId ? { sender: { id: senderId } } : {}),
    ...(chatId ? { chat: { id: chatId } } : {}),
  };
  return subprocessContext.sender || subprocessContext.chat ? subprocessContext : undefined;
}

function buildChannelContextEnv(
  channelContext: PluginHookChannelContext | undefined,
): Record<string, string> | undefined {
  const subprocessContext = buildSubprocessChannelContext(channelContext);
  if (!subprocessContext) {
    return undefined;
  }
  const serialized = safeJsonStringify(subprocessContext);
  return serialized ? { [CHANNEL_CONTEXT_ENV_KEY]: serialized } : undefined;
}
type ResolvedExecEnvPreparedState = {
  host?: ExecHost;
  pluginEnv?: Record<string, string>;
};
const resolvedExecEnvPreparedStates = new WeakMap<ExecToolArgs, ResolvedExecEnvPreparedState>();
type DeferredResolveExecEnvPreparedState = {
  hookContext?: HookContext;
};
const deferredResolveExecEnvPreparedStates = new WeakMap<
  ExecToolArgs,
  DeferredResolveExecEnvPreparedState
>();
type ResolvedExecWorkdirPreparedState = {
  host: ExecHost;
  inputWorkdir?: string;
  resolution: ExecWorkdirResolution;
};
const resolvedExecWorkdirPreparedStates = new WeakMap<
  ExecToolArgs,
  ResolvedExecWorkdirPreparedState
>();

const XML_ARG_VALUE_EXEC_PARAM_KEYS = [
  "command",
  "workdir",
  "host",
  "security",
  "ask",
  "node",
] as const;

function isExecToolArgsObject(value: unknown): value is ExecToolArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterPluginExecEnv(rawEnv: Record<string, string>): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(rawEnv)) {
    const key = normalizeHostOverrideEnvVarKey(rawKey);
    if (!key) {
      continue;
    }
    const upperKey = key.toUpperCase();
    if (
      upperKey === "PATH" ||
      upperKey === OPENCLAW_CLI_ENV_VAR ||
      isDangerousHostEnvVarName(upperKey) ||
      isDangerousHostEnvOverrideVarName(upperKey)
    ) {
      continue;
    }
    env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function markResolveExecEnvPrepared<T extends ExecToolArgs>(
  params: T,
  state: ResolvedExecEnvPreparedState = {},
): T {
  resolvedExecEnvPreparedStates.set(params, state);
  return params;
}

function getResolvedExecEnvPreparedState(
  params: ExecToolArgs,
): ResolvedExecEnvPreparedState | undefined {
  return resolvedExecEnvPreparedStates.get(params);
}

function isResolveExecEnvPrepared(params: ExecToolArgs): boolean {
  return Boolean(getResolvedExecEnvPreparedState(params));
}

function markDeferredResolveExecEnvPrepared<T extends ExecToolArgs>(
  params: T,
  state: DeferredResolveExecEnvPreparedState,
): T {
  deferredResolveExecEnvPreparedStates.set(params, state);
  return params;
}

function getDeferredResolveExecEnvPreparedState(
  params: ExecToolArgs,
): DeferredResolveExecEnvPreparedState | undefined {
  return deferredResolveExecEnvPreparedStates.get(params);
}

function markResolvedExecWorkdirPrepared<T extends ExecToolArgs>(
  params: T,
  state: ResolvedExecWorkdirPreparedState,
): T {
  resolvedExecWorkdirPreparedStates.set(params, state);
  return params;
}

function getResolvedExecWorkdirPreparedState(
  params: ExecToolArgs,
): ResolvedExecWorkdirPreparedState | undefined {
  return resolvedExecWorkdirPreparedStates.get(params);
}

function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  if (params.outcome.status === "failed") {
    return failedTextResult(`${warningText}${params.outcome.reason}`, {
      status: "failed",
      exitCode: params.outcome.exitCode ?? null,
      exitSignal: params.outcome.exitSignal,
      failureKind: params.outcome.failureKind,
      exitReason: params.outcome.exitReason,
      durationMs: params.outcome.durationMs,
      aggregated: params.outcome.aggregated,
      timedOut: params.outcome.timedOut,
      noOutputTimedOut: params.outcome.noOutputTimedOut,
      cwd: params.cwd,
    });
  }
  return textResult(`${warningText}${renderExecOutputText(params.outcome.aggregated)}`, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    exitSignal: params.outcome.exitSignal,
    exitReason: params.outcome.exitReason,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
    noOutputTimedOut: params.outcome.noOutputTimedOut,
    cwd: params.cwd,
  });
}

const PREFLIGHT_ENV_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);

const SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "EINVAL",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);
const SCRIPT_PREFLIGHT_MAX_BYTES = 512 * 1024;
const FS_CONSTANTS_WITH_OPTIONAL_NONBLOCK = fsConstants as typeof fsConstants & {
  O_NONBLOCK?: number;
};
const SCRIPT_PREFLIGHT_OPEN_FLAGS =
  fsConstants.O_RDONLY | (FS_CONSTANTS_WITH_OPTIONAL_NONBLOCK.O_NONBLOCK ?? 0);

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code);
}

type FsSafeModule = typeof import("../infra/fs-safe.js");

const fsSafeModuleLoader = createLazyImportLoader<FsSafeModule>(
  () => import("../infra/fs-safe.js"),
);

async function loadFsSafeModule(): Promise<FsSafeModule> {
  return await fsSafeModuleLoader.load();
}

function shouldSkipScriptPreflightPathError(
  error: unknown,
  FsSafeError: FsSafeModule["FsSafeError"],
): boolean {
  if (error instanceof FsSafeError) {
    return true;
  }
  const errorCode = getNodeErrorCode(error);
  return Boolean(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}

function resolvePreflightRelativePath(params: { rootDir: string; absPath: string }): string | null {
  const root = path.resolve(params.rootDir);
  const candidate = path.resolve(params.absPath);
  const relative = path.relative(root, candidate);
  if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function hasLeadingTildePathSegment(relativePath: string): boolean {
  return /^~(?:$|[\\/])/u.test(relativePath);
}

async function readLiteralTildePreflightScript(params: {
  absPath: string;
  fsSafe: FsSafeModule;
  workspaceRoot: Awaited<ReturnType<FsSafeModule["root"]>>;
}): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(params.absPath, SCRIPT_PREFLIGHT_OPEN_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new params.fsSafe.FsSafeError("not-file", "not a file");
    }
    if (stat.size > SCRIPT_PREFLIGHT_MAX_BYTES) {
      throw new params.fsSafe.FsSafeError(
        "too-large",
        `file exceeds limit of ${SCRIPT_PREFLIGHT_MAX_BYTES} bytes (got ${stat.size})`,
      );
    }
    const realPath = await params.fsSafe.resolveOpenedFileRealPathForHandle(handle, params.absPath);
    if (!params.fsSafe.isPathInside(params.workspaceRoot.rootReal, realPath)) {
      throw new params.fsSafe.FsSafeError("outside-workspace", "file is outside workspace root");
    }
    const buffer = await handle.readFile();
    if (buffer.byteLength > SCRIPT_PREFLIGHT_MAX_BYTES) {
      throw new params.fsSafe.FsSafeError(
        "too-large",
        `file exceeds limit of ${SCRIPT_PREFLIGHT_MAX_BYTES} bytes (got ${buffer.byteLength})`,
      );
    }
    return buffer.toString("utf-8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isShellEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function isEnvExecutableToken(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const base = normalizeOptionalLowercaseString(token.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedBase = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return normalizedBase === "env";
}

function stripPreflightEnvPrefix(argv: string[]): string[] {
  if (argv.length === 0) {
    return argv;
  }
  let idx = 0;
  while (idx < argv.length && isShellEnvAssignmentToken(argv.at(idx) ?? "")) {
    idx += 1;
  }
  if (!isEnvExecutableToken(argv[idx])) {
    return argv;
  }
  idx += 1;
  while (idx < argv.length) {
    const token = argv.at(idx);
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (isShellEnvAssignmentToken(token)) {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
    const equalsIndex = token.indexOf("=");
    const option = token.includes("=") ? token.slice(0, equalsIndex) : token;
    if (
      PREFLIGHT_ENV_OPTIONS_WITH_VALUES.has(option) &&
      !token.includes("=") &&
      idx < argv.length
    ) {
      idx += 1;
    }
  }
  return argv.slice(idx);
}

function findFirstPythonScriptArg(tokens: string[]): string | null {
  const optionsWithSeparateValue = new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens.at(i);
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      const next = tokens.at(i + 1);
      return next && normalizeLowercaseStringOrEmpty(next).endsWith(".py") ? next : null;
    }
    if (token === "-") {
      return null;
    }
    if (token === "-c" || token === "-m") {
      return null;
    }
    if ((token.startsWith("-c") || token.startsWith("-m")) && token.length > 2) {
      return null;
    }
    if (optionsWithSeparateValue.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return normalizeLowercaseStringOrEmpty(token).endsWith(".py") ? token : null;
  }
  return null;
}

function findNodeScriptArgs(tokens: string[]): string[] {
  const optionsWithSeparateValue = new Set(["-r", "--require", "--import"]);
  const preloadScripts: string[] = [];
  let entryScript: string | null = null;
  let hasInlineEvalOrPrint = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens.at(i);
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      if (!hasInlineEvalOrPrint && !entryScript) {
        const next = tokens.at(i + 1);
        if (next && normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
          entryScript = next;
        }
      }
      break;
    }
    if (
      token === "-e" ||
      token === "-p" ||
      token === "--eval" ||
      token === "--print" ||
      token.startsWith("--eval=") ||
      token.startsWith("--print=") ||
      ((token.startsWith("-e") || token.startsWith("-p")) && token.length > 2)
    ) {
      hasInlineEvalOrPrint = true;
      if (token === "-e" || token === "-p" || token === "--eval" || token === "--print") {
        i += 1;
      }
      continue;
    }
    if (optionsWithSeparateValue.has(token)) {
      const next = tokens.at(i + 1);
      if (next && normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
        preloadScripts.push(next);
      }
      i += 1;
      continue;
    }
    if (
      (token.startsWith("-r") && token.length > 2) ||
      token.startsWith("--require=") ||
      token.startsWith("--import=")
    ) {
      const inlineValue = token.startsWith("-r")
        ? token.slice(2)
        : token.slice(token.indexOf("=") + 1);
      if (normalizeLowercaseStringOrEmpty(inlineValue).endsWith(".js")) {
        preloadScripts.push(inlineValue);
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (
      !hasInlineEvalOrPrint &&
      !entryScript &&
      normalizeLowercaseStringOrEmpty(token).endsWith(".js")
    ) {
      entryScript = token;
    }
    break;
  }
  const targets = [...preloadScripts];
  if (entryScript) {
    targets.push(entryScript);
  }
  return targets;
}

function extractInterpreterScriptTargetFromArgv(
  argv: string[] | null,
): { kind: "python"; relOrAbsPaths: string[] } | { kind: "node"; relOrAbsPaths: string[] } | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  let commandIdx = 0;
  while (
    commandIdx < argv.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv.at(commandIdx) ?? "")
  ) {
    commandIdx += 1;
  }
  const executable = normalizeOptionalLowercaseString(argv.at(commandIdx));
  if (!executable) {
    return null;
  }
  const args = argv.slice(commandIdx + 1);
  if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
    const script = findFirstPythonScriptArg(args);
    if (script) {
      return { kind: "python", relOrAbsPaths: [script] };
    }
    return null;
  }
  if (executable === "node") {
    const scripts = findNodeScriptArgs(args);
    if (scripts.length > 0) {
      return { kind: "node", relOrAbsPaths: scripts };
    }
    return null;
  }
  return null;
}

function extractInterpreterScriptPathsFromSegment(rawSegment: string): string[] {
  const argv = splitShellArgs(rawSegment.trim());
  if (!argv || argv.length === 0) {
    return [];
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  const target = extractInterpreterScriptTargetFromArgv(
    stripPreflightEnvPrefix(withoutLeadingKeyword),
  );
  return target?.relOrAbsPaths ?? [];
}

function extractScriptTargetFromCommand(
  command: string,
): { kind: "python"; relOrAbsPaths: string[] } | { kind: "node"; relOrAbsPaths: string[] } | null {
  const raw = command.trim();
  const splitShellArgsPreservingBackslashes = (value: string): string[] | null => {
    const tokens: string[] = [];
    let buf = "";
    let inSingle = false;
    let inDouble = false;

    const pushToken = () => {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
    };

    for (const ch of value) {
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (/\s/.test(ch)) {
        pushToken();
        continue;
      }
      buf += ch;
    }

    if (inSingle || inDouble) {
      return null;
    }
    pushToken();
    return tokens;
  };
  const shouldUseWindowsPathTokenizer =
    process.platform === "win32" &&
    /(?:^|[\s"'`])(?:[A-Za-z]:\\|\\\\|[^\s"'`|&;()<>]+\\[^\s"'`|&;()<>]+)/.test(raw);
  const candidateArgv = shouldUseWindowsPathTokenizer
    ? [splitShellArgsPreservingBackslashes(raw)]
    : [splitShellArgs(raw)];

  for (const argv of candidateArgv) {
    const attempts = [argv, argv ? stripPreflightEnvPrefix(argv) : null];
    for (const attempt of attempts) {
      const target = extractInterpreterScriptTargetFromArgv(attempt);
      if (target) {
        return target;
      }
    }
  }
  return null;
}

function extractUnquotedShellText(raw: string): string | null {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      if (!inSingle && !inDouble) {
        // Preserve escapes outside quotes so downstream heuristics can distinguish
        // escaped literals (e.g. `\|`) from executable shell operators.
        out += `\\${ch}`;
      }
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      if (ch === "\\" && next && /[\\'"$`\n\r]/.test(next)) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    out += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  return out;
}

function splitShellSegmentsOutsideQuotes(
  rawText: string,
  params: { splitPipes: boolean },
): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushSegment = () => {
    if (buf.trim().length > 0) {
      segments.push(buf);
    }
    buf = "";
  };

  for (let i = 0; i < rawText.length; i += 1) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }

    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      buf += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      pushSegment();
      continue;
    }
    if (ch === ";") {
      pushSegment();
      continue;
    }
    if (ch === "&" && next === "&") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      pushSegment();
      i += 1;
      continue;
    }
    if (params.splitPipes && ch === "|") {
      pushSegment();
      continue;
    }

    buf += ch;
  }
  pushSegment();
  return segments;
}

function isInterpreterExecutable(executable: string | undefined): boolean {
  if (!executable) {
    return false;
  }
  return /^python(?:3(?:\.\d+)?)?$/i.test(executable) || executable === "node";
}

function hasUnescapedSequence(raw: string, sequence: string): boolean {
  if (sequence.length === 0) {
    return false;
  }
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (raw.startsWith(sequence, i)) {
      return true;
    }
  }
  return false;
}

function hasUnquotedScriptHint(raw: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let token = "";

  const flushToken = (): boolean => {
    const normalizedToken = normalizeLowercaseStringOrEmpty(token);
    if (normalizedToken.endsWith(".py") || normalizedToken.endsWith(".js")) {
      return true;
    }
    token = "";
    return false;
  };

  for (const ch of raw) {
    if (escaped) {
      if (!inSingle && !inDouble) {
        token += ch;
      }
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      if (flushToken()) {
        return true;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      if (flushToken()) {
        return true;
      }
      inDouble = true;
      continue;
    }
    if (/\s/u.test(ch) || "|&;()<>".includes(ch)) {
      if (flushToken()) {
        return true;
      }
      continue;
    }
    token += ch;
  }
  return flushToken();
}

function resolveLeadingShellSegmentExecutable(rawSegment: string): string | undefined {
  const segment = (extractUnquotedShellText(rawSegment) ?? rawSegment).trim();
  const argv = splitShellArgs(segment);
  if (!argv || argv.length === 0) {
    return undefined;
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  if (withoutLeadingKeyword.length === 0) {
    return undefined;
  }
  const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
  let commandIdx = 0;
  while (
    commandIdx < normalizedArgv.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")
  ) {
    commandIdx += 1;
  }
  return normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
}

function analyzeInterpreterHeuristicsFromUnquoted(raw: string): {
  hasPython: boolean;
  hasNode: boolean;
  hasComplexSyntax: boolean;
  hasProcessSubstitution: boolean;
  hasScriptHint: boolean;
} {
  const hasPython = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some((segment) =>
    /^python(?:3(?:\.\d+)?)?$/i.test(resolveLeadingShellSegmentExecutable(segment) ?? ""),
  );
  const hasNode = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some(
    (segment) => resolveLeadingShellSegmentExecutable(segment) === "node",
  );
  const hasProcessSubstitution = hasUnescapedSequence(raw, "<(") || hasUnescapedSequence(raw, ">(");
  const hasComplexSyntax =
    hasUnescapedSequence(raw, "|") ||
    hasUnescapedSequence(raw, "&&") ||
    hasUnescapedSequence(raw, "||") ||
    hasUnescapedSequence(raw, ";") ||
    raw.includes("\n") ||
    raw.includes("\r") ||
    hasUnescapedSequence(raw, "$(") ||
    hasUnescapedSequence(raw, "`") ||
    hasProcessSubstitution;
  const hasScriptHint = hasUnquotedScriptHint(raw);

  return { hasPython, hasNode, hasComplexSyntax, hasProcessSubstitution, hasScriptHint };
}

function extractShellWrappedCommandPayload(
  executable: string | undefined,
  args: string[],
): string | null {
  if (!executable) {
    return null;
  }
  const executableBase = normalizeOptionalLowercaseString(executable.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedExecutable = executableBase.endsWith(".exe")
    ? executableBase.slice(0, -4)
    : executableBase;
  if (!/^(?:bash|dash|fish|ksh|sh|zsh)$/i.test(normalizedExecutable)) {
    return null;
  }
  const shortOptionsWithSeparateValue = new Set(["-O", "-o"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args.at(i);
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      return null;
    }
    if (arg === "-c") {
      return args.at(i + 1) ?? null;
    }
    if (/^-[A-Za-z]+$/u.test(arg)) {
      if (arg.includes("c")) {
        return args.at(i + 1) ?? null;
      }
      if (shortOptionsWithSeparateValue.has(arg)) {
        i += 1;
      }
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) {
      if (!arg.includes("=")) {
        const next = args.at(i + 1);
        if (next && next !== "--" && !next.startsWith("-")) {
          i += 1;
        }
      }
      continue;
    }
    return null;
  }
  return null;
}

function shouldFailClosedInterpreterPreflight(command: string): {
  hasInterpreterInvocation: boolean;
  hasComplexSyntax: boolean;
  hasProcessSubstitution: boolean;
  hasInterpreterSegmentScriptHint: boolean;
  hasInterpreterPipelineScriptHint: boolean;
  isDirectInterpreterCommand: boolean;
} {
  const raw = command.trim();
  const rawArgv = splitShellArgs(raw);
  const argv = rawArgv ? stripPreflightEnvPrefix(rawArgv) : null;
  let commandIdx = 0;
  if (argv) {
    while (
      commandIdx < argv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx] ?? "")
    ) {
      commandIdx += 1;
    }
  }
  const directExecutable = normalizeOptionalLowercaseString(argv?.[commandIdx]);
  const args = argv ? argv.slice(commandIdx + 1) : [];

  const isDirectPythonExecutable = Boolean(
    directExecutable && /^python(?:3(?:\.\d+)?)?$/i.test(directExecutable),
  );
  const isDirectNodeExecutable = directExecutable === "node";
  const isDirectInterpreterCommand = isDirectPythonExecutable || isDirectNodeExecutable;

  const unquotedRaw = extractUnquotedShellText(raw) ?? raw;
  const topLevel = analyzeInterpreterHeuristicsFromUnquoted(unquotedRaw);

  const shellWrappedPayload = extractShellWrappedCommandPayload(directExecutable, args);
  const nestedUnquoted = shellWrappedPayload
    ? (extractUnquotedShellText(shellWrappedPayload) ?? shellWrappedPayload)
    : "";
  const nested = shellWrappedPayload
    ? analyzeInterpreterHeuristicsFromUnquoted(nestedUnquoted)
    : {
        hasPython: false,
        hasNode: false,
        hasComplexSyntax: false,
        hasProcessSubstitution: false,
        hasScriptHint: false,
      };
  const hasInterpreterInvocationInSegment = (rawSegment: string): boolean =>
    isInterpreterExecutable(resolveLeadingShellSegmentExecutable(rawSegment));
  const isScriptExecutingInterpreterCommand = (rawCommand: string): boolean => {
    const argvLocal = splitShellArgs(rawCommand.trim());
    if (!argvLocal || argvLocal.length === 0) {
      return false;
    }
    const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(
      argvLocal[0] ?? "",
    )
      ? argvLocal.slice(1)
      : argvLocal;
    if (withoutLeadingKeyword.length === 0) {
      return false;
    }
    const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
    let commandIdxLocal = 0;
    while (
      commandIdxLocal < normalizedArgv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdxLocal] ?? "")
    ) {
      commandIdxLocal += 1;
    }
    const executable = normalizeOptionalLowercaseString(normalizedArgv[commandIdxLocal]);
    if (!executable) {
      return false;
    }
    const argsLocal = normalizedArgv.slice(commandIdxLocal + 1);

    if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
      const pythonInfoOnlyFlags = new Set(["-V", "--version", "-h", "--help"]);
      if (argsLocal.some((arg) => pythonInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        argsLocal.some(
          (arg) =>
            arg === "-c" ||
            arg === "-m" ||
            arg.startsWith("-c") ||
            arg.startsWith("-m") ||
            arg === "--check-hash-based-pycs",
        )
      ) {
        return false;
      }
      return true;
    }

    if (executable === "node") {
      const nodeInfoOnlyFlags = new Set(["-v", "--version", "-h", "--help", "-c", "--check"]);
      if (argsLocal.some((arg) => nodeInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        argsLocal.some(
          (arg) =>
            arg === "-e" ||
            arg === "-p" ||
            arg === "--eval" ||
            arg === "--print" ||
            arg.startsWith("--eval=") ||
            arg.startsWith("--print=") ||
            ((arg.startsWith("-e") || arg.startsWith("-p")) && arg.length > 2),
        )
      ) {
        return false;
      }
      return true;
    }

    return false;
  };
  const hasScriptHintInSegment = (segment: string): boolean =>
    extractInterpreterScriptPathsFromSegment(segment).length > 0 || hasUnquotedScriptHint(segment);
  const hasInterpreterAndScriptHintInSameSegment = (rawText: string): boolean => {
    const segments = splitShellSegmentsOutsideQuotes(rawText, { splitPipes: true });
    return segments.some((segment) => {
      if (!isScriptExecutingInterpreterCommand(segment)) {
        return false;
      }
      return hasScriptHintInSegment(segment);
    });
  };
  const hasInterpreterPipelineScriptHintInSameSegment = (rawText: string): boolean => {
    const commandSegments = splitShellSegmentsOutsideQuotes(rawText, { splitPipes: false });
    return commandSegments.some((segment) => {
      const pipelineCommands = splitShellSegmentsOutsideQuotes(segment, { splitPipes: true });
      const hasScriptExecutingPipedInterpreter = pipelineCommands
        .slice(1)
        .some((pipelineCommand) => isScriptExecutingInterpreterCommand(pipelineCommand));
      if (!hasScriptExecutingPipedInterpreter) {
        return false;
      }
      return hasScriptHintInSegment(segment);
    });
  };
  const hasInterpreterSegmentScriptHint =
    hasInterpreterAndScriptHintInSameSegment(raw) ||
    (shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload));
  const hasInterpreterPipelineScriptHint =
    hasInterpreterPipelineScriptHintInSameSegment(raw) ||
    (shellWrappedPayload !== null &&
      hasInterpreterPipelineScriptHintInSameSegment(shellWrappedPayload));
  const hasShellWrappedInterpreterSegmentScriptHint =
    shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload);
  const hasShellWrappedInterpreterInvocation =
    (nested.hasPython || nested.hasNode) &&
    (hasShellWrappedInterpreterSegmentScriptHint ||
      nested.hasScriptHint ||
      nested.hasComplexSyntax ||
      nested.hasProcessSubstitution);
  const hasTopLevelInterpreterInvocation = splitShellSegmentsOutsideQuotes(raw, {
    splitPipes: true,
  }).some((segment) => hasInterpreterInvocationInSegment(segment));
  const hasInterpreterInvocation =
    isDirectInterpreterCommand ||
    hasShellWrappedInterpreterInvocation ||
    hasTopLevelInterpreterInvocation;

  return {
    hasInterpreterInvocation,
    hasComplexSyntax: topLevel.hasComplexSyntax || hasShellWrappedInterpreterInvocation,
    hasProcessSubstitution: topLevel.hasProcessSubstitution || nested.hasProcessSubstitution,
    hasInterpreterSegmentScriptHint,
    hasInterpreterPipelineScriptHint,
    isDirectInterpreterCommand,
  };
}

async function validateScriptFileForShellBleed(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  const target = extractScriptTargetFromCommand(params.command);
  if (!target) {
    const {
      hasInterpreterInvocation,
      hasComplexSyntax,
      hasProcessSubstitution,
      hasInterpreterSegmentScriptHint,
      hasInterpreterPipelineScriptHint,
      isDirectInterpreterCommand,
    } = shouldFailClosedInterpreterPreflight(params.command);
    if (
      hasInterpreterInvocation &&
      hasComplexSyntax &&
      (hasInterpreterSegmentScriptHint ||
        hasInterpreterPipelineScriptHint ||
        (hasProcessSubstitution && isDirectInterpreterCommand))
    ) {
      // Fail closed when interpreter-driven script execution is ambiguous; otherwise
      // attackers can route script content through forms our fast parser cannot validate.
      throw new Error(
        "exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation. " +
          "Use a direct `python <file>.py` or `node <file>.js` command.",
      );
    }
    return;
  }

  const fsSafe = await loadFsSafeModule();
  const { FsSafeError, root: fsRoot } = fsSafe;
  const workspaceRoot = await fsRoot(params.workdir);
  for (const relOrAbsPath of target.relOrAbsPaths) {
    const absPath = path.isAbsolute(relOrAbsPath)
      ? path.resolve(relOrAbsPath)
      : path.resolve(params.workdir, relOrAbsPath);
    const relativePath = resolvePreflightRelativePath({
      rootDir: params.workdir,
      absPath,
    });
    if (!relativePath) {
      continue;
    }

    // Best-effort: only validate files that safely resolve within workdir and
    // are reasonably small. This keeps preflight checks on a pinned file
    // identity instead of trusting mutable pathnames across multiple ops.
    // Use non-blocking open to avoid stalls if a path is swapped to a FIFO.
    let content: string;
    try {
      content = hasLeadingTildePathSegment(relativePath)
        ? await readLiteralTildePreflightScript({
            absPath,
            fsSafe,
            workspaceRoot,
          })
        : (
            await workspaceRoot.read(relativePath, {
              nonBlockingRead: true,
              symlinks: "follow-within-root",
              maxBytes: SCRIPT_PREFLIGHT_MAX_BYTES,
            })
          ).buffer.toString("utf-8");
    } catch (error) {
      if (shouldSkipScriptPreflightPathError(error, FsSafeError)) {
        // Preflight validation is best-effort: skip path/read failures and
        // continue to execute the command normally.
        continue;
      }
      throw error;
    }

    // Common failure mode: shell env var syntax leaking into Python/JS.
    // We deliberately match all-caps/underscore vars to avoid false positives with `$` as a JS identifier.
    const envVarRegex = /\$[A-Z_][A-Z0-9_]{1,}/g;
    const first = envVarRegex.exec(content);
    if (first) {
      const idx = first.index;
      const before = content.slice(0, idx);
      const line = before.split("\n").length;
      const token = first[0];
      throw new Error(
        [
          `exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(
            absPath,
          )}:${line}.`,
          target.kind === "python"
            ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.`
            : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
          "(If this is inside a string literal on purpose, escape it or restructure the code.)",
        ].join("\n"),
      );
    }

    // Another recurring pattern from the issue: shell commands accidentally emitted as JS.
    if (target.kind === "node") {
      const firstNonEmpty = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) {
        throw new Error(
          `exec preflight: JS file starts with shell syntax (${firstNonEmpty}). ` +
            `This looks like a shell command, not JavaScript.`,
        );
      }
    }
  }
}

function shouldSkipExecScriptPreflight(params: {
  host: ExecHost;
  security: ExecSecurity;
  ask: ExecAsk;
}): boolean {
  return params.host === "gateway" && params.security === "full" && params.ask === "off";
}

function resolveExecReviewerDefaults(params: { defaults?: ExecToolDefaults; agentId?: string }) {
  if (params.defaults?.reviewer) {
    return params.defaults.reviewer;
  }
  const cfg = params.defaults?.config;
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const agentExec = agentId
    ? cfg?.agents?.list?.find((entry) => normalizeAgentId(entry.id) === agentId)?.tools?.exec
    : undefined;
  return agentExec?.reviewer ?? cfg?.tools?.exec?.reviewer;
}

function resolveNotifyOnExitEmptySuccess(defaults?: ExecToolDefaults): boolean {
  if (typeof defaults?.notifyOnExitEmptySuccess === "boolean") {
    return defaults.notifyOnExitEmptySuccess;
  }
  return normalizeChatChannelId(defaults?.messageProvider) !== null;
}

/** Creates an exec tool instance with runtime defaults and approval policy wiring. */
export function createExecTool(
  defaults?: ExecToolDefaults,
): AgentToolWithMeta<typeof execSchema, ExecToolDetails> {
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (message) => {
      logInfo(message);
    },
  });
  if (unprofiledSafeBins.length > 0) {
    logInfo(
      `exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`,
    );
  }
  if (unprofiledInterpreterSafeBins.length > 0) {
    logInfo(
      `exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`,
    );
  }
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifyOnExitEmptySuccess = resolveNotifyOnExitEmptySuccess(defaults);
  const notifySessionKey = normalizeOptionalString(defaults?.sessionKey);
  const notifyDeliveryContext = normalizeDeliveryContext({
    channel: defaults?.messageProvider,
    to: defaults?.currentChannelId,
    accountId: defaults?.accountId,
    threadId: defaults?.currentThreadTs,
  });
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);
  const resolveHostForParams = (params: ExecToolArgs): ExecHost => {
    const elevatedDefaults = defaults?.elevated;
    const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
    const elevatedDefaultMode =
      elevatedDefaults?.defaultLevel === "full"
        ? "full"
        : elevatedDefaults?.defaultLevel === "ask"
          ? "ask"
          : elevatedDefaults?.defaultLevel === "on"
            ? "ask"
            : "off";
    const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
    const elevatedMode =
      typeof params.elevated === "boolean"
        ? params.elevated
          ? elevatedDefaultMode === "full"
            ? "full"
            : "ask"
          : "off"
        : effectiveDefaultMode;
    const requestedTarget = requireValidExecTarget(params.host);
    return resolveExecTarget({
      configuredTarget: defaults?.host,
      requestedTarget,
      elevatedRequested: elevatedMode !== "off",
      sandboxAvailable: Boolean(defaults?.sandbox),
    }).effectiveHost;
  };
  const buildUnavailableWorkdirResult = (params: {
    cwd: string;
    startedAt?: number;
    warningText?: string;
  }) =>
    buildExecForegroundResult({
      outcome: buildExecRuntimeErrorOutcome({
        error: formatUnavailableWorkdirFailure(params.cwd),
        aggregated: "",
        durationMs: params.startedAt ? Date.now() - params.startedAt : 0,
      }),
      cwd: params.cwd,
      warningText: params.warningText,
    });
  const prepareParamsWithResolvedExecWorkdir = async (rawArgs: unknown): Promise<ExecToolArgs> => {
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      return rawArgs as ExecToolArgs;
    }
    const params = stripMalformedXmlArgValueSuffixFromKeys(
      rawArgs as ExecToolArgs,
      XML_ARG_VALUE_EXEC_PARAM_KEYS,
    );
    let host: ExecHost;
    try {
      host = resolveHostForParams(params);
    } catch {
      return params;
    }
    if (host === "sandbox" && !defaults?.sandbox) {
      return params;
    }
    if (host === "sandbox" && defaults?.sandbox?.workdirValidation === "backend") {
      return params;
    }
    const resolution = await resolveExecWorkdir({
      host,
      workdir: params.workdir,
      defaultCwd: defaults?.cwd,
      nodeCwd: defaults?.nodeCwd,
      sandbox: defaults?.sandbox,
    });
    return markResolvedExecWorkdirPrepared(params, {
      host,
      inputWorkdir: params.workdir,
      resolution,
    });
  };
  const shouldDeferResolveExecEnvUntilWorkdirValidated = (params: ExecToolArgs): boolean => {
    try {
      return (
        resolveHostForParams(params) === "sandbox" &&
        defaults?.sandbox?.workdirValidation === "backend"
      );
    } catch {
      return false;
    }
  };
  const prepareParamsWithResolvedExecEnv = async (
    rawArgs: unknown,
    context?: { hookContext?: HookContext },
  ): Promise<ExecToolArgs> => {
    const params = stripMalformedXmlArgValueSuffixFromKeys(
      rawArgs as ExecToolArgs,
      XML_ARG_VALUE_EXEC_PARAM_KEYS,
    );
    if (!params.command) {
      return params;
    }
    if (isResolveExecEnvPrepared(params)) {
      return markResolveExecEnvPrepared(params);
    }
    const hookRunner = getGlobalHookRunner();
    if (
      !hookRunner?.hasHooks("resolve_exec_env") ||
      typeof hookRunner.runResolveExecEnv !== "function"
    ) {
      return markResolveExecEnvPrepared(params);
    }
    let host: ExecHost;
    try {
      host = resolveHostForParams(params);
    } catch {
      return params;
    }
    const rawPluginEnv = await hookRunner.runResolveExecEnv(
      {
        sessionKey: defaults?.sessionKey ?? context?.hookContext?.sessionKey,
        toolName: "exec",
        host,
      },
      {
        agentId: agentId ?? context?.hookContext?.agentId,
        sessionKey: defaults?.sessionKey ?? context?.hookContext?.sessionKey,
        messageProvider: defaults?.messageProvider,
        channelId: defaults?.currentChannelId ?? context?.hookContext?.channelId,
        ...(defaults?.channelContext ? { channelContext: defaults.channelContext } : {}),
      },
    );
    const pluginEnv = filterPluginExecEnv(rawPluginEnv);
    return markResolveExecEnvPrepared(params, { host, ...(pluginEnv ? { pluginEnv } : {}) });
  };
  const autoReviewer =
    defaults?.autoReviewer ??
    createModelExecAutoReviewer({
      cfg: defaults?.config,
      agentId,
      reviewer: resolveExecReviewerDefaults({ defaults, agentId }),
    });

  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return describeExecTool({ agentId, hasCronTool: defaults?.hasCronTool === true });
    },
    parameters: execSchema,
    prepareBeforeToolCallParams: async (args, context) => {
      const params = await prepareParamsWithResolvedExecWorkdir(args);
      const workdirState = getResolvedExecWorkdirPreparedState(params);
      if (workdirState?.resolution.kind === "unavailable") {
        return params;
      }
      if (!isExecToolArgsObject(params)) {
        return params;
      }
      if (shouldDeferResolveExecEnvUntilWorkdirValidated(params)) {
        return markDeferredResolveExecEnvPrepared(params, {
          hookContext: context.hookContext as HookContext | undefined,
        });
      }
      return prepareParamsWithResolvedExecEnv(params, {
        hookContext: context.hookContext as HookContext | undefined,
      });
    },
    finalizeBeforeToolCallParams: (params, preparedParams) => {
      const envState = getResolvedExecEnvPreparedState(preparedParams as ExecToolArgs);
      const deferredEnvState = getDeferredResolveExecEnvPreparedState(
        preparedParams as ExecToolArgs,
      );
      const workdirState = getResolvedExecWorkdirPreparedState(preparedParams as ExecToolArgs);
      if (!envState && !deferredEnvState && !workdirState) {
        return params;
      }
      if (!isExecToolArgsObject(params)) {
        return params;
      }
      const execParams = params;
      let host: ExecHost | undefined;
      const resolveFinalHost = () => {
        host ??= resolveHostForParams(execParams);
        return host;
      };
      try {
        if (envState?.host && execParams.command && resolveFinalHost() !== envState.host) {
          return { ...execParams };
        }
        if (
          workdirState &&
          (resolveFinalHost() !== workdirState.host ||
            execParams.workdir !== workdirState.inputWorkdir)
        ) {
          return { ...execParams };
        }
      } catch {
        return { ...execParams };
      }
      if (envState) {
        markResolveExecEnvPrepared(execParams, envState);
      }
      if (deferredEnvState) {
        markDeferredResolveExecEnvPrepared(execParams, deferredEnvState);
      }
      if (workdirState) {
        markResolvedExecWorkdirPrepared(execParams, workdirState);
      }
      return execParams;
    },
    execute: async (toolCallId, args, signal, onUpdate) => {
      signal?.throwIfAborted();
      let params = stripMalformedXmlArgValueSuffixFromKeys(
        args as ExecToolArgs,
        XML_ARG_VALUE_EXEC_PARAM_KEYS,
      );
      const resolveExecEnvPrepared = isResolveExecEnvPrepared(args as ExecToolArgs);
      const deferredResolveExecEnvState = getDeferredResolveExecEnvPreparedState(params);
      const preparedWorkdirState = getResolvedExecWorkdirPreparedState(params);

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const approvalWarningText = normalizeOptionalString(defaults?.approvalWarningText);
      if (approvalWarningText) {
        warnings.push(approvalWarningText);
      }
      const startedAt = Date.now();
      let execCommandOverride: string | undefined;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      const foregroundFallbackWarning =
        !allowBackground && (backgroundRequested || yieldRequested)
          ? "Warning: background execution is disabled; running synchronously."
          : undefined;
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = normalizeOptionalString(defaults?.messageProvider);
          const sessionKey = normalizeOptionalString(defaults?.sessionKey);
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      const requestedTarget = requireValidExecTarget(params.host);
      const target = resolveExecTarget({
        configuredTarget: defaults?.host,
        requestedTarget,
        elevatedRequested,
        sandboxAvailable: Boolean(defaults?.sandbox),
      });
      const host: ExecHost = target.effectiveHost;

      const explicitSecurity = defaults?.security;
      const configuredSecurity = explicitSecurity ?? (host === "sandbox" ? "deny" : "full");
      const modePolicy = resolveExecModePolicy({
        mode: defaults?.mode,
        security: configuredSecurity,
        ask: defaults?.ask ?? "off",
      });
      const approvalPolicy =
        host === "sandbox"
          ? undefined
          : resolveExecApprovalsFromFile({
              file: loadExecApprovals(),
              agentId,
              overrides: {
                security: "full",
                ask: "off",
              },
            }).agent;
      let security = minSecurity(
        modePolicy.security,
        approvalPolicy?.security ?? modePolicy.security,
      );
      if (
        security === "deny" &&
        (host !== "sandbox" || defaults?.mode === "deny" || explicitSecurity === "deny")
      ) {
        throw new Error(`exec denied: host=${host} security=deny`);
      }
      const hostPolicyAllowsFullBypass =
        (approvalPolicy?.security ?? "full") === "full" && (approvalPolicy?.ask ?? "off") === "off";
      const modePolicyAllowsFullBypass = modePolicy.security === "full" && modePolicy.ask === "off";
      if (
        elevatedRequested &&
        elevatedMode === "full" &&
        modePolicyAllowsFullBypass &&
        hostPolicyAllowsFullBypass
      ) {
        security = "full";
      }
      // Keep local exec defaults in sync with exec-approvals.json when tools.exec.* is unset.
      const requestedAsk = normalizeExecAsk(params.ask);
      const hostAsk = maxAsk(modePolicy.ask, approvalPolicy?.ask ?? modePolicy.ask);
      const trustedAsk = defaults?.messageProvider && hostAsk === "off" ? undefined : requestedAsk;
      let ask = maxAsk(hostAsk, trustedAsk ?? hostAsk);
      const bypassApprovals =
        elevatedRequested &&
        elevatedMode === "full" &&
        modePolicyAllowsFullBypass &&
        hostPolicyAllowsFullBypass;
      if (bypassApprovals) {
        ask = "off";
      }
      const autoReview = modePolicy.autoReview && ask === modePolicy.ask && !bypassApprovals;

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      if (target.selectedTarget === "sandbox" && !sandbox) {
        throw new Error(
          [
            "exec host=sandbox requires a sandbox runtime for this session.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or use host=auto/gateway/node.',
          ].join("\n"),
        );
      }
      if (!params.command) {
        throw new Error("Provide a command to start.");
      }
      await rejectUnsafeExecControlShellCommand(params.command);
      let workdir: string | undefined;
      let scriptPreflightCwd: string | null = null;
      let containerWorkdir = sandbox?.containerWorkdir;
      let discardPreparedSandboxWorkdir: (() => void) | null = null;
      const workdirResolution =
        preparedWorkdirState?.host === host
          ? preparedWorkdirState.resolution
          : await resolveExecWorkdir({
              host,
              workdir: params.workdir,
              defaultCwd: defaults?.cwd,
              nodeCwd: defaults?.nodeCwd,
              sandbox,
            });
      if (workdirResolution.kind === "unavailable") {
        return buildUnavailableWorkdirResult({
          cwd: workdirResolution.requestedCwd,
          startedAt,
          warningText: warnings.join("\n"),
        });
      }
      if (workdirResolution.kind === "sandbox") {
        workdir = workdirResolution.hostCwd;
        containerWorkdir = workdirResolution.containerCwd;
        scriptPreflightCwd = workdirResolution.scriptPreflightCwd;
        if (sandbox?.discardPreparedWorkdir && sandbox.workdirValidation === "backend") {
          const preparedContainerWorkdir = containerWorkdir;
          discardPreparedSandboxWorkdir = () => {
            sandbox.discardPreparedWorkdir?.(preparedContainerWorkdir);
          };
        }
      } else if (workdirResolution.kind === "local") {
        workdir = workdirResolution.hostCwd;
        scriptPreflightCwd = workdirResolution.hostCwd;
      } else {
        workdir = workdirResolution.remoteCwd;
      }
      let run: ExecProcessHandle;
      let backgroundTask: BackgroundExecTaskHandle | null = null;
      let settledOutcome: ExecProcessOutcome | null = null;
      let effectiveTimeout: number;
      try {
        if (elevatedRequested) {
          logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
        }
        if (!resolveExecEnvPrepared) {
          params = await prepareParamsWithResolvedExecEnv(params, {
            hookContext: deferredResolveExecEnvState?.hookContext,
          });
        }

        const inheritedBaseEnv = coerceEnv(process.env);
        const resolvedExecEnvState = getResolvedExecEnvPreparedState(params);
        const channelContextEnv = buildChannelContextEnv(defaults?.channelContext);
        const requestedEnv: Record<string, string> | undefined =
          params.env !== undefined ||
          resolvedExecEnvState?.pluginEnv !== undefined ||
          channelContextEnv !== undefined
            ? { ...params.env, ...resolvedExecEnvState?.pluginEnv, ...channelContextEnv }
            : undefined;
        const hostEnvResult =
          host === "sandbox"
            ? null
            : sanitizeHostExecEnvWithDiagnostics({
                baseEnv: inheritedBaseEnv,
                overrides: requestedEnv,
                blockPathOverrides: true,
              });
        if (
          hostEnvResult &&
          requestedEnv &&
          (hostEnvResult.rejectedOverrideBlockedKeys.length > 0 ||
            hostEnvResult.rejectedOverrideInvalidKeys.length > 0)
        ) {
          const blockedKeys = hostEnvResult.rejectedOverrideBlockedKeys;
          const invalidKeys = hostEnvResult.rejectedOverrideInvalidKeys;
          const pathBlocked = blockedKeys.includes("PATH");
          if (pathBlocked && blockedKeys.length === 1 && invalidKeys.length === 0) {
            throw new Error(
              "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
            );
          }
          if (blockedKeys.length === 1 && invalidKeys.length === 0) {
            throw new Error(
              `Security Violation: Environment variable '${blockedKeys[0]}' is forbidden during host execution.`,
            );
          }
          const details: string[] = [];
          if (blockedKeys.length > 0) {
            details.push(`blocked override keys: ${blockedKeys.join(", ")}`);
          }
          if (invalidKeys.length > 0) {
            details.push(`invalid non-portable override keys: ${invalidKeys.join(", ")}`);
          }
          const suffix = details.join("; ");
          if (pathBlocked) {
            throw new Error(
              `Security Violation: Custom 'PATH' variable is forbidden during host execution (${suffix}).`,
            );
          }
          throw new Error(`Security Violation: ${suffix}.`);
        }

        const env =
          sandbox && host === "sandbox"
            ? buildSandboxEnv({
                defaultPath: DEFAULT_PATH,
                paramsEnv: requestedEnv,
                sandboxEnv: sandbox.env,
                containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
              })
            : (hostEnvResult?.env ?? inheritedBaseEnv);

        if (!sandbox && host === "gateway" && !requestedEnv?.PATH) {
          const shellPath = getShellPathFromLoginShell({
            env: process.env,
            timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
          });
          applyShellPath(env, shellPath);
        }

        // `tools.exec.pathPrepend` is only meaningful when exec runs locally (gateway) or in the sandbox.
        // Node hosts intentionally ignore request-scoped PATH overrides, so don't pretend this applies.
        if (host === "node" && defaultPathPrepend.length > 0) {
          warnings.push(
            "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
          );
        } else {
          applyPathPrepend(env, defaultPathPrepend);
        }

        if (host === "node") {
          return executeNodeHostCommand({
            command: params.command,
            workdir,
            env,
            requestedEnv,
            requestedNode: params.node?.trim(),
            boundNode: defaults?.node?.trim(),
            sessionKey: defaults?.sessionKey,
            sessionId: defaults?.sessionId,
            sessionStore: defaults?.sessionStore,
            bashElevated: elevatedDefaults,
            approvalReviewerDeviceId: defaults?.approvalReviewerDeviceId,
            nonInteractiveApproval: defaults?.nonInteractiveApproval,
            turnSourceChannel: defaults?.messageProvider,
            turnSourceTo: defaults?.currentChannelId,
            turnSourceAccountId: defaults?.accountId,
            turnSourceThreadId: defaults?.currentThreadTs,
            agentId,
            security,
            ask,
            autoReview,
            autoReviewer,
            signal,
            strictInlineEval: defaults?.strictInlineEval,
            commandHighlighting: defaults?.commandHighlighting,
            trigger: defaults?.trigger,
            timeoutSec: params.timeout,
            defaultTimeoutSec,
            approvalRunningNoticeMs,
            warnings,
            foregroundWarnings: foregroundFallbackWarning ? [foregroundFallbackWarning] : [],
            notifySessionKey,
            notifyOnExit,
            trustedSafeBinDirs,
          });
        }

        if (!workdir) {
          throw new Error("exec internal error: local execution requires a resolved workdir");
        }

        if (host === "gateway" && !bypassApprovals) {
          const gatewayResult = await processGatewayAllowlist({
            command: params.command,
            workdir,
            env,
            pathPrepend: defaultPathPrepend,
            requestedEnv,
            pty: params.pty === true && !sandbox,
            timeoutSec: params.timeout,
            defaultTimeoutSec,
            security,
            ask,
            autoReview,
            autoReviewer,
            signal,
            safeBins,
            safeBinProfiles,
            strictInlineEval: defaults?.strictInlineEval,
            commandHighlighting: defaults?.commandHighlighting,
            trigger: defaults?.trigger,
            agentId,
            sessionKey: defaults?.sessionKey,
            runId: defaults?.runId,
            toolCallId,
            sessionId: defaults?.sessionId,
            sessionStore: defaults?.sessionStore,
            bashElevated: elevatedDefaults,
            approvalReviewerDeviceId: defaults?.approvalReviewerDeviceId,
            nonInteractiveApproval: defaults?.nonInteractiveApproval,
            turnSourceChannel: defaults?.messageProvider,
            turnSourceTo: defaults?.currentChannelId,
            turnSourceAccountId: defaults?.accountId,
            turnSourceThreadId: defaults?.currentThreadTs,
            scopeKey: defaults?.scopeKey,
            approvalFollowupText: defaults?.approvalFollowupText,
            approvalFollowup: defaults?.approvalFollowup,
            approvalFollowupMode: defaults?.approvalFollowupMode,
            warnings,
            notifySessionKey,
            approvalRunningNoticeMs,
            maxOutput,
            pendingMaxOutput,
            trustedSafeBinDirs,
          });
          if (gatewayResult.pendingResult) {
            return gatewayResult.pendingResult;
          }
          if (gatewayResult.deniedResult) {
            return gatewayResult.deniedResult;
          }
          signal?.throwIfAborted();
          execCommandOverride = gatewayResult.execCommandOverride;
          if (gatewayResult.allowWithoutEnforcedCommand) {
            execCommandOverride = undefined;
          }
        }

        // Pending approvals have not started the command. Add fallback warnings only
        // after approval routing proves this call will execute in the foreground.
        if (foregroundFallbackWarning) {
          warnings.push(foregroundFallbackWarning);
        }

        const explicitTimeoutSec = typeof params.timeout === "number" ? params.timeout : null;
        effectiveTimeout = explicitTimeoutSec ?? defaultTimeoutSec;
        const usePty = params.pty === true && !sandbox;

        // Preflight: catch a common model failure mode (shell syntax leaking into Python/JS sources)
        // before we execute and burn tokens in cron loops.
        if (scriptPreflightCwd && !shouldSkipExecScriptPreflight({ host, security, ask })) {
          await validateScriptFileForShellBleed({
            command: params.command,
            workdir: scriptPreflightCwd,
          });
        }

        signal?.throwIfAborted();
        run = await runExecProcess({
          command: params.command,
          execCommand: execCommandOverride,
          workdir,
          env,
          pathPrepend: defaultPathPrepend,
          sandbox,
          containerWorkdir,
          usePty,
          warnings,
          maxOutput,
          pendingMaxOutput,
          notifyOnExit,
          notifyOnExitEmptySuccess,
          scopeKey: defaults?.scopeKey,
          sessionKey: notifySessionKey,
          mainKey: defaults?.mainKey,
          sessionScope: defaults?.sessionScope,
          eventRouting: defaults?.eventRouting,
          notifyDeliveryContext,
          timeoutSec: effectiveTimeout,
          onUpdate,
          onSettledBeforeNotify: (outcome) => {
            settledOutcome = outcome;
            finalizeBackgroundExecTask({ handle: backgroundTask, outcome });
          },
        });
        discardPreparedSandboxWorkdir = null;
      } catch (error) {
        discardPreparedSandboxWorkdir?.();
        throw error;
      }

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;
      let registeredAbortSignal: AbortSignal | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        // Immediately suppress onUpdate calls so that any late stdout/stderr
        // from the still-running process cannot push a rejected Promise into
        // agent runtime's updateEvents after the agent run has ended (#62520).
        // Intentionally placed *before* the yielded/backgrounded guard: the
        // agent run is ending regardless, so no consumer exists for further
        // tool_execution_update events even for backgrounded sessions (which
        // retrieve output via process poll/log instead of onUpdate callbacks).
        run.disableUpdates();
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };

      const cleanupToolRunListeners = () => {
        if (registeredAbortSignal) {
          registeredAbortSignal.removeEventListener("abort", onAbortSignal);
          registeredAbortSignal = null;
        }
        if (yieldTimer) {
          clearTimeout(yieldTimer);
          yieldTimer = null;
        }
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
        registeredAbortSignal = signal;
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () => {
          cleanupToolRunListeners();
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });
        };

        const onYieldNow = () => {
          if (yielded) {
            return;
          }
          if (settledOutcome) {
            cleanupToolRunListeners();
            resolve(
              buildExecForegroundResult({
                outcome: settledOutcome,
                cwd: run.session.cwd,
                warningText: getWarningText(),
              }),
            );
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          // Only the guarded yield transition owns task registration. A process
          // that settles before this timer fires must stay out of the task ledger.
          backgroundTask = createBackgroundExecTask({
            processSessionId: run.session.id,
            sessionKey: notifySessionKey,
            agentId,
            startedAt: run.startedAt,
          });
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              onYieldNow();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            cleanupToolRunListeners();
            if (yielded || run.session.backgrounded) {
              return;
            }
            resolve(
              buildExecForegroundResult({
                outcome,
                cwd: run.session.cwd,
                warningText: getWarningText(),
              }),
            );
          })
          .catch((err: unknown) => {
            cleanupToolRunListeners();
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

/** Default exec tool instance used by agent tool registries. */
export const execTool = createExecTool();
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
