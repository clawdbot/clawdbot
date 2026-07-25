// Defines agent default configuration types shared by runtime schemas.
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SilentReplyPolicyShape } from "../shared/silent-reply-policy.js";
import type {
  AgentModelConfig,
  AgentToolModelConfig,
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
} from "./types.agents-shared.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";

/** Workspace bootstrap-file injection policy for agent system prompts. */
export type AgentContextInjection = "always" | "continuation-skip" | "never";
/**
 * Optional bootstrap files that setup can skip while still creating required
 * agent files. "HEARTBEAT.md" stays accepted as legacy config input even
 * though workspace setup no longer writes it.
 */
export type OptionalBootstrapFileName = "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "IDENTITY.md";
/** Embedded runner behavior contract used by strict-agentic provider flows. */
export type EmbeddedAgentExecutionContract = "default" | "strict-agentic";
/** Prompt-only default for how strongly agents should delegate to sub-agents. */
export type SubagentDelegationMode = "suggest" | "prefer";
/** Image compression/detail preference used before sending image inputs to models. */
export type AgentImageQualityPreference = "auto" | "efficient" | "balanced" | "high";
/** Canonical thinking levels accepted by agent defaults and compaction overrides. */
export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";

export type AgentModelEntryConfig = {
  /** Optional display/lookup alias for this provider/model entry. */
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
  /** Optional agent execution runtime for this specific provider/model entry. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
  streaming?: boolean;
};

export type AgentModelPolicyConfig = {
  /** Model refs allowed for session/run overrides. Empty or omitted allows any model. */
  allow?: string[];
};

export type AgentModelListConfig = {
  /** Primary provider/model ref. */
  primary?: string;
  /** Ordered provider/model fallback refs. */
  fallbacks?: string[];
};

export type AgentContextPruningConfig = {
  /** Pruning mode for old tool results in model context. */
  mode?: "off" | "cache-ttl";
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  tools?: {
    /** Tool names eligible for context pruning. */
    allow?: string[];
    /** Tool names excluded from context pruning. */
    deny?: string[];
  };
  hardClear?: {
    /** Replace oversized old tool results with a placeholder at high pressure. */
    enabled?: boolean;
    /** Placeholder text inserted when a tool result is hard-cleared. */
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
  /** Max chars retained from post-compaction AGENTS.md context injection (default: 1800). */
  postCompactionMaxChars?: number;
};

export type AgentDefaultsConfig = {
  /** @deprecated Doctor-only legacy input. */
  imageGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  videoGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  musicGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimezone?: string;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimestamp?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  envelopeElapsed?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  timeFormat?: "auto" | "12" | "24";
  /** @deprecated Doctor-only legacy input. */
  promptOverlays?: { gpt5?: { personality?: "friendly" | "on" | "off" } };
  /** Global default provider params applied to all models before per-model and per-agent overrides. */
  params?: Record<string, unknown>;
  /** Primary model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  model?: AgentModelConfig;
  /** Optional lower-cost model for short internal tasks such as generated session titles. */
  utilityModel?: string;
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** Optional image-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  imageModel?: AgentToolModelConfig;
  /** Media-generation model preferences by output modality. */
  mediaModels?: {
    image?: AgentToolModelConfig;
    video?: AgentToolModelConfig;
    music?: AgentToolModelConfig;
  };
  /** Optional voice model and fallbacks (provider/model) for TTS/STT/realtime voice providers. */
  voiceModel?: AgentToolModelConfig;
  /** Optional PDF-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  pdfModel?: AgentToolModelConfig;
  /** Maximum PDF file size in megabytes (default: 10). */
  pdfMaxMb?: number;
  /** Maximum number of PDF pages to process (default: 20). */
  pdfMaxPages?: number;
  /** Model catalog with optional aliases (full provider/model keys). */
  models?: Record<string, AgentModelEntryConfig>;
  /** Explicit model override policy. Empty or omitted allow permits any model. */
  modelPolicy?: AgentModelPolicyConfig;
  /** Agent working directory (preferred). Used as the default cwd for agent runs. */
  workspace?: string;
  /** Optional default allowlist of skills for agents that do not set agents.list[].skills. */
  skills?: string[];
  /** Silent-reply policy by conversation type. */
  silentReply?: SilentReplyPolicyShape;
  /** Optional repository root for system prompt runtime line (overrides auto-detect). */
  repoRoot?: string;
  /** Provider-independent prompt overlays applied by model family. */
  /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /**
   * List of optional bootstrap filenames to skip writing to the workspace root.
   * Applies to: SOUL.md, USER.md, IDENTITY.md ("HEARTBEAT.md" is accepted but a no-op).
   * Required workspace setup such as AGENTS.md and TOOLS.md still runs.
   * Example: ["SOUL.md", "USER.md", "IDENTITY.md"]
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
   * - once: inject once per unique truncation signature
   * - always: inject on every run with truncation (default)
   */
  /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string;
  /** Runtime-owned first-turn startup context for bare /new and /reset. */
  startupContext?: AgentStartupContextConfig;
  /** Focused context-budget overrides for high-volume injected/read surfaces. */
  contextLimits?: AgentContextLimitsConfig;
  /** Time format in system prompt: auto (OS preference), 12-hour, or 24-hour. */
  /**
   * Envelope timestamp timezone: "utc" (default), "local", "user", or an IANA timezone string.
   */
  /**
   * Include absolute timestamps in message envelopes, direct agent prompt prefixes,
   * and embedded model-input prefixes ("on" | "off", default: "on").
   */
  /**
   * Include elapsed time in message envelopes ("on" | "off", default: "on").
   */
  /** Optional context window cap (used for runtime estimates + status %). */
  contextTokens?: number;
  /** Opt-in: prune old tool results from the LLM context to reduce token usage. */
  contextPruning?: AgentContextPruningConfig;
  /** Compaction tuning and pre-compaction memory flush behavior. */
  compaction?: AgentCompactionConfig;
  /** Embedded OpenClaw runner hardening and compatibility controls. */
  embeddedAgent?: {
    /**
     * How embedded OpenClaw should trust workspace-local `.openclaw/settings.json`.
     * - sanitize (default): apply project settings except shellPath/shellCommandPrefix
     * - ignore: ignore project settings entirely
     * - trusted: trust project settings as-is
     */
    projectSettingsPolicy?: "trusted" | "sanitize" | "ignore";
    /**
     * Embedded OpenClaw execution contract:
     * - default: keep the standard runner behavior
     * - strict-agentic: enable structured plan tracking and non-visible turn recovery on supported GPT-5 runs
     */
    executionContract?: EmbeddedAgentExecutionContract;
  };
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: AgentThinkingLevel;
  /** Default fast-mode policy inherited by agent entries that omit it. */
  fastModeDefault?: FastMode;
  /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on" | "full";
  /**
   * Detail mode for user-visible tool progress in /verbose and editable progress drafts.
   * - explain: compact human summary (default)
   * - raw: include raw command/detail when available
   */
  toolProgressDetail?: "explain" | "raw";
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
  /**
   * Image compression/detail preference for image-tool media loading.
   * Default: auto, which adapts to provider/model limits and image count.
   */
  imageQuality?: AgentImageQualityPreference;
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
    /** Override the heartbeat prompt body. The default treats scratch as monitor prose and directs recurring work to cron jobs. */
    prompt?: string;
    /** Run timeout in seconds for heartbeat agent turns. Unset uses global timeout or heartbeat cadence capped at 600 seconds. */
    timeoutSeconds?: number;
    /**
     * If true, run heartbeat turns with lightweight bootstrap context.
     * Lightweight mode skips workspace bootstrap files; monitor scratch is
     * injected by the heartbeat runner either way.
     */
    lightContext?: boolean;
    /**
     * If true, run heartbeat turns in an isolated session with no prior
     * conversation history. Dramatically reduces per-heartbeat token cost by
     * avoiding the full session transcript.
     */
    isolatedSession?: boolean;
  };
  /** Max concurrent agent runs across all conversations. Default: 4. */
  maxConcurrent?: number;
  /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Prompt-only guidance for how strongly the main agent should delegate work. Default: "suggest". */
    delegationMode?: SubagentDelegationMode;
    /** Default allowlist of target agent ids for sessions_spawn. Use "*" to allow any configured target. */
    allowAgents?: string[];
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 8. */
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
    /** Gateway timeout in ms for sub-agent announce delivery calls (default: 120000). */
    announceTimeoutMs?: number;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). Default: false. */
    requireAgentId?: boolean;
  };
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: AgentSandboxConfig;
};

export type AgentCompactionMode = "default" | "safeguard";
export type AgentCompactionPostIndexSyncMode = "off" | "async" | "await";
export type AgentCompactionIdentifierPolicy = "strict" | "off";
export type AgentCompactionQualityGuardConfig = {
  /** Enable compaction summary quality audits and regeneration retries. Default: false. */
  enabled?: boolean;
  /** Maximum regeneration retries after a failed quality audit. Default: 1 when enabled. */
  maxRetries?: number;
};

export type AgentCompactionMidTurnPrecheckConfig = {
  /**
   * Enable structured context pressure checks after tool results are appended
   * and before the next agent model call. Default: false.
   */
  enabled?: boolean;
};

export type AgentCompactionConfig = {
  /** Compaction summarization mode. */
  mode?: AgentCompactionMode;
  /** Override the session thinking level for embedded OpenClaw compaction summaries. */
  thinkingLevel?: AgentThinkingLevel;
  /** Embedded OpenClaw keepRecentTokens budget used for cut-point selection. */
  keepRecentTokens?: number;
  /** Preserve this many most-recent user/assistant turns verbatim in compaction summary context. */
  recentTurnsPreserve?: number;
  /** Identifier-preservation instruction policy for compaction summaries. */
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  /** Optional quality-audit retries for safeguard compaction summaries. */
  qualityGuard?: AgentCompactionQualityGuardConfig;
  /** Mid-turn precheck for tool-loop context pressure. Default: disabled. */
  midTurnPrecheck?: AgentCompactionMidTurnPrecheckConfig;
  /** Post-compaction session memory index sync mode. */
  postIndexSync?: AgentCompactionPostIndexSyncMode;
  /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
  /** H2/H3 section names from AGENTS.md to inject after compaction. */
  postCompactionSections?: string[];
  /** Optional provider/model or configured bare alias for compaction summarization.
   * When set, compaction uses this model instead of the agent's primary model.
   * Falls back to the primary model when unset. */
  model?: string;
  /** Maximum time in seconds for a single compaction operation (default: 180). */
  timeoutSeconds?: number;
  /**
   * Id of a registered compaction provider plugin.
   * When set, the provider's summarize() is called instead of
   * the built-in summarizeInStages(). Falls back to built-in on failure.
   */
  provider?: string;
  /**
   * Rotate the active session transcript after compaction so the next turn
   * starts from the compaction summary and unsummarized tail while the old
   * transcript stays archived.
   * Default: false (existing behavior preserved).
   */
  truncateAfterCompaction?: boolean;
  /**
   * Trigger a normal local compaction when the active session transcript reaches
   * this size (bytes, or byte-size string like "20mb"). Set to 0/unset to
   * disable. Requires truncateAfterCompaction so successful compaction can
   * rotate to a smaller successor transcript. This does not split raw
   * transcript bytes.
   */
  maxActiveTranscriptBytes?: number | string;
  /**
   * Send brief context-maintenance notices to the user: when compaction starts
   * and completes, and when a pre-compaction memory flush is exhausted so the
   * reply continues in a degraded state.
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
};
