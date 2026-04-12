import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  buildBootstrapInjectionStats,
  analyzeBootstrapBudget,
} from "../agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../agents/pi-embedded-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";

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

export async function noteBootstrapFileSize(cfg: OpenClawConfig) {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const bootstrapMaxChars = resolveBootstrapMaxChars(cfg);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(cfg);
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: cfg,
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
  if (!analysis.hasTruncation && analysis.nearLimitFiles.length === 0 && !analysis.totalNearLimit) {
    return analysis;
  }

  const lines: string[] = [];
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
    lines.push("- Tip: tune `agents.defaults.bootstrapMaxChars` for per-file limits.");
  }
  if (needsTotalTip) {
    lines.push("- Tip: tune `agents.defaults.bootstrapTotalMaxChars` for total-budget limits.");
  }

  note(lines.join("\n"), "Bootstrap file size");
  return analysis;
}
