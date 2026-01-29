/**
 * Audit Reporter - Aggregate audit data into summary reports.
 *
 * Accepts AuditRecord[] and computes stats for tool usage,
 * category breakdown, policy decisions, errors, and timeline.
 */

import type { AuditRecord } from "./audit.js";

export type ToolStats = {
  tool: string;
  invocations: number;
  successCount: number;
  errorCount: number;
  blockedCount: number;
  successRate: number;
  avgDurationMs: number | null;
};

export type CategoryBreakdown = {
  category: string;
  count: number;
  percentage: number;
};

export type PolicyStats = {
  totalEvaluated: number;
  allowCount: number;
  denyCount: number;
  warnCount: number;
  blockRate: number;
};

export type ErrorSummary = {
  tool: string;
  count: number;
  topMessages: string[];
};

export type TimelineBucket = {
  minute: string;
  count: number;
};

export type AuditReport = {
  totalRecords: number;
  timeRange: { from: string; to: string } | null;
  toolStats: ToolStats[];
  categoryBreakdown: CategoryBreakdown[];
  policyStats: PolicyStats;
  errors: ErrorSummary[];
  timeline: TimelineBucket[];
};

export class AuditReporter {
  private records: AuditRecord[];

  constructor(records: AuditRecord[]) {
    this.records = records;
  }

  generate(): AuditReport {
    return {
      totalRecords: this.records.length,
      timeRange: this.computeTimeRange(),
      toolStats: this.computeToolStats(),
      categoryBreakdown: this.computeCategoryBreakdown(),
      policyStats: this.computePolicyStats(),
      errors: this.computeErrors(),
      timeline: this.computeTimeline(),
    };
  }

  private computeTimeRange(): { from: string; to: string } | null {
    if (this.records.length === 0) return null;
    const sorted = [...this.records].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    return {
      from: sorted[0]!.timestamp,
      to: sorted[sorted.length - 1]!.timestamp,
    };
  }

  private computeToolStats(): ToolStats[] {
    const map = new Map<string, { success: number; error: number; blocked: number; durations: number[] }>();

    for (const r of this.records) {
      let entry = map.get(r.tool);
      if (!entry) {
        entry = { success: 0, error: 0, blocked: 0, durations: [] };
        map.set(r.tool, entry);
      }
      if (r.result.status === "success") entry.success++;
      else if (r.result.status === "error") entry.error++;
      else if (r.result.status === "blocked") entry.blocked++;
      if (r.result.durationMs !== undefined) entry.durations.push(r.result.durationMs);
    }

    return Array.from(map.entries())
      .map(([tool, data]) => {
        const total = data.success + data.error + data.blocked;
        return {
          tool,
          invocations: total,
          successCount: data.success,
          errorCount: data.error,
          blockedCount: data.blocked,
          successRate: total > 0 ? data.success / total : 0,
          avgDurationMs:
            data.durations.length > 0
              ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
              : null,
        };
      })
      .sort((a, b) => b.invocations - a.invocations);
  }

  private computeCategoryBreakdown(): CategoryBreakdown[] {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    }
    const total = this.records.length;
    return Array.from(counts.entries())
      .map(([category, count]) => ({
        category,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  private computePolicyStats(): PolicyStats {
    // Derive policy decisions from result status:
    // blocked → deny, error/success → allow (we don't have warn in result status)
    let allowCount = 0;
    let denyCount = 0;
    const warnCount = 0; // Warn doesn't block, so it shows as success/error in results

    for (const r of this.records) {
      if (r.result.status === "blocked") {
        denyCount++;
      } else {
        allowCount++;
      }
    }

    const total = this.records.length;
    return {
      totalEvaluated: total,
      allowCount,
      denyCount,
      warnCount,
      blockRate: total > 0 ? denyCount / total : 0,
    };
  }

  private computeErrors(): ErrorSummary[] {
    const map = new Map<string, { count: number; messages: Map<string, number> }>();

    for (const r of this.records) {
      if (r.result.status !== "error") continue;
      let entry = map.get(r.tool);
      if (!entry) {
        entry = { count: 0, messages: new Map() };
        map.set(r.tool, entry);
      }
      entry.count++;
      if (r.result.errorMessage) {
        const msg = r.result.errorMessage;
        entry.messages.set(msg, (entry.messages.get(msg) ?? 0) + 1);
      }
    }

    return Array.from(map.entries())
      .map(([tool, data]) => ({
        tool,
        count: data.count,
        topMessages: Array.from(data.messages.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([msg]) => msg),
      }))
      .sort((a, b) => b.count - a.count);
  }

  private computeTimeline(): TimelineBucket[] {
    const buckets = new Map<string, number>();

    for (const r of this.records) {
      // Bucket by minute (truncate to minute)
      const d = new Date(r.timestamp);
      const minute = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
    }

    return Array.from(buckets.entries())
      .map(([minute, count]) => ({ minute, count }))
      .sort((a, b) => a.minute.localeCompare(b.minute));
  }

  /** Format report as structured text. */
  formatText(): string {
    const report = this.generate();
    const lines: string[] = [];

    lines.push("=== Audit Report ===");
    lines.push(`Total records: ${report.totalRecords}`);
    if (report.timeRange) {
      lines.push(`Time range: ${report.timeRange.from} → ${report.timeRange.to}`);
    }
    lines.push("");

    // Tool stats
    lines.push("--- Tool Stats ---");
    if (report.toolStats.length === 0) {
      lines.push("  (no data)");
    }
    for (const ts of report.toolStats) {
      const dur = ts.avgDurationMs !== null ? `${ts.avgDurationMs.toFixed(0)}ms avg` : "n/a";
      lines.push(
        `  ${ts.tool}: ${ts.invocations} calls, ${(ts.successRate * 100).toFixed(0)}% success, ${dur}`,
      );
    }
    lines.push("");

    // Category breakdown
    lines.push("--- Categories ---");
    for (const cb of report.categoryBreakdown) {
      lines.push(`  ${cb.category}: ${cb.count} (${cb.percentage.toFixed(1)}%)`);
    }
    lines.push("");

    // Policy
    lines.push("--- Policy ---");
    lines.push(`  Evaluated: ${report.policyStats.totalEvaluated}`);
    lines.push(`  Allowed: ${report.policyStats.allowCount}`);
    lines.push(`  Denied: ${report.policyStats.denyCount}`);
    lines.push(`  Block rate: ${(report.policyStats.blockRate * 100).toFixed(1)}%`);
    lines.push("");

    // Errors
    if (report.errors.length > 0) {
      lines.push("--- Errors ---");
      for (const err of report.errors) {
        lines.push(`  ${err.tool}: ${err.count} errors`);
        for (const msg of err.topMessages) {
          lines.push(`    - ${msg}`);
        }
      }
      lines.push("");
    }

    // Timeline
    if (report.timeline.length > 0) {
      lines.push("--- Timeline (actions/min) ---");
      for (const bucket of report.timeline) {
        lines.push(`  ${bucket.minute}: ${bucket.count}`);
      }
    }

    return lines.join("\n");
  }
}
