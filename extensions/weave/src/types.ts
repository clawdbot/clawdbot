/**
 * W&B Weave Plugin Types
 */

/**
 * Plugin configuration schema
 */
export interface WeavePluginConfig {
  /** W&B API key for authentication */
  apiKey: string;
  /** W&B entity (username or team name) */
  entity: string;
  /** Default W&B project name for traces */
  project: string;
  /** Automatically trace all agent runs (default: true) */
  autoTrace?: boolean;
  /** Log tool calls as child spans (default: true) */
  traceToolCalls?: boolean;
  /** Track session lifecycle (default: true) */
  traceSessions?: boolean;
  /** Custom W&B server URL */
  baseUrl?: string;
  /** Trace sampling rate 0.0 to 1.0 (default: 1.0) */
  sampleRate?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

/**
 * Trace context for tracking spans across hooks
 */
export interface TraceContext {
  /** Unique trace ID */
  traceId: string;
  /** Session key (channel:user:account) */
  sessionKey: string;
  /** Root span reference */
  rootSpan: WeaveSpan | null;
  /** Current active span */
  activeSpan: WeaveSpan | null;
  /** Start timestamp */
  startTime: number;
  /** Metadata collected during trace */
  metadata: Record<string, unknown>;
}

/**
 * Weave span representation
 */
export interface WeaveSpan {
  /** Span ID */
  id: string;
  /** Span name */
  name: string;
  /** Parent span ID (null for root) */
  parentId: string | null;
  /** Start timestamp */
  startTime: number;
  /** End timestamp (null if still running) */
  endTime: number | null;
  /** Span inputs */
  inputs: Record<string, unknown>;
  /** Span outputs */
  outputs: Record<string, unknown> | null;
  /** Span attributes/metadata */
  attributes: Record<string, unknown>;
  /** Span status */
  status: 'running' | 'success' | 'error';
  /** Error message if status is error */
  error?: string;
}

/**
 * Tool call data for tracing
 */
export interface ToolCallData {
  /** Tool name */
  name: string;
  /** Tool inputs */
  inputs: Record<string, unknown>;
  /** Tool outputs */
  outputs?: unknown;
  /** Execution duration in ms */
  duration?: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Agent run data for tracing
 */
export interface AgentRunData {
  /** Agent ID */
  agentId: string;
  /** Session key */
  sessionKey: string;
  /** Message channel */
  channel: string;
  /** User message */
  userMessage: string;
  /** Agent response */
  response?: string;
  /** Model used */
  model?: string;
  /** Token usage */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Tool calls made during the run */
  toolCalls: ToolCallData[];
  /** Run duration in ms */
  duration?: number;
  /** Whether the run succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Session data for tracing
 */
export interface SessionData {
  /** Session key */
  sessionKey: string;
  /** Channel */
  channel: string;
  /** User ID */
  userId: string;
  /** Account ID */
  accountId: string;
  /** Session start time */
  startTime: number;
  /** Session end time */
  endTime?: number;
  /** Number of messages in session */
  messageCount: number;
  /** Total token usage in session */
  totalTokens: number;
}

/**
 * Weave log entry for custom logging
 */
export interface WeaveLogEntry {
  /** Log name/key */
  name: string;
  /** Log value (metrics, data, etc.) */
  value: unknown;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp */
  timestamp?: number;
}

/**
 * Weave feedback entry
 */
export interface WeaveFeedback {
  /** Trace/call ID to annotate */
  callId: string;
  /** Feedback type */
  type: 'thumbs_up' | 'thumbs_down' | 'correction' | 'note' | 'custom';
  /** Feedback value */
  value: unknown;
  /** Optional note */
  note?: string;
}

/**
 * Weave query parameters
 */
export interface WeaveQuery {
  /** Project to query */
  project?: string;
  /** Filter by trace name */
  traceName?: string;
  /** Filter by time range (ISO timestamps) */
  timeRange?: {
    start: string;
    end: string;
  };
  /** Filter by metadata */
  filters?: Record<string, unknown>;
  /** Maximum results */
  limit?: number;
  /** Sort order */
  sortBy?: 'time' | 'duration' | 'tokens';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Weave evaluation configuration
 */
export interface WeaveEvalConfig {
  /** Dataset name or ID */
  dataset: string;
  /** Scorers to use */
  scorers: string[];
  /** Model/function to evaluate */
  model?: string;
  /** Evaluation name */
  name?: string;
  /** Number of trials per example */
  trials?: number;
}

/**
 * Weave dataset configuration
 */
export interface WeaveDatasetConfig {
  /** Dataset name */
  name: string;
  /** Dataset description */
  description?: string;
  /** Dataset rows */
  rows: Record<string, unknown>[];
}
