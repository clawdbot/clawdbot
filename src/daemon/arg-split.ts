type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only";

export function splitArgsPreservingQuotes(
  value: string,
  options?: { escapeMode?: ArgSplitEscapeMode },
): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  const escapeMode = options?.escapeMode ?? "none";

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escapeMode === "backslash" && char === "\\") {
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
      current += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
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
