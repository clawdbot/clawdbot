import os from "node:os";
import path from "node:path";

import type { MoltbotConfig, MemorySearchConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { clampInt, clampNumber, resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  provider: "openai" | "local" | "gemini" | "auto";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch?: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  experimental: {
    sessionMemory: boolean;
  };
  fallback: "openai" | "gemini" | "local" | "none";
  model: string;
  local: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  store: {
    driver: "sqlite";
    path: string;
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;
    overlap: number;
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    sessions: {
      deltaBytes: number;
      deltaMessages: number;
    };
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
};

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 100_000;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_CACHE_ENABLED = true;
const DEFAULT_SOURCES: Array<"memory" | "sessions"> = ["memory"];

function normalizeSources(
  sources: Array<"memory" | "sessions"> | undefined,
  sessionMemoryEnabled: boolean,
): Array<"memory" | "sessions"> {
  const normalized = new Set<"memory" | "sessions">();
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  for (const source of input) {
    if (source === "memory") normalized.add("memory");
    if (source === "sessions" && sessionMemoryEnabled) normalized.add("sessions");
  }
  if (normalized.size === 0) normalized.add("memory");
  return Array.from(normalized);
}

function resolveStorePath(agentId: string, raw?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
  if (!raw) return fallback;
  const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
  return resolveUserPath(withToken);
}

function mergeConfig(
  defaults: MemorySearchConfig | undefined,
  overrides: MemorySearchConfig | undefined,
  agentId: string,
): ResolvedMemorySearchConfig {
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  const sessionMemory =
    overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
  const provider = overrides?.provider ?? defaults?.provider ?? "auto";
  const defaultRemote = defaults?.remote;
  const overrideRemote = overrides?.remote;
  const hasRemoteConfig = Boolean(
    overrideRemote?.baseUrl ||
    overrideRemote?.apiKey ||
    overrideRemote?.headers ||
    defaultRemote?.baseUrl ||
    defaultRemote?.apiKey ||
    defaultRemote?.headers,
  );
  const includeRemote =
    hasRemoteConfig || provider === "openai" || provider === "gemini" || provider === "auto";
  const batch = {
    enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? true,
    wait: overrideRemote?.batch?.wait ?? defaultRemote?.batch?.wait ?? true,
    concurrency: Math.max(
      1,
      overrideRemote?.batch?.concurrency ?? defaultRemote?.batch?.concurrency ?? 2,
    ),
    pollIntervalMs:
      overrideRemote?.batch?.pollIntervalMs ?? defaultRemote?.batch?.pollIntervalMs ?? 2000,
    timeoutMinutes:
      overrideRemote?.batch?.timeoutMinutes ?? defaultRemote?.batch?.timeoutMinutes ?? 60,
  };
  const remote = includeRemote
    ? {
        baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
        apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
        headers: overrideRemote?.headers ?? defaultRemote?.headers,
        batch,
      }
    : undefined;
  const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
  const modelDefault =
    provider === "gemini"
      ? DEFAULT_GEMINI_MODEL
      : provider === "openai"
        ? DEFAULT_OPENAI_MODEL
        : undefined;
  const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
  const local = {
    modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
    modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir,
  };
  const sources = normalizeSources(overrides?.sources ?? defaults?.sources, sessionMemory);
  const vector = {
    enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
    extensionPath:
      overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath,
  };
  const store = {
    driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
    path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
    vector,
  };
  const chunking = {
    tokens: overrides?.chunking?.tokens ?? defaults?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
    overlap: overrides?.chunking?.overlap ?? defaults?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP,
  };
  const sync = {
    onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
    onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
    watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
    watchDebounceMs:
      overrides?.sync?.watchDebounceMs ??
      defaults?.sync?.watchDebounceMs ??
      DEFAULT_WATCH_DEBOUNCE_MS,
    intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 0,
    sessions: {
      deltaBytes:
        overrides?.sync?.sessions?.deltaBytes ??
        defaults?.sync?.sessions?.deltaBytes ??
        DEFAULT_SESSION_DELTA_BYTES,
      deltaMessages:
        overrides?.sync?.sessions?.deltaMessages ??
        defaults?.sync?.sessions?.deltaMessages ??
        DEFAULT_SESSION_DELTA_MESSAGES,
    },
  };
  const query = {
    maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
    minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE,
  };
  const hybrid = {
    enabled:
      overrides?.query?.hybrid?.enabled ??
      defaults?.query?.hybrid?.enabled ??
      DEFAULT_HYBRID_ENABLED,
    vectorWeight:
      overrides?.query?.hybrid?.vectorWeight ??
      defaults?.query?.hybrid?.vectorWeight ??
      DEFAULT_HYBRID_VECTOR_WEIGHT,
    textWeight:
      overrides?.query?.hybrid?.textWeight ??
      defaults?.query?.hybrid?.textWeight ??
      DEFAULT_HYBRID_TEXT_WEIGHT,
    candidateMultiplier:
      overrides?.query?.hybrid?.candidateMultiplier ??
      defaults?.query?.hybrid?.candidateMultiplier ??
      DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
  };
  const cache = {
    enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
    maxEntries: overrides?.cache?.maxEntries ?? defaults?.cache?.maxEntries,
  };

  const overlap = clampNumber(chunking.overlap, 0, Math.max(0, chunking.tokens - 1));
  const minScore = clampNumber(query.minScore, 0, 1);
  const vectorWeight = clampNumber(hybrid.vectorWeight, 0, 1);
  const textWeight = clampNumber(hybrid.textWeight, 0, 1);
  const sum = vectorWeight + textWeight;
  const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
  const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
  const candidateMultiplier = clampInt(hybrid.candidateMultiplier, 1, 20);
  const deltaBytes = clampInt(sync.sessions.deltaBytes, 0, Number.MAX_SAFE_INTEGER);
  const deltaMessages = clampInt(sync.sessions.deltaMessages, 0, Number.MAX_SAFE_INTEGER);
  return {
    enabled,
    sources,
    provider,
    remote,
    experimental: {
      sessionMemory,
    },
    fallback,
    model,
    local,
    store,
    chunking: { tokens: Math.max(1, chunking.tokens), overlap },
    sync: {
      ...sync,
      sessions: {
        deltaBytes,
        deltaMessages,
      },
    },
    query: {
      ...query,
      minScore,
      hybrid: {
        enabled: Boolean(hybrid.enabled),
        vectorWeight: normalizedVectorWeight,
        textWeight: normalizedTextWeight,
        candidateMultiplier,
      },
    },
    cache: {
      enabled: Boolean(cache.enabled),
      maxEntries:
        typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries)
          ? Math.max(1, Math.floor(cache.maxEntries))
          : undefined,
    },
  };
}

export function resolveMemorySearchConfig(
  cfg: MoltbotConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const resolved = mergeConfig(defaults, overrides, agentId);
  if (!resolved.enabled) return null;
  return resolved;
}
