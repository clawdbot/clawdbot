import type { Dirent } from "node:fs";
// Stable public surface for session cost and usage collection and reporting.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  isCompactionCheckpointTranscriptFileName,
  isPrimarySessionTranscriptFileName,
  parseParentSessionIdFromCheckpointFileName,
} from "../config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { hasErrnoCode } from "./errno.js";
import { discoverAllSessionsReporting as discoverAllSessionsFromReporting } from "./session-cost-usage-reporting.js";
import type { DiscoveredSession } from "./session-cost-usage.types.js";

export {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage-cache-runtime.js";
export { resolveExistingUsageSessionFile } from "./session-cost-usage-collection.js";
export {
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage-reporting.js";
export type {
  CostUsageSummary,
  CostUsageTotals,
  DiscoveredSession,
  SessionCostSummary,
  UsageCacheStatus,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

export async function discoverAllSessions(params?: {
  agentId?: string;
  startMs?: number;
  endMs?: number;
  includeFirstUserMessage?: boolean;
}): Promise<DiscoveredSession[]> {
  const agentId = params?.agentId ?? resolveDefaultAgentId(getRuntimeConfig());
  const discovered = await discoverAllSessionsFromReporting({
    agentId,
    ...(params?.startMs !== undefined ? { startMs: params.startMs } : {}),
    ...(params?.endMs !== undefined ? { endMs: params.endMs } : {}),
    ...(params?.includeFirstUserMessage !== undefined
      ? { includeFirstUserMessage: params.includeFirstUserMessage }
      : {}),
  });
  const bySessionId = new Map(discovered.map((session) => [session.sessionId, session]));
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return discovered;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isCompactionCheckpointTranscriptFileName(entry.name)) {
      continue;
    }
    const parentId = parseParentSessionIdFromCheckpointFileName(entry.name);
    if (!parentId) {
      continue;
    }
    const checkpointPath = path.join(sessionsDir, entry.name);
    let mtime: number;
    try {
      mtime = (await fs.stat(checkpointPath)).mtimeMs;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (params?.startMs !== undefined && mtime < params.startMs) {
      continue;
    }

    const existing = bySessionId.get(parentId);
    if (!existing) {
      bySessionId.set(parentId, {
        sessionId: parentId,
        sessionFile: checkpointPath,
        mtime,
        firstUserMessage: undefined,
      });
      continue;
    }
    if (mtime <= existing.mtime) {
      continue;
    }
    const existingIsPrimary = isPrimarySessionTranscriptFileName(
      path.basename(existing.sessionFile),
    );
    bySessionId.set(parentId, {
      ...existing,
      sessionFile: existingIsPrimary ? existing.sessionFile : checkpointPath,
      mtime,
    });
  }

  return Array.from(bySessionId.values()).toSorted((left, right) => right.mtime - left.mtime);
}
