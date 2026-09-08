// Resolves command executables and wrapper policy paths for exec approvals.
import crypto from "node:crypto";
import path from "node:path";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import {
  resolveExecutablePath as resolveExecutableCandidatePath,
  resolveExecutablePathCandidate,
} from "./executable-path.js";

export type ExecutableResolution = {
  kind: "executable";
  rawExecutable: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
  executableName: string;
};

export type CommandResolution = {
  kind: "command";
  execution: ExecutableResolution;
  policy: ExecutableResolution;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
};

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
  return filePath ? (safeRealpathSync(filePath) ?? undefined) : undefined;
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
    kind: "executable",
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
    kind: "command",
    execution,
    policy,
    effectiveArgv: params.effectiveArgv,
    wrapperChain: params.wrapperChain,
    policyBlocked: params.policyBlocked,
    blockedWrapper: params.blockedWrapper,
  };
  return resolution;
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
  platform: NodeJS.Platform = process.platform,
): CommandResolution | null {
  const plan = resolveExecWrapperTrustPlan(argv, undefined, platform);
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

export function resolveExecutableTrustPath(
  resolution: ExecutableResolution | null | undefined,
  cwd?: string,
): string | undefined {
  const realPath = resolution?.resolvedRealPath?.trim();
  if (realPath) {
    return realPath;
  }
  const candidatePath = resolveExecutableCandidatePathFromResolution(resolution, cwd);
  return tryResolveRealpath(candidatePath) ?? candidatePath;
}

export function resolveExecutionTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  if (!resolution) {
    return null;
  }
  return resolution.kind === "command" ? resolution.execution : resolution;
}

export function resolvePolicyTargetResolution(
  resolution: CommandResolution | ExecutableResolution | null,
): ExecutableResolution | null {
  if (!resolution) {
    return null;
  }
  return resolution.kind === "command" ? resolution.policy : resolution;
}

export function resolveExecutionTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    resolution?.kind === "command" ? resolution.execution : resolution,
    cwd,
  );
}

export function resolveExecutionTargetTrustPath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableTrustPath(
    resolution?.kind === "command" ? resolution.execution : resolution,
    cwd,
  );
}

export function resolvePolicyTargetCandidatePath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableCandidatePathFromResolution(
    resolution?.kind === "command" ? resolution.policy : resolution,
    cwd,
  );
}

export function resolvePolicyTargetTrustPath(
  resolution: CommandResolution | ExecutableResolution | null,
  cwd?: string,
): string | undefined {
  return resolveExecutableTrustPath(
    resolution?.kind === "command" ? resolution.policy : resolution,
    cwd,
  );
}

export function resolveApprovalAuditCandidatePath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetCandidatePath(resolution, cwd);
}

export function resolveApprovalAuditTrustPath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  return resolvePolicyTargetTrustPath(resolution, cwd);
}

/** @deprecated Use resolveExecutionTargetCandidatePath. */
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

const LEGACY_HASHED_ARG_PATTERN_PREFIX = "sha256:argv:";
const CWD_BOUND_HASHED_ARG_PATTERN_PREFIX = "sha256:cwd-argv:v1:";

export function isGeneratedHashedArgPattern(value: string | null | undefined): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith(CWD_BOUND_HASHED_ARG_PATTERN_PREFIX) ||
      value.startsWith(LEGACY_HASHED_ARG_PATTERN_PREFIX))
  );
}

export function isCwdBoundHashedArgPattern(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CWD_BOUND_HASHED_ARG_PATTERN_PREFIX);
}

export type ExecAllowlistScope = "command text" | "argv+cwd" | "argv" | "any args" | "inactive";

export function classifyExecAllowlistScope(
  entry: Pick<ExecAllowlistEntry, "pattern" | "source" | "argPattern">,
): ExecAllowlistScope {
  const pattern = entry.pattern.trim();
  const generated = entry.source === "allow-always";
  // Reserved command markers require generated source; manual patterns remain executable globs.
  if (generated && (pattern.startsWith("=command:") || pattern.startsWith("=node-command:"))) {
    return "command text";
  }
  // Legacy hashes never match, including on manual entries that Doctor must retain.
  const legacyHashed = entry.argPattern?.startsWith(LEGACY_HASHED_ARG_PATTERN_PREFIX) === true;
  if (legacyHashed || (generated && !isCwdBoundHashedArgPattern(entry.argPattern))) {
    return "inactive";
  }
  if (isCwdBoundHashedArgPattern(entry.argPattern)) {
    return "argv+cwd";
  }
  return entry.argPattern ? "argv" : "any args";
}

function renderGeneratedArgPatternSubject(argv: string[]): string {
  const argsSlice = argv.slice(1);
  return argsSlice.length === 0 ? "\x00\x00" : argsSlice.join("\x00") + "\x00";
}

function renderGeneratedHashedArgPatternSubject(argv: string[]): string {
  const argsSlice = argv.slice(1);
  return `${argsSlice.length}\x00${argsSlice
    .map((arg) => `${Buffer.byteLength(arg, "utf8")}\x00${arg}\x00`)
    .join("")}`;
}

function normalizeGrantCwd(cwd: string, platform?: string | null): string {
  const effectivePlatform = normalizeLowercaseStringOrEmpty(platform ?? process.platform);
  const pathApi = effectivePlatform.startsWith("win") ? path.win32 : path.posix;
  return pathApi.normalize(cwd).replaceAll("\\", "/");
}

export function buildCwdBoundHashedArgPattern(
  argv: string[],
  cwd: string,
  platform?: string | null,
): string {
  const normalizedCwd = normalizeGrantCwd(cwd, platform);
  const subject = `${Buffer.byteLength(normalizedCwd, "utf8")}\x00${normalizedCwd}\x00${renderGeneratedHashedArgPatternSubject(argv)}`;
  const digest = crypto.createHash("sha256").update(subject, "utf8").digest("hex");
  return `${CWD_BOUND_HASHED_ARG_PATTERN_PREFIX}${digest}`;
}

function matchArgPattern(
  argPattern: string,
  argv: string[],
  cwd: string | undefined,
  platform?: string | null,
): boolean {
  if (argPattern.startsWith(CWD_BOUND_HASHED_ARG_PATTERN_PREFIX)) {
    return cwd !== undefined && argPattern === buildCwdBoundHashedArgPattern(argv, cwd, platform);
  }
  if (argPattern.startsWith(LEGACY_HASHED_ARG_PATTERN_PREFIX)) {
    return false;
  }
  // Patterns built by buildArgPatternFromArgv use \x00 as the argument separator and
  // always include a trailing \x00 sentinel so that every auto-generated pattern
  // (including zero-arg "^\x00\x00$" and single-arg "^hello world\x00$") contains at
  // least one \x00.  This lets matchArgPattern detect the join style unambiguously
  // via .includes("\x00") without misidentifying anchored hand-authored patterns.
  // Legacy hand-authored patterns use a plain space and contain no \x00.
  // When \x00 style is active, a trailing \x00 is appended to the joined args string
  // to match the sentinel embedded in the pattern.
  // Every argv token remains authorization-significant: this boundary cannot prove
  // whether a redirect-shaped token was shell syntax or literal process data.
  //
  // Zero args use a double sentinel "\x00\x00" to distinguish [] from [""] — both
  // join to "" but must match different patterns ("^\x00\x00$" vs "^\x00$").
  const sep = argPattern.includes("\x00") ? "\x00" : " ";
  const argsString =
    sep === "\x00" ? renderGeneratedArgPatternSubject(argv) : argv.slice(1).join(sep);
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
  cwd?: string,
): ExecAllowlistEntry | null {
  if (!entries.length) {
    return null;
  }
  // A bare "*" wildcard allows any parsed executable command.
  // Check it before the resolvedPath guard so unresolved PATH lookups still
  // match (for example platform-specific executables without known extensions).
  const bareWild = entries.find(
    (e) => e.pattern?.trim() === "*" && !e.argPattern && e.source !== "allow-always",
  );
  if (bareWild && resolution) {
    return bareWild;
  }
  if (!resolution?.resolvedPath) {
    return null;
  }
  const trustPath = resolution.resolvedRealPath?.trim() || resolution.resolvedPath;
  if (!trustPath) {
    return null;
  }
  let pathOnlyMatch: ExecAllowlistEntry | null = null;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    const patternMatches = hasPathSelector(pattern)
      ? matchesExecAllowlistPattern(pattern, trustPath)
      : pattern !== "*" && matchesExecutableBasenamePattern(pattern, resolution);
    if (!patternMatches) {
      continue;
    }
    if (!entry.argPattern) {
      // Old generated allow-always entries were path-only and could authorize
      // changed argv after upgrade. Manual path-only entries have no source.
      if (entry.source === "allow-always") {
        continue;
      }
      if (!pathOnlyMatch) {
        pathOnlyMatch = entry;
      }
      continue;
    }
    // Entry has argPattern — check argv match.
    if (entry.source === "allow-always" && !isCwdBoundHashedArgPattern(entry.argPattern)) {
      continue;
    }
    if (argv && matchArgPattern(entry.argPattern, argv, cwd, platform)) {
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
