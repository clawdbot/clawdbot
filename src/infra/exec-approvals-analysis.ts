import type { ExecCommandSegment } from "./exec-command-analysis-types.js";
// Shared exec approval analysis types and Windows-only shell enforcement helpers.
import { rebuildWindowsShellCommandFromSource, windowsEscapeArg } from "./windows-shell-command.js";

export { analyzeArgvCommand } from "./exec-argv-analysis.js";

export {
  matchAllowlist,
  parseExecArgvToken,
  resolveAllowlistCandidatePath,
  resolveApprovalAuditCandidatePath,
  resolveApprovalAuditTrustPath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveExecutionTargetTrustPath,
  resolvePolicyAllowlistCandidatePath,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  resolvePolicyTargetTrustPath,
  resolveExecutableTrustPath,
  type CommandResolution,
  type ExecutableResolution,
  type ExecArgvToken,
} from "./exec-command-resolution.js";

export {
  analyzeWindowsShellCommand,
  isWindowsPlatform,
  tokenizeWindowsSegment,
  windowsEscapeArg,
} from "./windows-shell-command.js";
export type {
  ExecCommandAnalysis,
  ExecCommandSegment,
  ShellChainOperator,
} from "./exec-command-analysis-types.js";

function renderWindowsQuotedArgv(argv: readonly string[]):
  | { ok: true; rendered: string }
  | {
      ok: false;
      reason: string;
    } {
  const parts: string[] = [];
  for (const token of argv) {
    const result = windowsEscapeArg(token);
    if (!result.ok) {
      return { ok: false, reason: `unsafe windows token: ${token}` };
    }
    parts.push(result.escaped);
  }
  return { ok: true, rendered: parts.join(" ") };
}

export function resolvePlannedSegmentArgv(segment: ExecCommandSegment): string[] | null {
  if (segment.resolution?.policyBlocked === true) {
    return null;
  }
  const baseArgv =
    segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
      ? segment.resolution.effectiveArgv
      : segment.argv;
  if (baseArgv.length === 0) {
    return null;
  }
  const argv = [...baseArgv];
  const execution = segment.resolution?.execution;
  const resolvedExecutable =
    execution?.resolvedRealPath?.trim() ?? execution?.resolvedPath?.trim() ?? "";
  if (resolvedExecutable) {
    argv[0] = resolvedExecutable;
  }
  return argv;
}

export function buildEnforcedShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  if (params.platform !== "win32") {
    return { ok: false, reason: "unsupported platform" };
  }

  const rebuilt = rebuildWindowsShellCommandFromSource({
    command: params.command,
    renderSegment: (_raw, segmentIndex) => {
      const segment = params.segments[segmentIndex];
      if (!segment) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const argv = resolvePlannedSegmentArgv(segment);
      if (!argv) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      return renderWindowsQuotedArgv(argv);
    },
  });
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  if (rebuilt.segmentCount !== params.segments.length) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rebuilt.command };
}
