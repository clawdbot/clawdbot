import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { VerboseLevel } from "../../../auto-reply/thinking.js";
import { formatToolAggregate } from "../../../auto-reply/tool-meta.js";
import { formatInlineCodeSpan } from "../../../shared/markdown-code.js";
import { isExecLikeToolName, type ToolErrorSummary } from "../../tool-error-summary.js";

type ToolErrorWarningPolicy = {
  showWarning: boolean;
  includeDetails: boolean;
};

function isVerboseToolDetailEnabled(level?: VerboseLevel): boolean {
  return level === "full";
}

function shouldMarkNonTerminalToolErrorWarning(lastToolError: ToolErrorSummary): boolean {
  return lastToolError.middlewareError === true;
}

function formatToolErrorWarningText(params: {
  lastToolError: ToolErrorSummary;
  includeDetails: boolean;
  useMarkdown: boolean;
}): string {
  const terminalDiagnostic = params.lastToolError.terminalDiagnostic;
  if (terminalDiagnostic?.kind === "process") {
    const toolLabel = formatToolAggregate(
      "process",
      params.includeDetails ? [terminalDiagnostic.sessionId] : undefined,
      { markdown: params.useMarkdown },
    );
    const reason =
      terminalDiagnostic.reason.kind === "exit"
        ? `exit ${terminalDiagnostic.reason.exitCode}`
        : terminalDiagnostic.reason.kind === "signal"
          ? `signal ${terminalDiagnostic.reason.signal}`
          : terminalDiagnostic.reason.timeoutKind === "no-output-timeout"
            ? "timed out waiting for output"
            : "timed out";
    const errorSuffix =
      params.includeDetails && params.lastToolError.error ? `: ${params.lastToolError.error}` : "";
    const recoveryHint = params.includeDetails ? "" : ". Use /verbose full for complete output";
    return `⚠️ ${toolLabel} failed (${reason})${errorSuffix}${recoveryHint}.`;
  }

  const includeError =
    params.includeDetails || params.lastToolError.errorCode === "approval_timeout";
  if (isExecLikeToolName(params.lastToolError.toolName)) {
    const toolLabel = formatToolAggregate(params.lastToolError.toolName, undefined, {
      markdown: params.useMarkdown,
    });
    const subject = params.includeDetails
      ? formatExecLikeFailureSubject(params.lastToolError.meta, params.useMarkdown)
      : "";
    const conciseExitSuffix = params.includeDetails
      ? ""
      : formatConciseExecExitSuffix(params.lastToolError.error);
    const errorSuffix =
      includeError && params.lastToolError.error ? `: ${params.lastToolError.error}` : "";
    return subject
      ? `⚠️ ${toolLabel} failed: ${subject}${conciseExitSuffix}${errorSuffix}`
      : `⚠️ ${toolLabel} failed${conciseExitSuffix}${errorSuffix}`;
  }

  const toolSummary = formatToolAggregate(
    params.lastToolError.toolName,
    params.includeDetails && params.lastToolError.meta ? [params.lastToolError.meta] : undefined,
    { markdown: params.useMarkdown },
  );
  const errorSuffix =
    includeError && params.lastToolError.error ? `: ${params.lastToolError.error}` : "";
  return `⚠️ ${toolSummary} failed${errorSuffix}`;
}

function formatExecLikeFailureSubject(meta: string | undefined, markdown: boolean): string {
  const normalized = normalizeOptionalString(meta);
  if (!normalized) {
    return "";
  }

  const { flags, body } = splitExecLikeFailureMeta(normalized);
  if (!body) {
    return flags.join(" · ");
  }

  const { text, suffix } = splitDisplayContextSuffix(body);
  const literalCommand = extractLiteralExecCommand(text);
  const subject = `${maybeWrapInlineCode(literalCommand ?? text, markdown)}${suffix}`;
  return flags.length > 0 ? `${flags.join(" · ")} · ${subject}` : subject;
}

function splitExecLikeFailureMeta(meta: string): { flags: string[]; body: string } {
  const flags: string[] = [];
  const bodyParts: string[] = [];
  for (const part of meta
    .split(" · ")
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    if (part === "elevated" || part === "pty") {
      flags.push(part);
      continue;
    }
    bodyParts.push(part);
  }
  return { flags, body: bodyParts.join(" · ") };
}

const SEMANTIC_RUN_SUMMARIES = new Set(["tests", "build", "lint", "script", "command"]);
const LITERAL_RUN_SUMMARY_PREFIXES = new Set([
  "python",
  "python3",
  "ruby",
  "php",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "openclaw",
  "make",
  "cargo",
  "go",
  "docker",
  "npx",
  "uv",
  "poetry",
  "pytest",
  "vitest",
  "jest",
  "deno",
]);

function extractLiteralExecCommand(body: string): string | undefined {
  const rawCommand = extractRawExecCommand(body);
  if (rawCommand) {
    return rawCommand;
  }

  const nodeScript = body.match(/^run node script (.+)$/u);
  if (nodeScript?.[1]) {
    return `node ${nodeScript[1]}`;
  }

  const runSubject = body.match(/^run (.+)$/u)?.[1];
  if (runSubject && isKnownLiteralRunSummary(runSubject)) {
    return runSubject;
  }

  return undefined;
}

type RawExecContext = {
  leading: string[];
  trailing: string[];
};

function extractRawExecCommand(body: string): string | undefined {
  const codeSpan = extractTrailingMarkdownCodeSpan(body);
  if (!codeSpan) {
    return undefined;
  }
  const context = extractRawExecContext(codeSpan.prefix, codeSpan.value);
  const command = context.trailing.reduce((value, suffix) => `${value} ${suffix}`, codeSpan.value);
  return context.leading.length > 0 ? `${context.leading.join(" · ")} · ${command}` : command;
}

function extractTrailingMarkdownCodeSpan(
  body: string,
): { prefix: string | undefined; value: string } | undefined {
  const trimmed = body.trimEnd();
  if (!trimmed.endsWith("`")) {
    return undefined;
  }
  let delimiterLength = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === "`"; index -= 1) {
    delimiterLength += 1;
  }
  const delimiter = "`".repeat(delimiterLength);
  const valueEnd = trimmed.length - delimiterLength;
  let searchIndex = 0;
  while (searchIndex < valueEnd) {
    const openIndex = trimmed.indexOf(delimiter, searchIndex);
    if (openIndex < 0 || openIndex >= valueEnd) {
      return undefined;
    }
    const prefixMatch = trimmed.slice(0, openIndex).match(/^(?:(.*)(?:,\s*| · ))?$/u);
    if (prefixMatch) {
      return {
        prefix: prefixMatch[1],
        value: unwrapMarkdownInlineCodePadding(
          trimmed.slice(openIndex + delimiterLength, valueEnd),
        ),
      };
    }
    searchIndex = openIndex + delimiterLength;
  }
  return undefined;
}

function unwrapMarkdownInlineCodePadding(value: string): string {
  if (value.length < 2 || !value.startsWith(" ") || !value.endsWith(" ")) {
    return value;
  }
  const unwrapped = value.slice(1, -1);
  return /\S/u.test(unwrapped) ? unwrapped : value;
}
function extractRawExecContext(prefix: string | undefined, inlineCode: string): RawExecContext {
  const value = prefix ?? "";
  const leading = [...value.matchAll(/(?:^|,\s*| · )(node:\s*[^,·]+)(?=,\s*| · |$)/gu)]
    .map((match) => match[1]?.trim())
    .filter((part): part is string => Boolean(part));
  const trailing = [
    ...value.matchAll(
      /(\((?:agent|repo|sandbox|workspace)\)|\(in [^)\r\n]+\))(?=\s*(?:,\s*| · |$))/gu,
    ),
  ]
    .filter((match) => shouldKeepRawExecTrailingContext(value, match, inlineCode))
    .map((match) => match[1]?.trim())
    .filter((part): part is string => Boolean(part));
  return { leading, trailing };
}
function shouldKeepRawExecTrailingContext(
  prefix: string,
  match: RegExpMatchArray,
  inlineCode: string,
): boolean {
  const suffix = match[1]?.trim();
  if (!suffix || inlineCode.includes(suffix)) {
    return false;
  }
  const segment = prefix
    .slice(0, match.index ?? 0)
    .trimEnd()
    .split(/,\s*| · /u)
    .at(-1)
    ?.trim();
  const segmentCommand = segment ? extractLiteralExecCommand(segment) : undefined;
  if (segmentCommand === inlineCode || segment === inlineCode) {
    return true;
  }
  if (isCompactCwdSuffix(suffix)) {
    return true;
  }
  return isPathLikeCwdSuffix(suffix);
}
function isCompactCwdSuffix(suffix: string): boolean {
  return /^\((?:agent|repo|workspace)\)$/u.test(suffix);
}
function isPathLikeCwdSuffix(suffix: string): boolean {
  const cwd = suffix.match(/^\(in ([^)\r\n]+)\)$/u)?.[1]?.trim();
  return Boolean(
    cwd && (/^(?:\/|~|\.{1,2}(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/u.test(cwd) || cwd.includes("/")),
  );
}
function isKnownLiteralRunSummary(subject: string): boolean {
  if (
    SEMANTIC_RUN_SUMMARIES.has(subject) ||
    subject.includes("→") ||
    subject.includes("->") ||
    /^(?:node|python3?|ruby|php) inline script(?: \(heredoc\))?$/u.test(subject)
  ) {
    return false;
  }
  const match = subject.match(/^(\S+)\s+(.+)$/u);
  const command = match?.[1];
  const remainder = match?.[2];
  if (!command || !remainder || remainder === "command") {
    return false;
  }
  return LITERAL_RUN_SUMMARY_PREFIXES.has(command);
}
function splitDisplayContextSuffix(value: string): { text: string; suffix: string } {
  const match = /^(.*?)( \((?:agent|repo|workspace|sandbox)\))$/u.exec(value);
  if (!match) {
    return { text: value, suffix: "" };
  }
  return { text: match[1] ?? value, suffix: match[2] ?? "" };
}
function formatConciseExecExitSuffix(error: string | undefined): string {
  const normalized = normalizeOptionalString(error);
  const code = normalized?.match(
    /\b(?:command\s+)?(?:failed\s+with\s+exit\s+code|exited\s+with\s+code|exit(?:ed)?\s+code|exit\s+status)\s+(-?\d+)\b/iu,
  )?.[1];
  return code ? ` (exit ${code})` : "";
}
function maybeWrapInlineCode(value: string, markdown: boolean): string {
  return markdown ? formatInlineCodeSpan(value) : value;
}
/** Warn only when a tool failure would otherwise leave the user with no reply. */
function resolveToolErrorWarningPolicy(params: {
  hasUserFacingReply: boolean;
  suppressToolErrors: boolean;
  suppressToolErrorWarnings?: boolean;
  verboseLevel?: VerboseLevel;
}): ToolErrorWarningPolicy {
  const includeDetails = isVerboseToolDetailEnabled(params.verboseLevel);
  return {
    showWarning:
      !params.hasUserFacingReply &&
      !params.suppressToolErrors &&
      params.suppressToolErrorWarnings !== true,
    includeDetails,
  };
}

export function buildFailureWarning(params: {
  lastToolError: ToolErrorSummary;
  hasUserFacingReply: boolean;
  suppressToolErrors: boolean;
  suppressToolErrorWarnings?: boolean;
  verboseLevel?: VerboseLevel;
  useMarkdown: boolean;
}): { text: string; nonTerminalToolErrorWarning: boolean } | undefined {
  const warningPolicy = resolveToolErrorWarningPolicy(params);
  if (!warningPolicy.showWarning) {
    return undefined;
  }
  return {
    text: formatToolErrorWarningText({
      lastToolError: params.lastToolError,
      includeDetails: warningPolicy.includeDetails,
      useMarkdown: params.useMarkdown,
    }),
    nonTerminalToolErrorWarning: shouldMarkNonTerminalToolErrorWarning(params.lastToolError),
  };
}
