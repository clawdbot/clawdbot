import {
  buildExecDenylistRuleKey,
  evaluateExecDenylist,
  type ExecDenylistEntry,
  formatExecDenylistWarning,
  resolveEffectiveExecDenylist,
} from "../infra/exec-approvals-denylist.js";
import type {
  ExecApprovalUsageAuthorization,
  ExecCommandSegment,
} from "../infra/exec-approvals.js";

export function buildGatewayDenylistAuthorization(params: {
  command: string;
  segments: readonly ExecCommandSegment[];
  analysisOk: boolean;
  execConfigDenylist?: readonly ExecDenylistEntry[];
  resolveCurrentExecConfigDenylist?: () => readonly ExecDenylistEntry[];
  enforcedCommand?: string;
  fallbackEnforcedCommand?: string;
}): ExecApprovalUsageAuthorization["denylistBinding"] {
  const enforcedTexts = [params.enforcedCommand, params.fallbackEnforcedCommand].filter(
    (text): text is string => typeof text === "string" && text.trim().length > 0,
  );
  const segments =
    enforcedTexts.length > 0
      ? [...params.segments, ...enforcedTexts.map((raw) => ({ argv: [], raw }))]
      : params.segments;
  return {
    command: params.command,
    segments,
    analysisOk: params.analysisOk,
    configDenylist: params.execConfigDenylist ?? [],
    ...(params.resolveCurrentExecConfigDenylist
      ? { resolveCurrentConfigDenylist: params.resolveCurrentExecConfigDenylist }
      : {}),
    approvedRuleKeys: resolveEffectiveExecDenylist({
      layers: [params.execConfigDenylist],
    }).map(buildExecDenylistRuleKey),
  };
}

export function evaluateGatewayDenylistApproval(params: {
  command: string;
  segments: readonly ExecCommandSegment[];
  analysisOk: boolean;
  execConfigDenylist?: readonly ExecDenylistEntry[];
}): { requiresApproval: boolean; warning: string | null } {
  const evaluation = evaluateExecDenylist({
    command: params.command,
    segments: params.segments,
    denylist: resolveEffectiveExecDenylist({
      layers: [params.execConfigDenylist],
    }),
    analysisOk: params.analysisOk,
  });
  if (evaluation.match) {
    return { requiresApproval: true, warning: formatExecDenylistWarning(evaluation.match) };
  }
  if (evaluation.conservativeApproval) {
    return {
      requiresApproval: true,
      warning:
        "Warning: command could not be screened against the exec denylist; explicit approval is required.",
    };
  }
  return { requiresApproval: false, warning: null };
}
