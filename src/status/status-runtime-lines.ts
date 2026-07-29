import os from "node:os";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { formatMissingCostEntries } from "../infra/session-cost-usage-totals.js";
import {
  loadSessionCostSummariesFromCache,
  resolveExistingUsageSessionFile,
} from "../infra/session-cost-usage.js";
import { formatTokenCount, formatUsd } from "../utils/usage-format.js";

export function buildStatusUptimeLine(): string {
  const format = (ms: number) => formatDurationCompact(ms, { spaced: true }) ?? "0s";
  const gatewayMs = Math.max(0, Math.round(process.uptime() * 1000));
  const systemMs = Math.max(0, Math.round(os.uptime() * 1000));
  return `⏱️ Uptime: gateway ${format(gatewayMs)} · system ${format(systemMs)}`;
}

async function resolveSessionCostLine(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry?: SessionEntry;
  storePath?: string;
}): Promise<string | undefined> {
  const sessionId = params.sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  let sessionFile: string | undefined;
  try {
    const pathOpts = resolveSessionFilePathOptions({
      storePath: params.storePath,
      agentId: params.agentId,
    });
    sessionFile = resolveExistingUsageSessionFile({
      sessionId,
      sessionEntry: params.sessionEntry,
      sessionFile: resolveSessionFilePath(sessionId, params.sessionEntry, pathOpts),
      agentId: params.agentId,
    });
  } catch {
    return undefined;
  }
  if (!sessionFile) {
    return undefined;
  }
  const now = Date.now();
  const date = new Date(now);
  const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const loaded = await Promise.race([
      loadSessionCostSummariesFromCache({
        sessions: [{ sessionId, sessionFile }],
        config: params.cfg,
        agentId: params.agentId,
        startMs,
        endMs: now,
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: -date.getTimezoneOffset() },
        requestRefresh: false,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("session cost timeout")), 3_500);
      }),
    ]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    const summary = loaded.cacheStatus.status === "fresh" ? loaded.summaries[0] : null;
    if (!summary) {
      return undefined;
    }
    const cost =
      summary.missingCostEntries > 0
        ? `missing cost: ${formatMissingCostEntries(summary)}`
        : formatUsd(summary.totalCost);
    return `💵 ${cost ? `${cost} · ` : ""}${formatTokenCount(summary.totalTokens)} tok (today)`;
  } catch {
    return undefined;
  }
}

export async function appendSessionCostLine(
  usageLine: string | null,
  cfg: OpenClawConfig,
  agentId: string,
  sessionEntry?: SessionEntry,
  storePath?: string,
): Promise<string | null> {
  const line = await resolveSessionCostLine({
    cfg,
    agentId,
    ...(sessionEntry ? { sessionEntry } : {}),
    ...(storePath ? { storePath } : {}),
  });
  return line ? [usageLine, line].filter(Boolean).join("\n") : usageLine;
}
