// Evaluates exec approval allowlists and safe-bin usage.
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isInterpreterLikeAllowlistPattern } from "./command-analysis/inline-eval.js";
import { detectInlineEvalArgv } from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import type { CommandStep } from "./command-explainer/types.js";
import {
  isDispatchWrapperExecutable,
  resolveDispatchWrapperTrustPlan,
  unwrapDispatchWrappersForResolution,
} from "./dispatch-wrapper-resolution.js";
import {
  isWindowsPlatform,
  matchAllowlist,
  resolveExecutableTrustPath,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveExecutionTargetTrustPath,
  resolveCommandResolutionFromArgv,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  resolvePolicyTargetTrustPath,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ExecutableResolution,
  type ShellChainOperator,
} from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import {
  canUseReusableWrapperPayloadCandidates,
  planExecAuthorization,
  planShellAuthorization,
  type ExecAuthorizationCandidate,
  type ExecAuthorizationPlan,
} from "./exec-authorization-plan.js";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILES,
  type SafeBinProfile,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import { isSafeBuiltinSegment } from "./exec-safe-builtins.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperExecutable,
  normalizeExecutableToken,
  POWERSHELL_WRAPPERS,
} from "./exec-wrapper-resolution.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import { expandHomePrefix } from "./home-dir.js";
import { resolveKnownPackageManagerExecInvocation } from "./package-manager-exec-wrapper.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  isDirectShellPositionalCarrierCommand,
  isPowerShellInlineFileCommandFlag,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";
import { analyzeWindowsShellCommand } from "./windows-shell-command.js";

function hasShellLineContinuation(command: string): boolean {
  return /\\(?:\r\n|\n|\r)/.test(command);
}

function commandStepToPolicySegment(
  step: CommandStep,
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
  },
): ExecCommandSegment {
  return {
    raw: step.text,
    argv: step.argv,
    resolution: resolveCommandResolutionFromArgv(
      step.argv,
      params.cwd,
      params.env,
      (params.platform ?? undefined) as NodeJS.Platform | undefined,
    ),
  };
}

async function explainShellPolicySegments(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecCommandSegment[]> {
  try {
    const explanation = await explainShellCommand(params.command);
    const steps = [...explanation.topLevelCommands, ...explanation.nestedCommands];
    return steps.map((step) => commandStepToPolicySegment(step, params));
  } catch {
    return [];
  }
}

export function normalizeSafeBins(entries?: readonly string[]): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set();
  }
  const normalized = entries
    .map((entry) => normalizeLowercaseStringOrEmpty(entry))
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

export function resolveSafeBins(entries?: readonly string[] | null): Set<string> {
  if (entries === undefined) {
    return normalizeSafeBins(DEFAULT_SAFE_BINS);
  }
  return normalizeSafeBins(entries ?? []);
}

export function isSafeBinUsage(params: {
  argv: string[];
  resolution: ExecutableResolution | null;
  safeBins: Set<string>;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  isTrustedSafeBinPathFn?: typeof isTrustedSafeBinPath;
}): boolean {
  // Windows host exec uses PowerShell, which has different parsing/expansion rules.
  // Keep safeBins conservative there (require explicit allowlist entries).
  if (isWindowsPlatform(params.platform ?? process.platform)) {
    return false;
  }
  if (params.safeBins.size === 0) {
    return false;
  }
  const resolution = params.resolution;
  const execName = normalizeOptionalLowercaseString(resolution?.executableName);
  if (!execName) {
    return false;
  }
  const matchesSafeBin = params.safeBins.has(execName);
  if (!matchesSafeBin) {
    return false;
  }
  const trustPath = resolveExecutableTrustPath(resolution);
  if (!trustPath) {
    return false;
  }
  const isTrustedPath = params.isTrustedSafeBinPathFn ?? isTrustedSafeBinPath;
  if (
    !isTrustedPath({
      resolvedPath: trustPath,
      trustedDirs: params.trustedSafeBinDirs,
    })
  ) {
    return false;
  }
  const argv = params.argv.slice(1);
  const safeBinProfiles = params.safeBinProfiles ?? SAFE_BIN_PROFILES;
  const profile = safeBinProfiles[execName];
  if (!profile) {
    return false;
  }
  return validateSafeBinArgv(argv, profile, { binName: execName });
}

function isPathScopedExecutableToken(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

export type ExecAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

export type ExecSegmentSatisfiedBy =
  | "allowlist"
  | "safeBins"
  | "inlineChain"
  | "safeBuiltins"
  | "skills"
  | null;
export type SkillBinTrustEntry = {
  name: string;
  resolvedPath: string;
};
type ExecAllowlistContext = {
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: readonly SkillBinTrustEntry[];
  autoAllowSkills?: boolean;
  allowShellBuiltins?: boolean;
};

function pickExecAllowlistContext(params: ExecAllowlistContext): ExecAllowlistContext {
  return {
    allowlist: params.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
    allowShellBuiltins: params.allowShellBuiltins,
  };
}

function normalizeSkillBinName(value: string | undefined): string | null {
  const trimmed = normalizeOptionalLowercaseString(value);
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeSkillBinResolvedPath(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(trimmed);
  if (process.platform === "win32") {
    return normalizeLowercaseStringOrEmpty(resolved.replace(/\\/g, "/"));
  }
  return resolved;
}

function buildSkillBinTrustIndex(
  entries: readonly SkillBinTrustEntry[] | undefined,
): Map<string, Set<string>> {
  const trustByName = new Map<string, Set<string>>();
  if (!entries || entries.length === 0) {
    return trustByName;
  }
  for (const entry of entries) {
    const name = normalizeSkillBinName(entry.name);
    const resolvedPath = normalizeSkillBinResolvedPath(entry.resolvedPath);
    if (!name || !resolvedPath) {
      continue;
    }
    const paths = trustByName.get(name) ?? new Set<string>();
    paths.add(resolvedPath);
    trustByName.set(name, paths);
  }
  return trustByName;
}

function isSkillAutoAllowedSegment(params: {
  segment: ExecCommandSegment;
  allowSkills: boolean;
  skillBinTrust: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  if (!params.allowSkills) {
    return false;
  }
  const resolution = params.segment.resolution;
  const execution = resolveExecutionTargetResolution(resolution);
  const trustPath = resolveExecutionTargetTrustPath(resolution);
  if (!execution?.resolvedPath || !trustPath) {
    return false;
  }
  const rawExecutable = execution.rawExecutable?.trim() ?? "";
  if (!rawExecutable || isPathScopedExecutableToken(rawExecutable)) {
    return false;
  }
  const executableName = normalizeSkillBinName(execution.executableName);
  const resolvedPath = normalizeSkillBinResolvedPath(trustPath);
  if (!executableName || !resolvedPath) {
    return false;
  }
  return Boolean(params.skillBinTrust.get(executableName)?.has(resolvedPath));
}

const MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH = 3;

type InlineChainAllowlistEvaluation = {
  matches: ExecAllowlistEntry[];
  satisfiedBy: "allowlist" | "inlineChain";
};

type SegmentMatchEvaluation = {
  effectiveArgv: string[];
  inlineCommand: string | null;
  match: ExecAllowlistEntry | null;
};

const MAX_PACKAGE_MANAGER_EXEC_UNWRAP_DEPTH = 6;

type PackageManagerTrustTarget =
  | { kind: "blocked" }
  | { kind: "not-package-manager"; argv: string[] }
  | { kind: "package-manager"; argv: string[] };

// Package-manager exec keeps the outer argv for process launch, but durable
// approval matching must use the inner trust target so stale outer-wrapper
// allow-always entries cannot authorize a different wrapped payload.
function resolvePackageManagerTrustTargetArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): PackageManagerTrustTarget {
  let current = argv;
  let sawPackageManagerExec = false;
  for (let depth = 0; depth < MAX_PACKAGE_MANAGER_EXEC_UNWRAP_DEPTH; depth += 1) {
    const dispatchPlan = resolveDispatchWrapperTrustPlan(current, undefined, platform);
    if (dispatchPlan.policyBlocked) {
      return { kind: "blocked" };
    }
    current = dispatchPlan.argv;
    const packageManagerExec = resolveKnownPackageManagerExecInvocation(current);
    if (packageManagerExec.kind === "unsafe-exec") {
      return { kind: "blocked" };
    }
    if (packageManagerExec.kind !== "unwrapped") {
      return sawPackageManagerExec
        ? { kind: "package-manager", argv: current }
        : { kind: "not-package-manager", argv: current };
    }
    sawPackageManagerExec = true;
    current = packageManagerExec.argv;
  }
  return { kind: "blocked" };
}

function resolvePackageManagerAllowlistTargetArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string[] | null | undefined {
  const packageManagerTarget = resolvePackageManagerTrustTargetArgv(argv, platform);
  if (packageManagerTarget.kind === "blocked") {
    return null;
  }
  if (packageManagerTarget.kind !== "package-manager") {
    return undefined;
  }
  const trustPlan = resolveExecWrapperTrustPlan(packageManagerTarget.argv, undefined, platform);
  if (
    trustPlan.policyBlocked ||
    (trustPlan.shellWrapperExecutable && trustPlan.shellInlineCommand)
  ) {
    return null;
  }
  return trustPlan.argv;
}

function matchExecutableAllowlistForSegment(params: {
  allowlist: ExecAllowlistEntry[];
  candidateResolution: ExecutableResolution | null;
  effectiveArgv: string[];
  platform?: string | null;
  inlineCommand: string | null;
  isShellWrapperInvocation: boolean;
  isPositionalCarrierInvocation: boolean;
  allowlistTargetIsExecutionTarget: boolean;
}): ExecAllowlistEntry | null {
  if (params.isPositionalCarrierInvocation) {
    return null;
  }
  const match = matchAllowlist(
    params.allowlist,
    params.candidateResolution,
    params.effectiveArgv,
    params.platform,
  );
  const hasBoundArgPattern =
    typeof match?.argPattern === "string" && match.argPattern.trim().length > 0;
  const isBareWildcardMatch = match?.pattern?.trim() === "*" && !hasBoundArgPattern;
  const requiresBoundArgPattern =
    params.allowlistTargetIsExecutionTarget &&
    (params.inlineCommand !== null ||
      (params.isShellWrapperInvocation && params.effectiveArgv.length > 1));
  if (requiresBoundArgPattern && !hasBoundArgPattern && !isBareWildcardMatch) {
    return null;
  }
  return match;
}

function executableResolutionsReferToSameTarget(
  left: ExecutableResolution | null,
  right: ExecutableResolution | null,
): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    left.rawExecutable === right.rawExecutable &&
    left.resolvedPath === right.resolvedPath &&
    left.resolvedRealPath === right.resolvedRealPath &&
    left.executableName === right.executableName
  );
}

function resolveShellWrapperScriptArgv(params: {
  shellScriptCandidatePath: string;
  effectiveArgv: string[];
  cwd?: string;
}): string[] {
  const scriptBase = normalizeLowercaseStringOrEmpty(
    path.basename(params.shellScriptCandidatePath),
  );
  const cwdBase = params.cwd && params.cwd.trim() ? params.cwd.trim() : process.cwd();
  const resolveArgPath = (a: string): string => (path.isAbsolute(a) ? a : path.resolve(cwdBase, a));
  let idx = params.effectiveArgv.findIndex(
    (a) => resolveArgPath(a) === params.shellScriptCandidatePath,
  );
  if (idx === -1) {
    idx = params.effectiveArgv.findIndex(
      (a) => normalizeLowercaseStringOrEmpty(path.basename(a)) === scriptBase,
    );
  }
  const scriptArgs = idx !== -1 ? params.effectiveArgv.slice(idx + 1) : [];
  return [params.shellScriptCandidatePath, ...scriptArgs];
}

function resolvePowerShellFileScriptArgv(params: {
  segment: ExecCommandSegment;
  cwd?: string;
}): string[] | null {
  const argv = resolveSegmentSourceArgv(params.segment);
  if (!Array.isArray(argv) || argv.length < 3) {
    return null;
  }
  const wrapperName = normalizeExecutableToken(argv[0] ?? "");
  if (!POWERSHELL_WRAPPERS.has(wrapperName)) {
    return null;
  }

  const match = resolvePowerShellInlineCommandMatch(argv);
  if (match.valueTokenIndex === null || !match.command) {
    return null;
  }
  if (!isPowerShellInlineFileCommandFlag(argv[match.valueTokenIndex - 1] ?? "")) {
    return null;
  }

  const scriptToken = argv[match.valueTokenIndex]?.trim();
  if (!scriptToken) {
    return null;
  }
  const expanded = scriptToken.startsWith("~") ? expandHomePrefix(scriptToken) : scriptToken;
  const base = params.cwd && params.cwd.trim().length > 0 ? params.cwd : process.cwd();
  const scriptPath = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
  return [scriptPath, ...argv.slice(match.valueTokenIndex + 1)];
}

function resolveSegmentSourceArgv(segment: ExecCommandSegment): string[] {
  const sourceArgv = segment.sourceArgv;
  if (!Array.isArray(sourceArgv) || sourceArgv.length === 0) {
    return segment.argv;
  }

  const segmentExecutable = normalizeExecutableToken(segment.argv[0] ?? "");
  if (!segmentExecutable) {
    return segment.argv;
  }
  if (normalizeExecutableToken(sourceArgv[0] ?? "") === segmentExecutable) {
    return sourceArgv;
  }

  const unwrappedSourceArgv = unwrapDispatchWrappersForResolution(sourceArgv);
  return normalizeExecutableToken(unwrappedSourceArgv[0] ?? "") === segmentExecutable
    ? unwrappedSourceArgv
    : segment.argv;
}

function resolveSegmentAllowlistMatch(params: {
  segment: ExecCommandSegment;
  context: ExecAllowlistContext;
}): SegmentMatchEvaluation {
  const effectiveArgv =
    params.segment.resolution?.effectiveArgv && params.segment.resolution.effectiveArgv.length > 0
      ? params.segment.resolution.effectiveArgv
      : params.segment.argv;
  const packageManagerTargetArgv = resolvePackageManagerAllowlistTargetArgv(
    effectiveArgv,
    (params.context.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  if (packageManagerTargetArgv === null) {
    return { effectiveArgv, inlineCommand: null, match: null };
  }
  const matchArgv = packageManagerTargetArgv ?? effectiveArgv;
  const matchResolution =
    matchArgv === effectiveArgv
      ? params.segment.resolution
      : resolveCommandResolutionFromArgv(
          matchArgv,
          params.context.cwd,
          params.context.env,
          (params.context.platform ?? undefined) as NodeJS.Platform | undefined,
        );
  const allowlistSegment =
    matchArgv === params.segment.argv
      ? params.segment
      : { ...params.segment, argv: matchArgv, resolution: matchResolution };
  const executableResolution = resolvePolicyTargetResolution(matchResolution);
  const executionResolution = resolveExecutionTargetResolution(params.segment.resolution);
  const candidatePath = resolvePolicyTargetCandidatePath(matchResolution, params.context.cwd);
  const trustPath = resolvePolicyTargetTrustPath(matchResolution, params.context.cwd);
  const candidateResolution =
    candidatePath && executableResolution
      ? { ...executableResolution, resolvedPath: candidatePath, resolvedRealPath: trustPath }
      : executableResolution;
  const matchExecutionResolution = resolveExecutionTargetResolution(matchResolution);
  const inlineCommand = extractBindableShellWrapperInlineCommand(allowlistSegment.argv);
  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment: allowlistSegment,
    cwd: params.context.cwd,
  });
  const isShellWrapperInvocation = isShellWrapperSegment(allowlistSegment);
  const isPositionalCarrierInvocation =
    inlineCommand !== null && isDirectShellPositionalCarrierCommand(inlineCommand);
  const executableMatch = matchExecutableAllowlistForSegment({
    allowlist: params.context.allowlist,
    candidateResolution,
    effectiveArgv: matchArgv,
    platform: params.context.platform,
    inlineCommand,
    isShellWrapperInvocation,
    isPositionalCarrierInvocation,
    allowlistTargetIsExecutionTarget: executableResolutionsReferToSameTarget(
      executableResolution,
      matchExecutionResolution ?? executionResolution,
    ),
  });
  const shellPositionalArgvCandidatePath =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidatePath({
          segment: allowlistSegment,
          cwd: params.context.cwd,
          env: params.context.env,
          platform: params.context.platform,
        })
      : undefined;
  const shellPositionalArgvMatch = shellPositionalArgvCandidatePath
    ? matchAllowlist(
        params.context.allowlist,
        {
          rawExecutable: shellPositionalArgvCandidatePath,
          resolvedPath: shellPositionalArgvCandidatePath,
          resolvedRealPath: resolveCandidateTrustPath(shellPositionalArgvCandidatePath),
          executableName: path.basename(shellPositionalArgvCandidatePath),
        },
        undefined,
        params.context.platform,
      )
    : null;
  const shellScriptCandidatePath =
    powerShellFileScriptArgv?.[0] ??
    (inlineCommand === null
      ? resolveShellWrapperScriptCandidatePath({
          segment: allowlistSegment,
          cwd: params.context.cwd,
        })
      : undefined);
  const shellScriptArgv = shellScriptCandidatePath
    ? (powerShellFileScriptArgv ??
      resolveShellWrapperScriptArgv({
        shellScriptCandidatePath,
        effectiveArgv: matchArgv,
        cwd: params.context.cwd,
      }))
    : null;
  const shellScriptMatch =
    shellScriptCandidatePath && shellScriptArgv
      ? matchAllowlist(
          params.context.allowlist,
          {
            rawExecutable: shellScriptCandidatePath,
            resolvedPath: shellScriptCandidatePath,
            resolvedRealPath: resolveCandidateTrustPath(shellScriptCandidatePath),
            executableName: path.basename(shellScriptCandidatePath),
          },
          shellScriptArgv,
          params.context.platform,
        )
      : null;
  return {
    effectiveArgv,
    inlineCommand: powerShellFileScriptArgv ? null : inlineCommand,
    match: executableMatch ?? shellPositionalArgvMatch ?? shellScriptMatch,
  };
}

function resolveSegmentSatisfaction(params: {
  match: ExecAllowlistEntry | null;
  segment: ExecCommandSegment;
  effectiveArgv: string[];
  context: ExecAllowlistContext;
  allowSkills: boolean;
  skillBinTrust: ReadonlyMap<string, ReadonlySet<string>>;
}): ExecSegmentSatisfiedBy {
  if (params.match) {
    return "allowlist";
  }
  const safe = isSafeBinUsage({
    argv: params.effectiveArgv,
    resolution: resolveExecutionTargetResolution(params.segment.resolution),
    safeBins: params.context.safeBins,
    safeBinProfiles: params.context.safeBinProfiles,
    platform: params.context.platform,
    trustedSafeBinDirs: params.context.trustedSafeBinDirs,
  });
  if (safe) {
    return "safeBins";
  }
  if (
    params.context.allowShellBuiltins === true &&
    isSafeBuiltinSegment({ segment: params.segment, platform: params.context.platform })
  ) {
    return "safeBuiltins";
  }
  const skillAllow = isSkillAutoAllowedSegment({
    segment: params.segment,
    allowSkills: params.allowSkills,
    skillBinTrust: params.skillBinTrust,
  });
  return skillAllow ? "skills" : null;
}

function resolveInlineCommandFallback(params: {
  by: ExecSegmentSatisfiedBy;
  inlineCommand: string | null;
  context: ExecAllowlistContext;
  inlineDepth: number;
}): InlineChainAllowlistEvaluation | null {
  if (params.by !== null || !params.inlineCommand) {
    return null;
  }
  if (!isWindowsPlatform(params.context.platform)) {
    return null;
  }
  return evaluateShellWrapperInlineCommand({
    inlineCommand: params.inlineCommand,
    context: params.context,
    inlineDepth: params.inlineDepth + 1,
  });
}

function evaluateShellWrapperInlineCommand(params: {
  inlineCommand: string;
  context: ExecAllowlistContext;
  inlineDepth: number;
}): InlineChainAllowlistEvaluation | null {
  if (params.inlineDepth >= MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH) {
    return null;
  }
  if (hasShellLineContinuation(params.inlineCommand)) {
    return null;
  }
  const analysis = analyzeWindowsShellCommand({
    command: params.inlineCommand,
    cwd: params.context.cwd,
    env: params.context.env,
    platform: params.context.platform,
  });
  if (!analysis.ok || analysis.segments.length === 0) {
    return null;
  }

  const matches: ExecAllowlistEntry[] = [];
  for (const group of resolveAnalysisSegmentGroups(analysis)) {
    const result = evaluateSegments(group, params.context, params.inlineDepth);
    if (!result.satisfied) {
      return null;
    }
    matches.push(...result.matches);
  }
  return { matches, satisfiedBy: "allowlist" };
}

function evaluateSegments(
  segments: ExecCommandSegment[],
  params: ExecAllowlistContext,
  inlineDepth = 0,
): {
  satisfied: boolean;
  matches: ExecAllowlistEntry[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
} {
  const matches: ExecAllowlistEntry[] = [];
  const skillBinTrust = buildSkillBinTrustIndex(params.skillBins);
  const allowSkills = params.autoAllowSkills === true && skillBinTrust.size > 0;
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  const satisfied = segments.every((segment) => {
    if (segment.resolution?.policyBlocked === true) {
      segmentAllowlistEntries.push(null);
      segmentSatisfiedBy.push(null);
      return false;
    }
    const { effectiveArgv, inlineCommand, match } = resolveSegmentAllowlistMatch({
      segment,
      context: params,
    });
    if (match) {
      matches.push(match);
    }
    segmentAllowlistEntries.push(match ?? null);
    const by = resolveSegmentSatisfaction({
      match,
      segment,
      effectiveArgv,
      context: params,
      allowSkills,
      skillBinTrust,
    });
    const inlineResult = resolveInlineCommandFallback({
      by,
      inlineCommand,
      context: params,
      inlineDepth,
    });
    if (inlineResult) {
      matches.push(...inlineResult.matches);
      // Keep per-segment metadata aligned with segments: one satisfaction marker
      // for this wrapper segment, even when the inline payload has multiple parts.
      segmentSatisfiedBy.push(inlineResult.satisfiedBy);
      return true;
    }
    segmentSatisfiedBy.push(by);
    return Boolean(by);
  });

  return { satisfied, matches, segmentAllowlistEntries, segmentSatisfiedBy };
}

function resolveAnalysisSegmentGroups(analysis: ExecCommandAnalysis): ExecCommandSegment[][] {
  if (analysis.chains) {
    return analysis.chains;
  }
  return [analysis.segments];
}

type CandidateEvaluation = {
  match: ExecAllowlistEntry | null;
  satisfiedBy: ExecSegmentSatisfiedBy;
};

function evaluateAuthorizationCandidate(params: {
  candidate: ExecAuthorizationCandidate;
  context: ExecAllowlistContext;
  allowSkills: boolean;
  skillBinTrust: ReadonlyMap<string, ReadonlySet<string>>;
}): CandidateEvaluation {
  if (params.candidate.trustMode === "prompt-only") {
    return { match: null, satisfiedBy: null };
  }

  const { effectiveArgv, match } = resolveSegmentAllowlistMatch({
    segment: params.candidate.sourceSegment,
    context: params.context,
  });
  if (match) {
    return { match, satisfiedBy: "allowlist" };
  }
  const satisfiedBy = resolveSegmentSatisfaction({
    match,
    segment: params.candidate.sourceSegment,
    effectiveArgv,
    context: params.context,
    allowSkills: params.allowSkills,
    skillBinTrust: params.skillBinTrust,
  });
  return { match, satisfiedBy };
}

type PlanGroupEvaluation = {
  analysis: ExecCommandAnalysis;
  evaluation: ExecAllowlistEvaluation;
  opToNext: ShellChainOperator | null;
};

function evaluateAuthorizationPlanGroup(params: {
  group: Extract<ExecAuthorizationPlan, { ok: true }>["groups"][number];
  context: ExecAllowlistContext;
  allowSkills: boolean;
  skillBinTrust: ReadonlyMap<string, ReadonlySet<string>>;
}): {
  evaluation: ExecAllowlistEvaluation;
  segments: ExecCommandSegment[];
} {
  const matches: ExecAllowlistEntry[] = [];
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];
  const segments: ExecCommandSegment[] = [];
  let allowlistSatisfied = true;

  for (const candidate of params.group.candidates) {
    const result = evaluateAuthorizationCandidate({
      candidate,
      context: params.context,
      allowSkills: params.allowSkills,
      skillBinTrust: params.skillBinTrust,
    });
    if (result.match) {
      matches.push(result.match);
    }
    segments.push(candidate.sourceSegment);
    segmentAllowlistEntries.push(result.match);
    segmentSatisfiedBy.push(result.satisfiedBy);
    if (!result.satisfiedBy) {
      allowlistSatisfied = false;
    }
  }

  return {
    evaluation: {
      allowlistSatisfied,
      allowlistMatches: matches,
      segmentAllowlistEntries,
      segmentSatisfiedBy,
    },
    segments,
  };
}

function finalizeShellAllowlistEvaluations(params: {
  evaluations: PlanGroupEvaluation[];
  authorizationPlan?: ExecAuthorizationPlan;
}): ExecAllowlistAnalysis {
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segments: ExecCommandSegment[] = [];
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];
  let allowlistSatisfied = true;

  for (const { analysis, evaluation } of params.evaluations) {
    segments.push(...analysis.segments);
    allowlistMatches.push(...evaluation.allowlistMatches);
    segmentAllowlistEntries.push(...evaluation.segmentAllowlistEntries);
    segmentSatisfiedBy.push(...evaluation.segmentSatisfiedBy);
    if (!evaluation.allowlistSatisfied) {
      allowlistSatisfied = false;
    }
  }

  return {
    analysisOk: true,
    allowlistSatisfied,
    allowlistMatches,
    segments,
    segmentAllowlistEntries,
    segmentSatisfiedBy,
    ...(params.authorizationPlan ? { authorizationPlan: params.authorizationPlan } : {}),
  };
}

function evaluateAuthorizationPlan(params: {
  plan: ExecAuthorizationPlan;
  context: ExecAllowlistContext;
}): ExecAllowlistAnalysis {
  const analysisFailure = (): ExecAllowlistAnalysis => ({
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: [],
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
    authorizationPlan: params.plan,
  });
  if (!params.plan.ok) {
    return analysisFailure();
  }

  const skillBins = params.context.skillBins ?? [];
  const allowSkills = params.context.autoAllowSkills === true && skillBins.length > 0;
  const skillBinTrust = buildSkillBinTrustIndex(skillBins);
  const groupEvaluations: PlanGroupEvaluation[] = params.plan.groups.map((group) => {
    const { evaluation, segments } = evaluateAuthorizationPlanGroup({
      group,
      context: params.context,
      allowSkills,
      skillBinTrust,
    });
    return {
      analysis: { ok: true, segments },
      evaluation,
      opToNext: group.opToNext ?? null,
    };
  });
  return finalizeShellAllowlistEvaluations({
    evaluations: groupEvaluations,
    authorizationPlan: params.plan,
  });
}

export function evaluateExecAllowlist(
  params: {
    analysis: ExecCommandAnalysis;
  } & ExecAllowlistContext,
): ExecAllowlistEvaluation {
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];
  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return {
      allowlistSatisfied: false,
      allowlistMatches,
      segmentAllowlistEntries,
      segmentSatisfiedBy,
    };
  }

  const allowlistContext = pickExecAllowlistContext(params);
  const hasChains = Boolean(params.analysis.chains);
  for (const group of resolveAnalysisSegmentGroups(params.analysis)) {
    const result = evaluateSegments(group, allowlistContext);
    if (!result.satisfied) {
      if (!hasChains) {
        return {
          allowlistSatisfied: false,
          allowlistMatches: result.matches,
          segmentAllowlistEntries: result.segmentAllowlistEntries,
          segmentSatisfiedBy: result.segmentSatisfiedBy,
        };
      }
      return {
        allowlistSatisfied: false,
        allowlistMatches: [],
        segmentAllowlistEntries: [],
        segmentSatisfiedBy: [],
      };
    }
    allowlistMatches.push(...result.matches);
    segmentAllowlistEntries.push(...result.segmentAllowlistEntries);
    segmentSatisfiedBy.push(...result.segmentSatisfiedBy);
  }
  return {
    allowlistSatisfied: true,
    allowlistMatches,
    segmentAllowlistEntries,
    segmentSatisfiedBy,
  };
}

export type ExecAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan?: ExecAuthorizationPlan;
};

function hasSegmentExecutableMatch(
  segment: ExecCommandSegment,
  predicate: (token: string) => boolean,
): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  const candidates = [execution?.executableName, execution?.rawExecutable, segment.argv[0]];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    if (predicate(trimmed)) {
      return true;
    }
  }
  return false;
}

function isShellWrapperSegment(segment: ExecCommandSegment): boolean {
  return hasSegmentExecutableMatch(segment, isShellWrapperExecutable);
}

const SHELL_WRAPPER_OPTIONS_WITH_VALUE = new Set(["-c", "--command", "-o", "-O", "+O"]);

const SHELL_WRAPPER_DISQUALIFYING_SCRIPT_OPTIONS = [
  "--rcfile",
  "--init-file",
  "--startup-file",
] as const;

function hasDisqualifyingShellWrapperScriptOption(token: string): boolean {
  return SHELL_WRAPPER_DISQUALIFYING_SCRIPT_OPTIONS.some(
    (option) => token === option || token.startsWith(`${option}=`),
  );
}

const POWERSHELL_OPTIONS_WITH_VALUE_RE =
  /^-(?:executionpolicy|ep|windowstyle|w|workingdirectory|wd|inputformat|outputformat|settingsfile|configurationfile|version|v|psconsolefile|pscf|encodedcommand|en|enc|encodedarguments|ea)$/i;

function resolveShellWrapperScriptCandidatePath(params: {
  segment: ExecCommandSegment;
  cwd?: string;
}): string | undefined {
  if (!isShellWrapperSegment(params.segment)) {
    return undefined;
  }

  const argv = params.segment.argv;
  if (!Array.isArray(argv) || argv.length < 2) {
    return undefined;
  }

  const wrapperName = normalizeExecutableToken(argv[0] ?? "");
  const isPowerShell = POWERSHELL_WRAPPERS.has(wrapperName);

  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token === "-c" || token === "--command") {
      return undefined;
    }
    if (!isPowerShell && /^-[^-]*c[^-]*$/i.test(token)) {
      return undefined;
    }
    if (token === "-s" || (!isPowerShell && /^-[^-]*s[^-]*$/i.test(token))) {
      return undefined;
    }
    if (hasDisqualifyingShellWrapperScriptOption(token)) {
      return undefined;
    }
    if (SHELL_WRAPPER_OPTIONS_WITH_VALUE.has(token)) {
      idx += 2;
      continue;
    }
    if (isPowerShell && POWERSHELL_OPTIONS_WITH_VALUE_RE.test(token)) {
      idx += 2;
      continue;
    }
    if (token.startsWith("-") || token.startsWith("+")) {
      idx += 1;
      continue;
    }
    break;
  }

  const scriptToken = argv[idx]?.trim();
  if (!scriptToken) {
    return undefined;
  }
  if (path.isAbsolute(scriptToken)) {
    return scriptToken;
  }

  const expanded = scriptToken.startsWith("~") ? expandHomePrefix(scriptToken) : scriptToken;
  const base = params.cwd && params.cwd.trim().length > 0 ? params.cwd : process.cwd();
  return path.resolve(base, expanded);
}

function resolveShellWrapperPositionalArgvCandidatePath(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): string | undefined {
  if (!isShellWrapperSegment(params.segment)) {
    return undefined;
  }

  const argv = params.segment.argv;
  if (!Array.isArray(argv) || argv.length < 4) {
    return undefined;
  }

  const wrapper = normalizeExecutableToken(argv[0] ?? "");
  if (!["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"].includes(wrapper)) {
    return undefined;
  }

  const inlineMatch = resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) {
    return undefined;
  }
  if (!isDirectShellPositionalCarrierCommand(inlineMatch.command)) {
    return undefined;
  }

  const carriedExecutable = argv
    .slice(inlineMatch.valueTokenIndex + 1)
    .map((token) => token.trim())
    .find((token) => token.length > 0);
  if (!carriedExecutable) {
    return undefined;
  }

  const carriedName = normalizeExecutableToken(carriedExecutable);
  if (isDispatchWrapperExecutable(carriedName) || isShellWrapperExecutable(carriedName)) {
    return undefined;
  }

  const resolution = resolveCommandResolutionFromArgv(
    [carriedExecutable],
    params.cwd,
    params.env,
    (params.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  return resolveExecutionTargetCandidatePath(resolution, params.cwd);
}

export type AllowAlwaysPattern = {
  pattern: string;
  argPattern?: string;
};

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildScriptArgPatternFromArgv(
  argv: string[],
  scriptPath: string,
  cwd?: string,
  platform?: string | null,
): string | undefined {
  if (!isWindowsPlatform(platform ?? process.platform)) {
    return undefined;
  }
  const scriptBase = normalizeLowercaseStringOrEmpty(path.basename(scriptPath));
  const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  const resolveArgPath = (arg: string): string =>
    path.isAbsolute(arg) ? arg : path.resolve(base, arg);
  let scriptIdx = argv.findIndex((arg) => resolveArgPath(arg) === scriptPath);
  if (scriptIdx === -1) {
    scriptIdx = argv.findIndex(
      (arg) => normalizeLowercaseStringOrEmpty(path.basename(arg)) === scriptBase,
    );
  }
  const scriptArgs = scriptIdx !== -1 ? argv.slice(scriptIdx + 1) : [];
  const normalized = scriptArgs.map((a) => a.replace(/\//g, "\\"));
  if (normalized.length === 0) {
    return "^\x00\x00$";
  }
  return `^${normalized.map(escapeRegExpLiteral).join("\x00")}\x00$`;
}

function buildArgPatternFromArgv(argv: string[], platform?: string | null): string | undefined {
  if (!isWindowsPlatform(platform ?? process.platform)) {
    return undefined;
  }
  const args = argv.slice(1);
  const normalized = args.map((a) => a.replace(/\//g, "\\"));
  if (normalized.length === 0) {
    return "^\x00\x00$";
  }
  const joined = normalized.join("\x00");
  return `^${escapeRegExpLiteral(joined)}\x00$`;
}

function addAllowAlwaysPattern(
  out: AllowAlwaysPattern[],
  pattern: string,
  argPattern?: string,
): void {
  const exists = out.some(
    (p) => p.pattern === pattern && (p.argPattern ?? undefined) === (argPattern ?? undefined),
  );
  if (!exists) {
    out.push({ pattern, argPattern });
  }
}

function resolveCandidateTrustPath(candidatePath: string | undefined): string | undefined {
  if (!candidatePath) {
    return undefined;
  }
  return resolveExecutableTrustPath({
    rawExecutable: candidatePath,
    resolvedPath: candidatePath,
    executableName: path.basename(candidatePath),
  });
}

function resolveAllowAlwaysPatternArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  const packageManagerTarget = resolvePackageManagerTrustTargetArgv(argv, platform);
  if (packageManagerTarget.kind === "blocked") {
    return null;
  }
  return packageManagerTarget.argv;
}

function collectAllowAlwaysPatterns(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
  depth: number;
  out: AllowAlwaysPattern[];
}) {
  if (params.depth >= 3) {
    return;
  }

  const patternArgv = resolveAllowAlwaysPatternArgv(
    params.segment.argv,
    (params.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  if (!patternArgv) {
    return;
  }
  const trustPlan = resolveExecWrapperTrustPlan(
    patternArgv,
    undefined,
    (params.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  if (trustPlan.policyBlocked) {
    return;
  }
  const segment =
    trustPlan.argv === params.segment.argv
      ? params.segment
      : {
          raw: trustPlan.argv.join(" "),
          argv: trustPlan.argv,
          sourceArgv: params.segment.sourceArgv,
          resolution: resolveCommandResolutionFromArgv(
            trustPlan.argv,
            params.cwd,
            params.env,
            (params.platform ?? undefined) as NodeJS.Platform | undefined,
          ),
        };

  const candidatePath = resolveExecutionTargetTrustPath(segment.resolution, params.cwd);
  if (!candidatePath) {
    return;
  }
  if (isInterpreterLikeAllowlistPattern(candidatePath)) {
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    if (params.strictInlineEval !== true || detectInlineEvalArgv(effectiveArgv) !== null) {
      return;
    }
  }
  if (!trustPlan.shellWrapperExecutable) {
    const argPattern = buildArgPatternFromArgv(segment.argv, params.platform);
    addAllowAlwaysPattern(params.out, candidatePath, argPattern);
    return;
  }
  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment,
    cwd: params.cwd,
  });
  const inlineCommand = powerShellFileScriptArgv ? null : trustPlan.shellInlineCommand;
  const positionalArgvPath =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidatePath({
          segment,
          cwd: params.cwd,
          env: params.env,
          platform: params.platform,
        })
      : undefined;
  if (positionalArgvPath) {
    addAllowAlwaysPattern(
      params.out,
      resolveCandidateTrustPath(positionalArgvPath) ?? positionalArgvPath,
    );
    return;
  }
  if (!inlineCommand) {
    const scriptPath =
      powerShellFileScriptArgv?.[0] ??
      resolveShellWrapperScriptCandidatePath({
        segment,
        cwd: params.cwd,
      });
    if (scriptPath) {
      const scriptTrustPath = resolveCandidateTrustPath(scriptPath) ?? scriptPath;
      const argPattern = buildScriptArgPatternFromArgv(
        powerShellFileScriptArgv ?? segment.argv,
        scriptPath,
        params.cwd,
        params.platform,
      );
      addAllowAlwaysPattern(params.out, scriptTrustPath, argPattern);
    }
    return;
  }
  if (!isWindowsPlatform(params.platform)) {
    return;
  }
  const nested = analyzeWindowsShellCommand({
    command: inlineCommand,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!nested.ok || !canUseReusableWrapperPayloadCandidates(nested.segments)) {
    return;
  }
  for (const nestedSegment of nested.segments) {
    collectAllowAlwaysPatterns({
      segment: nestedSegment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
      depth: params.depth + 1,
      out: params.out,
    });
  }
}

/**
 * Derive persisted allowlist patterns for an "allow always" decision.
 * When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
 * persist the inner executable(s) rather than the shell binary.
 */
export function resolveAllowAlwaysPatternEntries(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): AllowAlwaysPattern[] {
  const patterns: AllowAlwaysPattern[] = [];
  for (const segment of params.segments) {
    collectAllowAlwaysPatterns({
      segment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
      depth: 0,
      out: patterns,
    });
  }
  return patterns;
}

export function resolveAllowAlwaysPatterns(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): string[] {
  return resolveAllowAlwaysPatternEntries(params).map((pattern) => pattern.pattern);
}

/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
export function evaluateShellAllowlist(
  params: {
    command: string;
    env?: NodeJS.ProcessEnv;
  } & ExecAllowlistContext,
): ExecAllowlistAnalysis {
  const allowlistContext = {
    ...pickExecAllowlistContext(params),
    allowShellBuiltins: true,
  };
  const analysisFailure = (): ExecAllowlistAnalysis => ({
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: [],
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
  });

  // Keep allowlist analysis conservative: line-continuation semantics are shell-dependent
  // and can rewrite token boundaries at runtime.
  if (hasShellLineContinuation(params.command)) {
    return analysisFailure();
  }

  if (!isWindowsPlatform(params.platform)) {
    return analysisFailure();
  }

  const analysis = analyzeWindowsShellCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!analysis.ok) {
    return analysisFailure();
  }
  const evaluation = evaluateExecAllowlist({ analysis, ...allowlistContext });
  return {
    analysisOk: true,
    allowlistSatisfied: evaluation.allowlistSatisfied,
    allowlistMatches: evaluation.allowlistMatches,
    segments: analysis.segments,
    segmentAllowlistEntries: evaluation.segmentAllowlistEntries,
    segmentSatisfiedBy: evaluation.segmentSatisfiedBy,
  };
}

export async function evaluateShellAllowlistWithAuthorization(
  params: {
    command: string;
    env?: NodeJS.ProcessEnv;
  } & ExecAllowlistContext,
): Promise<ExecAllowlistAnalysis> {
  const allowlistContext = {
    ...pickExecAllowlistContext(params),
    allowShellBuiltins: true,
  };
  const analysisFailure = (
    segments: ExecCommandSegment[] = [],
    authorizationPlan?: ExecAuthorizationPlan,
  ): ExecAllowlistAnalysis => ({
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments,
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
    ...(authorizationPlan ? { authorizationPlan } : {}),
  });

  if (!isWindowsPlatform(params.platform)) {
    const authorizationPlan = await planShellAuthorization({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!authorizationPlan.ok) {
      const segments = await explainShellPolicySegments({
        command: params.command,
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
      });
      return analysisFailure(segments, authorizationPlan);
    }
    return evaluateAuthorizationPlan({ plan: authorizationPlan, context: allowlistContext });
  }

  return evaluateShellAllowlist(params);
}

export async function evaluateExecAllowlistWithAuthorization(
  params: {
    analysis: ExecCommandAnalysis;
    command?: string;
  } & ExecAllowlistContext,
): Promise<
  ExecAllowlistEvaluation & {
    segments?: ExecCommandSegment[];
    authorizationPlan?: ExecAuthorizationPlan;
  }
> {
  if (isWindowsPlatform(params.platform)) {
    return evaluateExecAllowlist(params);
  }
  const authorizationPlan = await planExecAuthorization({
    analysis: params.analysis,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!authorizationPlan.ok) {
    return {
      allowlistSatisfied: false,
      allowlistMatches: [],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
      segments: params.analysis.segments,
      authorizationPlan,
    };
  }
  const result = evaluateAuthorizationPlan({
    plan: authorizationPlan,
    context: pickExecAllowlistContext(params),
  });
  return {
    allowlistSatisfied: result.allowlistSatisfied,
    allowlistMatches: result.allowlistMatches,
    segmentAllowlistEntries: result.segmentAllowlistEntries,
    segmentSatisfiedBy: result.segmentSatisfiedBy,
    segments: result.segments,
    authorizationPlan,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
