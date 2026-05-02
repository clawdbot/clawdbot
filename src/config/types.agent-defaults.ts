import type {
  SilentReplyPolicyShape,
  SilentReplyRewriteShape,
} from "../shared/silent-reply-policy.js";
import type {
  AgentEmbeddedHarnessConfig,
  AgentModelConfig,
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
} from "./types.agents-shared.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type { MemorySearchConfig } from "./types.tools.js";

export type AgentContextInjection = "always" | "continuation-skip" | "never";
export type OptionalBootstrapFileName = "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "IDENTITY.md";
export type EmbeddedPiExecutionContract = "default" | "strict-agentic";

export type Gpt5PromptOverlayConfig = {
  /** Friendly interaction-style layer for GPT-5-family models (default: friendly). */
  personality?: "friendly" | "on" | "off";
};

export type PromptOverlaysConfig = {
  /** Shared GPT-5-family prompt overlay used across providers. */
  gpt5?: Gpt5PromptOverlayConfig;
};

export type AgentModelEntryConfig = {
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
  /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
  streaming?: boolean;
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

export type AgentStartupContextConfig = {
  /** Enable runtime-owned startup-context prelude on bare session resets (default: true). */
  enabled?: boolean;
  /** Which bare reset commands should receive startup context (default: ["new", "reset"]). */
  applyOn?: Array<"new" | "reset">;
  /** How many dated memory files to load counting backward from today (default: 2). */
  dailyMemoryDays?: number;
  /** Max bytes to read from each daily memory file before skipping (default: 16384). */
  maxFileBytes?: number;
  /** Max characters retained from each daily memory file (default: 1200). */
  maxFileChars?: number;
  /** Max total characters retained across the startup prelude (default: 2800). */
  maxTotalChars?: number;
};

export type AgentContextLimitsConfig = {
  /** Default max chars returned by memory_get before truncation metadata/notice (default: 12000). */
  memoryGetMaxChars?: number;
  /** Default line window for memory_get when lines is omitted (default: 120). */
  memoryGetDefaultLines?: number;
  /** Max chars kept for a single live tool result before truncation (default: 16000). */
  toolResultMaxChars?: number;
  /** Max chars retained from post-compaction AGENTS.md context injection (default: 1800). */
  postCompactionMaxChars?: number;
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
  /** JSONL event dialect for CLIs with provider-specific stream formats. */
  jsonlDialect?: "claude-stream-json";
  /** Long-lived CLI process mode. */
  liveSession?: "claude-stdio";
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
  /** Flag used to pass a system prompt file. */
  systemPromptFileArg?: string;
  /** Config override flag used to pass a system prompt file (e.g. -c). */
  systemPromptFileConfigArg?: string;
  /** Config override key used to pass a system prompt file. */
  systemPromptFileConfigKey?: string;
  /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace";
  /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never";
  /** Flag used to pass image paths. */
  imageArg?: string;
  /** How to pass multiple images. */
  imageMode?: "repeat" | "list";
  /** Where staged image files should live before handing them to the CLI. */
  imagePathScope?: "temp" | "workspace";
  /** Serialize runs for this CLI. */
  serialize?: boolean;
  /** Runtime reliability tuning for this backend's process lifecycle. */
  reliability?: {
    /** Live-session output caps for CLIs that stream JSONL through a long-lived process. */
    outputLimits?: {
      /** Max raw JSONL characters retained for one live CLI turn. */
      maxTurnRawChars?: number;
      /** Max raw JSONL lines retained for one live CLI turn. */
      maxTurnLines?: number;
    };
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
  /** Global default provider params applied to all models before per-model and per-agent overrides. */
  params?: Record<string, unknown>;
  /** Default agent runtime policy. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** @deprecated Use agentRuntime. */
  embeddedHarness?: AgentEmbeddedHarnessConfig;
  /** Primary model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  model?: AgentModelConfig;
  /** Optional image-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  imageModel?: AgentModelConfig;
  /** Optional image-generation model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  imageGenerationModel?: AgentModelConfig;
  /** Optional video-generation model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  videoGenerationModel?: AgentModelConfig;
  /** Optional music-generation model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  musicGenerationModel?: AgentModelConfig;
  /**
   * When true (default), shared image/music/video generation appends other
   * auth-backed provider defaults after explicit primary/fallback refs. Set to
   * false to disable implicit cross-provider fallback while keeping explicit
   * fallbacks.
   */
  mediaGenerationAutoProviderFallback?: boolean;
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
  /** Optional default allowlist of skills for agents that do not set agents.list[].skills. */
  skills?: string[];
  /** Silent-reply policy by conversation type. */
  silentReply?: SilentReplyPolicyShape;
  /** Whether disallowed silent replies should be rewritten by conversation type. */
  silentReplyRewrite?: SilentReplyRewriteShape;
  /** Optional repository root for system prompt runtime line (overrides auto-detect). */
  repoRoot?: string;
  /** Optional full system prompt replacement. Primarily for prompt debugging and controlled experiments. */
  systemPromptOverride?: string;
  /** Provider-independent prompt overlays applied by model family. */
  promptOverlays?: PromptOverlaysConfig;
  /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /**
   * List of optional bootstrap filenames to skip writing to the workspace root.
   * Applies to: SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.
   * Required workspace setup such as AGENTS.md and TOOLS.md still runs.
   * Example: ["SOUL.md", "USER.md", "HEARTBEAT.md", "IDENTITY.md"]
   */
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
  /**
   * Controls when workspace bootstrap files (AGENTS.md, SOUL.md, etc.) are
   * injected into the system prompt:
   * - always: inject on every turn (default)
   * - continuation-skip: skip injection on safe continuation turns once the
   *   transcript already contains a completed assistant turn
   */
  contextInjection?: AgentContextInjection;
  /** Max chars for injected bootstrap files before truncation (default: 20000). */
  bootstrapMaxChars?: number;
  /** Max total chars across all injected bootstrap files (default: 150000). */
  bootstrapTotalMaxChars?: number;
  /** Experimental agent-default flags. Keep off unless you are intentionally testing a preview surface. */
  experimental?: {
    /**
     * Drop heavyweight non-essential default tools for weaker or smaller local
     * model backends. Experimental preview only.
     */
    localModelLean?: boolean;
  };
  /**
   * Agent-visible bootstrap truncation warning mode:
   * - off: do not inject warning text
   * - once: inject once per unique truncation signature (default)
   * - always: inject on every run with truncation
   */
  bootstrapPromptTruncationWarning?: "off" | "once" | "always";
  /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string;
  /** Runtime-owned first-turn startup context for bare /new and /reset. */
  startupContext?: AgentStartupContextConfig;
  /** Focused context-budget overrides for high-volume injected/read surfaces. */
  contextLimits?: AgentContextLimitsConfig;
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
    /**
     * Embedded Pi execution contract:
     * - default: keep the standard runner behavior
     * - strict-agentic: on OpenAI/OpenAI Codex GPT-5-family runs, keep acting until hitting a real blocker
     */
    executionContract?: EmbeddedPiExecutionContract;
  };
  /** Vector memory search configuration (per-agent overrides supported). */
  memorySearch?: MemorySearchConfig;
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
  /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on" | "full";
  /** Default reasoning level when no /reasoning directive is present. */
  reasoningDefault?: "off" | "on" | "stream";
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
    target?: string;
    /** Direct/DM delivery policy. Default: "allow". */
    directPolicy?: "allow" | "block";
    /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). Supports :topic:NNN suffix for Telegram topics. */
    to?: string;
    /** Optional account id for multi-account channels. */
    accountId?: string;
    /** Override the heartbeat prompt body (default: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."). */
    prompt?: string;
    /** Include the ## Heartbeats system prompt section for the default agent (default: true). */
    includeSystemPromptSection?: boolean;
    /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
    ackMaxChars?: number;
    /** Suppress tool error warning payloads during heartbeat runs. */
    suppressToolErrorWarnings?: boolean;
    /** Run timeout in seconds for heartbeat agent turns. */
    timeoutSeconds?: number;
    /**
     * If true, run heartbeat turns with lightweight bootstrap context.
     * Lightweight mode keeps only HEARTBEAT.md from workspace bootstrap files.
     */
    lightContext?: boolean;
    /**
     * If true, run heartbeat turns in an isolated session with no prior
     * conversation history. The heartbeat only sees its bootstrap context
     * (HEARTBEAT.md when lightContext is also enabled). Dramatically reduces
     * per-heartbeat token cost by avoiding the full session transcript.
     */
    isolatedSession?: boolean;
    /**
     * If true, defer heartbeat runs while subagent or nested command lanes are busy.
     * Cron lanes are always treated as busy for heartbeat deferral.
     */
    skipWhenBusy?: boolean;
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
    /** Default allowlist of target agent ids for sessions_spawn. Use "*" to allow any. */
    allowAgents?: string[];
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number;
    /** Maximum depth allowed for sessions_spawn chains. Default behavior: 1 (no nested spawns). */
    maxSpawnDepth?: number;
    /** Maximum active children a single requester session may spawn. Default behavior: 5. */
    maxChildrenPerAgent?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60, set 0 to disable). */
    archiveAfterMinutes?: number;
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string;
    /** Default run timeout in seconds for spawned sub-agents (0 = no timeout). */
    runTimeoutSeconds?: number;
    /** Gateway timeout in ms for sub-agent announce delivery calls (default: 90000). */
    announceTimeoutMs?: number;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). Default: false. */
    requireAgentId?: boolean;
  };
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: AgentSandboxConfig;
};

export type AgentCompactionMode = "default" | "safeguard";
export type AgentCompactionPostIndexSyncMode = "off" | "async" | "await";
export type AgentCompactionIdentifierPolicy = "strict" | "off" | "custom";
export type AgentCompactionQualityGuardConfig = {
  /** Enable compaction summary quality audits and regeneration retries. Default: false. */
  enabled?: boolean;
  /** Maximum regeneration retries after a failed quality audit. Default: 1 when enabled. */
  maxRetries?: number;
};

export type AgentCompactionMidTurnPrecheckConfig = {
  /**
   * Enable structured context pressure checks after tool results are appended
   * and before the next Pi model call. Default: false.
   */
  enabled?: boolean;
};

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
  /** Additional compaction-summary instructions that can preserve language or persona continuity. */
  customInstructions?: string;
  /** Preserve this many most-recent user/assistant turns verbatim in compaction summary context. */
  recentTurnsPreserve?: number;
  /** Identifier-preservation instruction policy for compaction summaries. */
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  /** Custom identifier-preservation instructions used when identifierPolicy is "custom". */
  identifierInstructions?: string;
  /** Optional quality-audit retries for safeguard compaction summaries. */
  qualityGuard?: AgentCompactionQualityGuardConfig;
  /** Mid-turn precheck for tool-loop context pressure. Default: disabled. */
  midTurnPrecheck?: AgentCompactionMidTurnPrecheckConfig;
  /** Post-compaction session memory index sync mode. */
  postIndexSync?: AgentCompactionPostIndexSyncMode;
  /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
  /**
   * H2/H3 section names from AGENTS.md to inject after compaction.
   * Defaults to ["Session Startup", "Red Lines"] when unset.
   * Set to [] to disable post-compaction context injection entirely.
   */
  postCompactionSections?: string[];
  /** Optional model override for compaction summarization (e.g. "openrouter/anthropic/claude-sonnet-4-6").
   * When set, compaction uses this model instead of the agent's primary model.
   * Falls back to the primary model when unset. */
  model?: string;
  /** Maximum time in seconds for a single compaction operation (default: 900). */
  timeoutSeconds?: number;
  /**
   * Id of a registered compaction provider plugin.
   * When set, the provider's summarize() is called instead of
   * the built-in summarizeInStages(). Falls back to built-in on failure.
   */
  provider?: string;
  /**
   * Rotate the active session JSONL file after compaction so the next turn
   * starts from the compaction summary and unsummarized tail while the old
   * transcript stays archived.
   * Default: false (existing behavior preserved).
   */
  truncateAfterCompaction?: boolean;
  /**
   * Trigger a normal local compaction when the active session JSONL reaches
   * this size (bytes, or byte-size string like "20mb"). Set to 0/unset to
   * disable. Requires truncateAfterCompaction so successful compaction can
   * rotate to a smaller successor transcript. This does not split raw
   * transcript bytes.
   */
  maxActiveTranscriptBytes?: number | string;
  /**
   * Send brief compaction notices to the user when compaction starts and completes.
   * Default: false (silent by default).
   */
  notifyUser?: boolean;
};

export type AgentCompactionMemoryFlushConfig = {
  /** Enable the pre-compaction memory flush (default: true). */
  enabled?: boolean;
  /** Optional provider/model override used only for pre-compaction memory flush turns. */
  model?: string;
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
