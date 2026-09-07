/** Detects mutable file operands in approved commands. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import { splitShellArgs } from "../utils/shell-argv.js";
import { detectPolicyInlineEval } from "./command-analysis/policy.js";
import { isInterpreterLikeSafeBin } from "./exec-safe-bin-runtime-policy.js";
import {
  POSIX_PARSEABLE_SHELL_WRAPPERS,
  POSIX_SHELL_WRAPPERS,
  normalizeExecutableToken,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";
import { parseInlineOptionToken } from "./inline-option-token.js";
import {
  normalizePackageManagerExecToken,
  PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE,
  PNPM_DLX_OPTIONS_WITH_VALUE,
  PNPM_FLAG_OPTIONS,
  PNPM_OPTIONS_WITH_VALUE,
  unwrapKnownPackageManagerExecInvocation,
} from "./package-manager-exec-wrapper.js";
import {
  BUN_OPTIONS_WITH_VALUE,
  BUN_SUBCOMMANDS,
  DENO_RUN_OPTIONS_WITH_VALUE,
  NODE_OPTIONS_WITH_FILE_VALUE,
  PERL_UNSAFE_APPROVAL_FLAGS,
  RUBY_UNSAFE_APPROVAL_FLAGS,
} from "./system-run-mutable-file-options.js";
import {
  isLikelyScriptLikePathSync,
  looksLikeExplicitPathToken,
  looksLikePathToken,
  pathLooksMutableForShellPayloadSync,
  resolvesToExistingFileSync,
} from "./system-run-mutable-file-policy.js";
import { hasUnbindableRuntimeApprovalOption } from "./system-run-runtime-file-options.js";
import {
  hasPosixShellCodeLoadingOption,
  hasPosixShellStartupEnvironment,
  resolvePosixShellScriptOperandIndex,
} from "./system-run-shell-file-operand.js";

const POSIX_SHELL_WRAPPER_SET: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;
const POSIX_PARSEABLE_SHELL_WRAPPER_SET: ReadonlySet<string> = POSIX_PARSEABLE_SHELL_WRAPPERS;
const PACKAGE_MANAGER_EXECUTABLES = new Set(["corepack", "npm", "npx", "pnpm", "yarn"]);

const MUTABLE_ARGV1_INTERPRETER_PATTERNS = [
  /^(?:node|nodejs)$/,
  /^perl$/,
  /^php$/,
  /^python(?:\d+(?:\.\d+)*)?$/,
  /^ruby$/,
] as const;

const GENERIC_MUTABLE_SCRIPT_RUNNERS = new Set([
  "esno",
  "jiti",
  "ts-node",
  "ts-node-esm",
  "tsx",
  "vite-node",
]);

const OPAQUE_MUTABLE_SCRIPT_RUNNERS = new Set(["busybox", "toybox"]);

function readTrimmedArgToken(argv: readonly string[], index: number): string {
  return normalizeNullableString(argv[index]) ?? "";
}

type FileOperandCollection = {
  hits: number[];
  sawOptionValueFile: boolean;
};

function unwrapArgvForMutableOperand(argv: string[]): {
  argv: string[];
  baseIndex: number;
  opaqueMultiplexerSeen: boolean;
} {
  let current = argv;
  let baseIndex = 0;
  let opaqueMultiplexerSeen = false;
  while (true) {
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(current);
    if (dispatchUnwrap.kind === "unwrapped") {
      baseIndex += current.length - dispatchUnwrap.argv.length;
      current = dispatchUnwrap.argv;
      continue;
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(current);
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
      if (OPAQUE_MUTABLE_SCRIPT_RUNNERS.has(shellMultiplexerUnwrap.wrapper)) {
        opaqueMultiplexerSeen = true;
      }
      baseIndex += current.length - shellMultiplexerUnwrap.argv.length;
      current = shellMultiplexerUnwrap.argv;
      continue;
    }
    const packageManagerUnwrap = unwrapKnownPackageManagerExecInvocation(current);
    if (packageManagerUnwrap) {
      baseIndex += current.length - packageManagerUnwrap.length;
      current = packageManagerUnwrap;
      continue;
    }
    return { argv: current, baseIndex, opaqueMultiplexerSeen };
  }
}

function hasDispatchCwdOption(argv: string[]): boolean {
  if (normalizeExecutableToken(argv[0] ?? "") !== "env") {
    return false;
  }
  for (const token of argv.slice(1)) {
    const normalized = token.trim().toLowerCase();
    if (
      normalized === "-c" ||
      normalized.startsWith("-c=") ||
      normalized === "--chdir" ||
      normalized.startsWith("--chdir=")
    ) {
      return true;
    }
    if (!normalized.startsWith("-") && !normalized.includes("=")) {
      return false;
    }
  }
  return false;
}

export function unwrapSystemRunMutableFileOperandArgv(argv: string[]): string[] {
  return unwrapArgvForMutableOperand(argv).argv;
}

function resolveOptionFilteredFileOperandIndex(params: {
  argv: string[];
  startIndex: number;
  cwd: string | undefined;
  optionsWithValue?: ReadonlySet<string>;
}): number | null {
  let afterDoubleDash = false;
  for (let i = params.startIndex; i < params.argv.length; i += 1) {
    const token = readTrimmedArgToken(params.argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return resolvesToExistingFileSync(token, params.cwd) ? i : null;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-") {
      return null;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && params.optionsWithValue?.has(token)) {
        i += 1;
      }
      continue;
    }
    return resolvesToExistingFileSync(token, params.cwd) ? i : null;
  }
  return null;
}

function resolveOptionFilteredPositionalIndex(params: {
  argv: string[];
  startIndex: number;
  optionsWithValue?: ReadonlySet<string>;
}): number | null {
  let afterDoubleDash = false;
  for (let i = params.startIndex; i < params.argv.length; i += 1) {
    const token = readTrimmedArgToken(params.argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return i;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-") {
      return null;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && params.optionsWithValue?.has(token)) {
        i += 1;
      }
      continue;
    }
    return i;
  }
  return null;
}

function collectExistingFileOperandIndexes(params: {
  argv: string[];
  startIndex: number;
  cwd: string | undefined;
  optionsWithFileValue?: ReadonlySet<string>;
}): FileOperandCollection {
  let afterDoubleDash = false;
  const hits: number[] = [];
  for (let i = params.startIndex; i < params.argv.length; i += 1) {
    const token = readTrimmedArgToken(params.argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      if (resolvesToExistingFileSync(token, params.cwd)) {
        hits.push(i);
      }
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-") {
      return { hits: [], sawOptionValueFile: false };
    }
    if (token.startsWith("-")) {
      const option = parseInlineOptionToken(token);
      const flag = option.name;
      const inlineValue = option.hasInlineValue ? option.inlineValue : undefined;
      if (params.optionsWithFileValue?.has(normalizeLowercaseStringOrEmpty(flag))) {
        if (inlineValue && resolvesToExistingFileSync(inlineValue, params.cwd)) {
          hits.push(i);
          return { hits, sawOptionValueFile: true };
        }
        const nextToken = readTrimmedArgToken(params.argv, i + 1);
        if (!inlineValue && nextToken && resolvesToExistingFileSync(nextToken, params.cwd)) {
          hits.push(i + 1);
          return { hits, sawOptionValueFile: true };
        }
      }
      continue;
    }
    if (resolvesToExistingFileSync(token, params.cwd)) {
      hits.push(i);
    }
  }
  return { hits, sawOptionValueFile: false };
}

function resolveGenericInterpreterScriptOperandIndex(params: {
  argv: string[];
  cwd: string | undefined;
  optionsWithFileValue?: ReadonlySet<string>;
}): number | null {
  const collection = collectExistingFileOperandIndexes({
    argv: params.argv,
    startIndex: 1,
    cwd: params.cwd,
    optionsWithFileValue: params.optionsWithFileValue,
  });
  if (collection.sawOptionValueFile) {
    return null;
  }
  return collection.hits.length === 1 ? expectDefined(collection.hits[0], "hits entry at 0") : null;
}

function resolveBunScriptOperandIndex(params: {
  argv: string[];
  cwd: string | undefined;
}): number | null {
  const directIndex = resolveOptionFilteredPositionalIndex({
    argv: params.argv,
    startIndex: 1,
    optionsWithValue: BUN_OPTIONS_WITH_VALUE,
  });
  if (directIndex === null) {
    return null;
  }
  const directToken = readTrimmedArgToken(params.argv, directIndex);
  if (directToken === "run") {
    return resolveOptionFilteredFileOperandIndex({
      argv: params.argv,
      startIndex: directIndex + 1,
      cwd: params.cwd,
      optionsWithValue: BUN_OPTIONS_WITH_VALUE,
    });
  }
  if (BUN_SUBCOMMANDS.has(directToken)) {
    return null;
  }
  if (!looksLikePathToken(directToken)) {
    return null;
  }
  return directIndex;
}

function resolveDenoRunScriptOperandIndex(params: {
  argv: string[];
  cwd: string | undefined;
}): number | null {
  if (readTrimmedArgToken(params.argv, 1) !== "run") {
    return null;
  }
  return resolveOptionFilteredFileOperandIndex({
    argv: params.argv,
    startIndex: 2,
    cwd: params.cwd,
    optionsWithValue: DENO_RUN_OPTIONS_WITH_VALUE,
  });
}

function hasRubyUnsafeApprovalFlag(argv: string[]): boolean {
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = readTrimmedArgToken(argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return false;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (
      token === "-C" ||
      token === "-I" ||
      token === "-r" ||
      token === "-S" ||
      token === "--chdir"
    ) {
      return true;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-I") ||
      token.startsWith("-r") ||
      token.startsWith("--chdir=") ||
      token.startsWith("--require=")
    ) {
      return true;
    }
    if (RUBY_UNSAFE_APPROVAL_FLAGS.has(normalizeLowercaseStringOrEmpty(token))) {
      return true;
    }
  }
  return false;
}

function hasPerlUnsafeApprovalFlag(argv: string[]): boolean {
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = readTrimmedArgToken(argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return false;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-I" || token === "-M" || token === "-m" || token === "-S") {
      return true;
    }
    if (token.startsWith("-I") || token.startsWith("-M") || token.startsWith("-m")) {
      return true;
    }
    if (PERL_UNSAFE_APPROVAL_FLAGS.has(token)) {
      return true;
    }
  }
  return false;
}

function hasNodeFileLoadingOption(argv: string[]): boolean {
  return argv.slice(1).some((token) => {
    const normalized = token.trim().toLowerCase();
    if (normalized === "-r" || normalized.startsWith("-r")) {
      return true;
    }
    return [...NODE_OPTIONS_WITH_FILE_VALUE].some(
      (flag) => normalized === flag || normalized.startsWith(`${flag}=`),
    );
  });
}

export function isSystemRunCommandTextBoundInterpreterInvocation(argv: string[]): boolean {
  const unwrapped = unwrapArgvForMutableOperand(argv);
  const executable = normalizeExecutableToken(unwrapped.argv[0] ?? "");
  if (POSIX_SHELL_WRAPPER_SET.has(executable)) {
    return false;
  }
  if (
    (executable === "node" || executable === "nodejs") &&
    hasNodeFileLoadingOption(unwrapped.argv)
  ) {
    return false;
  }
  if (
    (executable === "ruby" && hasRubyUnsafeApprovalFlag(unwrapped.argv)) ||
    (executable === "perl" && hasPerlUnsafeApprovalFlag(unwrapped.argv))
  ) {
    return false;
  }
  if (
    detectPolicyInlineEval([
      {
        raw: unwrapped.argv.join(" "),
        argv: unwrapped.argv,
        resolution: null,
      },
    ])
  ) {
    return true;
  }
  return (
    unwrapped.argv.length === 2 &&
    ["--help", "--version", "-h", "-v"].includes(unwrapped.argv[1]?.trim().toLowerCase() ?? "")
  );
}

function isMutableScriptRunner(executable: string): boolean {
  return (
    GENERIC_MUTABLE_SCRIPT_RUNNERS.has(executable) ||
    OPAQUE_MUTABLE_SCRIPT_RUNNERS.has(executable) ||
    isInterpreterLikeSafeBin(executable)
  );
}

function resolveDirectScriptExecutableIndex(params: {
  argv: string[];
  cwd: string | undefined;
}): number | null {
  const unwrapped = unwrapArgvForMutableOperand(params.argv);
  const executable = readTrimmedArgToken(unwrapped.argv, 0);
  if (
    PACKAGE_MANAGER_EXECUTABLES.has(normalizeExecutableToken(executable)) ||
    !looksLikeExplicitPathToken(executable) ||
    !resolvesToExistingFileSync(executable, params.cwd)
  ) {
    return null;
  }
  const resolvedPath = path.resolve(params.cwd ?? process.cwd(), executable);
  return pathLooksMutableForShellPayloadSync(resolvedPath) ? unwrapped.baseIndex : null;
}

function resolveMutableFileOperandIndex(argv: string[], cwd: string | undefined): number | null {
  const unwrapped = unwrapArgvForMutableOperand(argv);
  const executable = normalizeExecutableToken(unwrapped.argv[0] ?? "");
  if (!executable) {
    return null;
  }
  if (unwrapped.opaqueMultiplexerSeen || OPAQUE_MUTABLE_SCRIPT_RUNNERS.has(executable)) {
    return null;
  }
  if (POSIX_SHELL_WRAPPER_SET.has(executable)) {
    if (!POSIX_PARSEABLE_SHELL_WRAPPER_SET.has(executable)) {
      return null;
    }
    const shellIndex = resolvePosixShellScriptOperandIndex(unwrapped.argv, executable);
    return shellIndex === null ? null : unwrapped.baseIndex + shellIndex;
  }
  if (MUTABLE_ARGV1_INTERPRETER_PATTERNS.some((pattern) => pattern.test(executable))) {
    const operand = readTrimmedArgToken(unwrapped.argv, 1);
    if (operand && operand !== "-" && !operand.startsWith("-")) {
      return unwrapped.baseIndex + 1;
    }
  }
  if (executable === "bun") {
    const bunIndex = resolveBunScriptOperandIndex({
      argv: unwrapped.argv,
      cwd,
    });
    if (bunIndex !== null) {
      return unwrapped.baseIndex + bunIndex;
    }
  }
  if (executable === "deno") {
    const denoIndex = resolveDenoRunScriptOperandIndex({
      argv: unwrapped.argv,
      cwd,
    });
    if (denoIndex !== null) {
      return unwrapped.baseIndex + denoIndex;
    }
  }
  if (executable === "ruby" && hasRubyUnsafeApprovalFlag(unwrapped.argv)) {
    return null;
  }
  if (executable === "perl" && hasPerlUnsafeApprovalFlag(unwrapped.argv)) {
    return null;
  }
  if (!isMutableScriptRunner(executable)) {
    return resolveDirectScriptExecutableIndex({ argv, cwd });
  }
  const genericIndex = resolveGenericInterpreterScriptOperandIndex({
    argv: unwrapped.argv,
    cwd,
    optionsWithFileValue:
      executable === "node" || executable === "nodejs" ? NODE_OPTIONS_WITH_FILE_VALUE : undefined,
  });
  return genericIndex === null ? null : unwrapped.baseIndex + genericIndex;
}

function shellPayloadNeedsStableBinding(shellCommand: string, cwd: string | undefined): boolean {
  if (/[;&|<>]/u.test(shellCommand)) {
    return true;
  }
  const argv = splitShellArgs(shellCommand);
  if (!argv || argv.length === 0) {
    return false;
  }
  if (
    resolveMutableFileOperandIndex(argv, cwd) !== null ||
    requiresStableInterpreterApprovalBindingWithShellCommand({
      argv,
      cwd,
      shellCommand: null,
    })
  ) {
    return true;
  }
  const firstToken = readTrimmedArgToken(argv, 0);
  if (firstToken === "." || firstToken === "source") {
    return true;
  }
  if (!resolvesToExistingFileSync(firstToken, cwd)) {
    return false;
  }
  if (!path.isAbsolute(firstToken)) {
    return true;
  }
  const resolvedPath = path.resolve(cwd ?? process.cwd(), firstToken);
  if (pathLooksMutableForShellPayloadSync(resolvedPath)) {
    return true;
  }
  return isLikelyScriptLikePathSync(resolvedPath);
}

function requiresStableInterpreterApprovalBindingWithShellCommand(params: {
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}): boolean {
  const unwrapped = unwrapArgvForMutableOperand(params.argv);
  if (unwrapped.opaqueMultiplexerSeen) {
    return true;
  }
  if (params.shellCommand !== null) {
    return shellPayloadNeedsStableBinding(params.shellCommand, params.cwd);
  }
  if (pnpmDlxInvocationNeedsFailClosedBinding(params.argv, params.cwd)) {
    return true;
  }
  const directExecutable = readTrimmedArgToken(unwrapped.argv, 0);
  if (
    looksLikeExplicitPathToken(directExecutable) &&
    !resolvesToExistingFileSync(directExecutable, params.cwd)
  ) {
    return true;
  }
  const executable = normalizeExecutableToken(unwrapped.argv[0] ?? "");
  return (
    Boolean(executable) &&
    !POSIX_SHELL_WRAPPER_SET.has(executable) &&
    isMutableScriptRunner(executable)
  );
}

function pnpmDlxInvocationNeedsFailClosedBinding(argv: string[], cwd: string | undefined): boolean {
  if (normalizePackageManagerExecToken(argv[0] ?? "") !== "pnpm") {
    return false;
  }

  let idx = 1;
  while (idx < argv.length) {
    const token = readTrimmedArgToken(argv, idx);
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (token !== "dlx") {
        return false;
      }
      return pnpmDlxTailNeedsFailClosedBinding(argv.slice(idx + 1), cwd);
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (PNPM_OPTIONS_WITH_VALUE.has(flag) || PNPM_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return true;
  }

  return false;
}

function pnpmDlxTailNeedsFailClosedBinding(argv: string[], cwd: string | undefined): boolean {
  let idx = 0;
  while (idx < argv.length) {
    const token = readTrimmedArgToken(argv, idx);
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      return pnpmDlxTailMayNeedStableBinding(argv.slice(idx + 1), cwd);
    }
    if (!token.startsWith("-")) {
      return pnpmDlxTailMayNeedStableBinding(argv.slice(idx), cwd);
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (flag === "-c" || flag === "--shell-mode") {
      return false;
    }
    if (PNPM_OPTIONS_WITH_VALUE.has(flag) || PNPM_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return true;
  }

  return true;
}

function pnpmDlxTailMayNeedStableBinding(argv: string[], cwd: string | undefined): boolean {
  return resolveMutableFileOperandIndex(argv, cwd) !== null;
}

export function resolveSystemRunMutableFileOperandTarget(params: {
  argv: string[];
  cwd: string | undefined;
  shellCommand: string | null;
}): { ok: true; argvIndex: number | null } | { ok: false; message: string } {
  if (hasDispatchCwdOption(params.argv)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind dispatch cwd options",
    };
  }
  const unwrapped = unwrapArgvForMutableOperand(params.argv);
  if (
    hasPosixShellCodeLoadingOption(
      unwrapped.argv,
      normalizeExecutableToken(unwrapped.argv[0] ?? ""),
    )
  ) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup files",
    };
  }
  if (
    hasPosixShellStartupEnvironment({
      argv: params.argv,
      executable: normalizeExecutableToken(unwrapped.argv[0] ?? ""),
      env: process.env,
    })
  ) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup environment",
    };
  }
  if (
    hasUnbindableRuntimeApprovalOption({
      argv: unwrapped.argv,
      executable: normalizeExecutableToken(unwrapped.argv[0] ?? ""),
    })
  ) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind runtime code-loading or cwd options",
    };
  }
  const argvIndex = resolveMutableFileOperandIndex(params.argv, params.cwd);
  if (argvIndex === null) {
    if (
      requiresStableInterpreterApprovalBindingWithShellCommand({
        argv: params.argv,
        shellCommand: params.shellCommand,
        cwd: params.cwd,
      })
    ) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      };
    }
    return { ok: true, argvIndex: null };
  }
  const rawOperand = readTrimmedArgToken(params.argv, argvIndex);
  if (!rawOperand) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable script operand",
    };
  }
  return { ok: true, argvIndex };
}
