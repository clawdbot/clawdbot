// Shell argv helpers quote and parse shell-style argument strings.
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

// POSIX double quotes only consume the backslash before a small escape set;
// preserving other backslashes keeps command-risk analysis byte-faithful.
function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

/** Returns whether a shell string contains an unquoted command separator or pipeline operator. */
export function hasTopLevelShellControlOperator(raw: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStart = true;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (escaped) {
      escaped = false;
      wordStart = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === "\\" && isDoubleQuoteEscape(raw[i + 1])) {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStart = false;
      continue;
    }
    if (ch === "#" && wordStart) {
      return /[\r\n]/u.test(raw.slice(i + 1));
    }
    if (ch === "&" && (raw[i - 1] === ">" || raw[i - 1] === "<")) {
      wordStart = false;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      return true;
    }
    wordStart = /\s/u.test(ch);
  }

  return false;
}

/** Splits a shell-like argv string into tokens, returning null for unterminated quotes or escapes. */
export function splitShellArgs(raw: string): string[] | null {
  return splitQuotedArgs(raw, "shell");
}

/** Groups quoted process arguments, preserving literal backslashes and hash characters. */
export function splitCommandArgs(raw: string, options: { allowUnclosedQuotes: true }): string[];
export function splitCommandArgs(
  raw: string,
  options?: { allowUnclosedQuotes?: boolean },
): string[] | null;
export function splitCommandArgs(
  raw: string,
  options?: { allowUnclosedQuotes?: boolean },
): string[] | null {
  return splitQuotedArgs(raw, "command", options?.allowUnclosedQuotes);
}

function splitQuotedArgs(
  raw: string,
  syntax: "shell" | "command",
  allowUnclosedQuotes = false,
): string[] | null {
  const backslashEscapes = syntax === "shell";
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (backslashEscapes && !inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      // Inside double quotes, only POSIX-recognized escapes consume the backslash.
      if (backslashEscapes && ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
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
    // In POSIX shells, "#" starts a comment only when it begins a word; keep
    // inline hashes inside tokens so URLs/fragments are not truncated.
    if (syntax === "shell" && ch === "#" && buf.length === 0) {
      break;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || (!allowUnclosedQuotes && (inSingle || inDouble))) {
    return null;
  }
  pushToken();
  return tokens;
}
