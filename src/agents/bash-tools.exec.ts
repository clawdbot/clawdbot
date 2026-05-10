import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { buildCommandPayloadCandidates } from "../infra/command-analysis/risks.js";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import {
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  loadExecApprovals,
  maxAsk,
  minSecurity,
  requireValidExecTarget,
} from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeHostExecEnvWithDiagnostics } from "../infra/host-env-security.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import { renderExecOutputText } from "./bash-tools.exec-output.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  type ExecProcessOutcome,
  applyPathPrepend,
  applyShellPath,
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizePathPrepend,
  resolveExecTarget,
  resolveApprovalRunningNoticeMs,
  runExecProcess,
  execSchema,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import { type AgentToolWithMeta, failedTextResult, textResult } from "./tools/common.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

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
      durationMs: params.outcome.durationMs,
      aggregated: params.outcome.aggregated,
      timedOut: params.outcome.timedOut,
      cwd: params.cwd,
    });
  }
  return textResult(`${warningText}${renderExecOutputText(params.outcome.aggregated)}`, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
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
  return !!(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}

function resolvePreflightRelativePath(params: { rootDir: string; absPath: string }): string | null {
  const root = path.resolve(params.rootDir);
  const candidate = path.resolve(params.absPath);
  const relative = path.relative(root, candidate);
  if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) {
    return null;
  }
  // Preserve literal "~" path segments under the workdir. Root reads
  // expand home prefixes for relative paths, so normalize `~/...` to `./~/...`.
  return /^~(?:$|[\\/])/u.test(relative) ? `.${path.sep}${relative}` : relative;
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
  while (idx < argv.length && isShellEnvAssignmentToken(argv[idx])) {
    idx += 1;
  }
  if (!isEnvExecutableToken(argv[idx])) {
    return argv;
  }
  idx += 1;
  while (idx < argv.length) {
    const token = argv[idx];
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
    const option = token.split("=", 1)[0];
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
    const token = tokens[i];
    if (token === "--") {
      const next = tokens[i + 1];
      return normalizeLowercaseStringOrEmpty(next).endsWith(".py") ? next : null;
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
    const token = tokens[i];
    if (token === "--") {
      if (!hasInlineEvalOrPrint && !entryScript) {
        const next = tokens[i + 1];
        if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
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
      const next = tokens[i + 1];
      if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
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
  while (commandIdx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx])) {
    commandIdx += 1;
  }
  const executable = normalizeOptionalLowercaseString(argv[commandIdx]);
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

    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
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

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
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
    const arg = args[i];
    if (arg === "--") {
      return null;
    }
    if (arg === "-c") {
      return args[i + 1] ?? null;
    }
    if (/^-[A-Za-z]+$/u.test(arg)) {
      if (arg.includes("c")) {
        return args[i + 1] ?? null;
      }
      if (shortOptionsWithSeparateValue.has(arg)) {
        i += 1;
      }
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) {
      if (!arg.includes("=")) {
        const next = args[i + 1];
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
    const argv = splitShellArgs(rawCommand.trim());
    if (!argv || argv.length === 0) {
      return false;
    }
    const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
      ? argv.slice(1)
      : argv;
    if (withoutLeadingKeyword.length === 0) {
      return false;
    }
    const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
    let commandIdx = 0;
    while (
      commandIdx < normalizedArgv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")
    ) {
      commandIdx += 1;
    }
    const executable = normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
    if (!executable) {
      return false;
    }
    const args = normalizedArgv.slice(commandIdx + 1);

    if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
      const pythonInfoOnlyFlags = new Set(["-V", "--version", "-h", "--help"]);
      if (args.some((arg) => pythonInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        args.some(
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
      if (args.some((arg) => nodeInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        args.some(
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

  const { FsSafeError, root: fsRoot } = await loadFsSafeModule();
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
      const safeRead = await workspaceRoot.read(relativePath, {
        nonBlockingRead: true,
        symlinks: "follow-within-root",
        maxBytes: 512 * 1024,
      });
      content = safeRead.buffer.toString("utf-8");
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

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

function parseExecApprovalShellCommand(raw: string): ParsedExecApprovalCommand | null {
  const normalized = raw.trimStart();
  const match = normalized.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  return {
    approvalId: match[1],
    decision:
      normalizeLowercaseStringOrEmpty(match[2]) === "always"
        ? "allow-always"
        : (normalizeLowercaseStringOrEmpty(match[2]) as ParsedExecApprovalCommand["decision"]),
  };
}

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeLowercaseStringOrEmpty(token.split(/[\\/]/u).at(-1));
  return base.replace(/\.(?:cmd|exe)$/u, "");
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    normalizeCommandBaseName(argv[1]) === "openclaw"
  ) {
    return argv.slice(1);
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    (argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "run") &&
    normalizeCommandBaseName(argv[2]) === "openclaw"
  ) {
    return argv.slice(2);
  }
  if (commandName === "npx" || commandName === "bunx") {
    let idx = 1;
    while (idx < argv.length) {
      const token = argv[idx];
      if (token === "--") {
        idx += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      idx += 1;
      if ((token === "-p" || token === "--package") && idx < argv.length) {
        idx += 1;
      }
    }
    if (normalizeCommandBaseName(argv[idx]) === "openclaw") {
      return argv.slice(idx);
    }
  }
  return argv;
}

function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  const argv = splitShellArgs(raw);
  if (!argv) {
    return false;
  }
  const openclawArgv = stripOpenClawPackageRunner(argv);
  return (
    normalizeCommandBaseName(openclawArgv[0]) === "openclaw" &&
    (openclawArgv[1] === "channels" || openclawArgv[1] === "channel") &&
    openclawArgv[2] === "login"
  );
}

function rejectUnsafeControlShellCommand(command: string): void {
  const rawCommand = command.trim();
  const analysis = analyzeShellCommand({ command: rawCommand });
  const candidates = analysis.ok
    ? analysis.segments.flatMap((segment) => buildCommandPayloadCandidates(segment.argv))
    : rawCommand
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const argv = splitShellArgs(line);
          return argv ? buildCommandPayloadCandidates(argv) : [line];
        });
  for (const candidate of candidates) {
    if (parseExecApprovalShellCommand(candidate)) {
      throw new Error(
        [
          "exec cannot run /approve commands.",
          "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
        ].join(" "),
      );
    }
    if (parseOpenClawChannelsLoginShellCommand(candidate)) {
      throw new Error(
        [
          "exec cannot run interactive OpenClaw channel login commands.",
          "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
        ].join(" "),
      );
    }
  }
}

export function createExecTool(
  defaults?: ExecToolDefaults,
): AgentToolWithMeta<typeof execSchema, ExecToolDetails> {
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
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
  const notifyOnExitEmptySuccess = defaults?.notifyOnExitEmptySuccess === true;
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

  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return describeExecTool({ agentId, hasCronTool: defaults?.hasCronTool === true });
    },
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
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

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      const approvalWarningText = normalizeOptionalString(defaults?.approvalWarningText);
      if (approvalWarningText) {
        warnings.push(approvalWarningText);
      }
      let execCommandOverride: string | undefined;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
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
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }
      const requestedTarget = requireValidExecTarget(params.host);
      const target = resolveExecTarget({
        configuredTarget: defaults?.host,
        requestedTarget,
        elevatedRequested,
        sandboxAvailable: Boolean(defaults?.sandbox),
      });
      const host: ExecHost = target.effectiveHost;

      const approvalDefaults = loadExecApprovals().defaults;
      const configuredSecurity =
        defaults?.security ?? approvalDefaults?.security ?? (host === "sandbox" ? "deny" : "full");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      // Keep local exec defaults in sync with exec-approvals.json when tools.exec.* is unset.
      const configuredAsk = defaults?.ask ?? approvalDefaults?.ask ?? "off";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      if (target.selectedTarget === "sandbox" && !sandbox) {
        throw new Error(
          [
            "exec host=sandbox requires a sandbox runtime for this session.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or use host=auto/gateway/node.',
          ].join("\n"),
        );
      }
      const explicitWorkdir = normalizeOptionalString(params.workdir);
      const defaultWorkdir = normalizeOptionalString(defaults?.cwd);
      let workdir: string | undefined;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const sandboxWorkdir = explicitWorkdir ?? defaultWorkdir ?? process.cwd();
        const resolved = await resolveSandboxWorkdir({
          workdir: sandboxWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else if (host === "node") {
        // For remote node execution, only forward a cwd that was explicitly
        // requested on the tool call. The gateway's workspace root is wired in as a
        // local default, but it is not meaningful on the remote node and would
        // recreate the cross-platform approval failure this path is fixing.
        // When no explicit cwd was given, the gateway's own
        // process.cwd() is meaningless on the remote node (especially cross-platform,
        // e.g. Linux gateway + Windows node) and would cause
        // "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd".
        // Passing undefined lets the node use its own default working directory.
        workdir = explicitWorkdir;
      } else {
        const rawWorkdir = explicitWorkdir ?? defaultWorkdir ?? process.cwd();
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }
      rejectUnsafeControlShellCommand(params.command);

      const inheritedBaseEnv = coerceEnv(process.env);
      const hostEnvResult =
        host === "sandbox"
          ? null
          : sanitizeHostExecEnvWithDiagnostics({
              baseEnv: inheritedBaseEnv,
              overrides: params.env,
              blockPathOverrides: true,
            });
      if (
        hostEnvResult &&
        params.env &&
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
              paramsEnv: params.env,
              sandboxEnv: sandbox.env,
              containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
            })
          : (hostEnvResult?.env ?? inheritedBaseEnv);

      if (!sandbox && host === "gateway" && !params.env?.PATH) {
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
          requestedEnv: params.env,
          requestedNode: params.node?.trim(),
          boundNode: defaults?.node?.trim(),
          sessionKey: defaults?.sessionKey,
          bashElevated: elevatedDefaults,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          agentId,
          security,
          ask,
          strictInlineEval: defaults?.strictInlineEval,
          trigger: defaults?.trigger,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          approvalRunningNoticeMs,
          warnings,
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
          requestedEnv: params.env,
          pty: params.pty === true && !sandbox,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          security,
          ask,
          safeBins,
          safeBinProfiles,
          strictInlineEval: defaults?.strictInlineEval,
          trigger: defaults?.trigger,
          agentId,
          sessionKey: defaults?.sessionKey,
          bashElevated: elevatedDefaults,
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
        execCommandOverride = gatewayResult.execCommandOverride;
        if (gatewayResult.allowWithoutEnforcedCommand) {
          execCommandOverride = undefined;
        }
      }

      const explicitTimeoutSec = typeof params.timeout === "number" ? params.timeout : null;
      const effectiveTimeout = explicitTimeoutSec ?? defaultTimeoutSec;
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;

      // Preflight: catch a common model failure mode (shell syntax leaking into Python/JS sources)
      // before we execute and burn tokens in cron loops.
      if (!shouldSkipExecScriptPreflight({ host, security, ask })) {
        await validateScriptFileForShellBleed({ command: params.command, workdir });
      }

      const run = await runExecProcess({
        command: params.command,
        execCommand: execCommandOverride,
        workdir,
        env,
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
        notifyDeliveryContext,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        // Immediately suppress onUpdate calls so that any late stdout/stderr
        // from the still-running process cannot push a rejected Promise into
        // pi-agent-core's updateEvents after the agent run has ended (#62520).
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

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () =>
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

        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
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
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

export const execTool = createExecTool();

export const __testing = {
  parseOpenClawChannelsLoginShellCommand,
  validateScriptFileForShellBleed,
};
