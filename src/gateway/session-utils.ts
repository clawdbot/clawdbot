import fs from "node:fs";
import path from "node:path";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildGroupDisplayName,
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.js";
import type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
} from "./session-utils.types.js";

export {
  archiveFileOnDisk,
  capArrayByJsonBytes,
  readSessionMessages,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";
export type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
  SessionsPatchResult,
} from "./session-utils.types.js";

export function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.session;
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, storePath, store, entry, canonicalKey };
}

export function classifySessionKey(key: string, entry?: SessionEntry): GatewaySessionRow["kind"] {
  if (key === "global") return "global";
  if (key === "unknown") return "unknown";
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

export function parseGroupKey(
  key: string,
): { channel?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [channel, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { channel, kind, id };
    }
  }
  return null;
}

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function listExistingAgentIdsFromDisk(): string[] {
  const root = resolveStateDir();
  const agentsDir = path.join(root, "agents");
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: ClawdbotConfig): string[] {
  const agents = cfg.agents?.list ?? [];
  if (agents.length > 0) {
    const ids = new Set<string>();
    for (const entry of agents) {
      if (entry?.id) ids.add(normalizeAgentId(entry.id));
    }
    const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
    ids.add(defaultId);
    const sorted = Array.from(ids).filter(Boolean);
    sorted.sort((a, b) => a.localeCompare(b));
    return sorted.includes(defaultId)
      ? [defaultId, ...sorted.filter((id) => id !== defaultId)]
      : sorted;
  }

  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);
  for (const id of listExistingAgentIdsFromDisk()) ids.add(id);
  const sorted = Array.from(ids).filter(Boolean);
  sorted.sort((a, b) => a.localeCompare(b));
  if (sorted.includes(defaultId)) {
    return [defaultId, ...sorted.filter((id) => id !== defaultId)];
  }
  return sorted;
}

export function listAgentsForGateway(cfg: ClawdbotConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<string, { name?: string }>();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) continue;
    configuredById.set(normalizeAgentId(entry.id), {
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined,
    });
  }
  const explicitIds = new Set(
    (cfg.agents?.list ?? [])
      .map((entry) => (entry?.id ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  let agentIds = listConfiguredAgentIds(cfg).filter((id) =>
    allowedIds ? allowedIds.has(id) : true,
  );
  if (mainKey && !agentIds.includes(mainKey)) {
    agentIds = [...agentIds, mainKey];
  }
  const agents = agentIds.map((id) => {
    const meta = configuredById.get(id);
    return {
      id,
      name: meta?.name,
    };
  });
  return { defaultId, mainKey, scope, agents };
}

function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  if (key === "global" || key === "unknown") return key;
  if (key.startsWith("agent:")) return key;
  return `agent:${normalizeAgentId(agentId)}:${key}`;
}

function resolveDefaultStoreAgentId(cfg: ClawdbotConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

export function resolveSessionStoreKey(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) return raw;
  if (raw === "global" || raw === "unknown") return raw;

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const agentId = normalizeAgentId(parsed.agentId);
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId,
      sessionKey: raw,
    });
    if (canonical !== raw) return canonical;
    return raw;
  }

  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (raw === "main" || raw === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

function resolveSessionStoreAgentId(cfg: ClawdbotConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
  return resolveDefaultStoreAgentId(cfg);
}

function canonicalizeSpawnedByForAgent(agentId: string, spawnedBy?: string): string | undefined {
  const raw = spawnedBy?.trim();
  if (!raw) return undefined;
  if (raw === "global" || raw === "unknown") return raw;
  if (raw.startsWith("agent:")) return raw;
  return `agent:${normalizeAgentId(agentId)}:${raw}`;
}

export function resolveGatewaySessionStoreTarget(params: { cfg: ClawdbotConfig; key: string }): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = params.key.trim();
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const storeConfig = params.cfg.session?.store;
  const storePath = resolveStorePath(storeConfig, { agentId });

  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys };
  }

  const storeKeys = new Set<string>();
  storeKeys.add(canonicalKey);
  if (key && key !== canonicalKey) storeKeys.add(key);
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

export function loadCombinedSessionStoreForGateway(cfg: ClawdbotConfig): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadSessionStore(storePath);
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(defaultAgentId, key);
      combined[canonicalKey] = {
        ...entry,
        spawnedBy: canonicalizeSpawnedByForAgent(defaultAgentId, entry.spawnedBy),
      };
    }
    return { storePath, store: combined };
  }

  const agentIds = listConfiguredAgentIds(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const agentId of agentIds) {
    const storePath = resolveStorePath(storeConfig, { agentId });
    const store = loadSessionStore(storePath);
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(agentId, key);
      // Merge with existing entry if present (avoid overwriting with less complete data)
      const existing = combined[canonicalKey];
      combined[canonicalKey] = {
        ...existing,
        ...entry,
        spawnedBy: canonicalizeSpawnedByForAgent(agentId, entry.spawnedBy ?? existing?.spawnedBy),
      };
    }
  }

  const storePath =
    typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
  return { storePath, store: combined };
}

export function getSessionDefaults(cfg: ClawdbotConfig): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model) ??
    DEFAULT_CONTEXT_TOKENS;
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
  };
}

export function resolveSessionModelRef(
  cfg: ClawdbotConfig,
  entry?: SessionEntry,
): { provider: string; model: string } {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolved.provider;
  let model = resolved.model;
  const storedModelOverride = entry?.modelOverride?.trim();
  if (storedModelOverride) {
    provider = entry?.providerOverride?.trim() || provider;
    model = storedModelOverride;
  }
  return { provider, model };
}

export function listSessionsFromStore(params: {
  cfg: ClawdbotConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = typeof opts.label === "string" ? opts.label.trim() : "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let sessions = Object.entries(store)
    .filter(([key]) => {
      if (!includeGlobal && key === "global") return false;
      if (!includeUnknown && key === "unknown") return false;
      if (agentId) {
        if (key === "global" || key === "unknown") return false;
        const parsed = parseAgentSessionKey(key);
        if (!parsed) return false;
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      return true;
    })
    .filter(([key, entry]) => {
      if (!spawnedBy) return true;
      if (key === "unknown" || key === "global") return false;
      return entry?.spawnedBy === spawnedBy;
    })
    .filter(([, entry]) => {
      if (!label) return true;
      return entry?.label === label;
    })
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      const input = entry?.inputTokens ?? 0;
      const output = entry?.outputTokens ?? 0;
      const total = entry?.totalTokens ?? input + output;
      const parsed = parseGroupKey(key);
      const channel = entry?.channel ?? parsed?.channel;
      const subject = entry?.subject;
      const groupChannel = entry?.groupChannel;
      const space = entry?.space;
      const id = parsed?.id;
      const origin = entry?.origin;
      const originLabel = origin?.label;
      const displayName =
        entry?.displayName ??
        (channel
          ? buildGroupDisplayName({
              provider: channel,
              subject,
              groupChannel,
              space,
              id,
              key,
            })
          : undefined) ??
        entry?.label ??
        originLabel;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      return {
        key,
        kind: classifySessionKey(key, entry),
        label: entry?.label,
        displayName,
        channel,
        subject,
        groupChannel,
        space,
        chatType: entry?.chatType,
        origin,
        updatedAt,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        elevatedLevel: entry?.elevatedLevel,
        sendPolicy: entry?.sendPolicy,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: total,
        responseUsage: entry?.responseUsage,
        modelProvider: entry?.modelProvider,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
        deliveryContext: deliveryFields.deliveryContext,
        lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
        lastTo: deliveryFields.lastTo ?? entry?.lastTo,
        lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
      } satisfies GatewaySessionRow;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
  }

  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    const limit = Math.max(1, Math.floor(opts.limit));
    sessions = sessions.slice(0, limit);
  }

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    defaults: getSessionDefaults(cfg),
    sessions,
  };
}
