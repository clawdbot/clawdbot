import type {
  CostUsageDailyEntry,
  SessionsUsageEntry,
  SessionsUsageResult,
  SessionsUsageTotals,
  SessionUsageTimePoint,
} from "../usage-types.ts";

export type UsageSessionEntry = SessionsUsageEntry;
export type UsageTotals = SessionsUsageTotals;
export type CostDailyEntry = CostUsageDailyEntry;
export type UsageAggregates = SessionsUsageResult["aggregates"];

export type UsageColumnId =
  | "channel"
  | "agent"
  | "provider"
  | "model"
  | "messages"
  | "tools"
  | "errors"
  | "duration";

export type TimeSeriesPoint = SessionUsageTimePoint;

export type UsageDataState = {
  loading: boolean;
  error: string | null;
  sessions: UsageSessionEntry[];
  sessionsLimitReached: boolean; // True if 1000 session cap was hit
  totals: UsageTotals | null;
  aggregates: UsageAggregates | null;
  costDaily: CostDailyEntry[];
  cacheStatus: SessionsUsageResult["cacheStatus"];
};

export type UsageFilterState = {
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  selectedSessions: string[]; // Support multiple session selection
  selectedDays: string[]; // Support multiple day selection
  selectedHours: number[]; // Support multiple hour selection
  query: string;
  queryDraft: string;
  timeZone: "local" | "utc";
};

export type UsageDisplayState = {
  chartMode: "tokens" | "cost";
  dailyChartMode: "total" | "by-type";
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  sessionSortDir: "asc" | "desc";
  recentSessions: string[];
  sessionsTab: "all" | "recent";
  visibleColumns: UsageColumnId[];
  contextExpanded: boolean;
  headerPinned: boolean;
};

export type UsageDetailState = {
  timeSeriesMode: "cumulative" | "per-turn";
  timeSeriesBreakdownMode: "total" | "by-type";
  timeSeries: { points: TimeSeriesPoint[] } | null;
  timeSeriesLoading: boolean;
  timeSeriesCursorStart: number | null; // Start of selected range (null = no selection)
  timeSeriesCursorEnd: number | null; // End of selected range (null = no selection)
  sessionLogs: SessionLogEntry[] | null;
  sessionLogsLoading: boolean;
  sessionLogsExpanded: boolean;
  logFilters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  };
};

export type UsageCallbacks = {
  filters: {
    onStartDateChange: (date: string) => void;
    onEndDateChange: (date: string) => void;
    onScopeChange: (scope: "instance" | "family") => void;
    onRefresh: () => void;
    onTimeZoneChange: (zone: "local" | "utc") => void;
    onToggleHeaderPinned: () => void;
    onSelectDay: (day: string, shiftKey: boolean) => void; // Support shift-click
    onSelectHour: (hour: number, shiftKey: boolean) => void;
    onClearDays: () => void;
    onClearHours: () => void;
    onClearSessions: () => void;
    onClearFilters: () => void;
    onQueryDraftChange: (query: string) => void;
    onApplyQuery: () => void;
    onClearQuery: () => void;
  };
  display: {
    onChartModeChange: (mode: "tokens" | "cost") => void;
    onDailyChartModeChange: (mode: "total" | "by-type") => void;
    onSessionSortChange: (sort: "tokens" | "cost" | "recent" | "messages" | "errors") => void;
    onSessionSortDirChange: (dir: "asc" | "desc") => void;
    onSessionsTabChange: (tab: "all" | "recent") => void;
    onToggleColumn: (column: UsageColumnId) => void;
  };
  details: {
    onToggleContextExpanded: () => void;
    onToggleSessionLogsExpanded: () => void;
    onLogFilterRolesChange: (next: SessionLogRole[]) => void;
    onLogFilterToolsChange: (next: string[]) => void;
    onLogFilterHasToolsChange: (next: boolean) => void;
    onLogFilterQueryChange: (next: string) => void;
    onLogFilterClear: () => void;
    onSelectSession: (key: string, shiftKey: boolean) => void;
    onTimeSeriesModeChange: (mode: "cumulative" | "per-turn") => void;
    onTimeSeriesBreakdownChange: (mode: "total" | "by-type") => void;
    onTimeSeriesCursorRangeChange: (start: number | null, end: number | null) => void;
  };
};

export type UsageProps = {
  data: UsageDataState;
  filters: UsageFilterState;
  display: UsageDisplayState;
  detail: UsageDetailState;
  callbacks: UsageCallbacks;
};

export type SessionLogEntry = {
  timestamp: number;
  role: "user" | "assistant" | "tool" | "toolResult";
  content: string;
  tokens?: number;
  cost?: number;
};

export type SessionLogRole = SessionLogEntry["role"];
