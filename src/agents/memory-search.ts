import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig, MemorySearchConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  provider: "openai" | "local";
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
  fallback: "openai" | "none";
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

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
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
  const provider = overrides?.provider ?? defaults?.provider ?? "openai";
  const hasRemote = Boolean(defaults?.remote || overrides?.remote);
  const includeRemote = hasRemote || provider === "openai";
  const batch = {
    enabled: overrides?.remote?.batch?.enabled ?? defaults?.remote?.batch?.enabled ?? true,
    wait: overrides?.remote?.batch?.wait ?? defaults?.remote?.batch?.wait ?? true,
    concurrency: Math.max(
      1,
      overrides?.remote?.batch?.concurrency ?? defaults?.remote?.batch?.concurrency ?? 2,
    ),
    pollIntervalMs:
      overrides?.remote?.batch?.pollIntervalMs ?? defaults?.remote?.batch?.pollIntervalMs ?? 2000,
    timeoutMinutes:
      overrides?.remote?.batch?.timeoutMinutes ?? defaults?.remote?.batch?.timeoutMinutes ?? 60,
  };
  const remote = includeRemote
    ? {
        baseUrl: overrides?.remote?.baseUrl ?? defaults?.remote?.baseUrl,
        apiKey: overrides?.remote?.apiKey ?? defaults?.remote?.apiKey,
        headers: overrides?.remote?.headers ?? defaults?.remote?.headers,
        batch,
      }
    : undefined;
  const fallback = overrides?.fallback ?? defaults?.fallback ?? "openai";
  const model = overrides?.model ?? defaults?.model ?? DEFAULT_MODEL;
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

  const overlap = Math.max(0, Math.min(chunking.overlap, chunking.tokens - 1));
  const minScore = Math.max(0, Math.min(1, query.minScore));
  const vectorWeight = Math.max(0, Math.min(1, hybrid.vectorWeight));
  const textWeight = Math.max(0, Math.min(1, hybrid.textWeight));
  const sum = vectorWeight + textWeight;
  const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
  const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
  const candidateMultiplier = Math.max(1, Math.min(20, Math.floor(hybrid.candidateMultiplier)));
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
    sync,
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
  cfg: ClawdbotConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const resolved = mergeConfig(defaults, overrides, agentId);
  if (!resolved.enabled) return null;
  return resolved;
}
