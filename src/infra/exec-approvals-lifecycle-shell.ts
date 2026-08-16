// Splits compound shell text without treating quoted separators as commands.
import { splitShellArgs } from "../utils/shell-argv.js";

export type LifecycleShellDialect = "cmd" | "posix" | "powershell";

const POSIX_FUNCTION_DEFINITION_RE =
  /(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{((?:[^{}]|\$\{[^{}]*\})*)\}/gu;

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Remove function bodies that cannot execute because their function is never invoked. */
export function lifecycleExecutableCommandText(
  command: string,
  dialect: LifecycleShellDialect,
): string {
  if (dialect !== "posix") {
    return command;
  }
  return command.replace(POSIX_FUNCTION_DEFINITION_RE, (definition, name, _body, offset) => {
    const invocation = new RegExp(
      String.raw`(?:^|[;&|}\n()]|(?:if|then|elif|while|until|do|else)\s+)\s*${escapedRegExp(name)}(?:\s|[;&|]|$)`,
      "u",
    );
    const tail = command.slice(offset + definition.length);
    return invocation.test(tail) ? definition : " ".repeat(definition.length);
  });
}

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

function cmdLoopVariableOccupiesExecutable(argv: readonly string[], variable: string): boolean {
  let candidate = stripBraceTokens(argv);
  for (let depth = 0; candidate.length > 0 && depth < 8; depth += 1) {
    const executable = (candidate[0] ?? "").trim().toLowerCase().replace(/^@/u, "");
    if (executable.includes(variable)) {
      return true;
    }
    if (executable === "call") {
      candidate = stripBraceTokens(candidate.slice(1));
      continue;
    }
    if (executable === "cmd" && ["/c", "/k"].includes((candidate[1] ?? "").toLowerCase())) {
      candidate = stripBraceTokens(candidate.slice(2));
      continue;
    }
    return false;
  }
  return false;
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
  return Boolean(
    variable && cmdLoopVariableOccupiesExecutable(commandArgv, variable.trim().toLowerCase()),
  );
}

/** Return true when PowerShell calculates an invocation target for a lifecycle-shaped command. */
export function powerShellCalculatedInvocationRequiresApproval(command: string): boolean {
  const hasCalculatedTarget = /(?:^|[;|{\n\r])\s*[&.]\s*[$(@[{\]]/u.test(command);
  if (!hasCalculatedTarget) {
    return false;
  }
  return (
    /\b(?:approvals|config|configure|daemon|exec-approvals|exec-policy|gateway|hooks|node|onboard|plugins|reset|setup|uninstall|update)\b/iu.test(
      command,
    ) ||
    /(?:^|[;|{\n\r])\s*[&.]\s*(?:\([^)]*\)|[$@]\S+|\[[^\]]*\]\S*|\{[^}]*\})\s+[[$@({]/u.test(
      command,
    )
  );
}

function resolvePosixBindingArgv(
  name: string,
  bindings: ReadonlyMap<string, string>,
): string[] | null {
  let target = bindings.get(name);
  const seen = new Set([name]);
  for (let depth = 0; target && depth < 8; depth += 1) {
    const targetArgv = splitShellArgs(target) ?? [target];
    const nestedName = (targetArgv[0] ?? "").trim();
    if (!bindings.has(nestedName)) {
      return targetArgv;
    }
    if (seen.has(nestedName)) {
      return null;
    }
    seen.add(nestedName);
    const nestedTarget = bindings.get(nestedName) ?? "";
    target = [nestedTarget, ...targetArgv.slice(1)].join(" ");
  }
  return null;
}

function unwrapPosixBindingPrefixArgv(argv: string[]): string[] {
  let current = stripLifecyclePosixAssignments(argv) ?? argv;
  for (let depth = 0; depth < 8; depth += 1) {
    const prefix = (current[0] ?? "").trim().toLowerCase();
    if (!["builtin", "command"].includes(prefix)) {
      return current;
    }
    let executableIndex = 1;
    for (; executableIndex < current.length; executableIndex += 1) {
      const option = (current[executableIndex] ?? "").trim().toLowerCase();
      if (option === "--") {
        executableIndex += 1;
        break;
      }
      if (prefix === "command" && option === "-p") {
        continue;
      }
      if (option.startsWith("-")) {
        return [];
      }
      break;
    }
    current = current.slice(executableIndex);
  }
  return [];
}

/** Track POSIX alias and Bash hash bindings across compound command fragments. */
export function posixCommandBindingRequiresApproval(
  command: string,
  classify: (argv: string[], raw: string) => boolean,
): boolean {
  const aliasBindings = new Map<string, string>();
  const hashBindings = new Map<string, string>();
  const unresolvedAliases = new Set<string>();
  const unresolvedHashes = new Set<string>();
  for (const fragment of splitLifecycleCommandText(
    lifecycleExecutableCommandText(command, "posix"),
    new Set([";", "|", "&", "\n", "\r"]),
    "posix",
  )) {
    const argv = unwrapPosixBindingPrefixArgv(
      splitShellArgs(normalizeCompoundFragment(fragment, "posix")) ?? [],
    );
    if (!argv?.length) {
      continue;
    }
    const executable = (argv[0] ?? "").trim().toLowerCase();
    if (executable === "alias") {
      for (const assignment of argv.slice(1)) {
        const separator = assignment.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const name = assignment.slice(0, separator);
        const target = assignment.slice(separator + 1);
        aliasBindings.delete(name);
        unresolvedAliases.delete(name);
        if (/[$`()]/u.test(target)) {
          unresolvedAliases.add(name);
        } else {
          aliasBindings.set(name, target);
        }
      }
      continue;
    }
    if (executable === "unalias") {
      argv
        .slice(1)
        .filter((token) => !token.startsWith("-"))
        .forEach((name) => {
          aliasBindings.delete(name);
          unresolvedAliases.delete(name);
        });
      continue;
    }
    if (executable === "hash") {
      if (argv.includes("-r")) {
        hashBindings.clear();
        unresolvedHashes.clear();
      }
      const deleteIndex = argv.indexOf("-d");
      if (deleteIndex !== -1) {
        const name = argv[deleteIndex + 1] ?? "";
        hashBindings.delete(name);
        unresolvedHashes.delete(name);
      }
      const pathIndex = argv.indexOf("-p");
      if (pathIndex !== -1) {
        const target = argv[pathIndex + 1] ?? "";
        const name = argv[pathIndex + 2] ?? "";
        if (name) {
          hashBindings.delete(name);
          unresolvedHashes.delete(name);
          if (/[$`()]/u.test(target)) {
            unresolvedHashes.add(name);
          } else {
            hashBindings.set(name, target);
          }
        }
      }
      continue;
    }
    const bindings = new Map([...hashBindings, ...aliasBindings]);
    const bindingArgv = resolvePosixBindingArgv(executable, bindings);
    const resolvedArgv = bindingArgv ? [...bindingArgv, ...argv.slice(1)] : null;
    if (
      (resolvedArgv && classify(resolvedArgv, resolvedArgv.join(" "))) ||
      ((unresolvedAliases.has(executable) || unresolvedHashes.has(executable)) &&
        classify(["openclaw", ...argv.slice(1)], ["openclaw", ...argv.slice(1)].join(" ")))
    ) {
      return true;
    }
  }
  return false;
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
  const executableText = lifecycleExecutableCommandText(command, dialect);
  return splitLifecycleCommandText(executableText, new Set([";", "|", "&", "\n", "\r"]), dialect)
    .map((fragment) => normalizeCompoundFragment(fragment, dialect))
    .filter(Boolean);
}
