import type { ExecHost } from "../infra/exec-approvals.js";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { renderExecOutputText } from "./bash-tools.exec-output.js";
import type { ExecToolArgs } from "./bash-tools.exec-request-preparation.js";
import { type ExecProcessOutcome, resolveExecTarget } from "./bash-tools.exec-runtime.js";
import type {
  ExecToolApprovalReview,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { failedTextResult, textResult } from "./tools/common.js";

export function attachExecApprovalReview(
  result: AgentToolResult<ExecToolDetails>,
  review?: ExecToolApprovalReview,
): AgentToolResult<ExecToolDetails> {
  if (review) {
    result.details.approvalReviews = [review];
    result.details.approvalReviewOutcome = review.status === "approved" ? "approved" : "denied";
  }
  return result;
}

export function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
  aggregateOutputDropped?: boolean;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  const retentionCapNote = params.aggregateOutputDropped
    ? "\n\n[earlier output was discarded at the retention cap and cannot be recovered]"
    : "";
  if (params.outcome.status === "failed") {
    const linuxOomGuidance =
      params.outcome.failureKind === "signal" &&
      params.outcome.exitReason === "signal" &&
      params.outcome.oomScoreWrapperSelected === true &&
      (params.outcome.exitSignal === "SIGKILL" || params.outcome.exitSignal === 9)
        ? "\n\nOpenClaw selected its Linux OOM-score wrapper, which attempts to set this child's oom_score_adj to 1000. " +
          "SIGKILL alone does not identify whether the Linux OOM killer, an operator, or another process sent it. " +
          "Check cgroup memory events or kernel logs. If they show memory pressure, narrow the command or adjust memory, concurrency, or resource limits."
        : "";
    const outputText = `${warningText}${params.outcome.reason}${linuxOomGuidance}${retentionCapNote}`;
    return failedTextResult(outputText, {
      status: "failed",
      exitCode: params.outcome.exitCode ?? null,
      exitSignal: params.outcome.exitSignal,
      failureKind: params.outcome.failureKind,
      exitReason: params.outcome.exitReason,
      durationMs: params.outcome.durationMs,
      aggregated: params.outcome.aggregated,
      timedOut: params.outcome.timedOut,
      noOutputTimedOut: params.outcome.noOutputTimedOut,
      cwd: params.cwd,
    });
  }
  const outputText = `${warningText}${renderExecOutputText(params.outcome.aggregated)}${retentionCapNote}`;
  return textResult(outputText, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    exitSignal: params.outcome.exitSignal,
    exitReason: params.outcome.exitReason,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
    noOutputTimedOut: params.outcome.noOutputTimedOut,
    cwd: params.cwd,
  });
}

export function resolveExecReviewerDefaults(params: {
  defaults?: ExecToolDefaults;
  agentId?: string;
}) {
  if (params.defaults?.reviewer) {
    return params.defaults.reviewer;
  }
  const cfg = params.defaults?.config;
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const agentExec = agentId && cfg ? resolveAgentConfig(cfg, agentId)?.tools?.exec : undefined;
  return agentExec?.reviewer ?? cfg?.tools?.exec?.reviewer;
}

export function createExecHostResolver(defaults?: ExecToolDefaults) {
  return (params: ExecToolArgs): ExecHost => {
    const elevatedDefaults = defaults?.elevated;
    const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
    const elevatedDefaultMode =
      elevatedDefaults?.defaultLevel === "full"
        ? "full"
        : elevatedDefaults?.defaultLevel === "ask"
          ? "ask"
          : elevatedDefaults?.defaultLevel === "on"
            ? "ask"
            : "off";
    const effectiveDefaultMode =
      elevatedAllowed && !defaults?.sandboxRequired ? elevatedDefaultMode : "off";
    const elevatedMode =
      typeof params.elevated === "boolean"
        ? params.elevated
          ? elevatedDefaultMode === "full"
            ? "full"
            : "ask"
          : "off"
        : effectiveDefaultMode;
    const requestedTarget = requireValidExecTarget(params.host);
    return resolveExecTarget({
      configuredTarget: defaults?.host,
      requestedTarget,
      elevatedRequested: elevatedMode !== "off",
      sandboxAvailable: Boolean(defaults?.sandbox),
      sandboxRequired: defaults?.sandboxRequired,
    }).effectiveHost;
  };
}
