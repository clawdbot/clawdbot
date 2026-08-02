/** Detects ambiguous interpreter invocations that cannot be safely preflighted. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { splitShellArgs } from "../utils/shell-argv.js";
import {
  extractInterpreterScriptPathsFromSegment,
  stripPreflightEnvPrefix,
} from "./bash-tools.exec-script-target.js";

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

export function shouldFailClosedInterpreterPreflight(command: string): {
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
