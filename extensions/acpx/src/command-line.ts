export type AcpxAgentCommand = string | string[];

/** Match ACPX's persisted argv identity; scalar records keep their original bytes. */
export function renderAgentCommand(command: AcpxAgentCommand): string {
  return typeof command === "string"
    ? command
    : command
        .map((part) => (/^[A-Za-z0-9_@%+=:,./^~-]+$/.test(part) ? part : JSON.stringify(part)))
        .join(" ");
}

/** Split a command string into argv-like parts using simple quote/backslash rules. */
export function splitCommandParts(value: AcpxAgentCommand): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  const windows = process.platform === "win32";
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let hasPart = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      hasPart = true;
      continue;
    }
    if (ch === "\\" && quote !== "'" && !windows) {
      escaping = true;
      hasPart = true;
      continue;
    }
    if (windows && ch === '"' && quote !== "'") {
      // Windows folds backslash runs only before a double quote (libuv quote_cmd_arg).
      const backslashes = current.match(/\\+$/)?.[0].length ?? 0;
      current =
        current.slice(0, current.length - backslashes) + "\\".repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) {
        current += '"';
        continue;
      }
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasPart = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasPart) {
        parts.push(current);
        current = "";
        hasPart = false;
      }
      continue;
    }
    current += ch;
    hasPart = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Invalid agent command: unterminated quote");
  }
  if (hasPart) {
    parts.push(current);
  }
  return parts;
}
