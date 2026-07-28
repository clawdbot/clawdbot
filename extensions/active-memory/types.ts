import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionTranscriptTargetParams } from "openclaw/plugin-sdk/session-transcript-runtime";

const DEFAULT_TIMEOUT_MS = 15_000;
// CLI-runtime recalls dispatch through a fresh CLI process (spawn + MCP
// handshake + tool roundtrips); measured runs take 14-20s, so the plain
// default budget would time out most of them. Explicit timeoutMs config
// always wins over this default.
const DEFAULT_CLI_RUNTIME_RECALL_TIMEOUT_MS = 45_000;
const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAX_SUMMARY_CHARS = 220;
const DEFAULT_RECENT_USER_TURNS = 2;
const DEFAULT_RECENT_ASSISTANT_TURNS = 1;
const DEFAULT_RECENT_USER_CHARS = 220;
const DEFAULT_RECENT_ASSISTANT_CHARS = 180;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;
const CACHE_SWEEP_INTERVAL_MS = 1000;
const DEFAULT_MIN_TIMEOUT_MS = 250;
const DEFAULT_SETUP_GRACE_TIMEOUT_MS = 0;
const MAX_TIMEOUT_MS = 120_000;
const MAX_SETUP_GRACE_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY_MODE = "recent" as const;
const DEFAULT_QMD_SEARCH_MODE = "search" as const;
const DEFAULT_TRANSCRIPT_DIR = "active-memory";
const ACTIVE_MEMORY_RECALL_LANE = "active-memory";
const ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS = [0, 50, 250] as const;
const DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW = ["memory_search", "memory_get"] as const;
const LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW = ["memory_recall"] as const;
const MAX_ACTIVE_MEMORY_TOOLS_ALLOW = 32;
const STRUCTURED_MEMORY_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "timeout",
  "timed_out",
  "denied",
  "cancelled",
  "canceled",
  "aborted",
  "killed",
  "invalid",
  "forbidden",
  "unavailable",
  "disabled",
  "blocked",
]);
const STRUCTURED_MEMORY_EMPTY_STATUSES = new Set([
  "not_found",
  "empty",
  "no_results",
  "no_matches",
]);
const ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW = new Set([
  "*",
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "heartbeat_respond",
  "heartbeat_response",
  "image",
  "image_generate",
  "message",
  "music_generate",
  "nodes",
  "pdf",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "tts",
  "update_plan",
  "video_generate",
  "web_fetch",
  "web_search",
  "write",
]);
const DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS = 32_000;
const DEFAULT_TRANSCRIPT_READ_MAX_LINES = 2_000;
const DEFAULT_TRANSCRIPT_READ_MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_PARTIAL_DATA_GRACE_MS = 500;
const HOOK_TIMEOUT_RECOVERY_GRACE_MS = TIMEOUT_PARTIAL_DATA_GRACE_MS + 1_000;
const MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS = 480;
const TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS = 25;

const NO_RECALL_VALUES = new Set([
  "",
  "none",
  "no_reply",
  "no reply",
  "nothing useful",
  "no relevant memory",
  "no relevant memories",
  "timeout",
  "timed out",
  "request timed out",
  "llm request timed out",
  "the llm request timed out",
  "[]",
  "{}",
  "null",
  "n/a",
]);

const TIMEOUT_BOILERPLATE_PATTERNS = [
  /^(?:error:\s*)?(?:the\s+)?(?:llm|model|request|operation|agent)\s+(?:request\s+)?timed out\b/i,
  /^(?:error:\s*)?active-memory timeout after \d+ms\b/i,
];

const RECALLED_CONTEXT_LINE_PATTERNS = [
  /^🧩\s*active memory:/i,
  /^🔎\s*active memory debug:/i,
  /^🧠\s*memory search:/i,
  /^memory search:/i,
  /^active memory debug:/i,
  /^active memory:/i,
];

type ActiveRecallPluginConfig = {
  enabled?: boolean;
  agents?: string[];
  model?: string;
  modelFallback?: string;
  modelFallbackPolicy?: "default-remote" | "resolved-only";
  allowedChatTypes?: Array<"direct" | "group" | "channel" | "explicit">;
  allowedChatIds?: string[];
  deniedChatIds?: string[];
  thinking?: ActiveMemoryThinkingLevel;
  fastMode?: ActiveMemoryFastMode;
  promptStyle?:
    | "balanced"
    | "strict"
    | "contextual"
    | "recall-heavy"
    | "precision-heavy"
    | "preference-only";
  toolsAllow?: string[];
  promptOverride?: string;
  promptAppend?: string;
  timeoutMs?: number;
  setupGraceTimeoutMs?: number;
  queryMode?: "message" | "recent" | "full";
  maxSummaryChars?: number;
  recentUserTurns?: number;
  recentAssistantTurns?: number;
  recentUserChars?: number;
  recentAssistantChars?: number;
  logging?: boolean;
  cacheTtlMs?: number;
  circuitBreakerMaxTimeouts?: number;
  circuitBreakerCooldownMs?: number;
  persistTranscripts?: boolean;
  transcriptDir?: string;
  qmd?: {
    searchMode?: ActiveMemoryQmdSearchMode;
  };
};

type ActiveMemoryQmdSearchMode = "inherit" | "search" | "vsearch" | "query";

type ResolvedActiveRecallPluginConfig = {
  enabled: boolean;
  agents: string[];
  model?: string;
  modelFallback?: string;
  modelFallbackPolicy: "default-remote" | "resolved-only";
  allowedChatTypes: Array<"direct" | "group" | "channel" | "explicit">;
  allowedChatIds: string[];
  deniedChatIds: string[];
  thinking: ActiveMemoryThinkingLevel;
  fastMode?: ActiveMemoryFastMode;
  promptStyle:
    | "balanced"
    | "strict"
    | "contextual"
    | "recall-heavy"
    | "precision-heavy"
    | "preference-only";
  toolsAllow: string[];
  promptOverride?: string;
  promptAppend?: string;
  timeoutMs: number;
  /** True when timeoutMs is the built-in default rather than operator config. */
  timeoutMsIsDefault: boolean;
  setupGraceTimeoutMs: number;
  queryMode: "message" | "recent" | "full";
  maxSummaryChars: number;
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  logging: boolean;
  cacheTtlMs: number;
  circuitBreakerMaxTimeouts: number;
  circuitBreakerCooldownMs: number;
  persistTranscripts: boolean;
  transcriptDir: string;
  qmd: {
    searchMode: ActiveMemoryQmdSearchMode;
  };
};

type ActiveRecallRecentTurn = {
  role: "user" | "assistant";
  text: string;
};

type PluginDebugEntry = {
  pluginId: string;
  lines: string[];
};

type ActiveMemorySearchDebug = {
  backend?: string;
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
  searchMs?: number;
  hits?: number;
  warning?: string;
  action?: string;
  error?: string;
};

type ActiveRecallResult =
  | {
      status: "empty" | "failed" | "no_relevant_memory" | "timeout" | "unavailable";
      elapsedMs: number;
      summary: string | null;
      searchDebug?: ActiveMemorySearchDebug;
    }
  | {
      status: "timeout_partial";
      elapsedMs: number;
      summary: string;
      searchDebug?: ActiveMemorySearchDebug;
    }
  | {
      status: "ok";
      elapsedMs: number;
      rawReply: string;
      summary: string;
      searchDebug?: ActiveMemorySearchDebug;
    };

type ActiveMemoryPartialTimeoutError = Error & {
  activeMemoryPartialReply?: string;
  activeMemorySearchDebug?: ActiveMemorySearchDebug;
  activeMemoryUnavailableMemorySearch?: boolean;
};

type TranscriptReadLimits = {
  maxChars?: number;
  maxLines?: number;
  maxBytes?: number;
};

type ActiveMemoryTranscriptSource =
  | {
      kind: "runtime";
      target: SessionTranscriptTargetParams;
    }
  | {
      kind: "file";
      sessionFile: string;
    };

type RecallSubagentResult = {
  rawReply: string;
  resultStatus?: "failed" | "unavailable";
  transcriptPath?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult?: boolean;
  hasUnavailableMemorySearchResult?: boolean;
};

type TerminalMemorySearchResult = {
  status: "unavailable";
  hasUsableMemoryResult: boolean;
  searchDebug?: ActiveMemorySearchDebug;
};

type TerminalMemorySearchWatch = {
  promise: Promise<TerminalMemorySearchResult>;
  stop: () => void;
};

type CachedActiveRecallResult = {
  expiresAt: number;
  result: ActiveRecallResult;
};

type ActiveMemoryChatType = "direct" | "group" | "channel" | "explicit";

type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: true;
  updatedAt: number;
};
type ActiveMemoryThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";
type ActiveMemoryFastMode = boolean | "auto";
type ConversationRecallContext = NonNullable<OpenClawPluginToolContext["conversationRecall"]>;
type ActiveMemoryPromptStyle =
  | "balanced"
  | "strict"
  | "contextual"
  | "recall-heavy"
  | "precision-heavy"
  | "preference-only";

const ACTIVE_MEMORY_STATUS_PREFIX = "🧩 Active Memory:";
const ACTIVE_MEMORY_DEBUG_PREFIX = "🔎 Active Memory Debug:";
const ACTIVE_MEMORY_PLUGIN_TAG = "active_memory_plugin";
const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = `<${ACTIVE_MEMORY_PLUGIN_TAG}>`;
const ACTIVE_MEMORY_CLOSE_TAG = `</${ACTIVE_MEMORY_PLUGIN_TAG}>`;
const MAX_LOG_VALUE_CHARS = 300;
type CircuitBreakerEntry = {
  consecutiveTimeouts: number;
  lastTimeoutAt: number;
};

export {
  ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS,
  ACTIVE_MEMORY_CLOSE_TAG,
  ACTIVE_MEMORY_DEBUG_PREFIX,
  ACTIVE_MEMORY_OPEN_TAG,
  ACTIVE_MEMORY_PLUGIN_TAG,
  ACTIVE_MEMORY_RECALL_LANE,
  ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW,
  ACTIVE_MEMORY_STATUS_PREFIX,
  ACTIVE_MEMORY_CONTEXT_HEADER,
  CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
  DEFAULT_AGENT_ID,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_MAX_SUMMARY_CHARS,
  DEFAULT_MIN_TIMEOUT_MS,
  DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
  DEFAULT_QMD_SEARCH_MODE,
  DEFAULT_QUERY_MODE,
  DEFAULT_RECENT_ASSISTANT_CHARS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_CLI_RUNTIME_RECALL_TIMEOUT_MS,
  DEFAULT_SETUP_GRACE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_DIR,
  DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
  DEFAULT_TRANSCRIPT_READ_MAX_LINES,
  HOOK_TIMEOUT_RECOVERY_GRACE_MS,
  LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS,
  MAX_ACTIVE_MEMORY_TOOLS_ALLOW,
  MAX_LOG_VALUE_CHARS,
  MAX_SETUP_GRACE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  NO_RECALL_VALUES,
  RECALLED_CONTEXT_LINE_PATTERNS,
  STRUCTURED_MEMORY_EMPTY_STATUSES,
  STRUCTURED_MEMORY_FAILURE_STATUSES,
  TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS,
  TIMEOUT_BOILERPLATE_PATTERNS,
  TIMEOUT_PARTIAL_DATA_GRACE_MS,
};

export type {
  ActiveMemoryChatType,
  ActiveMemoryFastMode,
  ActiveMemoryPartialTimeoutError,
  ActiveMemoryPromptStyle,
  ActiveMemoryQmdSearchMode,
  ActiveMemorySearchDebug,
  ActiveMemoryThinkingLevel,
  ActiveMemoryToggleEntry,
  ActiveMemoryTranscriptSource,
  ActiveRecallPluginConfig,
  ActiveRecallRecentTurn,
  ActiveRecallResult,
  CachedActiveRecallResult,
  CircuitBreakerEntry,
  ConversationRecallContext,
  PluginDebugEntry,
  RecallSubagentResult,
  ResolvedActiveRecallPluginConfig,
  TerminalMemorySearchResult,
  TerminalMemorySearchWatch,
  TranscriptReadLimits,
};
