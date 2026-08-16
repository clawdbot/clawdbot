import { splitShellArgs } from "../utils/shell-argv.js";
import { lifecycleDynamicArgvMayHideLifecycle } from "./exec-approvals-lifecycle-env.js";
import {
  classifyOpenClawGatewayArgv,
  unresolvedGatewayMethodMayHideLifecycle,
} from "./exec-approvals-lifecycle-gateway.js";
import { unresolvedOpenClawNodeServiceActionMayMutate } from "./exec-approvals-lifecycle-node-service.js";
import { matchesOpenClawProcessPattern } from "./exec-approvals-lifecycle-patterns.js";
import {
  lifecycleExecutableCommandText,
  splitLifecycleInlineCommands,
  type LifecycleShellDialect,
} from "./exec-approvals-lifecycle-shell.js";
import { lifecycleBooleanOptionValueMayBeDynamic } from "./exec-approvals-lifecycle-tokens.js";
// Extracts shell command/process substitutions without treating quoted text as executable.
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "./shell-inline-command.js";
import { POSIX_PARSEABLE_SHELL_WRAPPERS } from "./shell-wrapper-resolution.js";

const MAX_SUBSTITUTION_DEPTH = 8;
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const DRY_RUN_OPTION = new Set(["--dry-run"]);

type ShellSubstitutionScan = {
  commands: string[];
  uncertain: boolean;
};

function findClosingParen(
  command: string,
  start: number,
  dialect: LifecycleShellDialect,
): number | null {
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
    if ((dialect === "posix" && char === "\\") || (dialect === "powershell" && char === "`")) {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === quote) {
        quote = null;
      }
      // Parentheses inside a quoted fragment do not close this outer
      // substitution. The complete fragment remains in the returned slice and
      // is recursively scanned for its own `$()` or backtick substitutions.
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

function extractAtDepth(
  command: string,
  depth: number,
  dialect: LifecycleShellDialect,
): ShellSubstitutionScan {
  const allowBacktickSubstitution = dialect === "posix";
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    return {
      commands: [],
      uncertain: (allowBacktickSubstitution ? /\$\(|[<>=]\(|`/u : /\$\(/u).test(command),
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
    if ((dialect === "posix" && char === "\\") || (dialect === "powershell" && char === "`")) {
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
    // Double quotes still execute `$()` (and POSIX backticks), so their content
    // intentionally falls through to the substitution scanner below.

    const next = command[index + 1] ?? "";
    const opensParenSubstitution =
      (dialect !== "cmd" && char === "$" && next === "(" && command[index + 2] !== "(") ||
      (dialect === "posix" && quote === null && ["<", ">", "="].includes(char) && next === "(");
    if (opensParenSubstitution) {
      const end = findClosingParen(command, index + 2, dialect);
      if (end !== null) {
        const nested = command.slice(index + 2, end).trim();
        if (nested) {
          const nestedScan = extractAtDepth(nested, depth + 1, dialect);
          extracted.push(nested, ...nestedScan.commands);
          uncertain ||= nestedScan.uncertain;
        }
        index = end;
      }
      continue;
    }
    if (allowBacktickSubstitution && char === "`") {
      const end = findClosingBacktick(command, index + 1);
      if (end !== null) {
        const nested = command.slice(index + 1, end).trim();
        if (nested) {
          const nestedScan = extractAtDepth(nested, depth + 1, dialect);
          extracted.push(nested, ...nestedScan.commands);
          uncertain ||= nestedScan.uncertain;
        }
        index = end;
      }
    }
  }
  return { commands: extracted, uncertain };
}

/** Return executable text nested in command or process substitutions for a shell dialect. */
export function extractShellSubstitutionCommands(
  command: string,
  dialect: LifecycleShellDialect = "posix",
): ShellSubstitutionScan {
  return extractAtDepth(lifecycleExecutableCommandText(command, dialect), 0, dialect);
}

/** Return true when a substitution selects an OpenClaw process for a later mutation. */
export function lifecycleSubstitutionSelectsOpenClawProcess(command: string): boolean {
  return extractShellSubstitutionCommands(command).commands.some((nested) =>
    splitLifecycleInlineCommands(nested).some((part) => {
      const argv = splitShellArgs(part);
      return (
        argv !== null &&
        ["pgrep", "pidof"].includes(normalizeExecutableToken(argv[0] ?? "")) &&
        argv.slice(1).some(matchesOpenClawProcessPattern)
      );
    }),
  );
}

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function scanFirstPositional(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
  standaloneOptions: ReadonlySet<string> = new Set(),
): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    const name = optionName(token);
    if (standaloneOptions.has(name)) {
      continue;
    }
    if (optionsWithValue.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
  }
  return argv.length;
}

function openClawSubstitutionMayHideLifecycle(
  argv: readonly string[],
  isSubstitution: (value: string | undefined) => boolean,
): boolean {
  const commandIndex = scanFirstPositional(argv, 1, OPENCLAW_GLOBAL_OPTIONS, OPENCLAW_GLOBAL_FLAGS);
  const command = (argv[commandIndex] ?? "").trim().toLowerCase();
  if (isSubstitution(argv[commandIndex])) {
    return true;
  }
  if (["daemon", "gateway"].includes(command)) {
    return (
      classifyOpenClawGatewayArgv(argv, commandIndex + 1) ||
      unresolvedGatewayMethodMayHideLifecycle(argv, commandIndex + 1, isSubstitution)
    );
  }
  if (command === "node") {
    return unresolvedOpenClawNodeServiceActionMayMutate(argv, commandIndex + 1, isSubstitution);
  }
  if (command === "uninstall") {
    return lifecycleBooleanOptionValueMayBeDynamic(
      argv,
      commandIndex + 1,
      DRY_RUN_OPTION,
      isSubstitution,
    );
  }
  return false;
}

/** Return true when substitution output can occupy a lifecycle-sensitive argv position. */
export function lifecycleSubstitutionResultMayHideLifecycle(
  argv: readonly string[],
  dialect: LifecycleShellDialect = "posix",
): boolean {
  const substitutionTokenRe =
    dialect === "posix" ? /\$\(|`|[<>=]\(/u : dialect === "powershell" ? /\$\(/u : /$a/u;
  const isSubstitution = (value: string | undefined): boolean =>
    substitutionTokenRe.test(value ?? "");
  const substitutionIndexes = argv.flatMap((token, index) =>
    isSubstitution(token) ? [index] : [],
  );
  if (substitutionIndexes.length === 0) {
    return false;
  }
  if (substitutionIndexes.includes(0)) {
    return true;
  }
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "openclaw" || executable.startsWith("openclaw@")) {
    return openClawSubstitutionMayHideLifecycle(argv, isSubstitution);
  }
  // kill signal-zero previews are handled by the process classifier after
  // substitution inspection; the shared dynamic scanner is deliberately
  // conservative for all other supported carriers and mutation commands.
  return executable !== "kill" && lifecycleDynamicArgvMayHideLifecycle(argv, isSubstitution);
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

const FUNCTION_POSITIONAL_REFERENCE_RE = /\$(?:[@*]|[0-9]+|\{(?:[@*]|[0-9]+)[^}]*\})/u;
const FUNCTION_DYNAMIC_EXECUTOR_RE =
  /(?:^|[;&|)])\s*(?:builtin|command|doas|env|exec|nohup|sudo)\b[^;&|]*\$(?:[@*]|[0-9]+|\{(?:[@*]|[0-9]+)[^}]*\})/u;
const FUNCTION_DIRECT_POSITIONAL_EXEC_RE =
  /(?:^|[;&|)])\s*["']?\$(?:[@*]|[0-9]+|\{(?:[@*]|[0-9]+)[^}]*\})["']?(?:\s|;|&|\|)/u;
const FUNCTION_OPENCLAW_POSITIONAL_RE =
  /(?:^|[;&|)])\s*(?:exec\s+)?(?:["']?[^;&|\s]*opencla(?:w|[?*])[^;&|\s]*["']?)[^;&|]*\$(?:[@*]|[0-9]+|\{(?:[@*]|[0-9]+)[^}]*\})/iu;

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Return true when an invoked shell function can route local positional argv to a lifecycle command. */
export function lifecycleFunctionLocalPositionalsRequireApproval(command: string): boolean {
  const definitionRe = /(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{([^{}]*)\}/gu;
  for (const match of command.matchAll(definitionRe)) {
    const name = match[1] ?? "";
    const body = match[2] ?? "";
    if (!name || !FUNCTION_POSITIONAL_REFERENCE_RE.test(body)) {
      continue;
    }
    const tail = command.slice((match.index ?? 0) + match[0].length);
    const invocationRe = new RegExp(
      String.raw`(?:^|[;&|}\n()]|(?:if|then|elif|while|until|do|else)\s+)\s*${escapedRegExp(name)}(?:\s|[;&|]|$)`,
      "u",
    );
    if (!invocationRe.test(tail)) {
      continue;
    }
    if (
      FUNCTION_DIRECT_POSITIONAL_EXEC_RE.test(body) ||
      FUNCTION_DYNAMIC_EXECUTOR_RE.test(body) ||
      FUNCTION_OPENCLAW_POSITIONAL_RE.test(body)
    ) {
      return true;
    }
  }
  return false;
}

/** Bind exact POSIX positional references for nested lifecycle classification. */
export function bindLifecyclePosixShellPositionals(
  argv: string[],
  positionalArgv: readonly string[],
): string[] {
  const bound: string[] = [];
  const arrayPositionals = positionalArgv.slice(1);
  for (const token of argv) {
    if (/^\$(?:@|\*|\{@\}|\{\*\})$/u.test(token)) {
      bound.push(...arrayPositionals);
      continue;
    }
    const replaced = token
      // Quote provenance is unavailable here. Joining embedded array
      // positionals deliberately over-approximates executable names such as
      // `open$@` so they cannot hide a lifecycle command.
      .replace(/\$(?:@|\*|\{@\}|\{\*\})/gu, arrayPositionals.join(""))
      .replace(
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
