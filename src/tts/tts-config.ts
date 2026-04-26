import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsConfig, TtsMode } from "../config/types.tts.js";
import { normalizeAccountId, normalizeAgentId } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";
export { normalizeTtsAutoMode } from "./tts-auto-mode.js";

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type TtsConfigResolutionContext = {
  agentId?: string;
  channelId?: string;
  accountId?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }
    const existing = result[key];
    result[key] = key in result ? deepMergeDefined(existing, value) : value;
  }
  return result;
}

function resolveAgentTtsOverride(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): TtsConfig | undefined {
  if (!agentId || !Array.isArray(cfg.agents?.list)) {
    return undefined;
  }
  const normalized = normalizeAgentId(agentId);
  const agent = cfg.agents.list.find((entry) => normalizeAgentId(entry.id) === normalized);
  return agent?.tts;
}

function resolveTtsConfigContext(
  contextOrAgentId?: string | TtsConfigResolutionContext,
): TtsConfigResolutionContext {
  return typeof contextOrAgentId === "string"
    ? { agentId: contextOrAgentId }
    : (contextOrAgentId ?? {});
}

function resolveRecordEntry<T>(
  entries: Record<string, T> | undefined,
  id: string | undefined,
  normalize: (value: string) => string,
): T | undefined {
  const normalizedId = normalizeOptionalString(id);
  if (!entries || !normalizedId) {
    return undefined;
  }
  if (Object.hasOwn(entries, normalizedId)) {
    return entries[normalizedId];
  }
  const normalized = normalize(normalizedId);
  const key = Object.keys(entries).find((candidate) => normalize(candidate) === normalized);
  return key ? entries[key] : undefined;
}

function asTtsConfig(value: unknown): TtsConfig | undefined {
  return isPlainObject(value) ? (value as TtsConfig) : undefined;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function resolveChannelConfig(
  cfg: OpenClawConfig,
  channelId: string | undefined,
): Record<string, unknown> | undefined {
  if (!isPlainObject(cfg.channels)) {
    return undefined;
  }
  const normalizedChannelId = normalizeOptionalString(channelId);
  if (!normalizedChannelId) {
    return undefined;
  }
  return asObjectRecord(
    resolveRecordEntry(
      cfg.channels as Record<string, unknown>,
      normalizedChannelId,
      normalizeLowercaseStringOrEmpty,
    ),
  );
}

function resolveChannelTtsOverride(
  cfg: OpenClawConfig,
  context: TtsConfigResolutionContext,
): TtsConfig | undefined {
  return asTtsConfig(resolveChannelConfig(cfg, context.channelId)?.tts);
}

function resolveAccountTtsOverride(
  cfg: OpenClawConfig,
  context: TtsConfigResolutionContext,
): TtsConfig | undefined {
  const channelConfig = resolveChannelConfig(cfg, context.channelId);
  const accounts = isPlainObject(channelConfig?.accounts) ? channelConfig.accounts : undefined;
  const accountConfig = resolveRecordEntry(accounts, context.accountId, normalizeAccountId);
  return asTtsConfig(asObjectRecord(accountConfig)?.tts);
}

export function resolveEffectiveTtsConfig(
  cfg: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): TtsConfig {
  const context = resolveTtsConfigContext(contextOrAgentId);
  const base = cfg.messages?.tts ?? {};
  const agentOverride = resolveAgentTtsOverride(cfg, context.agentId);
  const channelOverride = resolveChannelTtsOverride(cfg, context);
  const accountOverride = resolveAccountTtsOverride(cfg, context);
  let merged: unknown = base;
  for (const override of [agentOverride, channelOverride, accountOverride]) {
    merged = deepMergeDefined(merged, override ?? {});
  }
  return merged as TtsConfig;
}

export function resolveConfiguredTtsMode(
  cfg: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): TtsMode {
  return resolveEffectiveTtsConfig(cfg, contextOrAgentId).mode ?? "final";
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

function readTtsPrefsAutoMode(prefsPath: string): TtsAutoMode | undefined {
  try {
    if (!existsSync(prefsPath)) {
      return undefined;
    }
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as {
      tts?: { auto?: unknown; enabled?: unknown };
    };
    const auto = normalizeTtsAutoMode(prefs.tts?.auto);
    if (auto) {
      return auto;
    }
    if (typeof prefs.tts?.enabled === "boolean") {
      return prefs.tts.enabled ? "always" : "off";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function shouldAttemptTtsPayload(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): boolean {
  const sessionAuto = normalizeTtsAutoMode(params.ttsAuto);
  if (sessionAuto) {
    return sessionAuto !== "off";
  }

  const raw = resolveEffectiveTtsConfig(params.cfg, params);
  const prefsAuto = readTtsPrefsAutoMode(resolveTtsPrefsPathValue(raw?.prefsPath));
  if (prefsAuto) {
    return prefsAuto !== "off";
  }

  const configuredAuto = normalizeTtsAutoMode(raw?.auto);
  if (configuredAuto) {
    return configuredAuto !== "off";
  }
  return raw?.enabled === true;
}

export function shouldCleanTtsDirectiveText(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): boolean {
  if (!shouldAttemptTtsPayload(params)) {
    return false;
  }
  return resolveEffectiveTtsConfig(params.cfg, params).modelOverrides?.enabled !== false;
}
