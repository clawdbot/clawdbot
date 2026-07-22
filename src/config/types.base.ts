// Defines base configuration types shared by multiple config sections.
import type { ChatType } from "../channels/chat-type.js";

/** Reply handling mode for chat command surfaces. */
export type ReplyMode = "text" | "command";
/** Typing indicator timing policy shared by channel configs. */
export type TypingMode = "never" | "instant" | "thinking" | "message";
/** Session-key ownership model for inbound messages. */
export type SessionScope = "per-sender" | "global";
/** DM session-key granularity across peers, channels, and accounts. */
export type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
/** Which source messages outbound replies should thread or quote against. */
export type ReplyToMode = "off" | "first" | "all" | "batched";
/** Group-chat admission policy for channels with allowlists. */
export type GroupPolicy = "open" | "disabled" | "allowlist";
/** Direct-message admission policy for channels with pairing/allowlists. */
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
/** How much non-allowlisted context is visible to an agent. */
export type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";
/** Text splitting strategy for outbound channel delivery. */
export type TextChunkMode = "length" | "newline";
/** Preview/progress delivery mode while an agent response is still streaming. */
export type StreamingMode = "off" | "partial" | "block" | "progress";
/** How command text is represented in streaming progress previews. */
export type ChannelStreamingCommandTextMode = "raw" | "status";

export type OutboundRetryConfig = {
  /** Max retry attempts for outbound requests (default: 3). */
  attempts?: number;
  /** Minimum retry delay in ms (default: 300-500ms depending on provider). */
  minDelayMs?: number;
  /** Maximum retry delay cap in ms (default: 30000). */
  maxDelayMs?: number;
  /** Jitter factor (0-1) applied to delays (default: 0.1). */
  jitter?: number;
};

export type BlockStreamingCoalesceConfig = {
  /** Minimum buffered characters before coalesced block delivery. */
  minChars?: number;
  /** Maximum buffered characters before a block must be flushed. */
  maxChars?: number;
  /** Idle time in ms before flushing a partial coalesced block. */
  idleMs?: number;
};

export type BlockStreamingChunkConfig = {
  /** Minimum preview chunk size before sending another draft update. */
  minChars?: number;
  /** Maximum preview chunk size before forcing a draft update. */
  maxChars?: number;
  /** Preferred natural boundary when splitting preview chunks. */
  breakPreference?: "paragraph" | "newline" | "sentence";
};

export type ChannelStreamingProgressConfig = {
  /** Initial progress title. "auto" picks from labels; false hides the title. Default: "auto". */
  label?: string | false;
  /** Candidate labels for label="auto". Defaults to OpenClaw's built-in progress labels. */
  labels?: string[];
  /** Maximum number of progress lines to keep below the label. Default: 8. */
  maxLines?: number;
  /** Maximum characters per compact progress line before truncation. Default: 120. */
  maxLineChars?: number;
  /** Progress draft renderer. "text" is the portable fallback; "rich" lets supported channels use structured UI. */
  render?: "text" | "rich";
  /** Include compact tool/task progress in the draft. Default: true. */
  toolProgress?: boolean;
  /** Command/exec progress detail in the draft. "raw" preserves released behavior; "status" shows only the tool label. Default: "raw". */
  commandText?: ChannelStreamingCommandTextMode;
  /** Include assistant commentary/preamble text in the progress draft. Default: false. */
  commentary?: boolean;
  /**
   * Replace tool lines with a short utility-model narration of what the agent
   * is doing. Runs when a utility model resolves (explicit `utilityModel` or
   * the primary provider's declared default). Default: true.
   */
  narration?: boolean;
};

export type ChannelStreamingPreviewConfig = {
  /** Chunking thresholds for preview-draft updates while streaming. */
  chunk?: BlockStreamingChunkConfig;
  /**
   * Render live tool/activity updates into the preview draft for channels that
   * edit a single preview message in place.
   * Default: true.
   */
  toolProgress?: boolean;
  /** Command/exec progress detail in the preview. "raw" preserves released behavior; "status" shows only the tool label. Default: "raw". */
  commandText?: ChannelStreamingCommandTextMode;
};

export type ChannelStreamingBlockConfig = {
  /** Enable chunked block-reply delivery for channels that support it. */
  enabled?: boolean;
  /** Merge streamed block replies before sending. */
  coalesce?: BlockStreamingCoalesceConfig;
};

export type ChannelStreamingConfig = {
  /**
   * Preview streaming mode:
   * - "off": disable preview updates
   * - "partial": update one preview in place
   * - "block": emit larger chunked preview updates
   * - "progress": progress/status preview mode for channels that support it
   */
  mode?: StreamingMode;
  /** Chunking mode for outbound text delivery. */
  chunkMode?: TextChunkMode;
  /**
   * Channel-specific native transport streaming toggle.
   * Used today by Slack's native stream API.
   */
  nativeTransport?: boolean;
  preview?: ChannelStreamingPreviewConfig;
  progress?: ChannelStreamingProgressConfig;
  block?: ChannelStreamingBlockConfig;
};

export type ChannelDeliveryStreamingConfig = Pick<ChannelStreamingConfig, "chunkMode" | "block">;

/** Streaming subset used by channels that render visible preview/progress replies. */
export type ChannelPreviewStreamingConfig = Pick<
  ChannelStreamingConfig,
  "mode" | "chunkMode" | "preview" | "progress" | "block"
>;

export type MarkdownTableMode = "off" | "bullets" | "code" | "block";

export type MarkdownConfig = {
  /** Table rendering mode (off|bullets|code|block). */
  tables?: MarkdownTableMode;
};

export type HumanDelayConfig = {
  /** Delay style for block replies (off|natural|custom). */
  mode?: "off" | "natural" | "custom";
  /** Minimum delay in milliseconds (default: 800). */
  minMs?: number;
  /** Maximum delay in milliseconds (default: 2500). */
  maxMs?: number;
};

export type SessionSendPolicyAction = "allow" | "deny";
export type SessionSendPolicyMatch = {
  /** Channel/provider id match. */
  channel?: string;
  /** Direct/group/thread classification when the caller has channel metadata. */
  chatType?: ChatType;
  /**
   * Session key prefix match.
   * Note: some consumers match against a normalized key (for example, stripping `agent:<id>:`).
   */
  keyPrefix?: string;
  /** Optional raw session-key prefix match for consumers that normalize session keys. */
  rawKeyPrefix?: string;
};
export type SessionSendPolicyRule = {
  /** Action applied when match criteria select this rule. */
  action: SessionSendPolicyAction;
  /** Optional match filter; omitted match behaves as a catch-all rule. */
  match?: SessionSendPolicyMatch;
};
export type SessionSendPolicyConfig = {
  /** Fallback action when no send-policy rule matches. */
  default?: SessionSendPolicyAction;
  /** Ordered allow/deny rules; first matching rule wins. */
  rules?: SessionSendPolicyRule[];
};

export type SessionResetMode = "none" | "daily" | "idle";
export type SessionResetConfig = {
  mode?: SessionResetMode;
  /** Local hour (0-23) for the daily reset boundary. */
  atHour?: number;
  /** Sliding idle window (minutes). When set with daily mode, whichever expires first wins. */
  idleMinutes?: number;
};
export type SessionResetByTypeConfig = {
  direct?: SessionResetConfig;
  group?: SessionResetConfig;
  thread?: SessionResetConfig;
};

export type SessionThreadBindingsConfig = {
  /**
   * Master switch for thread-bound session routing features.
   * Channel/provider keys can override this default.
   */
  enabled?: boolean;
  /**
   * Inactivity window for thread-bound sessions (hours).
   * Session auto-unfocuses after this amount of idle time. Set to 0 to disable. Default: 24.
   */
  idleHours?: number;
  /**
   * Optional hard max age for thread-bound sessions (hours).
   * Session auto-unfocuses once this age is reached even if active. Set to 0 to disable. Default: 0.
   */
  maxAgeHours?: number;
  /**
   * Allow channel integrations to create thread-bound work sessions from
   * sessions_spawn or native ACP spawn flows. Channel/account keys can override.
   * Default: true when thread bindings are enabled.
   */
  spawnSessions?: boolean;
  /**
   * Default context mode for native subagents spawned into a bound thread.
   * Default: "fork" so the child starts from the requester transcript.
   */
  defaultSpawnContext?: "isolated" | "fork";
};

export type SessionConfig = {
  scope?: SessionScope;
  /** DM session scoping (default: "main"). */
  dmScope?: DmScope;
  /** Map platform-prefixed identities (e.g. "telegram:123") to canonical DM peers. */
  identityLinks?: Record<string, string[]>;
  resetTriggers?: string[];
  reset?: SessionResetConfig;
  resetByType?: SessionResetByTypeConfig;
  /** Channel-specific reset overrides (e.g. { discord: { mode: "idle", idleMinutes: 10080 } }). */
  resetByChannel?: Record<string, SessionResetConfig>;
  store?: string;
  mainKey?: string;
  sendPolicy?: SessionSendPolicyConfig;
  /** Shared defaults for thread-bound session routing across channels/providers. */
  threadBindings?: SessionThreadBindingsConfig;
  /** Automatic session store maintenance (pruning, capping, archive retention, disk budget). */
  maintenance?: SessionMaintenanceConfig;
};

export type SessionMaintenanceMode = "enforce" | "warn";

/** Session-store cleanup policy for transcript count, age, archives, and disk budget. */
export type SessionMaintenanceConfig = {
  /** Whether to enforce maintenance or warn only. Default: "enforce". */
  mode?: SessionMaintenanceMode;
  /** Remove session entries older than this duration (e.g. "30d", "12h"). Default: "30d". */
  pruneAfter?: string | number;
  /** Maximum number of session entries to keep. Default: 500. */
  maxEntries?: number;
  /**
   * Age-based retention for archived transcripts (`*.reset.<timestamp>` and
   * `*.deleted.<timestamp>`). Default and `false`: keep archives until the
   * disk budget evicts them oldest-first; a duration opts into deletion.
   */
  resetArchiveRetention?: string | number | false;
  /**
   * Per-agent sessions-directory disk budget (e.g. "500mb"). Default: "10gb".
   * When exceeded, warn (mode=warn) or enforce oldest-first cleanup
   * (mode=enforce). Set `false` to disable the budget entirely.
   */
  maxDiskBytes?: number | string | false;
  /**
   * Target size after disk-budget cleanup (high-water mark), e.g. "400mb".
   * Default: 80% of maxDiskBytes.
   */
  highWaterBytes?: number | string;
};

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
  /** Maximum size of a single log file in bytes before rotation. Default: 100 MB. */
  maxFileBytes?: number;
  consoleLevel?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  consoleStyle?: "pretty" | "json";
  /** Redact sensitive tokens in log sinks and persisted transcript text. Default: "tools". Safety-boundary UI/tool/diagnostic payloads may still redact when this is "off". */
  /** Regex patterns used to redact sensitive tokens from logs and transcripts. */
  redactPatterns?: string[];
  /** Metadata-only agent activity audit ledger settings. */
  audit?: AuditConfig;
};

export type DiagnosticsOtelConfig = {
  enabled?: boolean;
  endpoint?: string;
  tracesEndpoint?: string;
  metricsEndpoint?: string;
  logsEndpoint?: string;
  protocol?: "http/protobuf" | "grpc";
  headers?: Record<string, string>;
  serviceName?: string;
  traces?: boolean;
  metrics?: boolean;
  logs?: boolean;
  /** Log export sink: OTLP by default, stdout JSONL, or both. */
  logsExporter?: "otlp" | "stdout" | "both";
  /** Trace sample rate (0.0 - 1.0). */
  sampleRate?: number;
  /** Metric export interval (ms). */
  flushIntervalMs?: number;
  /**
   * Opt-in raw content capture for OTEL span attributes.
   * Boolean `true` captures non-system message/tool content; the object form
   * can enable each content class explicitly.
   */
  captureContent?:
    | boolean
    | {
        enabled?: boolean;
        inputMessages?: boolean;
        outputMessages?: boolean;
        toolInputs?: boolean;
        toolOutputs?: boolean;
        systemPrompt?: boolean;
        toolDefinitions?: boolean;
      };
};

export type DiagnosticsCacheTraceConfig = {
  /** Write prompt-cache trace artifacts for debugging deterministic cache input. */
  enabled?: boolean;
  /** @deprecated Doctor-only legacy input. */
  filePath?: string;
  /** @deprecated Doctor-only legacy input. */
  includeMessages?: boolean;
  /** @deprecated Doctor-only legacy input. */
  includePrompt?: boolean;
  /** @deprecated Doctor-only legacy input. */
  includeSystem?: boolean;
};

export type AuditConfig = {
  /**
   * Record metadata-only run, tool, and enabled message lifecycle events into
   * the shared state database. Content is never stored. Default: true. This is
   * startup-scoped; disabling stops new event inserts after restart while retained
   * records stay readable until they expire.
   */
  enabled?: boolean;
  /**
   * Record content-free message lifecycle metadata. `direct` records only
   * known direct conversations; `all` also records group, channel, and
   * unknown conversation kinds. Default: `off`.
   */
  messages?: "off" | "direct" | "all";
};

export type DiagnosticsConfig = {
  enabled?: boolean;
  /** Optional ad-hoc diagnostics flags (e.g. "telegram.http"). */
  flags?: string[];
  otel?: DiagnosticsOtelConfig;
  cacheTrace?: DiagnosticsCacheTraceConfig;
};

// Provider docking: allowlists keyed by provider id (and internal "webchat").
export type AgentElevatedAllowFromConfig = Partial<Record<string, Array<string | number>>>;

export type IdentityConfig = {
  name?: string;
  theme?: string;
  emoji?: string;
  /** Avatar image: workspace-relative path, http(s) URL, or data URI. */
  avatar?: string;
};
