import { getRuntimeConfig } from "../config/config.js";
import {
  resolveSessionCleanupAction,
  runSessionsCleanup,
  serializeSessionCleanupResult,
  type SessionCleanupSummary,
  type SessionsCleanupOptions,
  type SessionsCleanupResult,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import { resolveSessionDisplayModel } from "./sessions-display-model.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  SESSION_AGE_PAD,
  SESSION_KEY_PAD,
  SESSION_MODEL_PAD,
  toSessionDisplayRows,
} from "./sessions-table.js";

const ACTION_PAD = 16;

type SessionCleanupActionRow = ReturnType<typeof toSessionDisplayRows>[number] & {
  action: ReturnType<typeof resolveSessionCleanupAction>;
};

function formatCleanupActionCell(
  action: ReturnType<typeof resolveSessionCleanupAction>,
  rich: boolean,
): string {
  const label = action.padEnd(ACTION_PAD);
  if (!rich) {
    return label;
  }
  if (action === "keep") {
    return theme.muted(label);
  }
  if (action === "prune-missing") {
    return theme.error(label);
  }
  if (action === "prune-stale") {
    return theme.warn(label);
  }
  if (action === "retire-dm-scope") {
    return theme.warn(label);
  }
  if (action === "cap-overflow") {
    return theme.accentBright(label);
  }
  return theme.error(label);
}

function buildActionRows(params: {
  beforeStore: Parameters<typeof toSessionDisplayRows>[0];
  missingKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupActionRow[] {
  return toSessionDisplayRows(params.beforeStore).map((row) =>
    Object.assign({}, row, {
      action: resolveSessionCleanupAction({
        key: row.key,
        missingKeys: params.missingKeys,
        staleKeys: params.staleKeys,
        cappedKeys: params.cappedKeys,
        budgetEvictedKeys: params.budgetEvictedKeys,
        dmScopeRetiredKeys: params.dmScopeRetiredKeys,
      }),
    }),
  );
}

function renderStoreDryRunPlan(params: {
  cfg: OpenClawConfig;
  summary: SessionCleanupSummary;
  actionRows: SessionCleanupActionRow[];
  runtime: RuntimeEnv;
  showAgentHeader: boolean;
}) {
  const rich = isRich();
  if (params.showAgentHeader) {
    params.runtime.log(`Agent: ${params.summary.agentId}`);
  }
  params.runtime.log(`Session store: ${params.summary.storePath}`);
  params.runtime.log(`Maintenance mode: ${params.summary.mode}`);
  params.runtime.log(
    `Entries: ${params.summary.beforeCount} -> ${params.summary.afterCount} (remove ${params.summary.beforeCount - params.summary.afterCount})`,
  );
  params.runtime.log(`Would prune missing transcripts: ${params.summary.missing}`);
  params.runtime.log(`Would retire stale direct DM sessions: ${params.summary.dmScopeRetired}`);
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
  const header = [
    "Action".padEnd(ACTION_PAD),
    "Key".padEnd(SESSION_KEY_PAD),
    "Age".padEnd(SESSION_AGE_PAD),
    "Model".padEnd(SESSION_MODEL_PAD),
    "Flags",
  ].join(" ");
  params.runtime.log(rich ? theme.heading(header) : header);
  for (const actionRow of params.actionRows) {
    const model = resolveSessionDisplayModel(params.cfg, actionRow);
    const line = [
      formatCleanupActionCell(actionRow.action, rich),
      formatSessionKeyCell(actionRow.key, rich),
      formatSessionAgeCell(actionRow.updatedAt, rich),
      formatSessionModelCell(model, rich),
      formatSessionFlagsCell(actionRow, rich),
    ].join(" ");
    params.runtime.log(line.trimEnd());
  }
}

function renderAppliedSummaries(params: {
  summaries: SessionCleanupSummary[];
  runtime: RuntimeEnv;
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
    params.runtime.log(`Session store: ${summary.storePath}`);
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
): Promise<SessionsCleanupResult | null> {
  if (opts.store || opts.dryRun) {
    return null;
  }
  try {
    return await callGateway<SessionsCleanupResult>({
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
  } catch (error) {
    if (isGatewayTransportError(error)) {
      return null;
    }
    throw error;
  }
}

export async function sessionsCleanupCommand(opts: SessionsCleanupOptions, runtime: RuntimeEnv) {
  const gatewayResult = await maybeRunGatewayCleanup(opts);
  if (gatewayResult) {
    if (opts.json) {
      writeRuntimeJson(runtime, gatewayResult);
      return;
    }
    renderAppliedSummaries({
      summaries: "stores" in gatewayResult ? gatewayResult.stores : [gatewayResult],
      runtime,
    });
    return;
  }

  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }
  const { mode, previewResults, appliedSummaries } = await runSessionsCleanup({
    cfg,
    opts,
    targets,
  });

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(
        runtime,
        serializeSessionCleanupResult({
          mode,
          dryRun: true,
          summaries: previewResults.map((result) => result.summary),
        }),
      );
      return;
    }

    for (let i = 0; i < previewResults.length; i += 1) {
      const result = previewResults[i];
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
        summaries: appliedSummaries,
      }),
    );
    return;
  }

  renderAppliedSummaries({ summaries: appliedSummaries, runtime });
}
