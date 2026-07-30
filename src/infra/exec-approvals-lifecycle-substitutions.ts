// Extracts shell command/process substitutions without treating quoted text as executable.
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "./shell-inline-command.js";
import { POSIX_PARSEABLE_SHELL_WRAPPERS } from "./shell-wrapper-resolution.js";

const MAX_SUBSTITUTION_DEPTH = 8;
const SUBSTITUTION_RESULT_SENSITIVE_EXECUTABLES = new Set([
  "ash",
  "bash",
  "bunx",
  "doas",
  "env",
  "fish",
  "ksh",
  "launchctl",
  "net",
  "node",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "pwsh",
  "sc",
  "schtasks",
  "service",
  "sh",
  "sudo",
  "systemctl",
  "taskkill",
  "xargs",
  "yarn",
  "zsh",
]);
const LIFECYCLE_MUTATION_HINT_RE =
  /\b(?:daemon|gateway|install|kill|remove|restart|rm|start|stop|uninstall|update)\b/iu;
const SUBSTITUTION_TOKEN_RE = /\$\(|`|[<>=]\(/u;

export type ShellSubstitutionScan = {
  commands: string[];
  uncertain: boolean;
};

function findClosingParen(command: string, start: number): number | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
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
    if (char === "\\") {
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

function extractAtDepth(command: string, depth: number): ShellSubstitutionScan {
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    return {
      commands: [],
      uncertain: /\$\(|[<>=]\(|`/u.test(command),
    };
  }
  const extracted: string[] = [];
  let uncertain = false;
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
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    // Double quotes still execute `$()` and backticks, so their content must
    // intentionally fall through to the substitution scanner below.

    const next = command[index + 1] ?? "";
    const opensParenSubstitution =
      (char === "$" && next === "(" && command[index + 2] !== "(") ||
      (quote === null && ["<", ">", "="].includes(char) && next === "(");
    if (opensParenSubstitution) {
      const end = findClosingParen(command, index + 2);
      if (end !== null) {
        const nested = command.slice(index + 2, end).trim();
        if (nested) {
          const nestedScan = extractAtDepth(nested, depth + 1);
          extracted.push(nested, ...nestedScan.commands);
          uncertain ||= nestedScan.uncertain;
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
          const nestedScan = extractAtDepth(nested, depth + 1);
          extracted.push(nested, ...nestedScan.commands);
          uncertain ||= nestedScan.uncertain;
        }
        index = end;
      }
    }
  }
  return { commands: extracted, uncertain };
}

/** Return executable text nested in POSIX-style command or process substitutions. */
export function extractShellSubstitutionCommands(command: string): ShellSubstitutionScan {
  return extractAtDepth(command, 0);
}

/** Return true when substitution output can occupy a lifecycle-sensitive argv position. */
export function lifecycleSubstitutionResultMayHideLifecycle(argv: readonly string[]): boolean {
  const substitutionIndexes = argv.flatMap((token, index) =>
    SUBSTITUTION_TOKEN_RE.test(token) ? [index] : [],
  );
  if (substitutionIndexes.length === 0) {
    return false;
  }
  if (substitutionIndexes.includes(0)) {
    return true;
  }
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "openclaw" || executable.startsWith("openclaw@")) {
    return true;
  }
  if (!SUBSTITUTION_RESULT_SENSITIVE_EXECUTABLES.has(executable)) {
    return false;
  }
  const text = argv.join(" ").replace(/\[([a-z0-9])\]/giu, "$1");
  return /opencla(?:w|[?*])/iu.test(text) || LIFECYCLE_MUTATION_HINT_RE.test(text);
}

/** Return POSIX shell argv bound as $0, $1, ... after an inline command. */
export function resolveLifecyclePosixShellPositionals(argv: string[]): readonly string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!POSIX_PARSEABLE_SHELL_WRAPPERS.has(executable)) {
    return null;
  }
  const inlineMatch = resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  return inlineMatch.valueTokenIndex === null ? null : argv.slice(inlineMatch.valueTokenIndex + 1);
}

/** Return true when lost quote provenance makes positional field splitting ambiguous. */
export function lifecyclePositionalBindingRequiresApproval(
  command: string,
  positionalArgv: readonly string[],
): boolean {
  if (/\$\{(?:[0-9]+|[@*])[^0-9}][^}]*\}/u.test(command)) {
    return true;
  }
  if (
    /\$(?:[@*]|\{[@*]\})/u.test(command) &&
    positionalArgv.slice(1).some((token) => /\s/u.test(token))
  ) {
    return true;
  }
  const referencedIndexes = [...command.matchAll(/\$(?:\{([0-9]+)\}|([0-9]+))/gu)].map((match) =>
    Number.parseInt(match[1] ?? match[2] ?? "", 10),
  );
  return referencedIndexes.some(
    (index) => Number.isSafeInteger(index) && /\s/u.test(positionalArgv[index] ?? ""),
  );
}

/** Bind exact POSIX positional references for nested lifecycle classification. */
export function bindLifecyclePosixShellPositionals(
  argv: string[],
  positionalArgv: readonly string[],
): string[] {
  const bound: string[] = [];
  for (const token of argv) {
    if (/^\$(?:@|\*|\{@\}|\{\*\})$/u.test(token)) {
      bound.push(...positionalArgv.slice(1));
      continue;
    }
    const replaced = token.replace(
      /\$(?:\{([0-9]+)\}|([0-9]+))/gu,
      (_match, bracedIndex: string | undefined, bareIndex: string | undefined) => {
        const index = Number.parseInt(bracedIndex ?? bareIndex ?? "", 10);
        return Number.isSafeInteger(index) ? (positionalArgv[index] ?? "") : "";
      },
    );
    if (replaced) {
      bound.push(replaced);
    }
  }
  return bound;
}
