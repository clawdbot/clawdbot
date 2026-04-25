import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import {
  resolveExecutablePath as resolveExecutableCandidatePath,
  resolveExecutablePathCandidate,
} from "./executable-path.js";

export type ExecutableResolution = {
  rawExecutable: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
  executableName: string;
};

export type CommandResolution = {
  execution: ExecutableResolution;
  policy: ExecutableResolution;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
};

function isCommandResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): resolution is CommandResolution {
  return Boolean(resolution && "execution" in resolution && "policy" in resolution);
}

function parseFirstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1);
    if (end > 1) {
      return trimmed.slice(1, end);
    }
    return trimmed.slice(1);
  }
  const match = /^[^\s]+/.exec(trimmed);
  return match ? match[0] : null;
}

function tryResolveRealpath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function buildExecutableResolution(
  rawExecutable: string,
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): ExecutableResolution {
  const resolvedPath = resolveExecutableCandidatePath(rawExecutable, {
    cwd: params.cwd,
    env: params.env,
  });
  const resolvedRealPath = tryResolveRealpath(resolvedPath);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return {
    rawExecutable,
    resolvedPath,
    resolvedRealPath,
    executableName,
  };
}

function buildCommandResolution(params: {
  rawExecutable: string;
  policyRawExecutable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  effectiveArgv: string[];
  wrapperChain: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
}): CommandResolution {
  const execution = buildExecutableResolution(params.rawExecutable, params);
  const policy = params.policyRawExecutable
    ? buildExecutableResolution(params.policyRawExecutable, params)
    : execution;
  const resolution: CommandResolution = {
    execution,
    policy,
    effectiveArgv: params.effectiveArgv,
    wrapperChain: params.wrapperChain,
    policyBlocked: params.policyBlocked,
    blockedWrapper: params.blockedWrapper,
  };
  // Compatibility getters for JS/tests while TS callers migrate to explicit targets.
  return Object.defineProperties(resolution, {
    rawExecutable: {
      get: () => execution.rawExecutable,
    },
    resolvedPath: {
      get: () => execution.resolvedPath,
    },
    resolvedRealPath: {
      get: () => execution.resolvedRealPath,
    },
    executableName: {
      get: () => execution.executableName,
    },
    policyResolution: {
      get: () => (policy === execution ? undefined : policy),
    },
  });
}

export function resolveCommandResolution(
  command: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const rawExecutable = parseFirstToken(command);
  if (!rawExecutable) {
    return null;
  }
  return buildCommandResolution({
    rawExecutable,
    effectiveArgv: [rawExecutable],
    wrapperChain: [],
    policyBlocked: false,
    cwd,
    env,
  });
}

export function resolveCommandResolutionFromArgv(
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const plan = resolveExecWrapperTrustPlan(argv);
  const effectiveArgv = plan.argv;
  const rawExecutable = effectiveArgv[0]?.trim();
  if (!rawExecutable) {
    return null;
  }
  return buildCommandResolution({
    rawExecutable,
    policyRawExecutable: plan.policyArgv[0]?.trim(),
    effectiveArgv,
    wrapperChain: plan.wrapperChain,
    policyBlocked: plan.policyBlocked,
    blockedWrapper: plan.blockedWrapper,
    cwd,
    env,
  });
}

function resolveExecutableCandidatePathFromResolution(
  resolution: ExecutableResolution | null | undefined,
  cwd?: string,
): string | undefined {
  if (!resolution) {
    return undefined;
  }
  if (resolution.resolvedPath) {
    return resolution.resolvedPath;
  }
  const raw = resolution.rawExecutable?.trim();
  if (!raw) {
    return undefined;
  }
  return resolveExecutablePathCandidate(raw, {
    cwd,
    requirePathSeparator: true,
  });
}

export function resolveExecutionTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  if (!resolution) {
    return null;
  }
  return isCommandResolution(resolution) ? resolution.execution : resolution;
}

export function resolvePolicyTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  if (!resolution) {
    return null;
  }
  return isCommandResolution(resolution) ? resolution.policy : resolution;
}

export function resolveExecutionTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    isCommandResolution(resolution) ? resolution.execution : resolution,
    cwd,
  );
}

export function resolvePolicyTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    isCommandResolution(resolution) ? resolution.policy : resolution,
    cwd,
  );
}

export function resolveApprovalAuditCandidatePath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetCandidatePath(resolution, cwd);
}

// Legacy alias kept while callers migrate to explicit target naming.
export function resolveAllowlistCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutionTargetCandidatePath(resolution, cwd);
}

export function resolvePolicyAllowlistCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetCandidatePath(resolution, cwd);
}

// Strip trailing shell redirections (e.g. `2>&1`, `2>/dev/null`) so that
// allow-always argPatterns built without them still match commands that include
// them.  LLMs commonly add or omit these between runs of the same cron job.
const TRAILING_SHELL_REDIRECTIONS_RE = /\s+(?:[12]>&[12]|[12]>\/dev\/null)\s*$/;

function stripTrailingRedirections(value: string): string {
  let prev = value;
  while (true) {
    const next = prev.replace(TRAILING_SHELL_REDIRECTIONS_RE, "");
    if (next === prev) {
      return next;
    }
    prev = next;
  }
}

function matchArgPattern(argPattern: string, argv: string[], platform?: string | null): boolean {
  // Patterns built by buildArgPatternFromArgv use \x00 as the argument separator and
  // always include a trailing \x00 sentinel so that every auto-generated pattern
  // (including zero-arg "^\x00\x00$" and single-arg "^hello world\x00$") contains at
  // least one \x00.  This lets matchArgPattern detect the join style unambiguously
  // via .includes("\x00") without misidentifying anchored hand-authored patterns.
  // Legacy hand-authored patterns use a plain space and contain no \x00.
  // When \x00 style is active, a trailing \x00 is appended to the joined args string
  // to match the sentinel embedded in the pattern.
  //
  // Zero args use a double sentinel "\x00\x00" to distinguish [] from [""] — both
  // join to "" but must match different patterns ("^\x00\x00$" vs "^\x00$").
  const sep = argPattern.includes("\x00") ? "\x00" : " ";
  const argsSlice = argv.slice(1);
  const argsString =
    sep === "\x00"
      ? argsSlice.length === 0
        ? "\x00\x00" // zero args: double sentinel matches "^\x00\x00$" pattern
        : argsSlice.join(sep) + sep // trailing sentinel to match pattern format
      : argsSlice.join(sep);
  try {
    const regex = new RegExp(argPattern);
    if (regex.test(argsString)) {
      return true;
    }
    // On Windows, LLMs may use forward slashes (`C:/path`) or backslashes
    // (`C:\path`) interchangeably.  Normalize to backslashes and retry so
    // that an argPattern built from one style still matches the other.
    // Use the caller-supplied target platform so Linux gateways evaluating
    // Windows node commands also perform the normalization.
    const effectivePlatform = normalizeLowercaseStringOrEmpty(platform ?? process.platform);
    if (effectivePlatform.startsWith("win")) {
      const normalized = argsString.replace(/\//g, "\\");
      if (normalized !== argsString && regex.test(normalized)) {
        return true;
      }
    }
    // Retry after stripping trailing shell redirections (2>&1, etc.) so that
    // patterns saved without them still match commands that include them.
    // Only applies for space-joined (legacy hand-authored) patterns.  For
    // \x00-joined auto-generated patterns, redirections are already blocked
    // upstream by findWindowsUnsupportedToken, so any surviving 2>&1 token
    // is a literal data argument and must not be stripped.
    if (sep === " ") {
      const stripped = stripTrailingRedirections(argsString);
      if (stripped !== argsString && regex.test(stripped)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function hasPathSelector(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.includes("~");
}

function matchesExecutableBasenamePattern(
  pattern: string,
  resolution: ExecutableResolution,
): boolean {
  // Bare command-name allowlist entries are for PATH-resolved commands. A raw
  // path such as ./rg or /tmp/rg must use a path allowlist entry so a workspace
  // binary cannot inherit trust from a global command-name entry.
  if (hasPathSelector(resolution.rawExecutable)) {
    return false;
  }
  const candidates = new Set<string>();
  if (resolution.executableName) {
    candidates.add(resolution.executableName);
  }
  if (resolution.resolvedPath) {
    candidates.add(path.basename(resolution.resolvedPath));
  }
  return [...candidates].some((candidate) => matchesExecAllowlistPattern(pattern, candidate));
}

export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: ExecutableResolution | null,
  argv?: string[],
  platform?: string | null,
): ExecAllowlistEntry | null {
  if (!entries.length) {
    return null;
  }
  // A bare "*" wildcard allows any parsed executable command.
  // Check it before the resolvedPath guard so unresolved PATH lookups still
  // match (for example platform-specific executables without known extensions).
  const bareWild = entries.find((e) => e.pattern?.trim() === "*" && !e.argPattern);
  if (bareWild && resolution) {
    return bareWild;
  }
  if (!resolution?.resolvedPath) {
    return null;
  }
  const resolvedPath = resolution.resolvedPath;
  // argPattern matching is currently Windows-only.  On other platforms every
  // path-matched entry is treated as a match regardless of argPattern, which
  // preserves the pre-existing behaviour.
  // Use the caller-supplied target platform rather than process.platform so that
  // a Linux gateway evaluating a Windows node command applies argPattern correctly.
  const effectivePlatform = platform ?? process.platform;
  const useArgPattern = normalizeLowercaseStringOrEmpty(effectivePlatform).startsWith("win");
  let pathOnlyMatch: ExecAllowlistEntry | null = null;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    const patternMatches = hasPathSelector(pattern)
      ? matchesExecAllowlistPattern(pattern, resolvedPath)
      : pattern !== "*" && matchesExecutableBasenamePattern(pattern, resolution);
    if (!patternMatches) {
      continue;
    }
    if (!useArgPattern) {
      // Non-Windows: first path match wins (legacy behaviour).
      return entry;
    }
    if (!entry.argPattern) {
      if (!pathOnlyMatch) {
        pathOnlyMatch = entry;
      }
      continue;
    }
    // Entry has argPattern — check argv match.
    if (argv && matchArgPattern(entry.argPattern, argv, platform)) {
      return entry;
    }
  }
  return pathOnlyMatch;
}

export type ExecArgvToken =
  | {
      kind: "empty";
      raw: string;
    }
  | {
      kind: "terminator";
      raw: string;
    }
  | {
      kind: "stdin";
      raw: string;
    }
  | {
      kind: "positional";
      raw: string;
    }
  | {
      kind: "option";
      raw: string;
      style: "long";
      flag: string;
      inlineValue?: string;
    }
  | {
      kind: "option";
      raw: string;
      style: "short-cluster";
      cluster: string;
      flags: string[];
    };

/**
 * Tokenizes a single argv entry into a normalized option/positional model.
 * Consumers can share this model to keep argv parsing behavior consistent.
 */
export function parseExecArgvToken(raw: string): ExecArgvToken {
  if (!raw) {
    return { kind: "empty", raw };
  }
  if (raw === "--") {
    return { kind: "terminator", raw };
  }
  if (raw === "-") {
    return { kind: "stdin", raw };
  }
  if (!raw.startsWith("-")) {
    return { kind: "positional", raw };
  }
  if (raw.startsWith("--")) {
    const eqIndex = raw.indexOf("=");
    if (eqIndex > 0) {
      return {
        kind: "option",
        raw,
        style: "long",
        flag: raw.slice(0, eqIndex),
        inlineValue: raw.slice(eqIndex + 1),
      };
    }
    return { kind: "option", raw, style: "long", flag: raw };
  }
  const cluster = raw.slice(1);
  return {
    kind: "option",
    raw,
    style: "short-cluster",
    cluster,
    flags: cluster.split("").map((entry) => `-${entry}`),
  };
}
