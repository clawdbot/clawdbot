import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isInterpreterLikeAllowlistPattern } from "./command-analysis/inline-eval.js";
import { detectInlineEvalArgv } from "./command-analysis/risks.js";
import { isDispatchWrapperExecutable } from "./dispatch-wrapper-resolution.js";
import {
  analyzeShellCommand,
  isWindowsPlatform,
  matchAllowlist,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveCommandResolutionFromArgv,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  splitCommandChain,
  splitCommandChainWithOperators,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ExecutableResolution,
  type ShellChainOperator,
} from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILES,
  type SafeBinProfile,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import {
  extractShellWrapperInlineCommand,
  isShellWrapperExecutable,
  normalizeExecutableToken,
  POWERSHELL_WRAPPERS,
} from "./exec-wrapper-resolution.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import { expandHomePrefix } from "./home-dir.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "./shell-inline-command.js";

function hasShellLineContinuation(command: string): boolean {
  return /\\(?:\r\n|\n|\r)/.test(command);
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
  if (!resolution?.resolvedPath) {
    return false;
  }
  const isTrustedPath = params.isTrustedSafeBinPathFn ?? isTrustedSafeBinPath;
  if (
    !isTrustedPath({
      resolvedPath: resolution.resolvedPath,
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

export type ExecSegmentSatisfiedBy = "allowlist" | "safeBins" | "skills" | "skillPrelude" | null;
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
  if (!execution?.resolvedPath) {
    return false;
  }
  const rawExecutable = execution.rawExecutable?.trim() ?? "";
  if (!rawExecutable || isPathScopedExecutableToken(rawExecutable)) {
    return false;
  }
  const executableName = normalizeSkillBinName(execution.executableName);
  const resolvedPath = normalizeSkillBinResolvedPath(execution.resolvedPath);
  if (!executableName || !resolvedPath) {
    return false;
  }
  return Boolean(params.skillBinTrust.get(executableName)?.has(resolvedPath));
}

function resolveSkillPreludePath(rawPath: string, cwd?: string): string {
  const expanded = rawPath.startsWith("~") ? expandHomePrefix(rawPath) : rawPath;
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(cwd?.trim() || process.cwd(), expanded);
}

function isSkillMarkdownPreludePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const lowerNormalized = normalizeLowercaseStringOrEmpty(normalized);
  if (!lowerNormalized.endsWith("/skill.md")) {
    return false;
  }
  const parts = lowerNormalized.split("/").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] !== "skills") {
      continue;
    }
    const segmentsAfterSkills = parts.length - index - 1;
    if (segmentsAfterSkills === 1 || segmentsAfterSkills === 2) {
      return true;
    }
  }
  return false;
}

function resolveSkillMarkdownPreludeId(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const lowerNormalized = normalizeLowercaseStringOrEmpty(normalized);
  if (!lowerNormalized.endsWith("/skill.md")) {
    return null;
  }
  const parts = lowerNormalized.split("/").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] !== "skills") {
      continue;
    }
    if (parts.length - index - 1 !== 2) {
      continue;
    }
    const skillId = parts[index + 1]?.trim();
    return skillId || null;
  }
  return null;
}

function isSkillPreludeReadSegment(segment: ExecCommandSegment, cwd?: string): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  if (normalizeLowercaseStringOrEmpty(execution?.executableName) !== "cat") {
    return false;
  }
  // Keep the display-prelude exception narrow: only a plain `cat <...>/SKILL.md`
  // qualifies, not extra argv forms or arbitrary file reads.
  if (segment.argv.length !== 2) {
    return false;
  }
  const rawPath = segment.argv[1]?.trim();
  if (!rawPath) {
    return false;
  }
  return isSkillMarkdownPreludePath(resolveSkillPreludePath(rawPath, cwd));
}

function isSkillPreludeMarkerSegment(segment: ExecCommandSegment): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  if (normalizeLowercaseStringOrEmpty(execution?.executableName) !== "printf") {
    return false;
  }
  if (segment.argv.length !== 2) {
    return false;
  }
  const marker = segment.argv[1];
  return marker === "\\n---CMD---\\n" || marker === "\n---CMD---\n";
}

function isSkillPreludeSegment(segment: ExecCommandSegment, cwd?: string): boolean {
  return isSkillPreludeReadSegment(segment, cwd) || isSkillPreludeMarkerSegment(segment);
}

function isSkillPreludeOnlyEvaluation(
  segments: ExecCommandSegment[],
  cwd: string | undefined,
): boolean {
  return segments.length > 0 && segments.every((segment) => isSkillPreludeSegment(segment, cwd));
}

function resolveSkillPreludeIds(
  segments: ExecCommandSegment[],
  cwd: string | undefined,
): ReadonlySet<string> {
  const skillIds = new Set<string>();
  for (const segment of segments) {
    if (!isSkillPreludeReadSegment(segment, cwd)) {
      continue;
    }
    const rawPath = segment.argv[1]?.trim();
    if (!rawPath) {
      continue;
    }
    const skillId = resolveSkillMarkdownPreludeId(resolveSkillPreludePath(rawPath, cwd));
    if (skillId) {
      skillIds.add(skillId);
    }
  }
  return skillIds;
}

function resolveAllowlistedSkillWrapperId(segment: ExecCommandSegment): string | null {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  const executableName = normalizeExecutableToken(
    execution?.executableName ?? segment.argv[0] ?? "",
  );
  if (!executableName.endsWith("-wrapper")) {
    return null;
  }
  const skillId = executableName.slice(0, -"-wrapper".length).trim();
  return skillId || null;
}

function resolveTrustedSkillExecutionIds(params: {
  analysis: ExecCommandAnalysis;
  evaluation: ExecAllowlistEvaluation;
}): ReadonlySet<string> {
  const skillIds = new Set<string>();
  if (!params.evaluation.allowlistSatisfied) {
    return skillIds;
  }
  for (const [index, segment] of params.analysis.segments.entries()) {
    const satisfiedBy = params.evaluation.segmentSatisfiedBy[index];
    if (satisfiedBy === "skills") {
      const execution = resolveExecutionTargetResolution(segment.resolution);
      const executableName = normalizeExecutableToken(
        execution?.executableName ?? execution?.rawExecutable ?? segment.argv[0] ?? "",
      );
      if (executableName) {
        skillIds.add(executableName);
      }
      continue;
    }
    if (satisfiedBy !== "allowlist") {
      continue;
    }
    const wrapperSkillId = resolveAllowlistedSkillWrapperId(segment);
    if (wrapperSkillId) {
      skillIds.add(wrapperSkillId);
    }
  }
  return skillIds;
}

const MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH = 3;

type InlineChainAllowlistEvaluation = {
  matches: ExecAllowlistEntry[];
  satisfiedBy: "allowlist";
};

type SegmentMatchEvaluation = {
  effectiveArgv: string[];
  inlineCommand: string | null;
  match: ExecAllowlistEntry | null;
};

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

function resolveSegmentAllowlistMatch(params: {
  segment: ExecCommandSegment;
  context: ExecAllowlistContext;
}): SegmentMatchEvaluation {
  const effectiveArgv =
    params.segment.resolution?.effectiveArgv && params.segment.resolution.effectiveArgv.length > 0
      ? params.segment.resolution.effectiveArgv
      : params.segment.argv;
  const allowlistSegment =
    effectiveArgv === params.segment.argv
      ? params.segment
      : { ...params.segment, argv: effectiveArgv };
  const executableResolution = resolvePolicyTargetResolution(params.segment.resolution);
  const candidatePath = resolvePolicyTargetCandidatePath(
    params.segment.resolution,
    params.context.cwd,
  );
  const candidateResolution =
    candidatePath && executableResolution
      ? { ...executableResolution, resolvedPath: candidatePath }
      : executableResolution;
  const inlineCommand = extractShellWrapperInlineCommand(allowlistSegment.argv);
  const isPositionalCarrierInvocation =
    inlineCommand !== null && isDirectShellPositionalCarrierInvocation(inlineCommand);
  const executableMatch = isPositionalCarrierInvocation
    ? null
    : matchAllowlist(
        params.context.allowlist,
        candidateResolution,
        effectiveArgv,
        params.context.platform,
      );
  const shellPositionalArgvCandidatePath = resolveShellWrapperPositionalArgvCandidatePath({
    segment: allowlistSegment,
    cwd: params.context.cwd,
    env: params.context.env,
  });
  const shellPositionalArgvMatch = shellPositionalArgvCandidatePath
    ? matchAllowlist(
        params.context.allowlist,
        {
          rawExecutable: shellPositionalArgvCandidatePath,
          resolvedPath: shellPositionalArgvCandidatePath,
          executableName: path.basename(shellPositionalArgvCandidatePath),
        },
        undefined,
        params.context.platform,
      )
    : null;
  const shellScriptCandidatePath =
    inlineCommand === null
      ? resolveShellWrapperScriptCandidatePath({
          segment: allowlistSegment,
          cwd: params.context.cwd,
        })
      : undefined;
  const shellScriptArgv = shellScriptCandidatePath
    ? resolveShellWrapperScriptArgv({
        shellScriptCandidatePath,
        effectiveArgv,
        cwd: params.context.cwd,
      })
    : null;
  const shellScriptMatch =
    shellScriptCandidatePath && shellScriptArgv
      ? matchAllowlist(
          params.context.allowlist,
          {
            rawExecutable: shellScriptCandidatePath,
            resolvedPath: shellScriptCandidatePath,
            executableName: path.basename(shellScriptCandidatePath),
          },
          shellScriptArgv,
          params.context.platform,
        )
      : null;
  return {
    effectiveArgv,
    inlineCommand,
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
  const skillAllow = isSkillAutoAllowedSegment({
    segment: params.segment,
    allowSkills: params.allowSkills,
    skillBinTrust: params.skillBinTrust,
  });
  return skillAllow ? "skills" : null;
}

function resolveInlineChainFallback(params: {
  by: ExecSegmentSatisfiedBy;
  inlineCommand: string | null;
  context: ExecAllowlistContext;
  inlineDepth: number;
}): InlineChainAllowlistEvaluation | null {
  if (params.by !== null || !params.inlineCommand) {
    return null;
  }
  const inlineChainParts = splitCommandChain(params.inlineCommand);
  if (!inlineChainParts || inlineChainParts.length <= 1) {
    return null;
  }
  return evaluateShellWrapperInlineChain({
    inlineCommand: params.inlineCommand,
    context: params.context,
    inlineDepth: params.inlineDepth + 1,
    precomputedChainParts: inlineChainParts,
  });
}

function evaluateShellWrapperInlineChain(params: {
  inlineCommand: string;
  context: ExecAllowlistContext;
  inlineDepth: number;
  precomputedChainParts?: string[];
}): InlineChainAllowlistEvaluation | null {
  if (params.inlineDepth >= MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH) {
    return null;
  }
  if (isWindowsPlatform(params.context.platform)) {
    return null;
  }
  const chainParts = params.precomputedChainParts ?? splitCommandChain(params.inlineCommand);
  if (!chainParts || chainParts.length <= 1) {
    return null;
  }

  const matches: ExecAllowlistEntry[] = [];
  for (const part of chainParts) {
    const analysis = analyzeShellCommand({
      command: part,
      cwd: params.context.cwd,
      env: params.context.env,
      platform: params.context.platform,
    });
    if (!analysis.ok) {
      return null;
    }
    const result = evaluateSegments(analysis.segments, params.context, params.inlineDepth);
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
  inlineDepth: number = 0,
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
    const inlineResult = resolveInlineChainFallback({
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
  if (!isDirectShellPositionalCarrierInvocation(inlineMatch.command)) {
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

  const resolution = resolveCommandResolutionFromArgv([carriedExecutable], params.cwd, params.env);
  return resolveExecutionTargetCandidatePath(resolution, params.cwd);
}

function isDirectShellPositionalCarrierInvocation(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const shellWhitespace = String.raw`[^\S\r\n]+`;
  const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
  const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
  return new RegExp(
    `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`,
    "u",
  ).test(trimmed);
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

  const trustPlan = resolveExecWrapperTrustPlan(params.segment.argv);
  if (trustPlan.policyBlocked) {
    return;
  }
  const segment =
    trustPlan.argv === params.segment.argv
      ? params.segment
      : {
          raw: trustPlan.argv.join(" "),
          argv: trustPlan.argv,
          resolution: resolveCommandResolutionFromArgv(trustPlan.argv, params.cwd, params.env),
        };

  const candidatePath = resolveExecutionTargetCandidatePath(segment.resolution, params.cwd);
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
  const positionalArgvPath = resolveShellWrapperPositionalArgvCandidatePath({
    segment,
    cwd: params.cwd,
    env: params.env,
  });
  if (positionalArgvPath) {
    addAllowAlwaysPattern(params.out, positionalArgvPath);
    return;
  }
  const isPowerShellFileInvocation =
    POWERSHELL_WRAPPERS.has(normalizeExecutableToken(segment.argv[0] ?? "")) &&
    segment.argv.some((t) => {
      const lower = normalizeLowercaseStringOrEmpty(t);
      return lower === "-file" || lower === "-f";
    }) &&
    !segment.argv.some((t) => {
      const lower = normalizeLowercaseStringOrEmpty(t);
      return lower === "-command" || lower === "-c" || lower === "--command";
    });
  const inlineCommand = isPowerShellFileInvocation
    ? null
    : (trustPlan.shellInlineCommand ?? extractShellWrapperInlineCommand(segment.argv));
  if (!inlineCommand) {
    const scriptPath = resolveShellWrapperScriptCandidatePath({
      segment,
      cwd: params.cwd,
    });
    if (scriptPath) {
      const argPattern = buildScriptArgPatternFromArgv(
        params.segment.argv,
        scriptPath,
        params.cwd,
        params.platform,
      );
      addAllowAlwaysPattern(params.out, scriptPath, argPattern);
    }
    return;
  }
  const nested = analyzeShellCommand({
    command: inlineCommand,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!nested.ok) {
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
  const allowlistContext = pickExecAllowlistContext(params);
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

  const chainParts = isWindowsPlatform(params.platform)
    ? null
    : splitCommandChainWithOperators(params.command);
  if (!chainParts) {
    const analysis = analyzeShellCommand({
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

  const chainEvaluations = chainParts.map(({ part, opToNext }) => {
    const analysis = analyzeShellCommand({
      command: part,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!analysis.ok) {
      return null;
    }
    return {
      analysis,
      evaluation: evaluateExecAllowlist({ analysis, ...allowlistContext }),
      opToNext,
    };
  });
  if (chainEvaluations.some((entry) => entry === null)) {
    return analysisFailure();
  }

  const finalizedEvaluations = chainEvaluations as Array<{
    analysis: ExecCommandAnalysis;
    evaluation: ExecAllowlistEvaluation;
    opToNext: ShellChainOperator | null;
  }>;
  const allowSkillPreludeAtIndex = new Set<number>();
  const reachableSkillIds = new Set<string>();
  // Only allow the `cat SKILL.md && printf ...` display prelude when it sits on a
  // contiguous `&&` chain that actually reaches a later trusted skill-wrapper execution.
  for (let index = finalizedEvaluations.length - 1; index >= 0; index -= 1) {
    const { analysis, evaluation, opToNext } = finalizedEvaluations[index];
    const trustedSkillIds = resolveTrustedSkillExecutionIds({
      analysis,
      evaluation,
    });
    if (trustedSkillIds.size > 0) {
      for (const skillId of trustedSkillIds) {
        reachableSkillIds.add(skillId);
      }
      continue;
    }

    const isPreludeOnly =
      !evaluation.allowlistSatisfied && isSkillPreludeOnlyEvaluation(analysis.segments, params.cwd);
    const preludeSkillIds = isPreludeOnly
      ? resolveSkillPreludeIds(analysis.segments, params.cwd)
      : new Set<string>();
    const reachesTrustedSkillExecution =
      opToNext === "&&" &&
      (preludeSkillIds.size === 0
        ? reachableSkillIds.size > 0
        : [...preludeSkillIds].some((skillId) => reachableSkillIds.has(skillId)));
    if (isPreludeOnly && reachesTrustedSkillExecution) {
      allowSkillPreludeAtIndex.add(index);
      continue;
    }

    reachableSkillIds.clear();
  }
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segments: ExecCommandSegment[] = [];
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  for (const [index, { analysis, evaluation }] of finalizedEvaluations.entries()) {
    const effectiveSegmentSatisfiedBy = allowSkillPreludeAtIndex.has(index)
      ? analysis.segments.map(() => "skillPrelude" as const)
      : evaluation.segmentSatisfiedBy;
    const effectiveSegmentAllowlistEntries = allowSkillPreludeAtIndex.has(index)
      ? analysis.segments.map(() => null)
      : evaluation.segmentAllowlistEntries;

    segments.push(...analysis.segments);
    allowlistMatches.push(...evaluation.allowlistMatches);
    segmentAllowlistEntries.push(...effectiveSegmentAllowlistEntries);
    segmentSatisfiedBy.push(...effectiveSegmentSatisfiedBy);
    if (!evaluation.allowlistSatisfied && !allowSkillPreludeAtIndex.has(index)) {
      return {
        analysisOk: true,
        allowlistSatisfied: false,
        allowlistMatches,
        segments,
        segmentAllowlistEntries,
        segmentSatisfiedBy,
      };
    }
  }

  return {
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches,
    segments,
    segmentAllowlistEntries,
    segmentSatisfiedBy,
  };
}
