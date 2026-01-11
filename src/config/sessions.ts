import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Skill } from "@mariozechner/pi-coding-agent";
import JSON5 from "json5";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ProviderId } from "../providers/plugins/types.js";
import { PROVIDER_IDS } from "../providers/registry.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { normalizeE164 } from "../utils.js";
import {
  getFileMtimeMs,
  isCacheEnabled,
  resolveCacheTtlMs,
} from "./cache-utils.js";
import { loadConfig } from "./config.js";
import { resolveStateDir } from "./paths.js";

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.CLAWDBOT_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

function isSessionStoreCacheValid(entry: SessionStoreCacheEntry): boolean {
  const now = Date.now();
  const ttl = getSessionStoreTtl();
  return now - entry.loadedAt <= ttl;
}

function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function clearSessionStoreCacheForTest(): void {
  SESSION_STORE_CACHE.clear();
}

export type SessionScope = "per-sender" | "global";

export type SessionProviderId = ProviderId | "webchat";

const GROUP_SURFACES = new Set<string>([...PROVIDER_IDS, "webchat"]);

export type SessionChatType = "direct" | "group" | "room";

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  responseUsage?: "on" | "off";
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  compactionCount?: number;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  provider?: string;
  subject?: string;
  room?: string;
  space?: string;
  lastProvider?: SessionProviderId;
  lastTo?: string;
  lastAccountId?: string;
  skillsSnapshot?: SessionSkillSnapshot;
};

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  const sessionId =
    patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = Math.max(
    existing?.updatedAt ?? 0,
    patch.updatedAt ?? 0,
    Date.now(),
  );
  if (!existing) return { ...patch, sessionId, updatedAt };
  return { ...existing, ...patch, sessionId, updatedAt };
}
export type GroupKeyResolution = {
  key: string;
  legacyKey?: string;
  provider?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: Skill[];
};

function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveAgentSessionsDir(agentId, env, homedir);
}

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;

export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: number,
): string {
  const fileName =
    topicId !== undefined
      ? `${sessionId}-topic-${topicId}.jsonl`
      : `${sessionId}.jsonl`;
  return path.join(resolveAgentSessionsDir(agentId), fileName);
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: SessionEntry,
  opts?: { agentId?: string },
): string {
  const candidate = entry?.sessionFile?.trim();
  return candidate
    ? candidate
    : resolveSessionTranscriptPath(sessionId, opts?.agentId);
}

export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!store) return resolveDefaultSessionStorePath(agentId);
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      return path.resolve(expanded.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(expanded);
  }
  if (store.startsWith("~"))
    return path.resolve(store.replace(/^~(?=$|[\\/])/, os.homedir()));
  return path.resolve(store);
}

export function resolveMainSessionKey(cfg?: {
  session?: { scope?: SessionScope; mainKey?: string };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  if (cfg?.session?.scope === "global") return "global";
  const agents = cfg?.agents?.list ?? [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ??
    agents[0]?.id ??
    DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(defaultAgentId);
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  return buildAgentMainSessionKey({ agentId, mainKey });
}

export function resolveMainSessionKeyFromConfig(): string {
  return resolveMainSessionKey(loadConfig());
}

export { resolveAgentIdFromSessionKey };

export function resolveAgentMainSessionKey(params: {
  cfg?: { session?: { mainKey?: string } };
  agentId: string;
}): string {
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

function normalizeGroupLabel(raw?: string) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function shortenGroupId(value?: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  room?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = (params.provider?.trim().toLowerCase() || "group").trim();
  const room = params.room?.trim();
  const space = params.space?.trim();
  const subject = params.subject?.trim();
  const detail =
    (room && space
      ? `${space}${room.startsWith("#") ? "" : "#"}${room}`
      : room || subject || space || "") || "";
  const fallbackId = params.id?.trim() || params.key.replace(/^group:/, "");
  const rawLabel = detail || fallbackId;
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  if (!params.room && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (
    token &&
    !/^[@#]/.test(token) &&
    !token.startsWith("g-") &&
    !token.includes("#")
  ) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

export function resolveGroupSessionKey(
  ctx: MsgContext,
): GroupKeyResolution | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  if (!from) return null;
  const chatType = ctx.ChatType?.trim().toLowerCase();
  const isGroup =
    chatType === "group" ||
    from.startsWith("group:") ||
    from.includes("@g.us") ||
    from.includes(":group:") ||
    from.includes(":channel:");
  if (!isGroup) return null;

  const providerHint = ctx.Provider?.trim().toLowerCase();
  const hasLegacyGroupPrefix = from.startsWith("group:");
  const raw = (
    hasLegacyGroupPrefix ? from.slice("group:".length) : from
  ).trim();

  let provider: string | undefined;
  let kind: "group" | "channel" | undefined;
  let id = "";

  const parseKind = (value: string) => {
    if (value === "channel") return "channel";
    return "group";
  };

  const parseParts = (parts: string[]) => {
    if (parts.length >= 2 && GROUP_SURFACES.has(parts[0])) {
      provider = parts[0];
      if (parts.length >= 3) {
        const kindCandidate = parts[1];
        if (["group", "channel"].includes(kindCandidate)) {
          kind = parseKind(kindCandidate);
          id = parts.slice(2).join(":");
        } else {
          id = parts.slice(1).join(":");
        }
      } else {
        id = parts[1];
      }
      return;
    }
    if (parts.length >= 2 && ["group", "channel"].includes(parts[0])) {
      kind = parseKind(parts[0]);
      id = parts.slice(1).join(":");
    }
  };

  if (hasLegacyGroupPrefix) {
    const legacyParts = raw.split(":").filter(Boolean);
    if (legacyParts.length > 1) {
      parseParts(legacyParts);
    } else {
      id = raw;
    }
  } else if (from.includes("@g.us") && !from.includes(":")) {
    id = from;
  } else {
    parseParts(from.split(":").filter(Boolean));
    if (!id) {
      id = raw || from;
    }
  }

  const resolvedProvider = provider ?? providerHint;
  if (!resolvedProvider) {
    const legacy = hasLegacyGroupPrefix ? `group:${raw}` : `group:${from}`;
    return {
      key: legacy,
      id: raw || from,
      legacyKey: legacy,
      chatType: "group",
    };
  }

  const resolvedKind = kind === "channel" ? "channel" : "group";
  const key = `${resolvedProvider}:${resolvedKind}:${id || raw || from}`;
  let legacyKey: string | undefined;
  if (hasLegacyGroupPrefix || from.includes("@g.us")) {
    legacyKey = `group:${id || raw || from}`;
  }

  return {
    key,
    legacyKey,
    provider: resolvedProvider,
    id: id || raw || from,
    chatType: resolvedKind === "channel" ? "room" : "group",
  };
}

export function loadSessionStore(
  storePath: string,
): Record<string, SessionEntry> {
  // Check cache first if enabled
  if (isSessionStoreCacheEnabled()) {
    const cached = SESSION_STORE_CACHE.get(storePath);
    if (cached && isSessionStoreCacheValid(cached)) {
      const currentMtimeMs = getFileMtimeMs(storePath);
      if (currentMtimeMs === cached.mtimeMs) {
        // Return a shallow copy to prevent external mutations affecting cache
        return { ...cached.store };
      }
      invalidateSessionStoreCache(storePath);
    }
  }

  // Cache miss or disabled - load from disk
  let store: Record<string, SessionEntry> = {};
  let mtimeMs = getFileMtimeMs(storePath);
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      store = parsed as Record<string, SessionEntry>;
    }
    mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }

  // Cache the result if caching is enabled
  if (isSessionStoreCacheEnabled()) {
    SESSION_STORE_CACHE.set(storePath, {
      store: { ...store }, // Store a copy to prevent external mutations
      loadedAt: Date.now(),
      storePath,
      mtimeMs,
    });
  }

  return store;
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  // Invalidate cache on write to ensure consistency
  invalidateSessionStoreCache(storePath);

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  // Windows: avoid atomic rename swaps (can be flaky under concurrent access).
  // We serialize writers via the session-store lock instead.
  if (process.platform === "win32") {
    try {
      await fs.promises.writeFile(storePath, json, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") return;
      throw err;
    }
    return;
  }

  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, "utf-8");
    await fs.promises.rename(tmp, storePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, "utf-8");
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") return;
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store);
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 25;
  const staleMs = opts.staleMs ?? 30_000;
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // best-effort
      }
      await handle.close();
      break;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        // Store directory may be deleted/recreated in tests while writes are in-flight.
        // Best-effort: recreate the parent dir and retry until timeout.
        await fs.promises
          .mkdir(path.dirname(storePath), { recursive: true })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      if (code !== "EEXIST") throw err;

      const now = Date.now();
      if (now - startedAt > timeoutMs) {
        throw new Error(`timeout acquiring session store lock: ${lockPath}`);
      }

      // Best-effort stale lock eviction (e.g. crashed process).
      try {
        const st = await fs.promises.stat(lockPath);
        const ageMs = now - st.mtimeMs;
        if (ageMs > staleMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    if (!existing) return null;
    const patch = await update(existing);
    if (!patch) return existing;
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store);
    return next;
  });
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  provider: SessionEntry["lastProvider"];
  to?: string;
  accountId?: string;
}) {
  const { storePath, sessionKey, provider, to, accountId } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    const now = Date.now();
    const next = mergeSessionEntry(existing, {
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      lastProvider: provider,
      lastTo: to?.trim() ? to.trim() : undefined,
      lastAccountId: accountId?.trim()
        ? accountId.trim()
        : existing?.lastAccountId,
    });
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store);
    return next;
  });
}

// Decide which session bucket to use (per-sender vs global).
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") return "global";
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) return resolvedGroup.key;
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) return explicit;
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") return raw;
  const canonicalMainKey = normalizeMainKey(mainKey);
  const canonical = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey: canonicalMainKey,
  });
  const isGroup =
    raw.startsWith("group:") ||
    raw.includes(":group:") ||
    raw.includes(":channel:");
  if (!isGroup) return canonical;
  return `agent:${DEFAULT_AGENT_ID}:${raw}`;
}
