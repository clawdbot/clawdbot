// Splits compound shell text without treating quoted separators as commands.
export type LifecycleShellDialect = "cmd" | "posix" | "powershell";

function stripBraceTokens(argv: readonly string[]): string[] {
  let start = 0;
  let end = argv.length;
  while (argv[start] === "{" || argv[start] === "(") {
    start += 1;
  }
  while (argv[end - 1] === "}" || argv[end - 1] === ")") {
    end -= 1;
  }
  return argv.slice(start, end);
}

function unwrapCmdIfArgv(argv: readonly string[]): string[] {
  let index = 1;
  if ((argv[index] ?? "").toLowerCase() === "/i") {
    index += 1;
  }
  if ((argv[index] ?? "").toLowerCase() === "not") {
    index += 1;
  }
  const condition = (argv[index] ?? "").toLowerCase();
  index += ["cmdextversion", "defined", "errorlevel", "exist"].includes(condition) ? 2 : 1;
  return stripBraceTokens(argv.slice(index));
}

/** Return true when a shell control construct hides a dynamic executable. */
export function lifecycleControlArgvRequiresApproval(
  argv: readonly string[],
  dialect: LifecycleShellDialect,
): boolean {
  if (dialect !== "cmd" || (argv[0] ?? "").trim().toLowerCase() !== "for") {
    return false;
  }
  const doIndex = argv.findIndex((token) => token.toLowerCase() === "do");
  const inIndex = argv.findIndex((token) => token.toLowerCase() === "in");
  if (doIndex === -1 || inIndex === -1) {
    return false;
  }
  const variable = argv.slice(1, inIndex).find((token) => /^%%?[A-Za-z]$/u.test(token.trim()));
  const commandArgv = stripBraceTokens(argv.slice(doIndex + 1));
  return Boolean(variable && commandArgv[0]?.toLowerCase().includes(variable.trim().toLowerCase()));
}

/** Return true when PowerShell calculates an invocation target for a lifecycle-shaped command. */
export function powerShellCalculatedInvocationRequiresApproval(command: string): boolean {
  return (
    /(?:^|[;|\n\r])\s*[&.]\s*[$(@[{\]]/u.test(command) &&
    /\b(?:approvals|config|configure|daemon|exec-approvals|exec-policy|gateway|hooks|node|onboard|plugins|reset|setup|uninstall|update)\b/iu.test(
      command,
    )
  );
}

/** Return the executable argv nested in a supported shell control construct. */
export function unwrapLifecycleControlArgv(
  argv: readonly string[],
  dialect: LifecycleShellDialect,
): string[] | null {
  const first = (argv[0] ?? "").trim().toLowerCase();
  if (["(", "{"].includes(first)) {
    return stripBraceTokens(argv);
  }
  if (dialect === "powershell") {
    if (["&", "."].includes(first)) {
      return stripBraceTokens(argv.slice(1));
    }
    if (["begin", "catch", "else", "end", "finally", "process", "try"].includes(first)) {
      return stripBraceTokens(argv.slice(1));
    }
    if (["for", "foreach", "if", "elseif", "switch", "until", "while"].includes(first)) {
      const conditionEnd = argv.findIndex((token, index) => index > 0 && token.includes(")"));
      if (conditionEnd !== -1) {
        return stripBraceTokens(argv.slice(conditionEnd + 1));
      }
      if (first === "if") {
        return unwrapCmdIfArgv(argv);
      }
      return [];
    }
  }
  if (dialect === "cmd" && first === "if") {
    return unwrapCmdIfArgv(argv);
  }
  if (dialect === "cmd" && first === "for") {
    const doIndex = argv.findIndex((token) => token.toLowerCase() === "do");
    return doIndex === -1 ? [] : stripBraceTokens(argv.slice(doIndex + 1));
  }
  return null;
}

/** Strip leading POSIX assignment words and return the executable argv. */
export function stripLifecyclePosixAssignments(argv: string[]): string[] | null {
  const executableIndex = argv.findIndex(
    (token) => !/^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=.*/u.test(token),
  );
  return executableIndex === 0 ? null : executableIndex === -1 ? [] : argv.slice(executableIndex);
}

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

function normalizeCompoundFragment(fragment: string, dialect: LifecycleShellDialect): string {
  let normalized = fragment.trim().replace(/^[(){}\s]+|[(){}\s]+$/gu, "");
  normalized = normalized.replace(
    /^(?:(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{\s*)/u,
    "",
  );
  if (/^case\b[\s\S]*\bin\b/iu.test(normalized) && normalized.includes(")")) {
    normalized = normalized.slice(normalized.lastIndexOf(")") + 1).trim();
  }
  if (dialect === "powershell") {
    normalized = normalized
      .replace(/^(?:for|foreach|if|elseif|until|while)\s*\([^)]*\)\s*\{?\s*/iu, "")
      .replace(/^(?:begin|catch|else|end|finally|process|try)\s*\{?\s*/iu, "");
  } else if (dialect === "cmd" && /^if\s+/iu.test(normalized)) {
    normalized = normalized
      .replace(/^if\s+(?:\/i\s+)?(?:not\s+)?/iu, "")
      .replace(/^(?:(?:cmdextversion|defined|errorlevel|exist)\s+\S+|\S+==\S+)\s+/iu, "");
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
    .map((fragment) => normalizeCompoundFragment(fragment, dialect))
    .filter(Boolean);
}
