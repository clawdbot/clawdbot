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
  deny?: string[];
  profile?: ToolProfileId;
};

export type ExecToolConfig = {
  host?: "sandbox" | "gateway" | "node";
  security?: "deny" | "allowlist" | "full";
  ask?: "off" | "on-miss" | "always";
  node?: string;
  backgroundMs?: number;
  timeoutSec?: number;
  cleanupMs?: number;
  notifyOnExit?: boolean;
  applyPatch?: {
    enabled?: boolean;
    allowModels?: string[];
  };
};

export type AgentToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
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
  /** Experimental memory search settings. */
  experimental?: {
    /** Enable session transcript indexing (experimental, default: false). */
    sessionMemory?: boolean;
  };
  /** Embedding provider mode. */
  provider?: "openai" | "local";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch?: {
      /** Enable OpenAI Batch API for embedding indexing (default: true). */
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
  /** Fallback behavior when local embeddings fail. */
  fallback?: "openai" | "none";
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
