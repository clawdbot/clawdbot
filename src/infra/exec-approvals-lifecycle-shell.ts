// Splits compound shell text without treating quoted separators as commands.
export function splitLifecycleCommandText(
  command: string,
  delimiters: ReadonlySet<string>,
): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let parenDepth = 0;
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
    if (char === "\\" || char === "^" || char === "`") {
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
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (parenDepth === 0 && delimiters.has(char)) {
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

/** Split shell command lists and pipelines into executable text fragments. */
export function splitLifecycleInlineCommands(command: string): string[] {
  return splitLifecycleCommandText(command, new Set([";", "|", "&", "\n", "\r"]));
}
