// Splits compound shell text without treating quoted separators as commands.
export type LifecycleShellDialect = "cmd" | "posix" | "powershell";

export function splitLifecycleCommandText(
  command: string,
  delimiters: ReadonlySet<string>,
  dialect: LifecycleShellDialect = "posix",
): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (
      (dialect === "posix" && char === "\\") ||
      (dialect === "cmd" && char === "^") ||
      (dialect === "powershell" && char === "`")
    ) {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (delimiters.has(char)) {
      const part = command.slice(start, index).trim();
      if (part) {
        parts.push(part);
      }
      while (command[index + 1] === char) {
        index += 1;
      }
      start = index + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}

function normalizeCompoundFragment(fragment: string): string {
  let normalized = fragment.trim().replace(/^[(){}\s]+|[(){}\s]+$/gu, "");
  normalized = normalized.replace(
    /^(?:(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{\s*)/u,
    "",
  );
  if (/^case\b[\s\S]*\bin\b/iu.test(normalized) && normalized.includes(")")) {
    normalized = normalized.slice(normalized.lastIndexOf(")") + 1).trim();
  }
  return normalized
    .replace(/^(?:!|do|elif|else|if|then|until|while)\s+/u, "")
    .replace(/\s+(?:do|then)$/u, "")
    .trim();
}

/** Split shell command lists and pipelines into executable text fragments. */
export function splitLifecycleInlineCommands(
  command: string,
  dialect: LifecycleShellDialect = "posix",
): string[] {
  return splitLifecycleCommandText(command, new Set([";", "|", "&", "\n", "\r"]), dialect)
    .map(normalizeCompoundFragment)
    .filter(Boolean);
}
