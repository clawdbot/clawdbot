/**
 * Session cleanup command.
 *
 * It can delegate cleanup to a live gateway or run local store maintenance,
 * with dry-run tables that explain every planned pruning action.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveSessionCleanupAction,
  isSessionsCleanupPartialResult,
  runSessionsCleanup,
  serializeSessionCleanupResult,
  type SessionCleanupSummary,
  type SessionsCleanupOptions,
  type SessionsCleanupResult,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";
import { resolveSessionDisplayModel } from "./sessions-display-model.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  toSessionDisplayRows,
} from "./sessions-table.js";

type SessionCleanupActionRow = ReturnType<typeof toSessionDisplayRows>[number] & {
  action: ReturnType<typeof resolveSessionCleanupAction>;
  label?: string;
};

type SessionCleanupLabelSummary = {
  label: string;
  kept: number;
  pruned: number;
};

function formatCleanupActionCell(
  action: ReturnType<typeof resolveSessionCleanupAction>,
  rich: boolean,
): string {
  if (!rich) {
    return action;
  }
  if (action === "keep") {
    return theme.muted(action);
  }
  if (action === "archive-dashboard") {
    return theme.warn(action);
  }
  if (action === "archive-cap") {
    return theme.warn(action);
  }
  if (action === "prune-missing") {
    return theme.error(action);
  }
  if (action === "prune-model-run") {
    return theme.warn(action);
  }
  if (action === "prune-stale") {
    return theme.warn(action);
  }
  if (action === "retire-dm-scope") {
    return theme.warn(action);
  }
  if (action === "cap-overflow") {
    return theme.accentBright(action);
  }
  return theme.error(action);
}

function buildActionRows(params: {
  beforeStore: Parameters<typeof toSessionDisplayRows>[0];
  missingKeys: Set<string>;
  modelRunPrunedKeys: Set<string>;
  archivedKeys?: Set<string>;
  capArchivedKeys?: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupActionRow[] {
  // Recompute row actions from the preview sets so dry-run output uses the same
  // action labels as the cleanup engine without mutating the preview store.
  return toSessionDisplayRows(params.beforeStore).map((row) =>
    Object.assign({}, row, {
      label: params.beforeStore[row.key]?.label,
      action: resolveSessionCleanupAction({
        key: row.key,
        missingKeys: params.missingKeys,
        modelRunPrunedKeys: params.modelRunPrunedKeys,
        archivedKeys: params.archivedKeys,
        capArchivedKeys: params.capArchivedKeys,
        staleKeys: params.staleKeys,
        cappedKeys: params.cappedKeys,
        dmScopeRetiredKeys: params.dmScopeRetiredKeys,
      }),
    }),
  );
}

function buildLabelSummaries(actionRows: SessionCleanupActionRow[]): SessionCleanupLabelSummary[] {
  const summaryByLabel = new Map<string, SessionCleanupLabelSummary>();
  for (const actionRow of actionRows) {
    const rawLabel = typeof actionRow.label === "string" ? actionRow.label.trim() : "";
    const label = sanitizeTerminalText(rawLabel) || "(unlabeled)";
    let summary = summaryByLabel.get(label);
    if (!summary) {
      summary = { label, kept: 0, pruned: 0 };
      summaryByLabel.set(label, summary);
    }
    if (
      actionRow.action === "keep" ||
      actionRow.action === "archive-dashboard" ||
      actionRow.action === "archive-cap"
    ) {
      summary.kept += 1;
    } else {
      summary.pruned += 1;
    }
  }
  return [...summaryByLabel.values()].toSorted((a, b) => a.label.localeCompare(b.label));
}

function renderLabelSummaries(params: {
  actionRows: SessionCleanupActionRow[];
  runtime: RuntimeEnv;
}) {
  const summaries = buildLabelSummaries(params.actionRows);
  if (summaries.length === 0) {
    return;
  }
  const labelPad = summaries.reduce(
    (max, summary) => Math.max(max, visibleWidth(summary.label)),
    0,
  );
  const totalKept = summaries.reduce((total, summary) => total + summary.kept, 0);
  const totalPruned = summaries.reduce((total, summary) => total + summary.pruned, 0);
  params.runtime.log("");
  params.runtime.log("Summary by Label:");
  for (const summary of summaries) {
    const remaining = labelPad - visibleWidth(summary.label);
    const paddedLabel = remaining > 0 ? `${summary.label}${" ".repeat(remaining)}` : summary.label;
    params.runtime.log(`${paddedLabel}  ${summary.kept} kept, ${summary.pruned} pruned`);
  }
  params.runtime.log(`Total: ${totalKept} kept, ${totalPruned} pruned`);
}

function toDisplayedCleanupSummary(summary: SessionCleanupSummary): SessionCleanupSummary {
  return {
    ...summary,
    storePath: resolveSqliteTargetFromSessionStorePath(summary.storePath, {
      agentId: summary.agentId,
    }).path,
  };
}

function renderStoreDryRunPlan(params: {
  cfg: OpenClawConfig;
  summary: SessionCleanupSummary;
  actionRows: SessionCleanupActionRow[];
  runtime: RuntimeEnv;
  showAgentHeader: boolean;
}) {
  const rich = isRich();
  const displaySummary = toDisplayedCleanupSummary(params.summary);
  if (params.showAgentHeader) {
    params.runtime.log(`Agent: ${params.summary.agentId}`);
  }
  params.runtime.log(`Session store: ${displaySummary.storePath}`);
  params.runtime.log(`Maintenance mode: ${params.summary.mode}`);
  params.runtime.log(
    `Entries: ${params.summary.beforeCount} -> ${params.summary.afterCount} (remove ${params.summary.beforeCount - params.summary.afterCount})`,
  );
  params.runtime.log(`Would prune missing transcripts: ${params.summary.missing}`);
  params.runtime.log(`Would retire stale direct DM sessions: ${params.summary.dmScopeRetired}`);
  params.runtime.log(`Would prune stale model-run probes: ${params.summary.modelRunPruned}`);
  params.runtime.log(`Would archive inactive dashboard sessions: ${params.summary.archived ?? 0}`);
  params.runtime.log(`Would archive cap overflow: ${params.summary.capArchived ?? 0}`);
  params.runtime.log(`Would prune stale: ${params.summary.pruned}`);
  params.runtime.log(`Would cap overflow: ${params.summary.capped}`);
  if (params.summary.unreferencedArtifacts?.scannedFiles) {
    params.runtime.log(
      `Would prune unreferenced artifacts: ${params.summary.unreferencedArtifacts.removedFiles}`,
    );
  }
  if (params.summary.diskBudget) {
    params.runtime.log(
      `Would enforce disk budget: ${params.summary.diskBudget.totalBytesBefore} -> ${params.summary.diskBudget.totalBytesAfter} bytes (files ${params.summary.diskBudget.removedFiles}, entries ${params.summary.diskBudget.removedEntries})`,
    );
  }
  if (params.actionRows.length === 0) {
    return;
  }
  params.runtime.log("");
  params.runtime.log("Planned session actions:");
  params.runtime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "action", header: "Action" },
        { key: "key", header: "Key" },
        { key: "age", header: "Age" },
        { key: "model", header: "Model" },
        { key: "flags", header: "Flags", flex: true },
      ].map((column) =>
        Object.assign(column, { header: colorize(rich, theme.heading, column.header) }),
      ),
      rows: params.actionRows.map((row) => ({
        action: formatCleanupActionCell(row.action, rich),
        key: formatSessionKeyCell(row.key, rich),
        age: formatSessionAgeCell(row.updatedAt, rich),
        model: formatSessionModelCell(resolveSessionDisplayModel(params.cfg, row), rich),
        flags: formatSessionFlagsCell(row, rich),
      })),
    }).trimEnd(),
  );
  renderLabelSummaries({ actionRows: params.actionRows, runtime: params.runtime });
}

function renderAppliedSummaries(params: {
  summaries: SessionCleanupSummary[];
  runtime: RuntimeEnv;
  locallyOwned: boolean;
}) {
  for (let i = 0; i < params.summaries.length; i += 1) {
    const summary = params.summaries[i];
    if (!summary) {
      continue;
    }
    if (i > 0) {
      params.runtime.log("");
    }
    if (params.summaries.length > 1) {
      params.runtime.log(`Agent: ${summary.agentId}`);
    }
    const storePath = params.locallyOwned
      ? toDisplayedCleanupSummary(summary).storePath
      : summary.storePath;
    params.runtime.log(`Session store: ${storePath}`);
    params.runtime.log(`Applied maintenance. Current entries: ${summary.appliedCount ?? 0}`);
    if (summary.unreferencedArtifacts?.removedFiles) {
      params.runtime.log(
        `Pruned unreferenced artifacts: ${summary.unreferencedArtifacts.removedFiles}`,
      );
    }
  }
}

async function maybeRunGatewayCleanup(
  opts: SessionsCleanupOptions,
): Promise<{ delegated: true; result: SessionsCleanupResult } | { delegated: false }> {
  if (opts.store !== undefined || opts.dryRun) {
    // Explicit store paths and dry-runs stay local; sessions.cleanup takes no store param.
    // A blank --store is explicit too: delegating it would clean the default store.
    return { delegated: false };
  }
  try {
    const result = await callGateway<SessionsCleanupResult>({
      method: "sessions.cleanup",
      params: {
        agent: opts.agent,
        allAgents: opts.allAgents,
        enforce: opts.enforce,
        activeKey: opts.activeKey,
        fixMissing: opts.fixMissing,
        fixDmScope: opts.fixDmScope,
      },
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["sessions.cleanup"],
    });
    return { delegated: true, result };
  } catch (error) {
    if (isGatewayTransportError(error) && error.kind === "closed" && error.code === undefined) {
      // Only a pre-connect failure proves the Gateway never received this
      // mutation; timeouts and established closes must not replay it locally.
      return { delegated: false };
    }
    if (isRecord(error) && isSessionsCleanupPartialResult(error.details)) {
      return { delegated: true, result: error.details };
    }
    throw error;
  }
}

/** Runs session cleanup, optionally using the live gateway for active stores. */
export async function sessionsCleanupCommand(opts: SessionsCleanupOptions, runtime: RuntimeEnv) {
  const gatewayCleanup = await maybeRunGatewayCleanup(opts);
  if (gatewayCleanup.delegated) {
    // The Gateway owns this path. Preserve its syntax because resolving a remote
    // Windows path on a POSIX client (or vice versa) would fabricate a local path.
    const partialError =
      "partialError" in gatewayCleanup.result ? gatewayCleanup.result.partialError : undefined;
    if (opts.json) {
      writeRuntimeJson(runtime, gatewayCleanup.result);
      if (partialError) {
        process.exitCode = 1;
      }
      return;
    }
    renderAppliedSummaries({
      summaries:
        "stores" in gatewayCleanup.result ? gatewayCleanup.result.stores : [gatewayCleanup.result],
      runtime,
      locallyOwned: false,
    });
    if (partialError) {
      runtime.error(`[error] ${partialError.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const cfg = getRuntimeConfig();
  const targets = resolveCommandSessionStoreTargets({ cfg, opts });
  const cleanupParams = { cfg, opts, targets };
  let cleanupResult;
  if (opts.dryRun) {
    cleanupResult = await runSessionsCleanup(cleanupParams);
  } else {
    const { runLocalSessionsCleanup } = await import("./sessions-cleanup.runtime.js");
    cleanupResult = await runLocalSessionsCleanup(cleanupParams, runtime);
  }
  const { mode, previewResults, appliedSummaries, failure } = cleanupResult;

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(
        runtime,
        serializeSessionCleanupResult({
          mode,
          dryRun: true,
          summaries: previewResults.map((result) => toDisplayedCleanupSummary(result.summary)),
        }),
      );
      return;
    }

    for (const [i, result] of previewResults.entries()) {
      if (i > 0) {
        runtime.log("");
      }
      renderStoreDryRunPlan({
        cfg,
        summary: result.summary,
        actionRows: buildActionRows(result),
        runtime,
        showAgentHeader: previewResults.length > 1,
      });
    }
    return;
  }

  if (opts.json) {
    writeRuntimeJson(
      runtime,
      serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries.map(toDisplayedCleanupSummary),
        failure,
      }),
    );
    if (failure) {
      process.exitCode = 1;
    }
    return;
  }

  renderAppliedSummaries({ summaries: appliedSummaries, runtime, locallyOwned: true });
  if (failure) {
    runtime.error(`[error] ${failure.message}`);
    process.exitCode = 1;
  }
}
