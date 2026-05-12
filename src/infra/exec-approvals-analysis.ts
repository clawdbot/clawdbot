import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import {
  resolveCommandResolutionFromArgv,
  type CommandResolution,
} from "./exec-command-resolution.js";
import {
  extractShellWrapperInlineCommand,
  resolveShellWrapperTransportArgv,
} from "./exec-wrapper-resolution.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "./shell-inline-command.js";

export {
  matchAllowlist,
  parseExecArgvToken,
  resolveAllowlistCandidatePath,
  resolveApprovalAuditCandidatePath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolvePolicyAllowlistCandidatePath,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  type CommandResolution,
  type ExecutableResolution,
  type ExecArgvToken,
} from "./exec-command-resolution.js";

export type ExecCommandSegment = {
  raw: string;
  argv: string[];
  sourceArgv?: string[];
  resolution: CommandResolution | null;
};

export type ExecCommandAnalysis = {
  ok: boolean;
  reason?: string;
  segments: ExecCommandSegment[];
  chains?: ExecCommandSegment[][]; // Segments grouped by chain operator (&&, ||, ;)
};

export type ShellChainOperator = "&&" | "||" | ";";

export type ShellChainPart = {
  part: string;
  opToNext: ShellChainOperator | null;
};

const DISALLOWED_PIPELINE_TOKENS = new Set([">", "<", "`", "\n", "\r", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`"]);
const MAX_UNQUOTED_HEREDOC_CONTINUATION_LINES = 1024;
const MAX_UNQUOTED_HEREDOC_LOGICAL_LINE_LENGTH = 64 * 1024;
const WINDOWS_UNSUPPORTED_TOKENS = new Set([
  "&",
  "|",
  "<",
  ">",
  ";",
  "^",
  "(",
  ")",
  "%",
  "!",
  "`",
  "\n",
  "\r",
]);

function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

function isEscapedLineContinuation(next: string | undefined): next is string {
  return next === "\n" || next === "\r";
}

function isShellCommentStart(source: string, index: number): boolean {
  if (source[index] !== "#") {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const prev = source[index - 1];
  return Boolean(prev && /\s/.test(prev));
}

function splitShellPipeline(command: string): { ok: boolean; reason?: string; segments: string[] } {
  type HeredocSpec = {
    delimiter: string;
    stripTabs: boolean;
    quoted: boolean;
  };

  const parseHeredocDelimiter = (
    source: string,
    start: number,
  ): { delimiter: string; end: number; quoted: boolean } | null => {
    let i = start;
    while (i < source.length && (source[i] === " " || source[i] === "\t")) {
      i += 1;
    }
    if (i >= source.length) {
      return null;
    }

    const first = source[i];
    if (first === "'" || first === '"') {
      const quote = first;
      i += 1;
      let delimiter = "";
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\n" || ch === "\r") {
          return null;
        }
        if (quote === '"' && ch === "\\" && i + 1 < source.length) {
          delimiter += source[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          return { delimiter, end: i + 1, quoted: true };
        }
        delimiter += ch;
        i += 1;
      }
      return null;
    }

    let delimiter = "";
    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch) || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") {
        break;
      }
      delimiter += ch;
      i += 1;
    }
    if (!delimiter) {
      return null;
    }
    return { delimiter, end: i, quoted: false };
  };

  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let emptySegment = false;
  const pendingHeredocs: HeredocSpec[] = [];
  let inHeredocBody = false;
  let heredocLine = "";
  let unquotedHeredocLogicalChunks: string[] = [];
  let unquotedHeredocLogicalLength = 0;

  const pushPart = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    buf = "";
  };

  const isEscapedInHeredocLine = (line: string, index: number): boolean => {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && line[i] === "\\"; i -= 1) {
      slashes += 1;
    }
    return slashes % 2 === 1;
  };

  const hasUnquotedHeredocExpansionToken = (line: string): boolean => {
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "`" && !isEscapedInHeredocLine(line, i)) {
        return true;
      }
      if (ch === "$" && !isEscapedInHeredocLine(line, i)) {
        const next = line[i + 1];
        if (
          next === "(" ||
          next === "{" ||
          next === "[" ||
          (next !== undefined &&
            (/^[A-Za-z_]$/.test(next) || /^[0-9]$/.test(next) || "@*?!$#-".includes(next)))
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const stripUnquotedHeredocLineContinuation = (
    line: string,
  ): { line: string; continues: boolean } => {
    let trailingSlashes = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) {
      trailingSlashes += 1;
    }
    if (trailingSlashes % 2 === 1) {
      return { line: line.slice(0, -1), continues: true };
    }
    return { line, continues: false };
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (inHeredocBody) {
      if (ch === "\n" || ch === "\r") {
        const current = pendingHeredocs[0];
        if (current) {
          const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
          if (current.quoted) {
            if (line === current.delimiter) {
              pendingHeredocs.shift();
            }
          } else {
            // An unquoted heredoc body whose previous physical line ended with
            // `\<newline>` is spliced into the next line at runtime. In that
            // case bash does not treat the next physical line as the delimiter,
            // even if it matches literally — the splice wins and the body
            // continues. Only recognize the delimiter when no continuation is
            // pending.
            if (line === current.delimiter && unquotedHeredocLogicalChunks.length === 0) {
              pendingHeredocs.shift();
            } else {
              const continued = stripUnquotedHeredocLineContinuation(line);
              unquotedHeredocLogicalChunks.push(continued.line);
              if (unquotedHeredocLogicalChunks.length > MAX_UNQUOTED_HEREDOC_CONTINUATION_LINES) {
                return {
                  ok: false,
                  reason: "heredoc continuation too long",
                  segments: [],
                };
              }
              unquotedHeredocLogicalLength += continued.line.length;
              if (unquotedHeredocLogicalLength > MAX_UNQUOTED_HEREDOC_LOGICAL_LINE_LENGTH) {
                return {
                  ok: false,
                  reason: "heredoc logical line too large",
                  segments: [],
                };
              }
              if (!continued.continues) {
                if (hasUnquotedHeredocExpansionToken(unquotedHeredocLogicalChunks.join(""))) {
                  return { ok: false, reason: "shell expansion in unquoted heredoc", segments: [] };
                }
                unquotedHeredocLogicalChunks = [];
                unquotedHeredocLogicalLength = 0;
              }
            }
          }
        }
        heredocLine = "";
        if (pendingHeredocs.length === 0) {
          inHeredocBody = false;
        }
        if (ch === "\r" && next === "\n") {
          i += 1;
        }
      } else {
        heredocLine += ch;
      }
      continue;
    }

    if (escaped) {
      buf += ch;
      escaped = false;
      emptySegment = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && isEscapedLineContinuation(next)) {
        return { ok: false, reason: "unsupported shell token: newline", segments: [] };
      }
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        emptySegment = false;
        continue;
      }
      if (ch === "$" && next === "(") {
        return { ok: false, reason: "unsupported shell token: $()", segments: [] };
      }
      if (ch === "`") {
        return { ok: false, reason: "unsupported shell token: `", segments: [] };
      }
      if (ch === "\n" || ch === "\r") {
        return { ok: false, reason: "unsupported shell token: newline", segments: [] };
      }
      if (ch === '"') {
        inDouble = false;
      }
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (isShellCommentStart(command, i)) {
      break;
    }

    if ((ch === "\n" || ch === "\r") && pendingHeredocs.length > 0) {
      inHeredocBody = true;
      heredocLine = "";
      if (ch === "\r" && next === "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "|" && next === "|") {
      return { ok: false, reason: "unsupported shell token: ||", segments: [] };
    }
    if (ch === "|" && next === "&") {
      return { ok: false, reason: "unsupported shell token: |&", segments: [] };
    }
    if (ch === "|") {
      emptySegment = true;
      pushPart();
      continue;
    }
    if (ch === "&" || ch === ";") {
      return { ok: false, reason: `unsupported shell token: ${ch}`, segments: [] };
    }
    if (ch === "<" && next === "<") {
      buf += "<<";
      emptySegment = false;
      i += 1;

      let scanIndex = i + 1;
      let stripTabs = false;
      if (command[scanIndex] === "-") {
        stripTabs = true;
        buf += "-";
        scanIndex += 1;
      }

      const parsed = parseHeredocDelimiter(command, scanIndex);
      if (parsed) {
        pendingHeredocs.push({ delimiter: parsed.delimiter, stripTabs, quoted: parsed.quoted });
        buf += command.slice(scanIndex, parsed.end);
        i = parsed.end - 1;
      }
      continue;
    }
    if (DISALLOWED_PIPELINE_TOKENS.has(ch)) {
      return { ok: false, reason: `unsupported shell token: ${ch}`, segments: [] };
    }
    if (ch === "$" && next === "(") {
      return { ok: false, reason: "unsupported shell token: $()", segments: [] };
    }
    buf += ch;
    emptySegment = false;
  }

  if (inHeredocBody && pendingHeredocs.length > 0) {
    const current = pendingHeredocs[0];
    const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
    // Mirror the in-loop guard: a pending unquoted continuation splices into
    // the trailing line and prevents the delimiter from terminating the
    // heredoc, so only accept the tail as a delimiter when no continuation
    // chunks are pending. If a continuation is pending, splice the tail into
    // the buffered logical line and run the expansion check against what bash
    // would actually expand at runtime, so payloads like
    // `cat <<KEY\n$OPENAI_API_\\\nKEY` cannot slip through as "unterminated".
    const pendingContinuation = !current.quoted && unquotedHeredocLogicalChunks.length > 0;
    if (pendingContinuation) {
      const continued = stripUnquotedHeredocLineContinuation(line);
      const logical = [...unquotedHeredocLogicalChunks, continued.line].join("");
      if (hasUnquotedHeredocExpansionToken(logical)) {
        return { ok: false, reason: "shell expansion in unquoted heredoc", segments: [] };
      }
    } else if (line === current.delimiter) {
      pendingHeredocs.shift();
      unquotedHeredocLogicalChunks = [];
      unquotedHeredocLogicalLength = 0;
      if (pendingHeredocs.length === 0) {
        inHeredocBody = false;
      }
    }
  }

  if (pendingHeredocs.length > 0 || inHeredocBody) {
    return { ok: false, reason: "unterminated heredoc", segments: [] };
  }

  if (escaped || inSingle || inDouble) {
    return { ok: false, reason: "unterminated shell quote/escape", segments: [] };
  }

  pushPart();
  if (emptySegment || segments.length === 0) {
    return {
      ok: false,
      reason: segments.length === 0 ? "empty command" : "empty pipeline segment",
      segments: [],
    };
  }
  return { ok: true, segments };
}

// Characters that remain unsafe even inside double-quoted strings.
// - \n / \r: newlines break command parsing regardless of quoting.
// - %: cmd.exe expands %VAR% inside double quotes, so % can still be used
//   for injection even when quoted.
// - `: PowerShell escape character; forms escape sequences (`n, `0, `") even
//   inside double-quoted strings, so it cannot be safely quoted.
const WINDOWS_ALWAYS_UNSAFE_TOKENS = new Set(["\n", "\r", "%", "`"]);

function findWindowsUnsupportedToken(command: string): string | null {
  let inDouble = false;
  // Single-quote tracking is intentionally omitted here.  cmd.exe (used by the
  // node-host exec path via buildNodeShellCommand) does not recognise single
  // quotes as quoting, so metacharacters inside single-quoted strings remain
  // active at runtime.  Rejecting them at this layer keeps both execution paths
  // (PowerShell gateway and cmd.exe node-host) safe.
  // tokenizeWindowsSegment does track single quotes for accurate argv extraction
  // during enforcement, which is a separate concern from the safety check here.
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    // PowerShell expands $var, ${var}, and $(expr) inside double-quoted strings,
    // so $ followed by an identifier-start character, {, or ( is always unsafe —
    // regardless of quoting context.  A bare $ not followed by those characters
    // is safe (e.g. UNC admin share suffix \\host\C$).
    if (ch === "$") {
      const next = command[i + 1];
      // Block $var, ${var}, $(expr), $?  (exit status), and $$ (PID) — all expanded
      // by PowerShell inside double-quoted strings.  A bare $ not followed by these
      // characters is safe (e.g. the UNC admin share suffix \\host\C$).
      if (next !== undefined && /[A-Za-z_{(?$]/.test(next)) {
        return "$";
      }
      continue;
    }
    if (WINDOWS_UNSUPPORTED_TOKENS.has(ch)) {
      // Inside double-quoted strings, most special characters are safe literal
      // values (e.g. "2026-03-28 (土) - LifeLog" contains "()" which are fine).
      // tokenizeWindowsSegment already handles all of these correctly inside quotes.
      if (inDouble && !WINDOWS_ALWAYS_UNSAFE_TOKENS.has(ch)) {
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        return "newline";
      }
      return ch;
    }
  }
  return null;
}

function tokenizeWindowsSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inDouble = false;
  let inSingle = false;
  // Set to true when a quote-open is seen; ensures empty quoted args ("" or '')
  // are preserved as empty-string tokens rather than being silently dropped.
  let wasQuoted = false;

  const pushToken = () => {
    if (buf.length > 0 || wasQuoted) {
      tokens.push(buf);
      buf = "";
    }
    wasQuoted = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    // Double-quote toggle (not inside single quotes).
    if (ch === '"' && !inSingle) {
      if (!inDouble) {
        wasQuoted = true;
      }
      inDouble = !inDouble;
      continue;
    }
    // Single-quote toggle (not inside double quotes) — PowerShell literal strings.
    // '' inside a single-quoted string is the PowerShell escape for a literal apostrophe.
    if (ch === "'" && !inDouble) {
      if (inSingle && segment[i + 1] === "'") {
        buf += "'";
        i += 1;
        continue;
      }
      if (!inSingle) {
        wasQuoted = true;
      }
      inSingle = !inSingle;
      continue;
    }
    if (!inDouble && !inSingle && /\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (inDouble || inSingle) {
    return null;
  }
  pushToken();
  return tokens.length > 0 ? tokens : null;
}

/**
 * Recursively strip transparent Windows shell wrappers from a command string.
 *
 * LLMs generate commands with arbitrary nesting of shell wrappers:
 *   powershell -NoProfile -Command "& node 'C:\path' --count 3"
 *   cmd /c "node C:\path --count 3"
 *   & node C:\path --count 3
 *
 * All of these should resolve to: node C:\path --count 3
 *
 * Recognised wrappers (applied repeatedly until stable):
 *   - PowerShell call-operator: `& exe args`
 *   - cmd.exe pass-through:    `cmd /c "..."` or `cmd /c ...`
 *   - PowerShell invocation:   `powershell [-flags] -Command "..."`
 */
function stripWindowsShellWrapper(command: string): string {
  const MAX_DEPTH = 5;
  let result = command;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const prev = result;
    result = stripWindowsShellWrapperOnce(result.trim());
    if (result === prev) {
      break;
    }
  }
  return result;
}

function stripWindowsShellWrapperOnce(command: string): string {
  // PowerShell call-operator: & exe args → exe args
  const psCallMatch = command.match(/^&\s+(.+)$/s);
  if (psCallMatch) {
    return psCallMatch[1];
  }

  // PowerShell invocation: powershell[.exe] [-flags] -Command|-c|--command "inner"
  // Also handles pwsh[.exe] and the common -c / --command abbreviations of -Command.
  // Flags before -Command may be bare (-NoProfile) or take a single value
  // (-ExecutionPolicy Bypass, -WindowStyle Hidden).  The lookahead (?!-)
  // prevents a flag value from consuming the next flag name.
  // psFlags matches zero or more PowerShell flags before the command-introducing flag.
  // Each flag is either bare (-NoProfile) or takes a single value.
  // Flag values may be unquoted (-ExecutionPolicy Bypass) or quoted with
  // double-quotes (-WorkingDirectory "C:\Users\Jane Doe\proj") or single-
  // quotes (-WorkingDirectory 'C:\Users\Jane Doe\proj').  \S+ alone cannot
  // match quoted values that contain spaces, so we try double-quoted and
  // single-quoted patterns first, then fall back to \S+ for unquoted values.
  //
  // The negative lookahead (?!c(?:ommand)?\b|-command\b) prevents psFlags from
  // consuming -c or -command as an ordinary flag before the command-introducing
  // flag is matched.  Without it, -c "inner" would be swallowed as a value-taking
  // flag and the outer pattern would never see -c to match against psCommandFlag.
  const psFlags =
    /(?:-(?!c(?:ommand)?\b|-command\b)\w+(?:\s+(?!-)(?:"[^"]*(?:""[^"]*)*"|'[^']*(?:''[^']*)*'|\S+))?\s+)*/i
      .source;
  // Matches -Command, its abbreviation -c, and the --command double-dash alias.
  const psCommandFlag = `(?:-command|-c|--command)`;
  const psInvokeMatch = command.match(
    new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+"(.+)"$`, "is"),
  );
  if (psInvokeMatch) {
    // Within a double-quoted -Command argument, "" is the escape sequence for a
    // literal ".  Unescape before passing the payload to the tokenizer so that
    // `powershell -Command "node a.js ""hello world"""` correctly yields the
    // single argv token "hello world" rather than splitting on the space.
    return psInvokeMatch[1].replace(/""/g, '"');
  }
  // PowerShell -Command (or -c/--command) with single-quoted payload
  const psInvokeSingleQuote = command.match(
    new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+'(.+)'$`, "is"),
  );
  if (psInvokeSingleQuote) {
    // Inside a PowerShell single-quoted string '' encodes a literal apostrophe.
    // Unescape before tokenizing so that 'node a.js ''hello world''' correctly
    // yields the single argv token "hello world".
    return psInvokeSingleQuote[1].replace(/''/g, "'");
  }
  // PowerShell -Command (or -c/--command) without quotes (bare unquoted payload)
  const psInvokeNoQuote = command.match(
    new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+(.+)$`, "is"),
  );
  if (psInvokeNoQuote) {
    return psInvokeNoQuote[1];
  }

  // Note: cmd /c is intentionally NOT stripped here.  If a command is wrapped
  // with `cmd /c`, its inner payload would later be executed by PowerShell, which
  // changes semantics for cmd.exe builtins (dir, copy, etc.).  Callers that submit
  // `cmd /c <thing>` must have an explicit allowlist entry for `cmd` itself, or
  // the command will require user approval.

  return command;
}

function analyzeWindowsShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const effective = stripWindowsShellWrapper(params.command.trim());
  const unsupported = findWindowsUnsupportedToken(effective);
  if (unsupported) {
    return {
      ok: false,
      reason: `unsupported windows shell token: ${unsupported}`,
      segments: [],
    };
  }
  const argv = tokenizeWindowsSegment(effective);
  if (!argv || argv.length === 0) {
    return { ok: false, reason: "unable to parse windows command", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: params.command,
        argv,
        resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}

export function isWindowsPlatform(platform?: string | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(platform);
  return normalized.startsWith("win");
}

function parseSegmentsFromParts(
  parts: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): ExecCommandSegment[] | null {
  const segments: ExecCommandSegment[] = [];
  for (const raw of parts) {
    const argv = splitShellArgs(raw);
    if (!argv || argv.length === 0) {
      return null;
    }
    segments.push({
      raw,
      argv,
      resolution: resolveCommandResolutionFromArgv(argv, cwd, env),
    });
  }
  return segments;
}

/**
 * Splits a command string by chain operators (&&, ||, ;) while preserving the operators.
 * Returns null when no chain is present or when the chain is malformed.
 */
export function splitCommandChainWithOperators(command: string): ShellChainPart[] | null {
  const parts: ShellChainPart[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let foundChain = false;
  let invalidChain = false;

  const pushPart = (opToNext: ShellChainOperator | null) => {
    const trimmed = buf.trim();
    buf = "";
    if (!trimmed) {
      return false;
    }
    parts.push({ part: trimmed, opToNext });
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && isEscapedLineContinuation(next)) {
        invalidChain = true;
        break;
      }
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      buf += ch;
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
    if (isShellCommentStart(command, i)) {
      break;
    }

    if (ch === "&" && next === "&") {
      if (!pushPart("&&")) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === "|" && next === "|") {
      if (!pushPart("||")) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === ";") {
      if (!pushPart(";")) {
        invalidChain = true;
      }
      foundChain = true;
      continue;
    }

    buf += ch;
  }

  if (!foundChain) {
    return null;
  }
  const trimmed = buf.trim();
  if (!trimmed) {
    return null;
  }
  parts.push({ part: trimmed, opToNext: null });
  if (invalidChain || parts.length === 0) {
    return null;
  }
  return parts;
}

function shellEscapeSingleArg(value: string): string {
  // Shell-safe across sh/bash/zsh: single-quote everything, escape embedded single quotes.
  // Example: foo'bar -> 'foo'"'"'bar'
  const singleQuoteEscape = `'"'"'`;
  return `'${value.replace(/'/g, singleQuoteEscape)}'`;
}

// Characters that cannot be safely double-quoted in PowerShell enforced commands.
// %   — cmd.exe immediate/delayed expansion; also blocked in analysis phase.
// $id — PowerShell variable expansion: "$env:SECRET", "${var}", "$x" ($ followed by identifier
//       start or {). A bare $ not followed by [A-Za-z_{] is treated literally (e.g. "C$").
// `   — PowerShell escape character; can form escape sequences like `n, `0 inside double quotes.
// Note: ! is intentionally omitted — PowerShell does not treat ! as special in double-quoted
// strings (unlike cmd.exe delayed expansion), so "Hello!" is safe to pass through.
const WINDOWS_UNSAFE_CMD_META = /[%`]|\$(?=[A-Za-z_{(?$])/;

export function windowsEscapeArg(value: string): { ok: true; escaped: string } | { ok: false } {
  if (value === "") {
    return { ok: true, escaped: '""' };
  }
  // Reject tokens containing cmd.exe / PowerShell meta characters that cannot be safely quoted.
  if (WINDOWS_UNSAFE_CMD_META.test(value)) {
    return { ok: false };
  }
  // If the value contains only safe characters, return as-is.
  if (/^[a-zA-Z0-9_./:~\\=-]+$/.test(value)) {
    return { ok: true, escaped: value };
  }
  // Double-quote the value, escaping embedded double-quotes.
  const escaped = value.replace(/"/g, '""');
  return { ok: true, escaped: `"${escaped}"` };
}

type ShellSegmentRenderResult = { ok: true; rendered: string } | { ok: false; reason: string };

function rebuildWindowsShellCommandFromSource(params: {
  command: string;
  renderSegment: (rawSegment: string, segmentIndex: number) => ShellSegmentRenderResult;
}): { ok: boolean; command?: string; reason?: string; segmentCount?: number } {
  const source = stripWindowsShellWrapper(params.command.trim());
  if (!source) {
    return { ok: false, reason: "empty command" };
  }
  const unsupported = findWindowsUnsupportedToken(source);
  if (unsupported) {
    return { ok: false, reason: `unsupported windows shell token: ${unsupported}` };
  }
  const rendered = params.renderSegment(source, 0);
  if (!rendered.ok) {
    return { ok: false, reason: rendered.reason };
  }
  // Prefix with PowerShell call operator (&) so that quoted executable paths
  // (e.g. "C:\Program Files\nodejs\node.exe") are treated as commands, not
  // string literals.  The & operator is harmless for unquoted paths too.
  return { ok: true, command: `& ${rendered.rendered}`, segmentCount: 1 };
}

function rebuildShellCommandFromSource(params: {
  command: string;
  platform?: string | null;
  renderSegment: (rawSegment: string, segmentIndex: number) => ShellSegmentRenderResult;
}): { ok: boolean; command?: string; reason?: string; segmentCount?: number } {
  const platform = params.platform ?? null;
  if (isWindowsPlatform(platform)) {
    return rebuildWindowsShellCommandFromSource(params);
  }
  const source = params.command.trim();
  if (!source) {
    return { ok: false, reason: "empty command" };
  }

  const chain = splitCommandChainWithOperators(source);
  const chainParts: ShellChainPart[] = chain ?? [{ part: source, opToNext: null }];
  let segmentCount = 0;
  let out = "";

  for (const part of chainParts) {
    const pipelineSplit = splitShellPipeline(part.part);
    if (!pipelineSplit.ok) {
      return { ok: false, reason: pipelineSplit.reason ?? "unable to parse pipeline" };
    }
    const renderedSegments: string[] = [];
    for (const segmentRaw of pipelineSplit.segments) {
      const rendered = params.renderSegment(segmentRaw, segmentCount);
      if (!rendered.ok) {
        return { ok: false, reason: rendered.reason };
      }
      renderedSegments.push(rendered.rendered);
      segmentCount += 1;
    }
    out += renderedSegments.join(" | ");
    if (part.opToNext) {
      out += ` ${part.opToNext} `;
    }
  }

  return { ok: true, command: out, segmentCount };
}

/**
 * Builds a shell command string that preserves pipes/chaining, but forces *arguments* to be
 * literal (no globbing, no env-var expansion) by single-quoting every argv token.
 *
 * Used to make "safe bins" actually stdin-only even though execution happens via `shell -c`.
 */
export function buildSafeShellCommand(params: { command: string; platform?: string | null }): {
  ok: boolean;
  command?: string;
  reason?: string;
} {
  const isWindows = isWindowsPlatform(params.platform);
  const rebuilt = rebuildShellCommandFromSource({
    command: params.command,
    platform: params.platform,
    renderSegment: (segmentRaw) => {
      const argv = isWindows
        ? (tokenizeWindowsSegment(segmentRaw) ?? [])
        : (splitShellArgs(segmentRaw) ?? []);
      if (argv.length === 0) {
        return { ok: false, reason: "unable to parse shell segment" };
      }
      if (isWindows) {
        return renderWindowsQuotedArgv(argv);
      }
      return { ok: true, rendered: argv.map((token) => shellEscapeSingleArg(token)).join(" ") };
    },
  });
  return finalizeRebuiltShellCommand(rebuilt);
}

function renderWindowsQuotedArgv(argv: string[]): ShellSegmentRenderResult {
  const parts: string[] = [];
  for (const token of argv) {
    const result = windowsEscapeArg(token);
    if (!result.ok) {
      return { ok: false, reason: `unsafe windows token: ${token}` };
    }
    parts.push(result.escaped);
  }
  return { ok: true, rendered: parts.join(" ") };
}

function renderQuotedArgv(argv: string[], platform?: string | null): string | null {
  if (isWindowsPlatform(platform)) {
    const result = renderWindowsQuotedArgv(argv);
    return result.ok ? result.rendered : null;
  }
  return argv.map((token) => shellEscapeSingleArg(token)).join(" ");
}

function finalizeRebuiltShellCommand(
  rebuilt: ReturnType<typeof rebuildShellCommandFromSource>,
  expectedSegmentCount?: number,
): { ok: boolean; command?: string; reason?: string } {
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  if (typeof expectedSegmentCount === "number" && rebuilt.segmentCount !== expectedSegmentCount) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rebuilt.command };
}

export function resolvePlannedSegmentArgv(segment: ExecCommandSegment): string[] | null {
  if (segment.resolution?.policyBlocked === true) {
    return null;
  }
  const baseArgv =
    segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
      ? segment.resolution.effectiveArgv
      : segment.argv;
  if (baseArgv.length === 0) {
    return null;
  }
  const argv = [...baseArgv];
  const execution = segment.resolution?.execution;
  const resolvedExecutable =
    execution?.resolvedRealPath?.trim() ?? execution?.resolvedPath?.trim() ?? "";
  if (resolvedExecutable) {
    argv[0] = resolvedExecutable;
  }
  return argv;
}

function renderSafeBinSegmentArgv(
  segment: ExecCommandSegment,
  platform?: string | null,
): string | null {
  const argv = resolvePlannedSegmentArgv(segment);
  if (!argv || argv.length === 0) {
    return null;
  }
  return renderQuotedArgv(argv, platform);
}

function findSubsequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}

function replaceShellInlineCommandArgv(params: {
  argv: string[];
  oldCommand: string;
  nextCommand: string;
}): string[] | null {
  const transportArgv = resolveShellWrapperTransportArgv(params.argv);
  if (!transportArgv) {
    return null;
  }
  const transportStart = findSubsequence(params.argv, transportArgv);
  if (transportStart < 0) {
    return null;
  }
  const match = resolveInlineCommandMatch(transportArgv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (match.valueTokenIndex === null) {
    return null;
  }
  const absoluteValueIndex = transportStart + match.valueTokenIndex;
  const token = params.argv[absoluteValueIndex];
  if (token === undefined) {
    return null;
  }
  const rewritten = [...params.argv];
  if (token === params.oldCommand) {
    rewritten[absoluteValueIndex] = params.nextCommand;
    return rewritten;
  }
  if (token.endsWith(params.oldCommand)) {
    rewritten[absoluteValueIndex] =
      token.slice(0, token.length - params.oldCommand.length) + params.nextCommand;
    return rewritten;
  }
  return null;
}

function renderInlineChainSegmentArgv(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): string | null {
  const inlineCommand = extractShellWrapperInlineCommand(params.segment.argv);
  if (!inlineCommand) {
    return null;
  }
  const analysis = analyzeShellCommand({
    command: inlineCommand,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!analysis.ok) {
    return null;
  }
  const rebuilt = buildEnforcedShellCommand({
    command: inlineCommand,
    segments: analysis.segments,
    platform: params.platform,
  });
  if (!rebuilt.ok || !rebuilt.command) {
    return null;
  }
  const rewrittenArgv = replaceShellInlineCommandArgv({
    argv: params.segment.argv,
    oldCommand: inlineCommand,
    nextCommand: rebuilt.command,
  });
  return rewrittenArgv ? renderQuotedArgv(rewrittenArgv, params.platform) : null;
}

/**
 * Rebuilds a shell command and selectively single-quotes argv tokens for segments that
 * must be treated as literal (safeBins hardening) while preserving the rest of the
 * shell syntax (pipes + chaining).
 */
export function buildSafeBinsShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: (
    | "allowlist"
    | "safeBins"
    | "inlineChain"
    | "skills"
    | "skillPrelude"
    | null
  )[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  if (params.segments.length !== params.segmentSatisfiedBy.length) {
    return { ok: false, reason: "segment metadata mismatch" };
  }
  const rebuilt = rebuildShellCommandFromSource({
    command: params.command,
    platform: params.platform,
    renderSegment: (raw, segmentIndex) => {
      const seg = params.segments[segmentIndex];
      const by = params.segmentSatisfiedBy[segmentIndex];
      if (!seg || by === undefined) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const needsLiteral = by === "safeBins";
      if (by === "inlineChain") {
        const rendered = renderInlineChainSegmentArgv({
          segment: seg,
          cwd: params.cwd,
          env: params.env,
          platform: params.platform,
        });
        if (!rendered) {
          return { ok: false, reason: "inline chain execution plan unavailable" };
        }
        return { ok: true, rendered };
      }
      if (!needsLiteral) {
        return { ok: true, rendered: raw.trim() };
      }
      const rendered = renderSafeBinSegmentArgv(seg, params.platform);
      if (!rendered) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      return { ok: true, rendered };
    },
  });
  return finalizeRebuiltShellCommand(rebuilt, params.segments.length);
}

export function buildEnforcedShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  const rebuilt = rebuildShellCommandFromSource({
    command: params.command,
    platform: params.platform,
    renderSegment: (_raw, segmentIndex) => {
      const seg = params.segments[segmentIndex];
      if (!seg) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const argv = resolvePlannedSegmentArgv(seg);
      if (!argv) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      const rendered = renderQuotedArgv(argv, params.platform);
      if (!rendered) {
        return { ok: false, reason: "unsafe windows token in argv" };
      }
      return { ok: true, rendered };
    },
  });
  return finalizeRebuiltShellCommand(rebuilt, params.segments.length);
}

/**
 * Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
 * Returns null when no chain is present or when the chain is malformed.
 */
export function splitCommandChain(command: string): string[] | null {
  const parts = splitCommandChainWithOperators(command);
  if (!parts) {
    return null;
  }
  return parts.map((p) => p.part);
}

export function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ExecCommandAnalysis {
  if (isWindowsPlatform(params.platform)) {
    return analyzeWindowsShellCommand(params);
  }
  // First try splitting by chain operators (&&, ||, ;)
  const chainParts = splitCommandChain(params.command);
  if (chainParts) {
    const chains: ExecCommandSegment[][] = [];
    const allSegments: ExecCommandSegment[] = [];

    for (const part of chainParts) {
      const pipelineSplit = splitShellPipeline(part);
      if (!pipelineSplit.ok) {
        return { ok: false, reason: pipelineSplit.reason, segments: [] };
      }
      const segments = parseSegmentsFromParts(pipelineSplit.segments, params.cwd, params.env);
      if (!segments) {
        return { ok: false, reason: "unable to parse shell segment", segments: [] };
      }
      chains.push(segments);
      allSegments.push(...segments);
    }

    return { ok: true, segments: allSegments, chains };
  }

  // No chain operators, parse as simple pipeline
  const split = splitShellPipeline(params.command);
  if (!split.ok) {
    return { ok: false, reason: split.reason, segments: [] };
  }
  const segments = parseSegmentsFromParts(split.segments, params.cwd, params.env);
  if (!segments) {
    return { ok: false, reason: "unable to parse shell segment", segments: [] };
  }
  return { ok: true, segments };
}

export function analyzeArgvCommand(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const argv = params.argv.filter((entry) => entry.trim().length > 0);
  if (argv.length === 0) {
    return { ok: false, reason: "empty argv", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: argv.join(" "),
        argv,
        sourceArgv: [...params.argv],
        resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}
