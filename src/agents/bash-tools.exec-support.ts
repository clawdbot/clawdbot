import type { ExecHost } from "../infra/exec-approvals.js";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { renderExecOutputText } from "./bash-tools.exec-output.js";
import type { ExecToolArgs } from "./bash-tools.exec-request-preparation.js";
import { type ExecProcessOutcome, resolveExecTarget } from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { failedTextResult, textResult } from "./tools/common.js";

export function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  if (params.outcome.status === "failed") {
    return failedTextResult(`${warningText}${params.outcome.reason}`, {
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
  return textResult(`${warningText}${renderExecOutputText(params.outcome.aggregated)}`, {
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

export function resolveExecElevatedMode(params: {
  defaults?: ExecElevatedDefaults;
  requested?: boolean;
}): "full" | "ask" | "off" {
  const defaultMode =
    params.defaults?.defaultLevel === "full"
      ? "full"
      : params.defaults?.defaultLevel === "ask" || params.defaults?.defaultLevel === "on"
        ? "ask"
        : "off";
  if (typeof params.requested === "boolean") {
    return params.requested ? (defaultMode === "full" ? "full" : "ask") : "off";
  }
  return params.defaults?.enabled && params.defaults.allowed ? defaultMode : "off";
}

export function createExecHostResolver(defaults?: ExecToolDefaults) {
  return (params: ExecToolArgs): ExecHost => {
    const elevatedMode = resolveExecElevatedMode({
      defaults: defaults?.elevated,
      requested: params.elevated,
    });
    const requestedTarget = requireValidExecTarget(params.host);
    return resolveExecTarget({
      configuredTarget: defaults?.host,
      requestedTarget,
      elevatedRequested: elevatedMode !== "off",
      sandboxAvailable: Boolean(defaults?.sandbox),
    }).effectiveHost;
  };
}
