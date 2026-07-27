// Focused exec auto-review helpers for plugin-owned agent harnesses.
//
// Keep this out of agent-harness-runtime: model-backed review construction
// reaches provider/auth discovery and would create an architecture cycle through
// the broad harness barrel.

import type { ExecAutoReviewHost } from "../infra/exec-auto-review.js";

export async function reviewExecRequestWithConfiguredModel(params: {
  cfg?: import("../config/types.openclaw.js").OpenClawConfig;
  agentId?: string;
  reviewer?: unknown;
  input: import("../infra/exec-auto-review.js").ExecAutoReviewInput;
}): Promise<import("../infra/exec-auto-review.js").ExecAutoReviewDecision> {
  const { createModelExecAutoReviewer } = await import("../agents/exec-auto-reviewer.js");
  const reviewer = createModelExecAutoReviewer({
    cfg: params.cfg,
    agentId: params.agentId,
    reviewer: params.reviewer as
      | import("../agents/exec-auto-reviewer.js").ExecReviewerConfig
      | undefined,
  });
  return reviewer(params.input);
}

export async function buildExecAutoReviewInputForShellCommand(params: {
  command: string;
  cwd?: string | null;
  host: import("../infra/exec-auto-review.js").ExecAutoReviewHost;
  envKeys?: readonly string[];
  agent?: {
    id?: string | null;
    sessionKey?: string | null;
  };
}): Promise<import("../infra/exec-auto-review.js").ExecAutoReviewInput | undefined> {
  const [
    { commandRequiresSecurityAuditSuppressionApproval, evaluateShellAllowlistWithAuthorization },
    { detectUnsafeExecControlShellCommand },
    { detectPolicyInlineEval },
  ] = await Promise.all([
    import("../infra/exec-approvals.js"),
    import("../infra/exec-control-command-guard.js"),
    import("../infra/command-analysis/policy.js"),
  ]);
  const command = params.command.trim();
  const host: ExecAutoReviewHost = params.host;
  if (!command) {
    return undefined;
  }
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command,
    allowlist: [],
    safeBins: new Set<string>(),
    cwd: params.cwd ?? undefined,
    platform: process.platform,
  });
  const [segment] = allowlistEval.segments;
  const boundSingleCommand =
    allowlistEval.analysisOk &&
    allowlistEval.segments.length === 1 &&
    segment !== undefined &&
    segment.raw.trim() === command;
  if (!boundSingleCommand) {
    return undefined;
  }
  if (
    commandRequiresSecurityAuditSuppressionApproval({
      command,
      cwd: params.cwd ?? undefined,
      segments: allowlistEval.segments,
    })
  ) {
    return undefined;
  }
  if ((await detectUnsafeExecControlShellCommand(command)) !== null) {
    return undefined;
  }
  const inlineEval = detectPolicyInlineEval(allowlistEval.segments) !== null;
  const heredoc = segment.argv.some((token) => token.startsWith("<<"));
  return {
    command,
    argv: segment.argv,
    cwd: params.cwd ?? null,
    envKeys: params.envKeys,
    host,
    reason: inlineEval ? "strict-inline-eval" : heredoc ? "heredoc" : "approval-required",
    analysis: {
      parsed: true,
      allowlistMatched: false,
      inlineEval,
      ...(heredoc ? { heredoc } : {}),
    },
    agent: params.agent,
  };
}
