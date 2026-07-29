import type { ChannelId } from "../channels/plugins/types.js";
import type { AgentModelConfig, AgentSandboxConfig } from "./types.agents-shared.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type { MemorySearchConfig } from "./types.tools.js";

export type AgentModelEntryConfig = {
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
  /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
  streaming?: boolean;
  /**
   * Context window override for this model, in tokens. Takes precedence over
   * provider catalog metadata and over `agents.defaults.contextTokens`. Use it
   * when a gateway under-reports the window of the model it actually routes to.
   */
  contextTokens?: number;
};

export type AgentModelListConfig = {
  primary?: string;
  fallbacks?: string[];
};

export type AgentContextPruningConfig = {
  mode?: "off" | "cache-ttl";
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};

export type CliBackendConfig = {
  /** CLI command to execute (absolute path or on PATH). */
  command: string;
  /** Base args applied to every invocation. */
  args?: string[];
  /** Output parsing mode (default: json). */
  output?: "json" | "text" | "jsonl";
  /** Output parsing mode when resuming a CLI session. */
  resumeOutput?: "json" | "text" | "jsonl";
  /** Prompt input mode (default: arg). */
  input?: "arg" | "stdin";
  /** Max prompt length for arg mode (if exceeded, stdin is used). */
  maxPromptArgChars?: number;
  /** Extra env vars injected for this CLI. */
  env?: Record<string, string>;
  /** Env vars to remove before launching this CLI. */
  clearEnv?: string[];
  /** Flag used to pass model id (e.g. --model). */
  modelArg?: string;
  /** Model aliases mapping (config model id → CLI model id). */
  modelAliases?: Record<string, string>;
  /** Flag used to pass session id (e.g. --session-id). */
  sessionArg?: string;
  /** Extra args used when resuming a session (use {sessionId} placeholder). */
  sessionArgs?: string[];
  /** Alternate args to use when resuming a session (use {sessionId} placeholder). */
  resumeArgs?: string[];
  /** When to pass session ids. */
  sessionMode?: "always" | "existing" | "none";
  /** JSON fields to read session id from (in order). */
  sessionIdFields?: string[];
  /** Flag used to pass system prompt. */
  systemPromptArg?: string;
  /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace";
  /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never";
  /** Flag used to pass image paths. */
  imageArg?: string;
  /** How to pass multiple images. */
  imageMode?: "repeat" | "list";
  /** Serialize runs for this CLI. */
  serialize?: boolean;
  /** Runtime reliability tuning for this backend's process lifecycle. */
  reliability?: {
    /** No-output watchdog tuning (fresh vs resumed runs). */
    watchdog?: {
      /** Fresh/new sessions (non-resume). */
      fresh?: {
        /** Fixed watchdog timeout in ms (overrides ratio when set). */
        noOutputTimeoutMs?: number;
        /** Fraction of overall timeout used when fixed timeout is not set. */
        noOutputTimeoutRatio?: number;
        /** Lower bound for computed watchdog timeout. */
        minMs?: number;
        /** Upper bound for computed watchdog timeout. */
        maxMs?: number;
      };
      /** Resume sessions. */
      resume?: {
        /** Fixed watchdog timeout in ms (overrides ratio when set). */
        noOutputTimeoutMs?: number;
        /** Fraction of overall timeout used when fixed timeout is not set. */
        noOutputTimeoutRatio?: number;
        /** Lower bound for computed watchdog timeout. */
        minMs?: number;
        /** Upper bound for computed watchdog timeout. */
        maxMs?: number;
      };
    };
  };
};

export type AgentDefaultsConfig = {
  /** Primary model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  model?: AgentModelConfig;
  /** Optional image-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  imageModel?: AgentModelConfig;
  /** Optional PDF-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  pdfModel?: AgentModelConfig;
  /** Maximum PDF file size in megabytes (default: 10). */
  pdfMaxBytesMb?: number;
  /** Maximum number of PDF pages to process (default: 20). */
  pdfMaxPages?: number;
  /** Model catalog with optional aliases (full provider/model keys). */
  models?: Record<string, AgentModelEntryConfig>;
  /** Agent working directory (preferred). Used as the default cwd for agent runs. */
  workspace?: string;
  /** Optional repository root for system prompt runtime line (overrides auto-detect). */
  repoRoot?: string;
  /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /** Max chars for injected bootstrap files before truncation (default: 20000). */
  bootstrapMaxChars?: number;
  /** Max total chars across all injected bootstrap files (default: 150000). */
  bootstrapTotalMaxChars?: number;
  /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string;
  /** Time format in system prompt: auto (OS preference), 12-hour, or 24-hour. */
  timeFormat?: "auto" | "12" | "24";
  /**
   * Envelope timestamp timezone: "utc" (default), "local", "user", or an IANA timezone string.
   */
  envelopeTimezone?: string;
  /**
   * Include absolute timestamps in message envelopes ("on" | "off", default: "on").
   */
  envelopeTimestamp?: "on" | "off";
  /**
   * Include elapsed time in message envelopes ("on" | "off", default: "on").
   */
  envelopeElapsed?: "on" | "off";
  /** Optional context window cap (used for runtime estimates + status %). */
  contextTokens?: number;
  /** Optional CLI backends for text-only fallback (claude-cli, etc.). */
  cliBackends?: Record<string, CliBackendConfig>;
  /** Opt-in: prune old tool results from the LLM context to reduce token usage. */
  contextPruning?: AgentContextPruningConfig;
  /** Compaction tuning and pre-compaction memory flush behavior. */
  compaction?: AgentCompactionConfig;
  /** Embedded Pi runner hardening and compatibility controls. */
  embeddedPi?: {
    /**
     * How embedded Pi should trust workspace-local `.pi/config/settings.json`.
     * - sanitize (default): apply project settings except shellPath/shellCommandPrefix
     * - ignore: ignore project settings entirely
     * - trusted: trust project settings as-is
     */
    projectSettingsPolicy?: "trusted" | "sanitize" | "ignore";
  };
  /** Vector memory search configuration (per-agent overrides supported). */
  memorySearch?: MemorySearchConfig;
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
  /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on" | "full";
  /** Default elevated level when no /elevated directive is present. */
  elevatedDefault?: "off" | "on" | "ask" | "full";
  /** Default block streaming level when no override is present. */
  blockStreamingDefault?: "off" | "on";
  /**
   * Block streaming boundary:
   * - "text_end": end of each assistant text content block (before tool calls)
   * - "message_end": end of the whole assistant message (may include tool blocks)
   */
  blockStreamingBreak?: "text_end" | "message_end";
  /** Soft block chunking for streamed replies (min/max chars, prefer paragraph/newline). */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /**
   * Block reply coalescing (merge streamed chunks before send).
   * idleMs: wait time before flushing when idle.
   */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Human-like delay between block replies. */
  humanDelay?: HumanDelayConfig;
  timeoutSeconds?: number;
  /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
  mediaMaxMb?: number;
  /**
   * Max image side length (pixels) when sanitizing base64 image payloads in transcripts/tool results.
   * Default: 1200.
   */
  imageMaxDimensionPx?: number;
  typingIntervalSeconds?: number;
  /** Typing indicator start mode (never|instant|thinking|message). */
  typingMode?: TypingMode;
  /** Periodic background heartbeat runs. */
  heartbeat?: {
    /** Heartbeat interval (duration string, default unit: minutes; default: 30m). */
    every?: string;
    /** Optional active-hours window (local time); heartbeats run only inside this window. */
    activeHours?: {
      /** Start time (24h, HH:MM). Inclusive. */
      start?: string;
      /** End time (24h, HH:MM). Exclusive. Use "24:00" for end-of-day. */
      end?: string;
      /** Timezone for the window ("user", "local", or IANA TZ id). Default: "user". */
      timezone?: string;
    };
    /** Heartbeat model override (provider/model). */
    model?: string;
    /** Session key for heartbeat runs ("main" or explicit session key). */
    session?: string;
    /** Delivery target ("last", "none", or a channel id). */
    target?: "last" | "none" | ChannelId;
    /** Direct/DM delivery policy. Default: "allow". */
    directPolicy?: "allow" | "block";
    /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). Supports :topic:NNN suffix for Telegram topics. */
    to?: string;
    /** Optional account id for multi-account channels. */
    accountId?: string;
    /** Override the heartbeat prompt body (default: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."). */
    prompt?: string;
    /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
    ackMaxChars?: number;
    /** Suppress tool error warning payloads during heartbeat runs. */
    suppressToolErrorWarnings?: boolean;
    /**
     * If true, run heartbeat turns with lightweight bootstrap context.
     * Lightweight mode keeps only HEARTBEAT.md from workspace bootstrap files.
     */
    lightContext?: boolean;
    /**
     * When enabled, deliver the model's reasoning payload for heartbeat runs (when available)
     * as a separate message prefixed with `Reasoning:` (same as `/reasoning on`).
     *
     * Default: false (only the final heartbeat payload is delivered).
     */
    includeReasoning?: boolean;
  };
  /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
  maxConcurrent?: number;
  /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number;
    /** Maximum depth allowed for sessions_spawn chains. Default behavior: 1 (no nested spawns). */
    maxSpawnDepth?: number;
    /** Maximum active children a single requester session may spawn. Default behavior: 5. */
    maxChildrenPerAgent?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60). */
    archiveAfterMinutes?: number;
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string;
    /** Default run timeout in seconds for spawned sub-agents (0 = no timeout). */
    runTimeoutSeconds?: number;
    /** Gateway timeout in ms for sub-agent announce delivery calls (default: 60000). */
    announceTimeoutMs?: number;
  };
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: AgentSandboxConfig;
};

export type AgentCompactionMode = "default" | "safeguard";
export type AgentCompactionIdentifierPolicy = "strict" | "off" | "custom";

export type AgentCompactionConfig = {
  /** Compaction summarization mode. */
  mode?: AgentCompactionMode;
  /** Pi reserve tokens target before floor enforcement. */
  reserveTokens?: number;
  /** Pi keepRecentTokens budget used for cut-point selection. */
  keepRecentTokens?: number;
  /** Minimum reserve tokens enforced for Pi compaction (0 disables the floor). */
  reserveTokensFloor?: number;
  /** Max share of context window for history during safeguard pruning (0.1–0.9, default 0.5). */
  maxHistoryShare?: number;
  /** Identifier-preservation instruction policy for compaction summaries. */
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  /** Custom identifier-preservation instructions used when identifierPolicy is "custom". */
  identifierInstructions?: string;
  /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
};

export type AgentCompactionMemoryFlushConfig = {
  /** Enable the pre-compaction memory flush (default: true). */
  enabled?: boolean;
  /** Run the memory flush when context is within this many tokens of the compaction threshold. */
  softThresholdTokens?: number;
  /**
   * Force a memory flush when transcript size reaches this threshold
   * (bytes, or byte-size string like "2mb"). Set to 0 to disable.
   */
  forceFlushTranscriptBytes?: number | string;
  /** User prompt used for the memory flush turn (NO_REPLY is enforced if missing). */
  prompt?: string;
  /** System prompt appended for the memory flush turn. */
  systemPrompt?: string;
};
