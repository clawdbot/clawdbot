import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { normalizeUsage } from "../agents/usage.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import {
  isPrimarySessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { estimateUsageCost } from "../utils/usage-format.js";
import {
  isUsageCostRollupFresh,
  readUsageCostRollups,
  refreshCostUsageCacheForAgent,
  resolveUsageCostAgentDir,
  resolveUsageCostCacheDatabasePath,
  resolveUsageCostPricingFingerprint,
} from "./session-cost-usage-aggregation.js";
import {
  listUsageCountedTranscriptStats,
  readTranscriptRecords,
  readTranscriptRecordsBestEffort,
  resolveExistingUsageSessionFile,
  resolveUsageCostTranscriptFile,
  scanUsageFile,
} from "./session-cost-usage-collection.js";
import {
  computeUsageTokenTotals,
  createUsageCostResolver,
  extractCostBreakdown,
  parseTimestamp,
  shouldRecomputeRecordedZeroCost,
} from "./session-cost-usage-pricing.js";
import { createUsageDayKeyFormatter } from "./session-cost-usage-projection.js";
import { buildSessionCostSummaryFromRollup } from "./session-cost-usage-rollup.js";
import type {
  DiscoveredSession,
  SessionCostSummary,
  SessionLogEntry,
  SessionUsageTimePoint,
  SessionUsageTimeSeries,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

const USAGE_COST_DIRECT_REFRESH_RETRY_MS = 25;

/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export async function discoverAllSessions(params: {
  agentId: string;
  startMs?: number;
  endMs?: number;
  includeFirstUserMessage?: boolean;
}): Promise<DiscoveredSession[]> {
  const files = await listUsageCountedTranscriptStats(params.agentId, {
    minMtimeMs: params.startMs,
  });

  const discovered = new Map<string, DiscoveredSession>();

  for (const file of files) {
    // Do not exclude by endMs: a session can have activity in range even if it continued later.
    const filePath = file.filePath;
    const fileName = path.basename(filePath);
    const sqliteMarker = parseSqliteSessionFileMarker(filePath);

    const sessionId = sqliteMarker?.sessionId ?? parseUsageCountedSessionIdFromFileName(fileName);
    if (!sessionId) {
      continue;
    }
    const isPrimaryTranscript = sqliteMarker ? true : isPrimarySessionTranscriptFileName(fileName);

    // Try to read first user message for label extraction
    let firstUserMessage: string | undefined;
    if (params.includeFirstUserMessage !== false) {
      try {
        for await (const parsed of readTranscriptRecords(filePath)) {
          try {
            const message = parsed.message as Record<string, unknown> | undefined;
            if (message?.role === "user") {
              const content = message.content;
              if (typeof content === "string") {
                firstUserMessage = truncateUtf16Safe(content, 100);
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (
                    typeof block === "object" &&
                    block &&
                    (block as Record<string, unknown>).type === "text"
                  ) {
                    const text = (block as Record<string, unknown>).text;
                    if (typeof text === "string") {
                      firstUserMessage = truncateUtf16Safe(text, 100);
                    }
                    break;
                  }
                }
              }
              break; // Found first user message
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    const existing = discovered.get(sessionId);
    const existingIsPrimary = existing
      ? isPrimarySessionTranscriptFileName(path.basename(existing.sessionFile))
      : false;
    const shouldReplace =
      !existing ||
      (isPrimaryTranscript && !existingIsPrimary) ||
      (isPrimaryTranscript === existingIsPrimary && file.mtimeMs >= existing.mtime);

    if (shouldReplace) {
      discovered.set(sessionId, {
        sessionId,
        sessionFile: filePath,
        mtime: file.mtimeMs,
        firstUserMessage: firstUserMessage ?? existing?.firstUserMessage,
      });
      continue;
    }

    if (!existing.firstUserMessage && firstUserMessage) {
      existing.firstUserMessage = firstUserMessage;
      discovered.set(sessionId, existing);
    }
  }

  // Sort by mtime descending (most recent first)
  return Array.from(discovered.values()).toSorted((a, b) => b.mtime - a.mtime);
}

export async function loadSessionCostSummary(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  sessionTarget?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
}): Promise<SessionCostSummary | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  const file = await resolveUsageCostTranscriptFile(sessionFile);
  if (!file) {
    return null;
  }
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  while (
    (await refreshCostUsageCacheForAgent({
      config: params.config,
      agentId: params.agentId,
      agentDir,
      databasePath,
      sessionFiles: [sessionFile],
    })) === "busy"
  ) {
    // Direct detail callers require the requested session, unlike background
    // summary refreshes. Wait for the agent-wide writer to release, then retry.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, USAGE_COST_DIRECT_REFRESH_RETRY_MS);
    });
  }
  const currentFile = await resolveUsageCostTranscriptFile(sessionFile);
  if (!currentFile) {
    return null;
  }
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  const stored = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath).get(
    currentFile.filePath,
  );
  if (!stored || !isUsageCostRollupFresh({ stored, file: currentFile })) {
    return null;
  }
  const hasExplicitRange = params.startMs !== undefined || params.endMs !== undefined;
  return buildSessionCostSummaryFromRollup({
    rollup: stored.entry.rollup,
    sessionId: params.sessionId,
    sessionFile,
    startMs: params.startMs ?? Number.NEGATIVE_INFINITY,
    endMs: params.endMs ?? Number.POSITIVE_INFINITY,
    includeUntimestamped: params.includeUntimestamped === true || !hasExplicitRange,
    formatDay: createUsageDayKeyFormatter(params.dayBucket),
  });
}

export async function loadSessionUsageTimeSeries(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  maxPoints?: number;
}): Promise<SessionUsageTimeSeries | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  if (!parseSqliteSessionFileMarker(sessionFile) && !fs.existsSync(sessionFile)) {
    return null;
  }

  if (params.maxPoints !== undefined && params.maxPoints !== null) {
    if (!Number.isFinite(params.maxPoints) || params.maxPoints <= 0) {
      return { sessionId: params.sessionId, points: [] };
    }
  }

  const points: Array<Omit<SessionUsageTimePoint, "cumulativeTokens" | "cumulativeCost">> = [];
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

  await scanUsageFile({
    filePath: sessionFile,
    config: params.config,
    resolveCost,
    onEntry: (entry) => {
      const ts = entry.timestamp?.getTime();
      if (!ts) {
        return;
      }

      const { input, output, cacheRead, cacheWrite, totalTokens } = computeUsageTokenTotals(
        entry.usage,
      );
      const cost = entry.costTotal ?? 0;

      points.push({
        timestamp: ts,
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost,
      });
    },
  });

  // Sort by timestamp
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  const sortedPoints: SessionUsageTimePoint[] = points
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map((point) => {
      cumulativeTokens += point.totalTokens;
      cumulativeCost += point.cost;
      return Object.assign(point, { cumulativeTokens, cumulativeCost });
    });

  // Optionally downsample if too many points
  const maxPoints = params.maxPoints ?? 100;
  if (sortedPoints.length > maxPoints) {
    const step = Math.ceil(sortedPoints.length / maxPoints);
    const downsampled: SessionUsageTimePoint[] = [];
    let downsampledCumulativeTokens = 0;
    let downsampledCumulativeCost = 0;
    for (let i = 0; i < sortedPoints.length; i += step) {
      const bucket = sortedPoints.slice(i, i + step);
      const bucketLast = bucket[bucket.length - 1];
      if (!bucketLast) {
        continue;
      }

      let bucketInput = 0;
      let bucketOutput = 0;
      let bucketCacheRead = 0;
      let bucketCacheWrite = 0;
      let bucketTotalTokens = 0;
      let bucketCost = 0;
      for (const point of bucket) {
        bucketInput += point.input;
        bucketOutput += point.output;
        bucketCacheRead += point.cacheRead;
        bucketCacheWrite += point.cacheWrite;
        bucketTotalTokens += point.totalTokens;
        bucketCost += point.cost;
      }

      downsampledCumulativeTokens += bucketTotalTokens;
      downsampledCumulativeCost += bucketCost;

      downsampled.push({
        timestamp: bucketLast.timestamp,
        input: bucketInput,
        output: bucketOutput,
        cacheRead: bucketCacheRead,
        cacheWrite: bucketCacheWrite,
        totalTokens: bucketTotalTokens,
        cost: bucketCost,
        cumulativeTokens: downsampledCumulativeTokens,
        cumulativeCost: downsampledCumulativeCost,
      });
    }
    return { sessionId: params.sessionId, points: downsampled };
  }

  return { sessionId: params.sessionId, points: sortedPoints };
}

export async function loadSessionLogs(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  limit?: number;
}): Promise<SessionLogEntry[] | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  if (!parseSqliteSessionFileMarker(sessionFile) && !fs.existsSync(sessionFile)) {
    return null;
  }

  const logs: SessionLogEntry[] = [];
  if (params.limit !== undefined && params.limit !== null) {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
  }
  const limit = params.limit ?? 50;
  const boundedLimit = Number.isInteger(limit);
  const retentionLimit = limit * 2;
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

  for await (const parsed of readTranscriptRecordsBestEffort(sessionFile)) {
    try {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) {
        continue;
      }

      const role = message.role as string | undefined;
      if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "toolResult") {
        continue;
      }

      const contentParts: string[] = [];
      const rawToolName = message.toolName ?? message.tool_name ?? message.name ?? message.tool;
      const toolName = normalizeOptionalString(rawToolName);
      if (role === "tool" || role === "toolResult") {
        contentParts.push(`[Tool: ${toolName ?? "tool"}]`);
        contentParts.push("[Tool Result]");
      }

      // Extract content
      const rawContent = message.content;
      if (typeof rawContent === "string") {
        contentParts.push(rawContent);
      } else if (Array.isArray(rawContent)) {
        // Handle content blocks (text, tool_use, etc.)
        const contentText = rawContent
          .map((block: unknown) => {
            if (typeof block === "string") {
              return block;
            }
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              return b.text;
            }
            if (b.type === "tool_use") {
              const name = typeof b.name === "string" ? b.name : "unknown";
              return `[Tool: ${name}]`;
            }
            if (b.type === "tool_result") {
              return "[Tool Result]";
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (contentText) {
          contentParts.push(contentText);
        }
      }

      // OpenAI-style tool calls stored outside the content array.
      const rawToolCalls =
        message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
      const toolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls
        : rawToolCalls
          ? [rawToolCalls]
          : [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const callObj = call as Record<string, unknown>;
          const directName = typeof callObj.name === "string" ? callObj.name : undefined;
          const fn = callObj.function as Record<string, unknown> | undefined;
          const fnName = typeof fn?.name === "string" ? fn.name : undefined;
          const name = directName ?? fnName ?? "unknown";
          contentParts.push(`[Tool: ${name}]`);
        }
      }

      let content = contentParts.join("\n").trim();
      if (!content) {
        continue;
      }
      content = stripInboundMetadata(content);
      if (role === "user") {
        content = stripMessageIdHints(stripEnvelope(content)).trim();
      }
      if (!content) {
        continue;
      }

      // Truncate very long content.
      const maxLen = 2000;
      if (content.length > maxLen) {
        content = truncateUtf16Safe(content, maxLen) + "…";
      }

      // Get timestamp
      // Keep detail logs on the usage-summary timestamp path, including nested
      // fallback; direct Date parsing can leak NaN as null through Gateway JSON.
      const timestamp = parseTimestamp(parsed)?.getTime() ?? 0;

      // Get usage for assistant messages
      let tokens: number | undefined;
      let cost: number | undefined;
      if (role === "assistant") {
        const usageRaw = message.usage as Record<string, unknown> | undefined;
        const usage = normalizeUsage(usageRaw);
        if (usage) {
          tokens =
            usage.total ??
            (usage.input ?? 0) +
              (usage.output ?? 0) +
              (usage.cacheRead ?? 0) +
              (usage.cacheWrite ?? 0);
          const breakdown = extractCostBreakdown(usageRaw);
          const costConfig = resolveCost({
            provider:
              (typeof message.provider === "string" ? message.provider : undefined) ??
              (typeof parsed.provider === "string" ? parsed.provider : undefined),
            model:
              (typeof message.model === "string" ? message.model : undefined) ??
              (typeof parsed.model === "string" ? parsed.model : undefined),
          });
          if (
            breakdown?.total !== undefined &&
            !shouldRecomputeRecordedZeroCost({
              usage,
              cost: costConfig,
              costBreakdown: breakdown,
              costTotal: breakdown.total,
            })
          ) {
            cost = breakdown.total;
          } else {
            cost = estimateUsageCost({ usage, cost: costConfig });
          }
        }
      }

      logs.push({
        timestamp,
        role,
        content,
        tokens,
        cost,
      });
      // Timestamps can arrive out of order, so keep a bounded sorted window instead
      // of relying on transcript append order or retaining the whole file.
      if (boundedLimit && logs.length > retentionLimit) {
        logs.sort((a, b) => a.timestamp - b.timestamp);
        logs.splice(0, logs.length - limit);
      }
    } catch {
      // Ignore malformed lines
    }
  }

  // Sort by timestamp and limit
  if (boundedLimit) {
    logs.sort((a, b) => a.timestamp - b.timestamp);
    return logs.length > limit ? logs.slice(-limit) : logs;
  }

  // Return most recent logs
  const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);
  if (sortedLogs.length > limit) {
    return sortedLogs.slice(-limit);
  }

  return sortedLogs;
}
