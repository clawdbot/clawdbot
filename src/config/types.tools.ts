import type { ChatType } from "../channels/chat-type.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { AgentElevatedAllowFromConfig, SessionSendPolicyAction } from "./types.base.js";
import type { MemoryQmdIndexPath } from "./types.memory.js";
import type { ConfiguredProviderRequest } from "./types.provider-request.js";
import type { SecretInput } from "./types.secrets.js";

export type MediaUnderstandingScopeMatch = {
  channel?: string;
  chatType?: ChatType;
  keyPrefix?: string;
};

export type MediaUnderstandingScopeRule = {
  action: SessionSendPolicyAction;
  match?: MediaUnderstandingScopeMatch;
};

export type MediaUnderstandingScopeConfig = {
  default?: SessionSendPolicyAction;
  rules?: MediaUnderstandingScopeRule[];
};

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingAttachmentsConfig = {
  /** Select the first matching attachment or process multiple. */
  mode?: "first" | "all";
  /** Max number of attachments to process (default: 1). */
  maxAttachments?: number;
  /** Attachment ordering preference. */
  prefer?: "first" | "last" | "path" | "url";
};

type MediaProviderRequestConfig = {
  /** Optional provider-specific query params (merged into requests). */
  providerOptions?: Record<string, Record<string, string | number | boolean>>;
  /** @deprecated Use providerOptions.deepgram instead. */
  deepgram?: {
    detectLanguage?: boolean;
    punctuate?: boolean;
    smartFormat?: boolean;
  };
  /** Optional base URL override for provider requests. */
  baseUrl?: string;
  /** Optional headers merged into provider requests. */
  headers?: Record<string, string>;
  /** Optional request transport overrides for provider HTTP calls. */
  request?: ConfiguredProviderRequest;
};

export type MediaUnderstandingModelConfig = MediaProviderRequestConfig & {
  /** provider API id (e.g. openai, google). */
  provider?: string;
  /** Model id for provider-based understanding. */
  model?: string;
  /** Optional capability tags for shared model lists. */
  capabilities?: MediaUnderstandingCapability[];
  /** Use a CLI command instead of provider API. */
  type?: "provider" | "cli";
  /** CLI binary (required when type=cli). */
  command?: string;
  /** CLI args (template-enabled). */
  args?: string[];
  /** Optional prompt override for this model entry. */
  prompt?: string;
  /** Optional max output characters for this model entry. */
  maxChars?: number;
  /** Optional max bytes for this model entry. */
  maxBytes?: number;
  /** Optional timeout override (seconds) for this model entry. */
  timeoutSeconds?: number;
  /** Optional language hint for audio transcription. */
  language?: string;
  /** Auth profile id to use for this provider. */
  profile?: string;
  /** Preferred profile id if multiple are available. */
  preferredProfile?: string;
};

export type MediaUnderstandingConfig = MediaProviderRequestConfig & {
  /** Enable media understanding when models are configured. */
  enabled?: boolean;
  /** Optional scope gating for understanding. */
  scope?: MediaUnderstandingScopeConfig;
  /** Default max bytes to send. */
  maxBytes?: number;
  /** Default max output characters. */
  maxChars?: number;
  /** Default prompt. */
  prompt?: string;
  /** Default timeout (seconds). */
  timeoutSeconds?: number;
  /** Default language hint (audio). */
  language?: string;
  /** Attachment selection policy. */
  attachments?: MediaUnderstandingAttachmentsConfig;
  /** Ordered model list (fallbacks in order). */
  models?: MediaUnderstandingModelConfig[];
  /**
   * Echo the audio transcript back to the originating chat before agent processing.
   * Lets users verify what was heard. Default: false.
   */
  echoTranscript?: boolean;
  /**
   * Format string for the echoed transcript. Use `{transcript}` as placeholder.
   * Default: '📝 "{transcript}"'
   */
  echoFormat?: string;
};

export type LinkModelConfig = {
  /** Use a CLI command for link processing. */
  type?: "cli";
  /** CLI binary (required when type=cli). */
  command: string;
  /** CLI args (template-enabled). */
  args?: string[];
  /** Optional timeout override (seconds) for this model entry. */
  timeoutSeconds?: number;
};

export type LinkToolsConfig = {
  /** Enable link understanding when models are configured. */
  enabled?: boolean;
  /** Optional scope gating for understanding. */
  scope?: MediaUnderstandingScopeConfig;
  /** Max number of links to process per message. */
  maxLinks?: number;
  /** Default timeout (seconds). */
  timeoutSeconds?: number;
  /** Ordered model list (fallbacks in order). */
  models?: LinkModelConfig[];
};

export type MediaToolsConfig = {
  /** Shared model list applied across image/audio/video. */
  models?: MediaUnderstandingModelConfig[];
  /** Max concurrent media understanding runs. */
  concurrency?: number;
  asyncCompletion?: {
    /**
     * Enable direct channel sends for completed async media generation tasks.
     * Default: false.
     */
    directSend?: boolean;
  };
  image?: MediaUnderstandingConfig;
  audio?: MediaUnderstandingConfig;
  video?: MediaUnderstandingConfig;
};

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

export type ToolLoopDetectionDetectorConfig = {
  /** Enable warning/blocking for repeated identical calls to the same tool/params. */
  genericRepeat?: boolean;
  /** Enable warning/blocking for known no-progress polling loops. */
  knownPollNoProgress?: boolean;
  /** Enable warning/blocking for no-progress ping-pong alternating patterns. */
  pingPong?: boolean;
};

export type ToolLoopDetectionConfig = {
  /** Enable tool-loop protection (default: false). */
  enabled?: boolean;
  /** Maximum tool call history entries retained for loop detection (default: 30). */
  historySize?: number;
  /** Warning threshold before a warning-only loop classification (default: 10). */
  warningThreshold?: number;
  /** Block repeated calls to the same unavailable tool after this many misses (default: 10). */
  unknownToolThreshold?: number;
  /** Critical threshold for blocking repetitive loops (default: 20). */
  criticalThreshold?: number;
  /** Global no-progress breaker threshold (default: 30). */
  globalCircuitBreakerThreshold?: number;
  /** Detector toggles. */
  detectors?: ToolLoopDetectionDetectorConfig;
};

export type SessionsToolsVisibility = "self" | "tree" | "agent" | "all";

export type ToolPolicyConfig = {
  allow?: string[];
  /**
   * Additional allowlist entries merged into the effective allowlist.
   *
   * Intended for additive configuration (e.g., "also allow lobster") without forcing
   * users to replace/duplicate an existing allowlist or profile.
   */
  alsoAllow?: string[];
  deny?: string[];
  profile?: ToolProfileId;
};

export type GroupToolPolicyConfig = {
  allow?: string[];
  /** Additional allowlist entries merged into allow. */
  alsoAllow?: string[];
  deny?: string[];
};

export const TOOLS_BY_SENDER_KEY_TYPES = ["id", "e164", "username", "name"] as const;
export type ToolsBySenderKeyType = (typeof TOOLS_BY_SENDER_KEY_TYPES)[number];

export function parseToolsBySenderTypedKey(
  rawKey: string,
): { type: ToolsBySenderKeyType; value: string } | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
    const prefix = `${type}:`;
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    return {
      type,
      value: trimmed.slice(prefix.length),
    };
  }
  return undefined;
}

/**
 * Per-sender overrides.
 *
 * Prefer explicit key prefixes:
 * - id:<senderId>
 * - e164:<phone>
 * - username:<handle>
 * - name:<display-name>
 * - * (wildcard)
 *
 * Legacy unprefixed keys are supported for backward compatibility and are matched as senderId only.
 */
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;

export type ExecToolConfig = {
  /** Exec host routing (default: auto). */
  host?: "auto" | "sandbox" | "gateway" | "node";
  /** Exec security mode (default: deny). */
  security?: "deny" | "allowlist" | "full";
  /** Exec ask mode (default: on-miss). */
  ask?: "off" | "on-miss" | "always";
  /** Default node binding for exec.host=node (node id/name). */
  node?: string;
  /** Directories to prepend to PATH when running exec (gateway/sandbox). */
  pathPrepend?: string[];
  /** Safe stdin-only binaries that can run without allowlist entries. */
  safeBins?: string[];
  /**
   * Require explicit approval for interpreter inline-eval forms (`python -c`, `node -e`, etc.).
   * Prevents silent allowlist reuse and allow-always persistence for those forms.
   */
  strictInlineEval?: boolean;
  /** Extra explicit directories trusted for safeBins path checks (never derived from PATH). */
  safeBinTrustedDirs?: string[];
  /** Optional custom safe-bin profiles for entries in tools.exec.safeBins. */
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  /** Default time (ms) before an exec command auto-backgrounds. */
  backgroundMs?: number;
  /** Default timeout (seconds) before auto-killing exec commands. */
  timeoutSec?: number;
  /** Emit a running notice (ms) when approval-backed exec runs long (default: 10000, 0 = off). */
  approvalRunningNoticeMs?: number;
  /** How long to keep finished sessions in memory (ms). */
  cleanupMs?: number;
  /** Emit a system event and heartbeat when a backgrounded exec exits. */
  notifyOnExit?: boolean;
  /**
   * Also emit success exit notifications when a backgrounded exec has no output.
   * Default false to reduce context noise.
   */
  notifyOnExitEmptySuccess?: boolean;
  /** apply_patch subtool configuration. */
  applyPatch?: {
    /** Enable apply_patch for OpenAI models (default: true; set false to disable). */
    enabled?: boolean;
    /**
     * Restrict apply_patch paths to the workspace directory.
     * Default: true (safer; does not affect read/write/edit).
     */
    workspaceOnly?: boolean;
    /**
     * Optional allowlist of model ids that can use apply_patch.
     * Accepts either raw ids (e.g. "gpt-5.4") or full ids (e.g. "openai/gpt-5.4").
     */
    allowModels?: string[];
  };
};

export type FsToolsConfig = {
  /**
   * Restrict filesystem tools (read/write/edit/apply_patch) to the agent workspace directory.
   * Default: false (unrestricted, matches legacy behavior).
   */
  workspaceOnly?: boolean;
};

export type AgentToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
  /** Additional allowlist entries merged into allow and/or profile allowlist. */
  alsoAllow?: string[];
  deny?: string[];
  /** Optional tool policy overrides keyed by provider id or "provider/model". */
  byProvider?: Record<string, ToolPolicyConfig>;
  /** Per-agent elevated exec gate (can only further restrict global tools.elevated). */
  elevated?: {
    /** Enable or disable elevated mode for this agent (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Exec tool defaults for this agent. */
  exec?: ExecToolConfig;
  /** Filesystem tool path guards. */
  fs?: FsToolsConfig;
  /** Runtime loop detection for repetitive/ stuck tool-call patterns. */
  loopDetection?: ToolLoopDetectionConfig;
  sandbox?: {
    tools?: {
      allow?: string[];
      /** Additional allowlist entries merged into allow and/or the sandbox default allowlist. */
      alsoAllow?: string[];
      deny?: string[];
    };
  };
};

export type MemorySearchConfig = {
  /** Enable vector memory search (default: true). */
  enabled?: boolean;
  /** Sources to index and search (default: ["memory"]). */
  sources?: Array<"memory" | "sessions">;
  /** Extra paths to include in memory search (directories or .md files). */
  extraPaths?: string[];
  /** Optional QMD-specific extra collections for cross-agent search. */
  qmd?: {
    /** Additional QMD collections appended for this agent's search scope. */
    extraCollections?: MemoryQmdIndexPath[];
  };
  /** Optional multimodal file indexing for selected extra paths. */
  multimodal?: {
    /** Enable image/audio embeddings from extraPaths. */
    enabled?: boolean;
    /** Which non-text file types to index. */
    modalities?: Array<"image" | "audio" | "all">;
    /** Max bytes allowed per multimodal file before it is skipped. */
    maxFileBytes?: number;
  };
  /** Experimental memory search settings. */
  experimental?: {
    /** Enable session transcript indexing (experimental, default: false). */
    sessionMemory?: boolean;
  };
  /** Memory embedding provider adapter id. */
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
    batch?: {
      /** Enable batch API for embedding indexing (OpenAI/Gemini; default: true). */
      enabled?: boolean;
      /** Wait for batch completion (default: true). */
      wait?: boolean;
      /** Max concurrent batch jobs (default: 2). */
      concurrency?: number;
      /** Poll interval in ms (default: 5000). */
      pollIntervalMs?: number;
      /** Timeout in minutes (default: 60). */
      timeoutMinutes?: number;
    };
  };
  /** Fallback memory embedding provider adapter id when embeddings fail. */
  fallback?: string;
  /** Embedding model id (remote) or alias (local). */
  model?: string;
  /**
   * Gemini embedding-2 models only: output vector dimensions.
   * Supported values today are 768, 1536, and 3072.
   */
  outputDimensionality?: number;
  /** Local embedding settings (node-llama-cpp). */
  local?: {
    /** GGUF model path or hf: URI. */
    modelPath?: string;
    /** Optional cache directory for local models. */
    modelCacheDir?: string;
  };
  /** Index storage configuration. */
  store?: {
    driver?: "sqlite";
    path?: string;
    fts?: {
      /** FTS5 tokenizer (default: "unicode61"). Use "trigram" for CJK text support. */
      tokenizer?: "unicode61" | "trigram";
    };
    vector?: {
      /** Enable sqlite-vec extension for vector search (default: true). */
      enabled?: boolean;
      /** Optional override path to sqlite-vec extension (.dylib/.so/.dll). */
      extensionPath?: string;
    };
    cache?: {
      /** Enable embedding cache (default: true). */
      enabled?: boolean;
      /** Optional max cache entries per provider/model. */
      maxEntries?: number;
    };
  };
  /** Chunking configuration. */
  chunking?: {
    tokens?: number;
    overlap?: number;
  };
  /** Sync behavior. */
  sync?: {
    onSessionStart?: boolean;
    onSearch?: boolean;
    watch?: boolean;
    watchDebounceMs?: number;
    intervalMinutes?: number;
    sessions?: {
      /** Minimum appended bytes before session transcripts are reindexed. */
      deltaBytes?: number;
      /** Minimum appended JSONL lines before session transcripts are reindexed. */
      deltaMessages?: number;
      /** Force session reindex after compaction-triggered transcript updates (default: true). */
      postCompactionForce?: boolean;
    };
  };
  /** Query behavior. */
  query?: {
    maxResults?: number;
    minScore?: number;
    hybrid?: {
      /** Enable hybrid BM25 + vector search (default: true). */
      enabled?: boolean;
      /** Weight for vector similarity when merging results (0-1). */
      vectorWeight?: number;
      /** Weight for BM25 text relevance when merging results (0-1). */
      textWeight?: number;
      /** Multiplier for candidate pool size (default: 4). */
      candidateMultiplier?: number;
      /** Optional MMR re-ranking for result diversity. */
      mmr?: {
        /** Enable MMR re-ranking (default: false). */
        enabled?: boolean;
        /** Lambda: 0 = max diversity, 1 = max relevance (default: 0.7). */
        lambda?: number;
      };
      /** Optional temporal decay to boost recency in hybrid scoring. */
      temporalDecay?: {
        /** Enable temporal decay (default: false). */
        enabled?: boolean;
        /** Half-life in days for exponential decay (default: 30). */
        halfLifeDays?: number;
      };
    };
  };
  /** Index cache behavior. */
  cache?: {
    /** Cache chunk embeddings in SQLite (default: true). */
    enabled?: boolean;
    /** Optional cap on cached embeddings (best-effort). */
    maxEntries?: number;
  };
};

export type ToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
  /** Additional allowlist entries merged into allow and/or profile allowlist. */
  alsoAllow?: string[];
  deny?: string[];
  /** Optional tool policy overrides keyed by provider id or "provider/model". */
  byProvider?: Record<string, ToolPolicyConfig>;
  web?: {
    search?: {
      /** Enable managed web_search and optional Codex-native web search. */
      enabled?: boolean;
      /** Search provider id. */
      provider?: string;
      /** Shared API key slot used by providers that do not need nested config. */
      apiKey?: SecretInput;
      /** Default search results count (1-10). */
      maxResults?: number;
      /** Timeout in seconds for search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for search results. */
      cacheTtlMinutes?: number;
      /** Optional native Codex web search for Codex-capable models. */
      openaiCodex?: {
        /** Enable native Codex web search for eligible models. */
        enabled?: boolean;
        /** Use cached or live external web access. Default: "cached". */
        mode?: "cached" | "live";
        /** Optional allowlist of domains passed to the native Codex tool. */
        allowedDomains?: string[];
        /** Optional Codex native search context size hint. */
        contextSize?: "low" | "medium" | "high";
        /** Optional approximate user location passed to the native Codex tool. */
        userLocation?: {
          country?: string;
          region?: string;
          city?: string;
          timezone?: string;
        };
      };
    } & Record<string, unknown>;
    /** X (formerly Twitter) search tool configuration using xAI Grok. */
    x_search?: {
      /** Enable X search tool (default: true when xAI auth is available via plugin config or XAI_API_KEY). */
      enabled?: boolean;
      /** Model id to use for X search. */
      model?: string;
      /** Keep inline citations in the xAI response payload when available. */
      inlineCitations?: boolean;
      /** Optional max search/tool turns for xAI to use internally. */
      maxTurns?: number;
      /** Timeout in seconds for X search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for X search results. */
      cacheTtlMinutes?: number;
    };
    fetch?: {
      /** Enable web fetch tool (default: true). */
      enabled?: boolean;
      /** Web fetch fallback provider id. */
      provider?: string;
      /** Max characters to return from fetched content. */
      maxChars?: number;
      /** Hard cap for maxChars (tool or config), defaults to 50000. */
      maxCharsCap?: number;
      /** Max download size before truncation, defaults to 2000000. */
      maxResponseBytes?: number;
      /** Timeout in seconds for fetch requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for fetched content. */
      cacheTtlMinutes?: number;
      /** Maximum number of redirects to follow (default: 3). */
      maxRedirects?: number;
      /** Override User-Agent header for fetch requests. */
      userAgent?: string;
      /** Use Readability to extract main content (default: true). */
      readability?: boolean;
      /** SSRF policy configuration for web_fetch. */
      ssrfPolicy?: {
        /** Allow RFC 2544 benchmark range IPs (198.18.0.0/15) for fake-IP proxy compatibility (e.g., Clash TUN mode, Surge). */
        allowRfc2544BenchmarkRange?: boolean;
      };
    };
  };
  media?: MediaToolsConfig;
  links?: LinkToolsConfig;
  /** Message tool configuration. */
  message?: {
    /**
     * @deprecated Use tools.message.crossContext settings.
     * Allows cross-context sends across providers.
     */
    allowCrossContextSend?: boolean;
    crossContext?: {
      /** Allow sends to other channels within the same provider (default: true). */
      allowWithinProvider?: boolean;
      /** Allow sends across different providers (default: false). */
      allowAcrossProviders?: boolean;
      /** Cross-context marker configuration. */
      marker?: {
        /** Enable origin markers for cross-context sends (default: true). */
        enabled?: boolean;
        /** Text prefix template, supports {channel}. */
        prefix?: string;
        /** Text suffix template, supports {channel}. */
        suffix?: string;
      };
    };
    broadcast?: {
      /** Enable broadcast action (default: true). */
      enabled?: boolean;
    };
  };
  agentToAgent?: {
    /** Enable agent-to-agent messaging tools. Default: false. */
    enabled?: boolean;
    /** Allowlist of agent ids or patterns (implementation-defined). */
    allow?: string[];
  };
  /**
   * Session tool visibility controls which sessions can be targeted by session tools
   * (sessions_list, sessions_history, sessions_send).
   *
   * Default: "tree" (current session + spawned subagent sessions).
   */
  sessions?: {
    /**
     * - "self": only the current session
     * - "tree": current session + sessions spawned by this session (default)
     * - "agent": any session belonging to the current agent id (can include other users)
     * - "all": any session (cross-agent still requires tools.agentToAgent)
     */
    visibility?: SessionsToolsVisibility;
  };
  /** Elevated exec permissions for the host machine. */
  elevated?: {
    /** Enable or disable elevated mode (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Exec tool defaults. */
  exec?: ExecToolConfig;
  /** Filesystem tool path guards. */
  fs?: FsToolsConfig;
  /** Runtime loop detection for repetitive/ stuck tool-call patterns. */
  loopDetection?: ToolLoopDetectionConfig;
  /** Sub-agent tool policy defaults (deny wins). */
  subagents?: {
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
    tools?: {
      allow?: string[];
      /** Additional allowlist entries merged into allow and/or default sub-agent denylist. */
      alsoAllow?: string[];
      deny?: string[];
    };
  };
  /** Sandbox tool policy defaults (deny wins). */
  sandbox?: {
    tools?: {
      allow?: string[];
      /** Additional allowlist entries merged into allow and/or the sandbox default allowlist. */
      alsoAllow?: string[];
      deny?: string[];
    };
  };
  /** Experimental tool flags. Default off unless explicitly enabled, except strict-agentic GPT-5 OpenAI/Codex runs may auto-enable `planTool`. */
  experimental?: {
    /** Enable the structured `update_plan` tool explicitly outside strict-agentic execution mode. */
    planTool?: boolean;
  };
};
