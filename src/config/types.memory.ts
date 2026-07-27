/**
 * Memory config types shared by core context-engine paths and memory host/plugin runtimes.
 * Builtin memory stays core-owned; qmd settings describe the external QMD integration.
 */
import type { SessionSendPolicyConfig } from "./types.base.js";
import type { SecretInput } from "./types.secrets.js";

/** Memory backend family selected for retrieval and session memory features. */
export type MemoryBackend = "builtin" | "qmd";
/** Citation rendering mode for memory-injected context. */
export type MemoryCitationsMode = "auto" | "on" | "off";
/** QMD search command flavor used for retrieval. */
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

/** Top-level memory config block. */
export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  /** Shared embedding/search defaults. Per-agent overrides live under agents.entries.*.memory.search. */
  search?: MemorySearchConfig;
  qmd?: MemoryQmdConfig;
};

/** QMD-specific memory backend config. */
export type MemoryQmdConfig = {
  command?: string;
  searchMode?: MemoryQmdSearchMode;
  rerank?: boolean;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

/** Additional QMD index path entry. */
export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemorySearchConfig = {
  /** Enable vector memory search (default: true). */
  enabled?: boolean;
  /** Use relevant context from this agent's other private conversations. */
  rememberAcrossConversations?: boolean;
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
  /** Experimental session transcript indexing. */
  experimental?: {
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
    };
  };
  /** Fallback memory embedding provider adapter id when embeddings fail. */
  fallback?: string;
  /** Embedding model id (remote) or alias (local). */
  model?: string;
  /** Optional provider-specific embedding input_type for query and document requests. */
  inputType?: string;
  /** Optional provider-specific embedding input_type for query-time memory search. */
  queryInputType?: string;
  /** Optional provider-specific embedding input_type for document/index embeddings. */
  documentInputType?: string;
  /**
   * Gemini embedding-2 models only: output vector dimensions.
   * Supported values today are 768, 1536, and 3072.
   */
  outputDimensionality?: number;
  /** Local embedding settings (node-llama-cpp). */
  local?: {
    /** GGUF model path or hf: URI. */
    modelPath?: string;
  };
  /** Index storage configuration. */
  store?: {
    fts?: {
      /** FTS5 tokenizer (default: "unicode61"). Use "trigram" for CJK text support. */
      tokenizer?: "unicode61" | "trigram";
    };
    vector?: {
      /** Enable the sqlite-vec semantic index (default: true). */
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
  /** Query behavior. */
  query?: {
    maxResults?: number;
    minScore?: number;
  };
  /** Index cache behavior. */
  cache?: {
    /** Cache chunk embeddings in SQLite (default: true). */
    enabled?: boolean;
  };
};

/** Session export settings for QMD memory indexing. */
export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

/** Retrieval and injection limits for QMD memory results. */
export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
