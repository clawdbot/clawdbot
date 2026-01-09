import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildGroupDisplayName,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import {
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";

export type GatewaySessionsDefaults = {
  model: string | null;
  contextTokens: number | null;
};

export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  provider?: string;
  subject?: string;
  room?: string;
  space?: string;
  chatType?: "direct" | "group" | "room";
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseUsage?: "on" | "off";
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  lastProvider?: SessionEntry["lastProvider"];
  lastTo?: string;
  lastAccountId?: string;
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
};

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(
    sessionId,
    storePath,
    sessionFile,
  );

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messages.push(parsed.message);
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  if (sessionFile) candidates.push(sessionFile);
  if (storePath) {
    const dir = path.dirname(storePath);
    candidates.push(path.join(dir, `${sessionId}.jsonl`));
  }
  if (agentId) {
    candidates.push(resolveSessionTranscriptPath(sessionId, agentId));
  }
  candidates.push(
    path.join(os.homedir(), ".clawdbot", "sessions", `${sessionId}.jsonl`),
  );
  return candidates;
}

export function archiveFileOnDisk(filePath: string, reason: string): string {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
  return archived;
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) return { items, bytes: 2 };
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

export function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.session;
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const parsed = parseAgentSessionKey(sessionKey);
  const legacyKey = parsed?.rest;
  const entry = store[sessionKey] ?? (legacyKey ? store[legacyKey] : undefined);
  return { cfg, storePath, store, entry };
}

export function classifySessionKey(
  key: string,
  entry?: SessionEntry,
): GatewaySessionRow["kind"] {
  if (key === "global") return "global";
  if (key === "unknown") return "unknown";
  if (entry?.chatType === "group" || entry?.chatType === "room") return "group";
  if (
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:")
  ) {
    return "group";
  }
  return "direct";
}

export function parseGroupKey(
  key: string,
): { provider?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  if (rawKey.startsWith("group:")) {
    const raw = rawKey.slice("group:".length);
    return raw ? { id: raw } : null;
  }
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [provider, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { provider, kind, id };
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
  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);
  const agents = cfg.agents?.list ?? [];
  for (const entry of agents) {
    if (entry?.id) ids.add(normalizeAgentId(entry.id));
  }
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
  const mainKey =
    (cfg.session?.mainKey ?? DEFAULT_MAIN_KEY).trim() || DEFAULT_MAIN_KEY;
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<string, { name?: string }>();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) continue;
    configuredById.set(normalizeAgentId(entry.id), {
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : undefined,
    });
  }
  const agents = listConfiguredAgentIds(cfg).map((id) => {
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

function canonicalizeSpawnedByForAgent(
  agentId: string,
  spawnedBy?: string,
): string | undefined {
  const raw = spawnedBy?.trim();
  if (!raw) return undefined;
  if (raw === "global" || raw === "unknown") return raw;
  if (raw.startsWith("agent:")) return raw;
  return `agent:${normalizeAgentId(agentId)}:${raw}`;
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: ClawdbotConfig;
  key: string;
}): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = params.key.trim();
  const agentId = resolveAgentIdFromSessionKey(key);
  const storeConfig = params.cfg.session?.store;
  const storePath = resolveStorePath(storeConfig, { agentId });

  if (key === "global" || key === "unknown") {
    return { agentId, storePath, canonicalKey: key, storeKeys: [key] };
  }

  const parsed = parseAgentSessionKey(key);
  if (parsed) {
    return {
      agentId,
      storePath,
      canonicalKey: key,
      storeKeys: [key, parsed.rest],
    };
  }

  if (key.startsWith("subagent:")) {
    const canonical = canonicalizeSessionKeyForAgent(agentId, key);
    return {
      agentId,
      storePath,
      canonicalKey: canonical,
      storeKeys: [canonical, key],
    };
  }

  const canonical = canonicalizeSessionKeyForAgent(agentId, key);
  return {
    agentId,
    storePath,
    canonicalKey: canonical,
    storeKeys: [canonical, key],
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
        spawnedBy: canonicalizeSpawnedByForAgent(
          defaultAgentId,
          entry.spawnedBy,
        ),
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
      combined[canonicalKey] = {
        ...entry,
        spawnedBy: canonicalizeSpawnedByForAgent(agentId, entry.spawnedBy),
      };
    }
  }

  const storePath =
    typeof storeConfig === "string" && storeConfig.trim()
      ? storeConfig.trim()
      : "(multiple)";
  return { storePath, store: combined };
}

export function getSessionDefaults(
  cfg: ClawdbotConfig,
): GatewaySessionsDefaults {
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
  const agentId =
    typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const activeMinutes =
    typeof opts.activeMinutes === "number" &&
    Number.isFinite(opts.activeMinutes)
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
      const provider = entry?.provider ?? parsed?.provider;
      const subject = entry?.subject;
      const room = entry?.room;
      const space = entry?.space;
      const id = parsed?.id;
      const displayName =
        entry?.displayName ??
        (provider
          ? buildGroupDisplayName({
              provider,
              subject,
              room,
              space,
              id,
              key,
            })
          : undefined);
      return {
        key,
        kind: classifySessionKey(key, entry),
        label: entry?.label,
        displayName,
        provider,
        subject,
        room,
        space,
        chatType: entry?.chatType,
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
        lastProvider: entry?.lastProvider,
        lastTo: entry?.lastTo,
        lastAccountId: entry?.lastAccountId,
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
