// Extracts shell command/process substitutions without treating quoted text as executable.
const MAX_SUBSTITUTION_DEPTH = 8;

function findClosingParen(command: string, start: number): number | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
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
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function findClosingBacktick(command: string, start: number): number | null {
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      return index;
    }
  }
  return null;
}

function extractAtDepth(command: string, depth: number): string[] {
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    return [];
  }
  const extracted: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === "'") {
      continue;
    }

    const next = command[index + 1] ?? "";
    const opensParenSubstitution =
      (char === "$" && next === "(" && command[index + 2] !== "(") ||
      (quote === null && ["<", ">", "="].includes(char) && next === "(");
    if (opensParenSubstitution) {
      const end = findClosingParen(command, index + 2);
      if (end !== null) {
        const nested = command.slice(index + 2, end).trim();
        if (nested) {
          extracted.push(nested, ...extractAtDepth(nested, depth + 1));
        }
        index = end;
      }
      continue;
    }
    if (char === "`") {
      const end = findClosingBacktick(command, index + 1);
      if (end !== null) {
        const nested = command.slice(index + 1, end).trim();
        if (nested) {
          extracted.push(nested, ...extractAtDepth(nested, depth + 1));
        }
        index = end;
      }
    }
  }
  return extracted;
}

/** Return executable text nested in POSIX-style command or process substitutions. */
export function extractShellSubstitutionCommands(command: string): string[] {
  return extractAtDepth(command, 0);
}
