import { splitShellArgs } from "../../utils/shell-argv.js";
import {
  COMMAND_CARRIER_EXECUTABLES,
  isEnvAssignmentToken,
  parseEnvInvocationPrelude,
  resolveCarrierCommandArgv,
  SOURCE_EXECUTABLES,
} from "../command-carriers.js";
import { unwrapKnownDispatchWrapperInvocation } from "../dispatch-wrapper-resolution.js";
import type { ExecCommandSegment } from "../exec-approvals-analysis.js";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "../shell-inline-command.js";
import {
  extractShellWrapperInlineCommand,
  isShellWrapperExecutable,
} from "../shell-wrapper-resolution.js";
import { detectInterpreterInlineEvalArgv, type InterpreterInlineEvalHit } from "./inline-eval.js";

export { COMMAND_CARRIER_EXECUTABLES, resolveCarrierCommandArgv, SOURCE_EXECUTABLES };

export type CommandCarrierHit = {
  command: string;
  flag?: string;
};

export type CarriedShellBuiltinHit = { kind: "eval" } | { kind: "source"; command: string };

function commandArgvKey(argv: readonly string[]): string {
  return argv.join("\0");
}

function isCommandCarrierExecutable(executable: string, options?: { includeExec?: boolean }) {
  return (
    COMMAND_CARRIER_EXECUTABLES.has(executable) ||
    Boolean(options?.includeExec && executable === "exec")
  );
}

export function buildCommandPayloadCandidates(
  argv: string[],
  seenArgv = new Set<string>(),
): string[] {
  const key = commandArgvKey(argv);
  if (seenArgv.has(key)) {
    return argv.length > 0 ? [argv.join(" ")] : [];
  }
  seenArgv.add(key);
  const assignmentStrippedArgv = stripLeadingEnvAssignments(argv);
  const carriedArgv = resolveCarrierCommandArgv(assignmentStrippedArgv, 0, {
    includeExec: true,
  });
  const executableArgv = carriedArgv ?? assignmentStrippedArgv;
  const carriedCandidates = carriedArgv ? buildCommandPayloadCandidates(carriedArgv, seenArgv) : [];
  const shellWrapperPayload = extractShellWrapperInlineCommand(executableArgv);
  const shellWrapperCandidates = shellWrapperPayload
    ? (() => {
        const innerArgv = splitShellArgs(shellWrapperPayload);
        return innerArgv
          ? buildCommandPayloadCandidates(innerArgv, seenArgv)
          : [shellWrapperPayload];
      })()
    : [];
  return uniqueCommandPayloadCandidates([
    ...(executableArgv.length > 0 ? [executableArgv.join(" ")] : []),
    ...carriedCandidates,
    ...shellWrapperCandidates,
  ]);
}

function stripLeadingEnvAssignments(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && isEnvAssignmentToken(argv[index] ?? "")) {
    index += 1;
  }
  return index > 0 ? argv.slice(index) : argv;
}

function uniqueCommandPayloadCandidates(candidates: string[]): string[] {
  return [...new Set(candidates.filter((candidate) => candidate.trim().length > 0))];
}

type ShellPositionalCarrierPlan = { kind: "all" } | { kind: "indexes"; indexes: number[] };

function normalizeShellPositionalToken(
  token: string,
): { kind: "all" | "star" | "zero" } | { kind: "index"; index: number } | null {
  const unquoted =
    token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
  const match = unquoted.match(/^\$(?:([0-9@*])|\{([0-9@*])\})$/u);
  const value = match?.[1] ?? match?.[2];
  if (value === undefined) {
    return null;
  }
  if (value === "@") {
    return { kind: "all" };
  }
  if (value === "*") {
    return { kind: "star" };
  }
  if (value === "0") {
    return { kind: "zero" };
  }
  return { kind: "index", index: Number.parseInt(value, 10) };
}

function resolveShellPositionalCarrierPlan(command: string): ShellPositionalCarrierPlan | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const shellWhitespace = String.raw`[^\S\r\n]+`;
  const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
  const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
  if (
    !new RegExp(
      `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`,
      "u",
    ).test(trimmed)
  ) {
    return null;
  }

  const tokens = trimmed.match(/"[^"]*"|\S+/gu) ?? [];
  let index = 0;
  if (tokens[index] === "exec") {
    index += 1;
    if (tokens[index] === "--") {
      index += 1;
    }
  }
  const zero = normalizeShellPositionalToken(tokens[index] ?? "");
  if (zero?.kind !== "zero") {
    return null;
  }
  index += 1;

  const indexes = [0];
  for (; index < tokens.length; index += 1) {
    const positional = normalizeShellPositionalToken(tokens[index] ?? "");
    if (positional === null || positional.kind === "zero" || positional.kind === "star") {
      return null;
    }
    if (positional.kind === "all") {
      return { kind: "all" };
    }
    if (positional.kind === "index") {
      indexes.push(positional.index);
    }
  }
  return { kind: "indexes", indexes };
}

function resolveShellPositionalCarrierArgv(params: {
  executableArgv: string[];
  valueTokenIndex: number;
  plan: ShellPositionalCarrierPlan;
}): string[] {
  const positionalArgv = params.executableArgv.slice(params.valueTokenIndex + 1);
  const carriedArgv =
    params.plan.kind === "all"
      ? positionalArgv
      : params.plan.indexes.map((index) => positionalArgv[index] ?? "");
  return carriedArgv.map((token) => token.trim()).filter((token) => token.length > 0);
}

function detectShellPositionalCarrierInlineEvalArgvInternal(
  argv: string[],
  seenArgv: Set<string>,
): InterpreterInlineEvalHit | null {
  const executableArgv = stripLeadingEnvAssignments(argv);
  const executable = normalizeExecutableToken(executableArgv[0] ?? "");
  if (!isShellWrapperExecutable(executable)) {
    return null;
  }
  if (!["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"].includes(executable)) {
    return null;
  }
  const key = commandArgvKey(executableArgv);
  if (seenArgv.has(key)) {
    return null;
  }
  seenArgv.add(key);

  const inlineMatch = resolveInlineCommandMatch(executableArgv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) {
    return null;
  }
  const carrierPlan = resolveShellPositionalCarrierPlan(inlineMatch.command);
  if (!carrierPlan) {
    return null;
  }

  const carriedArgv = resolveShellPositionalCarrierArgv({
    executableArgv,
    valueTokenIndex: inlineMatch.valueTokenIndex,
    plan: carrierPlan,
  });
  if (carriedArgv.length === 0) {
    return null;
  }

  return detectInlineEvalArgvInternal(carriedArgv, seenArgv);
}

function detectCarrierInlineEvalArgvInternal(
  argv: string[],
  seenArgv: Set<string>,
): InterpreterInlineEvalHit | null {
  const executableArgv = stripLeadingEnvAssignments(argv);
  const key = commandArgvKey(executableArgv);
  if (seenArgv.has(key)) {
    return null;
  }
  seenArgv.add(key);

  const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(executableArgv);
  if (dispatchUnwrap.kind === "unwrapped") {
    return detectInlineEvalArgvInternal(dispatchUnwrap.argv, seenArgv);
  }

  const executable = normalizeExecutableToken(executableArgv[0] ?? "");
  if (!isCommandCarrierExecutable(executable, { includeExec: true })) {
    return null;
  }
  const carriedArgv = resolveCarrierCommandArgv(executableArgv, 0, { includeExec: true });
  if (!carriedArgv) {
    return null;
  }
  return detectInlineEvalArgvInternal(carriedArgv, seenArgv);
}

export function detectCarrierInlineEvalArgv(argv: string[]): InterpreterInlineEvalHit | null {
  return detectCarrierInlineEvalArgvInternal(argv, new Set());
}

function detectInlineEvalArgvInternal(
  argv: string[] | undefined | null,
  seenArgv: Set<string>,
): InterpreterInlineEvalHit | null {
  if (!Array.isArray(argv)) {
    return null;
  }
  return (
    detectInterpreterInlineEvalArgv(argv) ??
    detectShellPositionalCarrierInlineEvalArgvInternal(argv, seenArgv) ??
    detectCarrierInlineEvalArgvInternal(argv, seenArgv)
  );
}

export function detectInlineEvalArgv(
  argv: string[] | undefined | null,
): InterpreterInlineEvalHit | null {
  return detectInlineEvalArgvInternal(argv, new Set());
}

export function detectInlineEvalInSegments(
  segments: readonly ExecCommandSegment[],
): InterpreterInlineEvalHit | null {
  for (const segment of segments) {
    const effective = segment.resolution?.effectiveArgv ?? segment.argv;
    const hit = detectInlineEvalArgv(effective) ?? detectInlineEvalArgv(segment.argv);
    if (hit) {
      return hit;
    }
  }
  return null;
}

export function detectCommandCarrierArgv(argv: string[]): CommandCarrierHit[] {
  const executable = argv[0];
  if (!executable) {
    return [];
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  const hits: CommandCarrierHit[] = [];
  if (normalizedExecutable === "find") {
    const flag = argv.find((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg));
    if (flag) {
      hits.push({ command: executable, flag });
    }
  }
  if (normalizedExecutable === "xargs") {
    hits.push({ command: normalizedExecutable });
  }
  const splitStringFlag = detectEnvSplitStringFlag(argv);
  if (splitStringFlag) {
    hits.push({ command: normalizedExecutable, flag: splitStringFlag });
  }
  return hits;
}

export function detectEnvSplitStringFlag(argv: string[]): string | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "env") {
    return null;
  }
  const parsed = parseEnvInvocationPrelude(argv);
  if (!parsed?.splitArgv) {
    return null;
  }
  for (const arg of argv.slice(1, parsed.commandIndex)) {
    const token = arg.trim();
    if (token === "-S" || token === "-s") {
      return token;
    }
    if (token === "--split-string") {
      return "--split-string";
    }
    if (token.startsWith("--split-string=") || (token.startsWith("-S") && token.length > 2)) {
      return token.startsWith("--") ? "--split-string" : "-S";
    }
    if (token.startsWith("-") && !token.startsWith("--")) {
      for (const option of token.slice(1)) {
        if (option === "S") {
          return "-S";
        }
        if (option === "s") {
          return "-s";
        }
      }
    }
  }
  return null;
}

export function detectShellWrapperThroughCarrierArgv(
  argv: string[],
  shellCommandFlag: (argv: string[], startIndex: number) => unknown,
): string | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!isCommandCarrierExecutable(executable, { includeExec: true })) {
    return null;
  }
  const carriedArgv = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
  if (!carriedArgv) {
    return null;
  }
  if (isShellWrapperExecutable(carriedArgv[0] ?? "") && shellCommandFlag(carriedArgv, 1)) {
    return executable;
  }
  return detectShellWrapperThroughCarrierArgv(carriedArgv, shellCommandFlag) ? executable : null;
}

export function detectCarriedShellBuiltinArgv(argv: string[]): CarriedShellBuiltinHit | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!isCommandCarrierExecutable(executable, { includeExec: true })) {
    return null;
  }
  const carriedArgv = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
  if (!carriedArgv) {
    return null;
  }
  const nestedCarrierHit = detectCarriedShellBuiltinArgv(carriedArgv);
  if (nestedCarrierHit) {
    return nestedCarrierHit;
  }
  const carriedCommand = carriedArgv[0];
  const normalizedCarriedCommand = carriedCommand
    ? normalizeExecutableToken(carriedCommand)
    : undefined;
  if (normalizedCarriedCommand === "eval") {
    return { kind: "eval" };
  }
  if (normalizedCarriedCommand && SOURCE_EXECUTABLES.has(normalizedCarriedCommand)) {
    return { kind: "source", command: normalizedCarriedCommand };
  }
  return null;
}
