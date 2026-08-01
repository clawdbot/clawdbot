/** Doctor note for workspace bootstrap file size and truncation risk. */
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildBootstrapInjectionStats,
  analyzeBootstrapBudget,
} from "../agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../agents/embedded-agent-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(value)));
}

function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return "0%";
  }
  const pct = Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
  return `${pct}%`;
}

function formatCauses(causes: Array<"per-file-limit" | "total-limit">): string {
  if (causes.length === 0) {
    return "unknown";
  }
  return causes.map((cause) => (cause === "per-file-limit" ? "max/file" : "max/total")).join(", ");
}

/**
 * Analyzes configured bootstrap files and emits warnings when injection will truncate content.
 *
 * Returns the raw budget analysis for tests and callers that need structured evidence.
 */
export async function noteBootstrapFileSize(cfg: OpenClawConfig) {
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const agentIds = listAgentIds(cfg);
  const workspaces = agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  }));
  let defaultAnalysis: ReturnType<typeof analyzeBootstrapBudget> | undefined;
  for (const { agentId, workspaceDir } of workspaces) {
    const bootstrapMaxChars = resolveBootstrapMaxChars(cfg, agentId);
    const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(cfg, agentId);
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config: cfg,
      agentId,
    });
    const stats = buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    });
    const analysis = analyzeBootstrapBudget({
      files: stats,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    });
    if (agentId === defaultAgentId) {
      defaultAnalysis = analysis;
    }
    if (
      !analysis.hasTruncation &&
      analysis.nearLimitFiles.length === 0 &&
      !analysis.totalNearLimit
    ) {
      continue;
    }

    const lines: string[] = agentIds.length > 1 ? [`Agent "${agentId}":`] : [];
    if (analysis.hasTruncation) {
      lines.push("Workspace bootstrap files exceed limits and will be truncated:");
      for (const file of analysis.truncatedFiles) {
        const truncatedChars = Math.max(0, file.rawChars - file.injectedChars);
        lines.push(
          `- ${file.name}: ${formatInt(file.rawChars)} raw / ${formatInt(file.injectedChars)} injected (${formatPercent(truncatedChars, file.rawChars)} truncated; ${formatCauses(file.causes)})`,
        );
      }
    } else {
      lines.push("Workspace bootstrap files are near configured limits:");
    }

    const nonTruncatedNearLimit = analysis.nearLimitFiles.filter((file) => !file.truncated);
    if (nonTruncatedNearLimit.length > 0) {
      for (const file of nonTruncatedNearLimit) {
        lines.push(
          `- ${file.name}: ${formatInt(file.rawChars)} chars (${formatPercent(file.rawChars, bootstrapMaxChars)} of max/file ${formatInt(bootstrapMaxChars)})`,
        );
      }
    }

    lines.push(
      `Total bootstrap injected chars: ${formatInt(analysis.totals.injectedChars)} (${formatPercent(analysis.totals.injectedChars, bootstrapTotalMaxChars)} of max/total ${formatInt(bootstrapTotalMaxChars)}).`,
    );
    lines.push(
      `Total bootstrap raw chars (before truncation): ${formatInt(analysis.totals.rawChars)}.`,
    );

    const needsPerFileTip =
      analysis.truncatedFiles.some((file) => file.causes.includes("per-file-limit")) ||
      analysis.nearLimitFiles.length > 0;
    const needsTotalTip =
      analysis.truncatedFiles.some((file) => file.causes.includes("total-limit")) ||
      analysis.totalNearLimit;
    if (needsPerFileTip || needsTotalTip) {
      lines.push("");
    }
    if (needsPerFileTip) {
      lines.push(
        "- Tip: tune `agents.entries.*.bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits.",
      );
    }
    if (needsTotalTip) {
      lines.push(
        "- Tip: tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback, for total-budget limits.",
      );
    }

    note(lines.join("\n"), "Bootstrap file size");
  }
  return defaultAnalysis;
}
