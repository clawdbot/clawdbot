import type { AgentElevatedAllowFromConfig } from "./types.base.js";

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

export type AgentToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
  deny?: string[];
  /** Per-agent elevated exec gate (can only further restrict global tools.elevated). */
  elevated?: {
    /** Enable or disable elevated mode for this agent (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
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
  /** Embedding provider mode. */
  provider?: "openai" | "local";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
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
  };
};

export type ToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
  deny?: string[];
  audio?: {
    transcription?: {
      /** CLI args (template-enabled). */
      args?: string[];
      timeoutSeconds?: number;
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
  exec?: {
    /** Default time (ms) before an exec command auto-backgrounds. */
    backgroundMs?: number;
    /** Default timeout (seconds) before auto-killing exec commands. */
    timeoutSec?: number;
    /** How long to keep finished sessions in memory (ms). */
    cleanupMs?: number;
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
  /** @deprecated Use tools.exec. */
  bash?: {
    /** Default time (ms) before a bash command auto-backgrounds. */
    backgroundMs?: number;
    /** Default timeout (seconds) before auto-killing bash commands. */
    timeoutSec?: number;
    /** How long to keep finished sessions in memory (ms). */
    cleanupMs?: number;
  };
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
