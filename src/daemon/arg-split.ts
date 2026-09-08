/** Shared argument splitter for service command lines rendered by platform adapters. */
type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only" | "windows-cmd";
type ArgSplitQuoteChar = '"' | "'";
type ArgSplitQuoteStart = "anywhere" | "item-start";

/** Splits service command strings while preserving quoted arguments across platform parsers. */
export function splitArgsPreservingQuotes(
  value: string,
  options?: {
    escapeMode?: ArgSplitEscapeMode;
    quoteChars?: readonly ArgSplitQuoteChar[];
    quoteStart?: ArgSplitQuoteStart;
  },
): string[] {
  const args: string[] = [];
  let current = "";
  let quoteChar: ArgSplitQuoteChar | null = null;
  const escapeMode = options?.escapeMode ?? "none";
  const quoteChars = new Set<ArgSplitQuoteChar>(options?.quoteChars ?? ['"']);
  const quoteStart = options?.quoteStart ?? "anywhere";

  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (escapeMode === "backslash" && char === "\\") {
      // POSIX-style service parsers consume any escaped next byte.
      if (i + 1 < value.length) {
        current += value[i + 1];
        i++;
      }
      continue;
    }
    if (
      escapeMode === "backslash-quote-only" &&
      char === "\\" &&
      i + 1 < value.length &&
      value[i + 1] === '"'
    ) {
      // Windows cmd scripts escape only renderer-inserted quotes here; paths keep
      // their backslashes literal.
      current += '"';
      i++;
      continue;
    }
    if (escapeMode === "windows-cmd" && char === "\\") {
      // CommandLineToArgvW: 2n backslashes + " closes the quote with n
      // backslashes; 2n+1 backslashes + " is n backslashes and a literal ".
      let slashCount = 1;
      while (i + slashCount < value.length && value.charAt(i + slashCount) === "\\") {
        slashCount += 1;
      }
      const quoteIndex = i + slashCount;
      if (quoteIndex < value.length && value.charAt(quoteIndex) === '"') {
        current += "\\".repeat(Math.floor(slashCount / 2));
        if (slashCount % 2 === 1) {
          current += '"';
        } else if (quoteChar === '"') {
          quoteChar = null;
        } else {
          const canOpenQuote = quoteStart === "anywhere" || current.length === 0;
          if (!quoteChar && canOpenQuote) {
            quoteChar = '"';
          } else {
            current += '"';
          }
        }
        i = quoteIndex;
        continue;
      }
      current += "\\".repeat(slashCount);
      i += slashCount - 1;
      continue;
    }
    if (quoteChars.has(char as ArgSplitQuoteChar)) {
      if (quoteChar === char) {
        quoteChar = null;
        continue;
      }
      const canOpenQuote = quoteStart === "anywhere" || current.length === 0;
      if (!quoteChar && canOpenQuote) {
        quoteChar = char as ArgSplitQuoteChar;
        continue;
      }
    }
    if (!quoteChar && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}
