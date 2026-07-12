import { expectDefined } from "@openclaw/normalization-core";
/** Resolves system.run allowlist matches, argv plans, and truncated command output. */
import {
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlistWithAuthorization,
  resolvePlannedSegmentArgv,
  type ExecAllowlistEntry,
  type ExecApprovalsResolved,
  type ExecCommandSegment,
  type ExecSegmentSatisfiedBy,
  type ExecSecurity,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import type { ExecAuthorizationPlan } from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  normalizeExecutableToken,
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../infra/exec-wrapper-resolution.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import type { RunResult } from "./invoke-types.js";

/**
 * Allowlist analysis and argv rewriting for node-host system.run.
 *
 * This module keeps command approval analysis separate from process execution,
 * and only rewrites shell transports when the rebuilt command still satisfies policy.
 */
const POSIX_SHELL_WRAPPER_NAMES: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;

type SystemRunAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  allowlistSatisfied: boolean;
  allowlistAuthorizationSatisfied: boolean;
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan?: ExecAuthorizationPlan;
};

/** Evaluates analyzed command segments against allowlist and trusted safe-bin policy. */
export async function evaluateSystemRunAllowlist(params: {
  shellCommand: string | null;
  argv: string[];
  approvals: ExecApprovalsResolved;
  security: ExecSecurity;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
}): Promise<SystemRunAllowlistAnalysis> {
  if (params.shellCommand) {
    const allowlistEval = await evaluateShellAllowlistWithAuthorization({
      command: params.shellCommand,
      allowlist: params.approvals.allowlist,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      cwd: params.cwd,
      env: params.env,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
      platform: process.platform,
    });
    return {
      analysisOk: allowlistEval.analysisOk,
      allowlistMatches: allowlistEval.allowlistMatches,
      allowlistSatisfied:
        params.security === "allowlist" && allowlistEval.analysisOk
          ? allowlistEval.allowlistSatisfied
          : false,
      allowlistAuthorizationSatisfied: allowlistEval.analysisOk && allowlistEval.allowlistSatisfied,
      segments: allowlistEval.segments,
      segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
      segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
      ...(allowlistEval.authorizationPlan
        ? { authorizationPlan: allowlistEval.authorizationPlan }
        : {}),
    };
  }

  const analysis = analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
  const allowlistEval = evaluateExecAllowlist({
    analysis,
    allowlist: params.approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  });
  return {
    analysisOk: analysis.ok,
    allowlistMatches: allowlistEval.allowlistMatches,
    allowlistSatisfied:
      params.security === "allowlist" && analysis.ok ? allowlistEval.allowlistSatisfied : false,
    allowlistAuthorizationSatisfied: analysis.ok && allowlistEval.allowlistSatisfied,
    segments: analysis.segments,
    segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
    segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
  };
}

/** Resolve the single planned argv that can replace the caller argv after allowlist approval. */
export function resolvePlannedAllowlistArgv(params: {
  security: ExecSecurity;
  shellCommand: string | null;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  segments: ExecCommandSegment[];
}): string[] | undefined | null {
  if (
    params.security !== "allowlist" ||
    params.policy.approvedByAsk ||
    params.shellCommand ||
    !params.policy.analysisOk ||
    !params.policy.allowlistSatisfied ||
    params.segments.length !== 1
  ) {
    return undefined;
  }
  const plannedAllowlistArgv = resolvePlannedSegmentArgv(
    expectDefined(params.segments[0], "segments entry at 0"),
  );
  return plannedAllowlistArgv && plannedAllowlistArgv.length > 0 ? plannedAllowlistArgv : null;
}

/** Resolve final argv after safe-bin shell rewriting. */
export async function resolveSystemRunExecArgv(params: {
  plannedAllowlistArgv: string[] | undefined;
  argv: string[];
  security: ExecSecurity;
  approvals: ExecApprovalsResolved;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
  isWindows: boolean;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  shellCommand: string | null;
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan: ExecAuthorizationPlan | undefined;
  cwd: string | undefined;
  env: Record<string, string> | undefined;
}): Promise<string[] | null> {
  let execArgv = params.plannedAllowlistArgv ?? params.argv;
  if (
    params.security === "allowlist" &&
    params.isWindows &&
    !params.policy.approvedByAsk &&
    params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied &&
    params.segments.length === 1
  ) {
    // Exact-path matches stay bound to the resolved executable, while the bare
    // wildcard contract can still authorize unresolved Windows commands.
    const plannedArgv = resolvePlannedSegmentArgv(
      expectDefined(params.segments[0], "segments entry at 0"),
    );
    if (!plannedArgv) {
      return null;
    }
    execArgv = plannedArgv;
  }
  if (
    params.security === "allowlist" &&
    !params.isWindows &&
    !params.policy.approvedByAsk &&
    params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied &&
    params.segmentSatisfiedBy.some((entry) => entry === "safeBins" || entry === "inlineChain") &&
    isPosixShellInlineCommandTransport(params.argv)
  ) {
    if (!params.authorizationPlan) {
      return null;
    }
    const rebuilt = buildAuthorizedShellCommandFromPlan({
      plan: params.authorizationPlan,
      mode: "safeBins",
      segmentSatisfiedBy: params.segmentSatisfiedBy,
    });
    if (!rebuilt.ok || !rebuilt.command) {
      return null;
    }
    const rewrittenArgv = replacePosixShellInlineCommand({
      argv: params.argv,
      oldCommand: params.shellCommand,
      nextCommand: rebuilt.command,
    });
    if (!rewrittenArgv) {
      return null;
    }
    execArgv = rewrittenArgv;
  }
  return execArgv;
}

function isPosixShellInlineCommandTransport(argv: string[]): boolean {
  const transportArgv = resolveShellWrapperTransportArgv(argv);
  return Boolean(
    transportArgv &&
    POSIX_SHELL_WRAPPER_NAMES.has(normalizeExecutableToken(transportArgv[0] ?? "")),
  );
}

function findSubsequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}

function replacePosixShellInlineCommand(params: {
  argv: string[];
  oldCommand: string;
  nextCommand: string;
}): string[] | null {
  const transportArgv = resolveShellWrapperTransportArgv(params.argv);
  if (
    !transportArgv ||
    !POSIX_SHELL_WRAPPER_NAMES.has(normalizeExecutableToken(transportArgv[0] ?? ""))
  ) {
    return null;
  }
  const transportStart = findSubsequence(params.argv, transportArgv);
  if (transportStart < 0) {
    return null;
  }
  const match = resolveInlineCommandMatch(transportArgv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (match.valueTokenIndex === null) {
    return null;
  }
  const absoluteValueIndex = transportStart + match.valueTokenIndex;
  const token = params.argv[absoluteValueIndex];
  if (token === undefined) {
    return null;
  }
  const rewritten = [...params.argv];
  if (token === params.oldCommand) {
    rewritten[absoluteValueIndex] = params.nextCommand;
    return rewritten;
  }
  if (token.endsWith(params.oldCommand)) {
    // Combined shell flags can leave the inline command in a suffix of the same argv token.
    rewritten[absoluteValueIndex] =
      token.slice(0, token.length - params.oldCommand.length) + params.nextCommand;
    return rewritten;
  }
  return null;
}

/** Mark truncated output in stderr when possible, otherwise stdout. */
/** Truncates captured stdout/stderr in place to the node-host output cap. */
export function applyOutputTruncation(result: RunResult): void {
  if (!result.truncated) {
    return;
  }
  const suffix = "... (truncated)";
  if (result.stderr.trim().length > 0) {
    result.stderr = `${result.stderr}\n${suffix}`;
  } else {
    result.stdout = `${result.stdout}\n${suffix}`;
  }
}
