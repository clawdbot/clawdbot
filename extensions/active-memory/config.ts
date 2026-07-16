import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import {
  asOptionalRecord as asRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW,
  DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS,
  DEFAULT_MAX_SUMMARY_CHARS,
  DEFAULT_MIN_TIMEOUT_MS,
  DEFAULT_QMD_SEARCH_MODE,
  DEFAULT_QUERY_MODE,
  DEFAULT_RECENT_ASSISTANT_CHARS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_SETUP_GRACE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_DIR,
  LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  MAX_ACTIVE_MEMORY_TOOLS_ALLOW,
  MAX_SETUP_GRACE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type ActiveMemoryChatType,
  type ActiveMemoryFastMode,
  type ActiveMemoryPromptStyle,
  type ActiveMemoryQmdSearchMode,
  type ActiveMemoryThinkingLevel,
  type ActiveRecallPluginConfig,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

let minimumTimeoutMs = DEFAULT_MIN_TIMEOUT_MS;
let setupGraceTimeoutMs = DEFAULT_SETUP_GRACE_TIMEOUT_MS;

function parseOptionalPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseStrictPositiveInteger(value)
        : Number.NaN;
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeTranscriptDir(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return DEFAULT_TRANSCRIPT_DIR;
  }
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/").map((part) => part.trim());
  const safeParts = parts.filter((part) => part.length > 0 && part !== "." && part !== "..");
  return safeParts.length > 0 ? path.join(...safeParts) : DEFAULT_TRANSCRIPT_DIR;
}

function normalizeChatIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeConfiguredToolsAllow(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = normalizeLowercaseStringOrEmpty(entry);
    if (!normalized || isReservedActiveMemoryToolsAllowEntry(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_ACTIVE_MEMORY_TOOLS_ALLOW) {
      break;
    }
  }
  return out.length > 0 ? out : undefined;
}

function isReservedActiveMemoryToolsAllowEntry(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("group:") || ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW.has(normalized);
}

function resolveDefaultToolsAllow(cfg: OpenClawConfig | undefined): string[] {
  return cfg?.plugins?.slots?.memory === "memory-lancedb"
    ? [...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW]
    : [...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW];
}

function resolveToolsAllow(params: { pluginToolsAllow: unknown; cfg?: OpenClawConfig }): string[] {
  return (
    normalizeConfiguredToolsAllow(params.pluginToolsAllow) ?? resolveDefaultToolsAllow(params.cfg)
  );
}

function normalizePromptConfigText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : undefined;
}

function resolveQmdSearchMode(value: unknown): ActiveMemoryQmdSearchMode {
  if (value === "inherit" || value === "search" || value === "vsearch" || value === "query") {
    return value;
  }
  return DEFAULT_QMD_SEARCH_MODE;
}

function hasDeprecatedModelFallbackPolicy(pluginConfig: unknown): boolean {
  const raw = asRecord(pluginConfig);
  return raw ? Object.hasOwn(raw, "modelFallbackPolicy") : false;
}

function resolveSafeTranscriptDir(baseSessionsDir: string, transcriptDir: string): string {
  const normalized = transcriptDir.trim();
  if (!normalized || normalized.includes(":") || path.isAbsolute(normalized)) {
    return path.resolve(baseSessionsDir, DEFAULT_TRANSCRIPT_DIR);
  }
  const resolvedBase = path.resolve(baseSessionsDir);
  const candidate = path.resolve(resolvedBase, normalized);
  if (!isPathInside(resolvedBase, candidate)) {
    return path.resolve(resolvedBase, DEFAULT_TRANSCRIPT_DIR);
  }
  return candidate;
}

function toSafeTranscriptAgentDirName(agentId: string): string {
  const encoded = encodeURIComponent(agentId.trim());
  return encoded ? encoded : "unknown-agent";
}

function resolvePersistentTranscriptBaseDir(api: OpenClawPluginApi, agentId: string): string {
  return path.join(
    api.runtime.state.resolveStateDir(),
    "plugins",
    "active-memory",
    "transcripts",
    "agents",
    toSafeTranscriptAgentDirName(agentId),
  );
}

function requireTransientWorkspaceDir(tempDir: string | undefined): string {
  if (!tempDir) {
    throw new Error("Active memory transient workspace was not initialized.");
  }
  return tempDir;
}

function formatRuntimeToolsAllowSource(toolsAllow: readonly string[]): string {
  return `runtime toolsAllow: ${toolsAllow.join(", ")}`;
}

function isMissingRegisteredMemoryToolsError(
  error: unknown,
  toolsAllow: readonly string[] = DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim();
  const prefix = "No callable tools remain after resolving explicit tool allowlist (";
  const suffix =
    "); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.";
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) {
    return false;
  }
  const sources = message.slice(prefix.length, -suffix.length);
  const runtimeSource = formatRuntimeToolsAllowSource(toolsAllow);
  const sourceParts = sources
    .split(";")
    .map((source) => source.trim())
    .filter(Boolean);
  return sourceParts.includes(runtimeSource);
}

function normalizePluginConfig(
  pluginConfig: unknown,
  cfg?: OpenClawConfig,
): ResolvedActiveRecallPluginConfig {
  const raw = (
    pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}
  ) as ActiveRecallPluginConfig;
  const qmd = asRecord(raw.qmd);
  const allowedChatTypes = Array.isArray(raw.allowedChatTypes)
    ? raw.allowedChatTypes.filter(
        (value): value is ActiveMemoryChatType =>
          value === "direct" || value === "group" || value === "channel" || value === "explicit",
      )
    : [];
  return {
    enabled: raw.enabled !== false,
    agents: Array.isArray(raw.agents) ? normalizeStringEntries(raw.agents) : [],
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
    modelFallback:
      typeof raw.modelFallback === "string" && raw.modelFallback.trim()
        ? raw.modelFallback.trim()
        : undefined,
    modelFallbackPolicy:
      raw.modelFallbackPolicy === "resolved-only" ? "resolved-only" : "default-remote",
    allowedChatTypes: allowedChatTypes.length > 0 ? allowedChatTypes : ["direct"],
    allowedChatIds: normalizeChatIdList(raw.allowedChatIds),
    deniedChatIds: normalizeChatIdList(raw.deniedChatIds),
    thinking: resolveThinkingLevel(raw.thinking),
    fastMode: normalizeActiveMemoryFastMode(raw.fastMode),
    promptStyle: resolvePromptStyle(raw.promptStyle, raw.queryMode),
    toolsAllow: resolveToolsAllow({ pluginToolsAllow: raw.toolsAllow, cfg }),
    promptOverride: normalizePromptConfigText(raw.promptOverride),
    promptAppend: normalizePromptConfigText(raw.promptAppend),
    timeoutMs: clampInt(
      parseOptionalPositiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
      DEFAULT_TIMEOUT_MS,
      minimumTimeoutMs,
      MAX_TIMEOUT_MS,
    ),
    setupGraceTimeoutMs: clampInt(
      raw.setupGraceTimeoutMs,
      setupGraceTimeoutMs,
      0,
      MAX_SETUP_GRACE_TIMEOUT_MS,
    ),
    queryMode:
      raw.queryMode === "message" || raw.queryMode === "recent" || raw.queryMode === "full"
        ? raw.queryMode
        : DEFAULT_QUERY_MODE,
    maxSummaryChars: clampInt(raw.maxSummaryChars, DEFAULT_MAX_SUMMARY_CHARS, 40, 1000),
    recentUserTurns: clampInt(raw.recentUserTurns, DEFAULT_RECENT_USER_TURNS, 0, 4),
    recentAssistantTurns: clampInt(raw.recentAssistantTurns, DEFAULT_RECENT_ASSISTANT_TURNS, 0, 3),
    recentUserChars: clampInt(raw.recentUserChars, DEFAULT_RECENT_USER_CHARS, 40, 1000),
    recentAssistantChars: clampInt(
      raw.recentAssistantChars,
      DEFAULT_RECENT_ASSISTANT_CHARS,
      40,
      1000,
    ),
    logging: raw.logging === true,
    cacheTtlMs: clampInt(raw.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1000, 120_000),
    circuitBreakerMaxTimeouts: clampInt(
      raw.circuitBreakerMaxTimeouts,
      DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS,
      1,
      20,
    ),
    circuitBreakerCooldownMs: clampInt(
      raw.circuitBreakerCooldownMs,
      DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
      5000,
      600_000,
    ),
    persistTranscripts: raw.persistTranscripts === true,
    transcriptDir: normalizeTranscriptDir(raw.transcriptDir),
    qmd: {
      searchMode: resolveQmdSearchMode(qmd?.searchMode),
    },
  };
}

function applyActiveMemoryRuntimeConfigSnapshot(
  cfg: OpenClawConfig,
  pluginConfig: ResolvedActiveRecallPluginConfig,
): OpenClawConfig {
  const existingEntry = asRecord(cfg.plugins?.entries?.["active-memory"]);
  const existingPluginConfig = asRecord(existingEntry?.config);
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        "active-memory": {
          ...existingEntry,
          config: {
            ...existingPluginConfig,
            qmd: {
              ...asRecord(existingPluginConfig?.qmd),
              searchMode: pluginConfig.qmd.searchMode,
            },
          },
        },
      },
    },
  };
}

function resolveActiveMemoryCleanupConfig(api: OpenClawPluginApi): OpenClawConfig | undefined {
  try {
    return (
      (api.runtime.config?.current?.() as OpenClawConfig | undefined) ??
      (api.config as OpenClawConfig | undefined)
    );
  } catch {
    return api.config as OpenClawConfig | undefined;
  }
}

function resolveThinkingLevel(thinking: unknown): ActiveMemoryThinkingLevel {
  if (
    thinking === "off" ||
    thinking === "minimal" ||
    thinking === "low" ||
    thinking === "medium" ||
    thinking === "high" ||
    thinking === "xhigh" ||
    thinking === "adaptive" ||
    thinking === "max"
  ) {
    return thinking;
  }
  return "off";
}

function normalizeActiveMemoryFastMode(fastMode: unknown): ActiveMemoryFastMode | undefined {
  return fastMode === true || fastMode === false || fastMode === "auto" ? fastMode : undefined;
}

function resolvePromptStyle(
  promptStyle: unknown,
  queryMode: ActiveRecallPluginConfig["queryMode"],
): ActiveMemoryPromptStyle {
  if (
    promptStyle === "balanced" ||
    promptStyle === "strict" ||
    promptStyle === "contextual" ||
    promptStyle === "recall-heavy" ||
    promptStyle === "precision-heavy" ||
    promptStyle === "preference-only"
  ) {
    return promptStyle;
  }
  if (queryMode === "message") {
    return "strict";
  }
  if (queryMode === "full") {
    return "contextual";
  }
  return "balanced";
}

function resetActiveMemoryConfigForTests(): void {
  minimumTimeoutMs = DEFAULT_MIN_TIMEOUT_MS;
  setupGraceTimeoutMs = DEFAULT_SETUP_GRACE_TIMEOUT_MS;
}

function setMinimumTimeoutMsForTests(value: number): void {
  minimumTimeoutMs = value;
}

function setSetupGraceTimeoutMsForTests(value: number): void {
  setupGraceTimeoutMs = Math.max(0, Math.floor(value));
}

export {
  applyActiveMemoryRuntimeConfigSnapshot,
  clampInt,
  hasDeprecatedModelFallbackPolicy,
  isMissingRegisteredMemoryToolsError,
  normalizeActiveMemoryFastMode,
  normalizePluginConfig,
  requireTransientWorkspaceDir,
  resetActiveMemoryConfigForTests,
  resolveActiveMemoryCleanupConfig,
  resolvePersistentTranscriptBaseDir,
  resolveSafeTranscriptDir,
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
};
