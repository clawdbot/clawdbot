import type { NormalizedChatType } from "../channels/chat-type.js";
import type { AgentElevatedAllowFromConfig, SessionSendPolicyAction } from "./types.base.js";

export type MediaUnderstandingScopeMatch = {
  channel?: string;
  chatType?: NormalizedChatType;
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

export type MediaUnderstandingModelConfig = {
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
  /** Auth profile id to use for this provider. */
  profile?: string;
  /** Preferred profile id if multiple are available. */
  preferredProfile?: string;
};

export type MediaUnderstandingConfig = {
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
  /** Attachment selection policy. */
  attachments?: MediaUnderstandingAttachmentsConfig;
  /** Ordered model list (fallbacks in order). */
  models?: MediaUnderstandingModelConfig[];
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
  image?: MediaUnderstandingConfig;
  audio?: MediaUnderstandingConfig;
  video?: MediaUnderstandingConfig;
};

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

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

export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;

export type ExecToolConfig = {
  /** Exec host routing (default: sandbox). */
  host?: "sandbox" | "gateway" | "node";
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
  /** apply_patch subtool configuration (experimental). */
  applyPatch?: {
    /** Enable apply_patch for OpenAI models (default: false). */
    enabled?: boolean;
    /**
     * Optional allowlist of model ids that can use apply_patch.
     * Accepts either raw ids (e.g. "gpt-5.2") or full ids (e.g. "openai/gpt-5.2").
     */
    allowModels?: string[];
  };
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
  sandbox?: {
    tools?: {
      allow?: string[];
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
  /** Experimental memory search settings. */
  experimental?: {
    /** Enable session transcript indexing (experimental, default: false). */
    sessionMemory?: boolean;
  };
  /** Embedding provider mode. */
  provider?: "openai" | "gemini" | "local";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
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
  /** Fallback behavior when embeddings fail. */
  fallback?: "openai" | "gemini" | "local" | "none";
  /** Embedding model id (remote) or alias (local). */
  model?: string;
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
      /** Enable web search tool (default: true when API key is present). */
      enabled?: boolean;
      /** Search provider ("brave" or "perplexity"). */
      provider?: "brave" | "perplexity";
      /** Brave Search API key (optional; defaults to BRAVE_API_KEY env var). */
      apiKey?: string;
      /** Default search results count (1-10). */
      maxResults?: number;
      /** Timeout in seconds for search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for search results. */
      cacheTtlMinutes?: number;
      /** Perplexity-specific configuration (used when provider="perplexity"). */
      perplexity?: {
        /** API key for Perplexity or OpenRouter (defaults to PERPLEXITY_API_KEY or OPENROUTER_API_KEY env var). */
        apiKey?: string;
        /** Base URL for API requests (defaults to OpenRouter: https://openrouter.ai/api/v1). */
        baseUrl?: string;
        /** Model to use (defaults to "perplexity/sonar-pro"). */
        model?: string;
      };
    };
    fetch?: {
      /** Enable web fetch tool (default: true). */
      enabled?: boolean;
      /** Max characters to return from fetched content. */
      maxChars?: number;
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
      firecrawl?: {
        /** Enable Firecrawl fallback (default: true when apiKey is set). */
        enabled?: boolean;
        /** Firecrawl API key (optional; defaults to FIRECRAWL_API_KEY env var). */
        apiKey?: string;
        /** Firecrawl base URL (default: https://api.firecrawl.dev). */
        baseUrl?: string;
        /** Whether to keep only main content (default: true). */
        onlyMainContent?: boolean;
        /** Max age (ms) for cached Firecrawl content. */
        maxAgeMs?: number;
        /** Timeout in seconds for Firecrawl requests. */
        timeoutSeconds?: number;
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
  /** Elevated exec permissions for the host machine. */
  elevated?: {
    /** Enable or disable elevated mode (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Exec tool defaults. */
  exec?: ExecToolConfig;
  /** Sub-agent tool policy defaults (deny wins). */
  subagents?: {
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
  /** Sandbox tool policy defaults (deny wins). */
  sandbox?: {
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
};
