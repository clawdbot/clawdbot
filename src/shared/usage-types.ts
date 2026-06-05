// Usage types define shared usage accounting structures for sessions and runs.
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionMessageCounts,
  SessionModelUsage,
  SessionToolUsage,
} from "../infra/session-cost-usage.js";

/** One session or session-family row returned by the gateway usage endpoint. */
export type SessionUsageEntry = {
  /** Stable row key for UI diffing; may be a session id or family key. */
  key: string;
  /** Human-readable session label when available. */
  label?: string;
  /** Concrete session id for instance-scoped rows. */
  sessionId?: string;
  /** Whether this row represents one session instance or a grouped family. */
  scope?: "instance" | "family";
  /** Grouping key shared by related historical session instances. */
  sessionFamilyKey?: string;
  /** Latest/current session id for a grouped family row. */
  currentSessionId?: string;
  /** Session ids included in a family aggregate row. */
  includedSessionIds?: string[];
  /** Count of historical instances included in the family row. */
  historicalInstanceCount?: number;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: SessionSystemPromptReport | null;
};

/** Cross-session aggregate buckets returned alongside usage rows. */
export type SessionsUsageAggregates = {
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
  byChannel: Array<{ channel: string; totals: CostUsageSummary["totals"] }>;
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

/** Full gateway response for the sessions usage view. */
export type SessionsUsageResult = {
  /** Unix epoch milliseconds for when this report was generated. */
  updatedAt: number;
  /** Inclusive report start date in YYYY-MM-DD form. */
  startDate: string;
  /** Inclusive report end date in YYYY-MM-DD form. */
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageSummary["totals"];
  aggregates: SessionsUsageAggregates;
  cacheStatus?: CostUsageSummary["cacheStatus"];
};
