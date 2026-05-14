import { log } from "@clack/prompts";
import { redactMigrationPlan } from "../../plugin-sdk/migration.js";
import type { MigrationApplyResult, MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { writeRuntimeJson } from "../../runtime.js";
import type { RuntimeEnv } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import type { MigrateApplyOptions } from "./types.js";

function formatCount(value: number, label: string): string {
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

function formatPlanHeader(plan: MigrationPlan, heading: string): string[] {
  const lines = [`${theme.heading(heading)} ${plan.providerId}`, `Source: ${plan.source}`];
  if (plan.target) {
    lines.push(`Target: ${plan.target}`);
  }
  const visible = plan.items.filter((item) => !HIDDEN_KINDS.has(item.kind));
  const visibleConflicts = visible.filter((item) => item.status === "conflict").length;
  const visibleSensitive = visible.filter((item) => item.sensitive === true).length;
  lines.push(
    [
      formatCount(visible.length, "item"),
      formatCount(visibleConflicts, "conflict"),
      formatCount(visibleSensitive, "sensitive item"),
    ].join(", "),
  );
  return lines;
}

type ItemGroup = {
  kind: string;
  heading: string;
};

const ITEM_GROUPS: ItemGroup[] = [
  { kind: "skill", heading: "Skills:" },
  { kind: "plugin", heading: "Plugins:" },
  { kind: "memory", heading: "Memory:" },
  { kind: "secret", heading: "Secrets:" },
  { kind: "archive", heading: "Archive:" },
  { kind: "manual", heading: "Manual review:" },
];

const HIDDEN_KINDS = new Set(["config"]);
const KNOWN_KINDS = new Set(ITEM_GROUPS.map((group) => group.kind));

type FormatMode = "preview" | "result";

function formatPlanItems(plan: MigrationPlan, mode: FormatMode): string[] {
  const lines: string[] = [];
  const buckets = new Map<string, MigrationItem[]>();
  const other: MigrationItem[] = [];
  for (const item of plan.items) {
    if (HIDDEN_KINDS.has(item.kind)) {
      continue;
    }
    if (KNOWN_KINDS.has(item.kind)) {
      const list = buckets.get(item.kind) ?? [];
      list.push(item);
      buckets.set(item.kind, list);
    } else {
      other.push(item);
    }
  }
  for (const group of ITEM_GROUPS) {
    const items = buckets.get(group.kind);
    if (!items || items.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(theme.heading(group.heading));
    for (const item of items) {
      lines.push(formatMigrationItem(item, mode));
    }
  }
  if (other.length > 0) {
    lines.push("");
    lines.push(theme.heading("Other:"));
    for (const item of other) {
      lines.push(formatMigrationItem(item, mode));
    }
  }
  return lines;
}

function formatPlanWarnings(plan: MigrationPlan): string[] {
  if (!plan.warnings || plan.warnings.length === 0) {
    return [];
  }
  const lines = ["", theme.warn("Warnings:")];
  for (const warning of plan.warnings) {
    lines.push(`⚠️  ${warning}`);
  }
  return lines;
}

export function formatMigrationPreview(plan: MigrationPlan): string[] {
  return [
    ...formatPlanHeader(plan, "Migration preview:"),
    ...formatPlanItems(plan, "preview"),
    ...formatPlanWarnings(plan),
  ];
}

export function formatMigrationResult(plan: MigrationPlan): string[] {
  const lines = [...formatPlanHeader(plan, "Migration plan:"), ...formatPlanItems(plan, "result")];
  if (plan.nextSteps && plan.nextSteps.length > 0) {
    lines.push("");
    lines.push(theme.heading("Next:"));
    for (const step of plan.nextSteps) {
      const prefix = plan.warnings?.includes(step) ? "⚠️ " : "•";
      lines.push(`${prefix} ${step}`);
    }
  }
  return lines;
}

function formatItemDisplayName(item: MigrationItem): string {
  return item.id.replace(/^[^:]+:/, "").replace(/:\d+$/, "");
}

const REASON_CODE_MESSAGES: Record<string, string> = {
  plugin_missing: "Plugin not found in the Codex marketplace",
  marketplace_missing: "Codex marketplace is unavailable",
  disabled: "Plugin is disabled in Codex",
  refresh_failed: "Failed to refresh the Codex plugin marketplace",
  auth_required: "Plugin requires additional authentication",
  already_active: "Plugin is already active in OpenClaw",
  installed: "Plugin is already installed in OpenClaw",
  plugin_install_failed: "Plugin installation failed",
  codex_subscription_required: "Plugin requires an active Codex subscription",
  "not selected for migration": "Skipped because it was not selected for migration",
};

// Phrase-form conflict reasons, used as-is in selection-prompt hints
// (`<source label> <phrase>`) and wrapped into sentence form for preview
// /result rows. Keep one map so the two surfaces never drift.
export const MIGRATION_CONFLICT_REASON_PHRASES: Record<string, string> = {
  "target exists": "already installed in workspace",
  "plugin exists": "already installed in workspace",
};

function conflictReasonSentence(reason: string): string | undefined {
  const phrase = MIGRATION_CONFLICT_REASON_PHRASES[reason];
  if (!phrase) {
    return undefined;
  }
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

function humanizeReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  return REASON_CODE_MESSAGES[reason] ?? conflictReasonSentence(reason) ?? reason;
}

function formatItemMessage(item: MigrationItem, mode: FormatMode): string | undefined {
  if (mode === "preview") {
    if (
      item.status === "conflict" ||
      item.status === "skipped" ||
      item.status === "warning" ||
      item.status === "error"
    ) {
      return humanizeReason(item.reason) ?? item.message;
    }
    if (item.kind === "skill" && item.action === "copy") {
      return "Copy Codex skill into OpenClaw";
    }
    if (item.kind === "plugin" && item.action === "install") {
      return "Install Codex plugin into OpenClaw";
    }
    return item.message ?? humanizeReason(item.reason);
  }
  if (
    (item.kind === "skill" && item.action === "copy") ||
    (item.kind === "plugin" && item.action === "install")
  ) {
    if (item.status === "migrated") {
      return "Migrated";
    }
    if (item.status === "skipped") {
      return "Skipped";
    }
    if (item.status === "warning") {
      return item.message ?? humanizeReason(item.reason);
    }
    if (item.status === "error" || item.status === "conflict") {
      return humanizeReason(item.reason) ?? item.message;
    }
    return undefined;
  }
  if (item.status === "warning" || item.status === "error" || item.status === "conflict") {
    return humanizeReason(item.reason) ?? item.message;
  }
  return item.message ?? humanizeReason(item.reason);
}

const RESULT_STATUS_GLYPHS: Record<string, string> = {
  migrated: "✅",
  warning: "⚠️ ",
  error: "❌",
  skipped: "⏭️ ",
  conflict: "⚠️ ",
};

function formatItemPrefix(item: MigrationItem): string {
  if (item.kind === "manual") {
    return "🔍 ";
  }
  if (item.kind === "archive") {
    return "📖 ";
  }
  const glyph = RESULT_STATUS_GLYPHS[item.status];
  if (glyph) {
    return `${glyph} `;
  }
  return "• ";
}

function formatMigrationItem(item: MigrationItem, mode: FormatMode): string {
  const name = formatItemDisplayName(item);
  const message = formatItemMessage(item, mode);
  const messageSuffix = message ? ` ${theme.muted(`(${message})`)}` : "";
  const sensitive = item.sensitive ? " [sensitive]" : "";
  const prefix = formatItemPrefix(item);
  return `${prefix}${name}${sensitive}${messageSuffix}`;
}

export function assertConflictFreePlan(plan: MigrationPlan, providerId: string): void {
  if (plan.summary.conflicts > 0) {
    throw new Error(
      `Migration has ${formatCount(plan.summary.conflicts, "conflict")}. Re-run with --overwrite after reviewing openclaw migrate plan ${providerId}.`,
    );
  }
}

export function writeApplyResult(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions,
  result: MigrationApplyResult,
): void {
  if (opts.json) {
    writeRuntimeJson(runtime, redactMigrationPlan(result));
    return;
  }
  log.message(formatMigrationResult(result).join("\n"));
  if (result.backupPath) {
    runtime.log(`Backup: ${result.backupPath}`);
  } else if (!opts.noBackup) {
    runtime.log("Backup: skipped (no existing OpenClaw state found)");
  }
  if (result.reportDir) {
    runtime.log(`Report: ${result.reportDir}`);
  }
}

export function assertApplySucceeded(result: MigrationApplyResult): void {
  if (result.summary.errors === 0 && result.summary.conflicts === 0) {
    return;
  }
  const reportHint = result.reportDir ? ` See report: ${result.reportDir}.` : "";
  if (result.summary.errors > 0) {
    throw new Error(
      `Migration finished with ${formatCount(result.summary.errors, "error")}.${reportHint}`,
    );
  }
  throw new Error(
    `Migration finished with ${formatCount(result.summary.conflicts, "conflict")}.${reportHint}`,
  );
}
