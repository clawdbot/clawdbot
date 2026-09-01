/**
 * Lightweight shell parsing helpers for exec display summaries.
 *
 * Handles common quoting, wrapper, and preamble shapes for UI labels without validating shell syntax.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type PreambleResult = {
  command: string;
  chdirPath?: string;
};

/** Removes matching outer single or double quotes from a display token. */
export function stripOuterQuotes(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export type ShellWords = {
  words: string[];
  hereInput?: "heredoc" | "here-string";
  unsupported: boolean;
};

/** Separates command arguments from unquoted shell redirects before quote removal. */
export function parseShellWords(input: string | undefined, maxWords = 48): ShellWords {
  const source = input ?? "";
  const result: ShellWords = { words: [], unsupported: false };
  let current = "";
  let quote: '"' | "'" | "ansi-c" | undefined;
  let previousUnquotedDollar = false;
  let started = false;
  let protectedWord = false;
  let redirectOperand = false;
  const flush = () => {
    if (started) {
      if (!redirectOperand) {
        result.words.push(current);
      }
      redirectOperand = false;
    }
    current = "";
    started = false;
    protectedWord = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    const wasUnquotedDollar: boolean = previousUnquotedDollar;
    previousUnquotedDollar = false;
    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\\" && (!quote || quote === "ansi-c" || /[$`"\\\n]/u.test(next))) {
      if (!next) {
        result.unsupported = true;
        break;
      }
      index += 1;
      if (next !== "\n") {
        current += next;
        started = protectedWord = true;
      } else {
        previousUnquotedDollar = wasUnquotedDollar;
      }
      continue;
    }
    if (quote) {
      if (char === (quote === "ansi-c" ? "'" : quote)) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char === "'" && wasUnquotedDollar ? "ansi-c" : char;
      started = protectedWord = true;
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      if (result.words.length >= maxWords) {
        return result;
      }
      continue;
    }
    if (char === "#" && !started) {
      break;
    }
    if (char === "<" || char === ">" || (char === "&" && next === ">")) {
      if (next === "(") {
        result.unsupported = true;
      }
      // Only unquoted adjacent digits or {name} belong to the redirect's fd prefix.
      if (!protectedWord && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/u.test(current)) {
        current = "";
        started = false;
      }
      flush();
      let operator = char;
      if (char === "&") {
        operator += next;
        index += 1;
        if (source.charAt(index + 1) === ">") {
          operator += ">";
          index += 1;
        }
      } else if (
        next === char ||
        next === "&" ||
        (char === "<" && next === ">") ||
        (char === ">" && next === "|")
      ) {
        operator += next;
        index += 1;
        if (
          operator === "<<" &&
          (source.charAt(index + 1) === "-" || source.charAt(index + 1) === "<")
        ) {
          operator += source.charAt(++index);
        }
      }
      if (operator.startsWith("<<")) {
        result.hereInput = operator === "<<<" ? "here-string" : "heredoc";
      }
      redirectOperand = true;
      continue;
    }
    current += char;
    started = true;
    previousUnquotedDollar = char === "$";
  }
  flush();
  result.unsupported ||= quote !== undefined || redirectOperand;
  return result;
}

/** Returns a normalized basename for a command token. */
export function binaryName(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  const cleaned = stripOuterQuotes(token) ?? token;
  const segment = cleaned.split(/[/]/).at(-1) ?? cleaned;
  return normalizeLowercaseStringOrEmpty(segment);
}

/** Parses option boundaries once; callers supply the command's value-taking options. */
export function parseShellOptions(words: string[], from = 1, optionsWithValue: string[] = []) {
  const positional: string[] = [];
  const options = new Map<string, string | undefined>();
  const takesValue = new Set(optionsWithValue);
  const record = (name: string, value?: string) => {
    if (!options.has(name)) {
      options.set(name, value);
    }
  };
  for (let index = from; index < words.length; index += 1) {
    const token = words[index];
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      positional.push(...words.slice(index + 1));
      break;
    }
    if (takesValue.has(token)) {
      record(token, words[++index]);
    } else if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      record(
        equals < 0 ? token : token.slice(0, equals),
        equals < 0 ? undefined : token.slice(equals + 1),
      );
    } else if (token.startsWith("-") && token.length > 1) {
      for (let offset = 1; offset < token.length; offset += 1) {
        const name = `-${token[offset]}`;
        if (takesValue.has(name)) {
          record(name, token.slice(offset + 1) || words[++index]);
          break;
        }
        record(name);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

/** Reads the first occurrence of any matching short or long option. */
export function optionValue(words: string[], names: string[]): string | undefined {
  const { options } = parseShellOptions(words, 1, names);
  for (const [name, value] of options) {
    if (names.includes(name)) {
      return value;
    }
  }
  return undefined;
}

/** Returns positional args after consuming options and their values. */
export function positionalArgs(
  words: string[],
  from = 1,
  optionsWithValue: string[] = [],
): string[] {
  return parseShellOptions(words, from, optionsWithValue).positional;
}

/** Returns the first positional arg after skipping options and configured option values. */
export function firstPositional(
  words: string[],
  from = 1,
  optionsWithValue: string[] = [],
): string | undefined {
  return positionalArgs(words, from, optionsWithValue)[0];
}

/** Removes leading `env` wrappers and VAR=value assignments from parsed words. */
export function trimLeadingEnv(words: string[]): string[] {
  if (words.length === 0) {
    return words;
  }

  let index = 0;
  if (binaryName(words[0]) === "env") {
    index = 1;
    while (index < words.length) {
      const token = words[index];
      if (!token) {
        break;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      break;
    }
    return words.slice(index);
  }

  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words.at(index) ?? "")) {
    index += 1;
  }
  return words.slice(index);
}

/** Unwraps common `sh -c`/`bash -lc` command wrappers for display parsing. */
export function unwrapShellWrapper(command: string): string {
  const { words } = parseShellWords(command, 10);
  if (words.length < 3) {
    return command;
  }

  const bin = binaryName(words[0]);
  if (!(bin === "bash" || bin === "sh" || bin === "zsh" || bin === "fish")) {
    return command;
  }

  const flagIndex = words.findIndex(
    (token, index) => index > 0 && (token === "-c" || token === "-lc" || token === "-ic"),
  );
  if (flagIndex === -1) {
    return command;
  }

  const inner = words
    .slice(flagIndex + 1)
    .join(" ")
    .trim();
  return inner ? (stripOuterQuotes(inner) ?? command) : command;
}

type HeredocMarker = {
  value: string;
  stripLeadingTabs: boolean;
  operatorIndex: number;
};

function parseHeredocMarker(command: string, operatorIndex: number): HeredocMarker | undefined {
  if (
    command[operatorIndex] !== "<" ||
    command[operatorIndex - 1] === "<" ||
    command[operatorIndex + 1] !== "<" ||
    command[operatorIndex + 2] === "<"
  ) {
    return undefined;
  }

  const stripLeadingTabs = command[operatorIndex + 2] === "-";
  let index = operatorIndex + (stripLeadingTabs ? 3 : 2);
  while (/[ \t]/u.test(command[index] ?? "")) {
    index += 1;
  }

  let value = "";
  let quote: '"' | "'" | undefined;
  for (; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === "\\" && index + 1 < command.length) {
        index += 1;
        value += command[index] ?? "";
        continue;
      }
      value += char;
      continue;
    }

    if (/[\r\n;&|<>]/u.test(char) || /[ \t]/u.test(char)) {
      break;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      value += command[index] ?? "";
      continue;
    }
    value += char;
  }

  return value ? { value, stripLeadingTabs, operatorIndex } : undefined;
}

function findHeredocBodyEnd(
  command: string,
  marker: HeredocMarker,
  bodyStart: number,
): number | undefined {
  let lineStart = bodyStart;
  while (lineStart <= command.length) {
    const lineEnd = command.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? command.length : lineEnd;
    const rawLine = command.slice(lineStart, end).replace(/\r$/u, "");
    const candidate = marker.stripLeadingTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
    if (candidate === marker.value) {
      return end;
    }
    if (lineEnd === -1) {
      return undefined;
    }
    lineStart = lineEnd + 1;
  }

  return undefined;
}

function findArithmeticSecondParen(command: string, firstParenIndex: number): number | undefined {
  let index = firstParenIndex + 1;
  // Bash removes unquoted backslash-newline pairs before recognizing the `((` token.
  while (command[index] === "\\" && command[index + 1] === "\n") {
    index += 2;
  }
  return command[index] === "(" ? index : undefined;
}

export function scanTopLevelChars(
  command: string,
  visit: (char: string, index: number) => boolean | void,
  visitHeredocBody?: (operatorIndex: number, start: number, end: number) => void,
): void {
  let quote: '"' | "'" | "ansi-c" | undefined;
  let escaped = false;
  let atWordStart = true;
  let arithmeticDepth = 0;
  let plainSubshellDepth = 0;
  let pendingHeredocs: HeredocMarker[] = [];
  let previousUnquotedDollar = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);
    const previousWasUnquotedDollar: boolean = previousUnquotedDollar;
    previousUnquotedDollar = false;

    if (escaped) {
      escaped = false;
      if (char === "\n") {
        // A line continuation disappears before tokenization; keep both code units absent.
        previousUnquotedDollar = previousWasUnquotedDollar;
        if (visit("", i - 1) === false || visit("", i) === false) {
          return;
        }
      } else {
        atWordStart = false;
      }
      continue;
    }

    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\\") {
      // Defer adjacency until the escaped character reveals whether this is a continuation.
      previousUnquotedDollar = previousWasUnquotedDollar;
      escaped = true;
      continue;
    }

    if (quote) {
      const terminator = quote === "ansi-c" ? "'" : quote;
      if (char === terminator) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char === "'" && previousWasUnquotedDollar ? "ansi-c" : char;
      atWordStart = false;
      continue;
    }

    if (char === "#" && atWordStart && arithmeticDepth === 0) {
      const newline = command.indexOf("\n", i + 1);
      if (newline === -1) {
        return;
      }
      i = newline - 1;
      continue;
    }

    const arithmeticSecondParenIndex =
      arithmeticDepth === 0 && char === "(" && (previousWasUnquotedDollar || atWordStart)
        ? findArithmeticSecondParen(command, i)
        : undefined;
    const startsArithmetic = arithmeticSecondParenIndex !== undefined;
    const inArithmetic = arithmeticDepth > 0 || startsArithmetic;

    if (!inArithmetic) {
      const heredoc = parseHeredocMarker(command, i);
      if (heredoc) {
        pendingHeredocs.push(heredoc);
      }
    }

    if (char === "\n" && pendingHeredocs.length > 0) {
      let bodyStart = i + 1;
      let bodyEnd: number | undefined;
      const bodies: Array<{ marker: HeredocMarker; start: number; end: number }> = [];
      for (const marker of pendingHeredocs) {
        bodyEnd = findHeredocBodyEnd(command, marker, bodyStart);
        if (bodyEnd === undefined) {
          break;
        }
        bodies.push({ marker, start: bodyStart, end: bodyEnd });
        bodyStart = bodyEnd + 1;
      }
      pendingHeredocs = [];
      if (bodyEnd !== undefined) {
        for (const body of bodies) {
          visitHeredocBody?.(body.marker.operatorIndex, body.start, body.end);
        }
        i = bodyEnd - 1;
        continue;
      }
    }

    if (arithmeticSecondParenIndex !== undefined) {
      // Expose only the `((` opener; separators inside the arithmetic body stay protected.
      if (
        visit(char, i) === false ||
        visit(command.charAt(arithmeticSecondParenIndex), arithmeticSecondParenIndex) === false
      ) {
        return;
      }
    } else if (!inArithmetic && visit(char, i) === false) {
      return;
    }

    if (char === "(" && (arithmeticDepth > 0 || startsArithmetic)) {
      arithmeticDepth += 1;
      continue;
    }
    if (char === ")" && arithmeticDepth > 0) {
      arithmeticDepth -= 1;
      continue;
    }
    if (inArithmetic) {
      continue;
    }

    if (/\s/u.test(char)) {
      atWordStart = true;
    } else if (char === "(") {
      const previous = command[i - 1];
      const isWordExpansion = previous === "$" || previous === "<" || previous === ">";
      if (isWordExpansion) {
        // The expansion is part of the surrounding word, but its body starts a fresh command.
        atWordStart = true;
      } else if (atWordStart) {
        plainSubshellDepth += 1;
        atWordStart = true;
      }
    } else if (char === ")") {
      if (plainSubshellDepth > 0) {
        plainSubshellDepth -= 1;
        atWordStart = true;
      } else {
        // Command and process substitutions remain part of the word that opened them.
        atWordStart = false;
      }
    } else if (/[;&|<>]/u.test(char)) {
      atWordStart = true;
    } else {
      atWordStart = false;
    }
    previousUnquotedDollar = char === "$";
  }
}

function splitTopLevel(
  command: string,
  separatorLength: (char: string, index: number) => number,
): string[] {
  const parts: string[] = [];
  let segmentStart = 0;
  let sliceStart = 0;
  let chunks: string[] = [];

  scanTopLevelChars(
    command,
    (char, index) => {
      const length = separatorLength(char, index);
      if (length === 0) {
        return true;
      }
      parts.push(chunks.join("") + command.slice(sliceStart, index));
      segmentStart = index + length;
      sliceStart = segmentStart;
      chunks = [];
      return true;
    },
    (operatorIndex, bodyStart, bodyEnd) => {
      if (operatorIndex < segmentStart) {
        chunks.push(command.slice(sliceStart, bodyStart));
        sliceStart = bodyEnd;
      }
    },
  );

  parts.push(chunks.join("") + command.slice(sliceStart));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// `&` and `|` start commands unless they belong to redirects such as `>&`, `&>`, or `>|`.
// Bash pipeline prefixes remain part of the command start that follows them.
const SHELL_COMMAND_START_PATTERN = String.raw`(?:^|;|\n|(?<!>)\||(?<![<>])&(?![>&]))\s*(?:(?:time(?:\s+-p)?(?:\s+--)?|!)(?:\s+|(?=\()))*`;
const SHELL_TOKEN_END_PATTERN = String.raw`(?=$|[\s;&|()<>])`;
const SHELL_NAMED_COMPOUND_START_PATTERN =
  `(?:(?:for|while|until|if|case|select|coproc)${SHELL_TOKEN_END_PATTERN}|` +
  `(?:\\[\\[|\\{)${SHELL_TOKEN_END_PATTERN})`;
const SHELL_COMPOUND_START_PATTERN = `(?:${SHELL_NAMED_COMPOUND_START_PATTERN}|\\((?!\\())`;
const SHELL_FUNCTION_BODY_START_PATTERN = `(?:${SHELL_NAMED_COMPOUND_START_PATTERN}|\\()`;
const SHELL_COMPOUND_AT_COMMAND_START_RE = new RegExp(
  `${SHELL_COMMAND_START_PATTERN}${SHELL_COMPOUND_START_PATTERN}`,
  "u",
);
const SHELL_FUNCTION_NAME_PATTERN = `[^\\s;&|()<>]+`;
const SHELL_FUNCTION_AT_COMMAND_START_RE = new RegExp(
  `${SHELL_COMMAND_START_PATTERN}function\\s+${SHELL_FUNCTION_NAME_PATTERN}(?:\\s+${SHELL_FUNCTION_BODY_START_PATTERN}|\\((?!\\s*\\)))`,
  "u",
);
const SHELL_PAREN_FUNCTION_AT_COMMAND_START_RE = new RegExp(
  `${SHELL_COMMAND_START_PATTERN}(?:function\\s+)?${SHELL_FUNCTION_NAME_PATTERN}\\s*\\(\\s*\\)\\s*${SHELL_FUNCTION_BODY_START_PATTERN}`,
  "u",
);
const SHELL_SUBSTITUTION_COMMAND_START_PATTERN = String.raw`(?:\$\((?!\()|[<>]\()\s*(?:(?:time(?:\s+-p)?(?:\s+--)?|!)(?:\s+|(?=\()))*`;
const SHELL_COMPOUND_AT_SUBSTITUTION_START_RE = new RegExp(
  `${SHELL_SUBSTITUTION_COMMAND_START_PATTERN}${SHELL_COMPOUND_START_PATTERN}`,
  "u",
);
const SHELL_FUNCTION_AT_SUBSTITUTION_START_RE = new RegExp(
  `${SHELL_SUBSTITUTION_COMMAND_START_PATTERN}function\\s+${SHELL_FUNCTION_NAME_PATTERN}(?:\\s+${SHELL_FUNCTION_BODY_START_PATTERN}|\\((?!\\s*\\)))`,
  "u",
);
const SHELL_PAREN_FUNCTION_AT_SUBSTITUTION_START_RE = new RegExp(
  `${SHELL_SUBSTITUTION_COMMAND_START_PATTERN}(?:function\\s+)?${SHELL_FUNCTION_NAME_PATTERN}\\s*\\(\\s*\\)\\s*${SHELL_FUNCTION_BODY_START_PATTERN}`,
  "u",
);

/** Returns whether unquoted shell syntax contains a compound-command introducer. */
export function hasShellCompoundCommand(command: string): boolean {
  // Keep quoted and escaped fragments token-occupying so `"x"select` cannot become `select`.
  const syntaxChars = Array.from({ length: command.length }, () => "\0");
  scanTopLevelChars(command, (char, index) => {
    syntaxChars[index] = char;
    return true;
  });
  const syntax = syntaxChars.join("");
  return (
    SHELL_COMPOUND_AT_COMMAND_START_RE.test(syntax) ||
    SHELL_FUNCTION_AT_COMMAND_START_RE.test(syntax) ||
    SHELL_PAREN_FUNCTION_AT_COMMAND_START_RE.test(syntax) ||
    SHELL_COMPOUND_AT_SUBSTITUTION_START_RE.test(syntax) ||
    SHELL_FUNCTION_AT_SUBSTITUTION_START_RE.test(syntax) ||
    SHELL_PAREN_FUNCTION_AT_SUBSTITUTION_START_RE.test(syntax)
  );
}

/** Splits a command on top-level stage separators such as `;`, `&&`, and `||`. */
export function splitTopLevelStages(command: string): string[] {
  // Shell keywords delimit compound commands, not standalone executables. This lightweight
  // display parser cannot safely distinguish their internal separators from outer stages.
  if (hasShellCompoundCommand(command)) {
    return command.trim() ? [command.trim()] : [];
  }
  return splitTopLevel(command, (char, index) => {
    if (char === ";") {
      return 1;
    }
    if ((char === "&" || char === "|") && command[index + 1] === char) {
      return 2;
    }
    return 0;
  });
}

/** Splits a command on top-level single pipes without splitting `||`. */
export function splitTopLevelPipes(command: string): string[] {
  return splitTopLevel(command, (char, index) => {
    if (
      char === "|" &&
      command[index - 1] !== "|" &&
      command[index - 1] !== ">" &&
      command[index + 1] !== "|"
    ) {
      return 1;
    }
    return 0;
  });
}

function parseChdirTarget(head: string): string | undefined {
  const { words } = parseShellWords(head, 3);
  const bin = binaryName(words[0]);
  if (bin === "cd" || bin === "pushd") {
    return words[1] || undefined;
  }
  return undefined;
}

function isChdirCommand(head: string): boolean {
  const bin = binaryName(parseShellWords(head, 2).words[0]);
  return bin === "cd" || bin === "pushd" || bin === "popd";
}

function isPopdCommand(head: string): boolean {
  return binaryName(parseShellWords(head, 2).words[0]) === "popd";
}

/** Removes leading setup commands such as exports and cwd changes from display summaries. */
export function stripShellPreamble(command: string): PreambleResult {
  let rest = command.trim();
  let chdirPath: string | undefined;

  for (let i = 0; i < 4; i += 1) {
    let first: { index: number; length: number; isOr?: boolean } | undefined;
    // Only scan top-level separators so quoted strings and nested shell fragments stay intact in
    // the command fragment that display code will summarize.
    scanTopLevelChars(rest, (char, idx) => {
      if (char === "&" && rest[idx + 1] === "&") {
        first = { index: idx, length: 2 };
        return false;
      }
      if (char === "|" && rest[idx + 1] === "|") {
        first = { index: idx, length: 2, isOr: true };
        return false;
      }
      if (char === ";" || char === "\n") {
        first = { index: idx, length: 1 };
        return false;
      }
      return undefined;
    });
    const head = (first ? rest.slice(0, first.index) : rest).trim();
    const isChdir = (first ? !first.isOr : i > 0) && isChdirCommand(head);
    const isPreamble =
      head.startsWith("set ") || head.startsWith("export ") || head.startsWith("unset ") || isChdir;

    if (!isPreamble) {
      break;
    }

    if (isChdir) {
      if (isPopdCommand(head)) {
        chdirPath = undefined;
      } else {
        chdirPath = parseChdirTarget(head) ?? chdirPath;
      }
    }

    rest = first ? rest.slice(first.index + first.length).trimStart() : "";
    if (!rest) {
      break;
    }
  }

  return { command: rest.trim(), chdirPath };
}
