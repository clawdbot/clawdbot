import type { NormalizedUsage } from "../agents/usage.js";
import type {
  SessionUsageTimePoint as SharedSessionUsageTimePoint,
  SessionUsageTimeSeries as SharedSessionUsageTimeSeries,
} from "../shared/session-usage-timeseries-types.js";

export type CostBreakdown = {
  total?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ParsedUsageEntry = {
  usage: NormalizedUsage;
  costTotal?: number;
  costBreakdown?: CostBreakdown;
  provider?: string;
  model?: string;
  timestamp?: Date;
};

export type ParsedTranscriptEntry = {
  message: Record<string, unknown>;
  role?: "user" | "assistant";
  timestamp?: Date;
  durationMs?: number;
  usage?: NormalizedUsage;
  costTotal?: number;
  costBreakdown?: CostBreakdown;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolNames: string[];
  toolResultCounts: { total: number; errors: number };
};

export type CostUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  // Cost breakdown by token type (from actual API data when available)
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
};

export type CostUsageDailyEntry = CostUsageTotals & {
  date: string;
};

export type CostUsageSummary = {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: CostUsageTotals;
};

export type SessionDailyUsage = {
  date: string; // YYYY-MM-DD
  tokens: number;
  cost: number;
};

export type SessionDailyMessageCounts = {
  date: string; // YYYY-MM-DD
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
};

export type SessionUtcQuarterHourMessageCounts = {
  date: string; // YYYY-MM-DD (UTC)
  quarterIndex: number; // 0-95, UTC quarter-hour bucket (index = floor((utcH * 60 + utcM) / 15))
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
};

export type SessionLatencyStats = {
  count: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
};

export type SessionDailyLatency = SessionLatencyStats & {
  date: string; // YYYY-MM-DD
};

export type SessionDailyModelUsage = {
  date: string; // YYYY-MM-DD
  provider?: string;
  model?: string;
  tokens: number;
  cost: number;
  count: number;
};

export type SessionMessageCounts = {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
};

export type SessionToolUsage = {
  totalCalls: number;
  uniqueTools: number;
  tools: Array<{ name: string; count: number }>;
};

export type SessionModelUsage = {
  provider?: string;
  model?: string;
  count: number;
  totals: CostUsageTotals;
};

export type SessionCostSummary = CostUsageTotals & {
  sessionId?: string;
  sessionFile?: string;
  firstActivity?: number;
  lastActivity?: number;
  durationMs?: number;
  activityDates?: string[]; // YYYY-MM-DD dates when session had activity
  dailyBreakdown?: SessionDailyUsage[]; // Per-day token/cost breakdown
  dailyMessageCounts?: SessionDailyMessageCounts[];
  utcQuarterHourMessageCounts?: SessionUtcQuarterHourMessageCounts[]; // UTC quarter-hour buckets for precise hourly stats
  dailyLatency?: SessionDailyLatency[];
  dailyModelUsage?: SessionDailyModelUsage[];
  messageCounts?: SessionMessageCounts;
  toolUsage?: SessionToolUsage;
  modelUsage?: SessionModelUsage[];
  latency?: SessionLatencyStats;
};

export type DiscoveredSession = {
  sessionId: string;
  sessionFile: string;
  mtime: number;
  firstUserMessage?: string;
};

export type SessionUsageTimePoint = SharedSessionUsageTimePoint;

export type SessionUsageTimeSeries = SharedSessionUsageTimeSeries;

export type SessionLogEntry = {
  timestamp: number;
  role: "user" | "assistant" | "tool" | "toolResult";
  content: string;
  tokens?: number;
  cost?: number;
};
