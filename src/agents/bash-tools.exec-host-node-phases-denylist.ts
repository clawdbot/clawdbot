import type { InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import {
  evaluateExecDenylist,
  type ExecDenylistEntry,
  formatExecDenylistWarning,
} from "../infra/exec-approvals-denylist.js";
import {
  type AllowAlwaysPersistenceDecision,
  type ExecAsk,
  evaluateShellAllowlistWithAuthorization,
  type ExecCommandSegment,
  type ExecSecurity,
} from "../infra/exec-approvals.js";

export type NodePolicyCommandEval = {
  command: string;
  cwd: string | undefined;
  allowlistEval: {
    analysisOk: boolean;
    segments: readonly ExecCommandSegment[];
  };
};

export type NodeApprovalAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
  nodeApprovalPolicyKnown: boolean;
  nodeSecurity?: ExecSecurity;
  nodeAsk?: ExecAsk;
  inlineEvalHit: InterpreterInlineEvalHit | null;
  requiresSecurityAuditSuppressionApproval: boolean;
  requiresDenylistApproval: boolean;
  denylistWarning: string | null;
  denylistScreenings: NodeDenylistAnalysis["denylistScreenings"];
  autoReviewArgv?: string[];
  allowAlwaysPersistence: AllowAlwaysPersistenceDecision;
};

type NodeDenylistAnalysis = {
  requiresDenylistApproval: boolean;
  denylistWarning: string | null;
  denylistScreenings: readonly {
    command: string;
    segments: readonly ExecCommandSegment[];
    analysisOk: boolean;
  }[];
};

export async function addNodePolicyCommandEval(
  entries: NodePolicyCommandEval[],
  params: {
    command: string | null | undefined;
    cwd: string | undefined;
    env: NodeJS.ProcessEnv;
    platform?: string | null;
    trustedSafeBinDirs?: ReadonlySet<string>;
  },
): Promise<void> {
  const normalizedCommand = params.command?.trim();
  if (!normalizedCommand) {
    return;
  }
  if (
    entries.some((entry) => entry.command.trim() === normalizedCommand && entry.cwd === params.cwd)
  ) {
    return;
  }
  entries.push({
    command: normalizedCommand,
    cwd: params.cwd,
    allowlistEval: await evaluateShellAllowlistWithAuthorization({
      command: normalizedCommand,
      allowlist: [],
      safeBins: new Set(),
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
    }),
  });
}

export function analyzeNodeDenylistRequirement(params: {
  policyCommandEvals: readonly NodePolicyCommandEval[];
  effectiveDenylist: readonly ExecDenylistEntry[];
  analysisOk: boolean;
}): NodeDenylistAnalysis {
  let denylistWarning: string | null = null;
  let requiresDenylistApproval = false;
  for (const entry of params.policyCommandEvals) {
    const denylistEvaluation = evaluateExecDenylist({
      command: entry.command,
      segments: entry.allowlistEval.segments,
      denylist: params.effectiveDenylist,
      analysisOk: params.analysisOk,
    });
    if (denylistEvaluation.match) {
      requiresDenylistApproval = true;
      denylistWarning = formatExecDenylistWarning(denylistEvaluation.match);
      break;
    }
    if (denylistEvaluation.conservativeApproval) {
      requiresDenylistApproval = true;
      denylistWarning =
        "Warning: command could not be screened against the exec denylist; explicit approval is required.";
    }
  }
  return {
    requiresDenylistApproval,
    denylistWarning,
    denylistScreenings: params.policyCommandEvals.map((entry) => ({
      command: entry.command,
      segments: entry.allowlistEval.segments,
      analysisOk: entry.allowlistEval.analysisOk,
    })),
  };
}
