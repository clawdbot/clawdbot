import fs from "node:fs";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "openclaw/plugin-sdk/json-store";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  RECENT_UNBOUND_WEBHOOK_ECHO_WINDOW_MS,
  THREAD_BINDINGS_VERSION,
  type PersistedThreadBindingRecord,
  type PersistedThreadBindingsPayload,
  type ThreadBindingManager,
  type ThreadBindingRecord,
  type ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

type ThreadBindingsGlobalState = {
  managersByAccountId: Map<string, ThreadBindingManager>;
  bindingsByThreadId: Map<string, ThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
  tokensByAccountId: Map<string, string>;
  recentUnboundWebhookEchoesByBindingKey: Map<string, { webhookId: string; expiresAt: number }>;
  reusableWebhooksByAccountChannel: Map<string, { webhookId: string; webhookToken: string }>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
  lastPersistedAtMs: number;
};

// Plugin hooks can load this module through a separate runtime path while core
// imports it via ESM. Store mutable state on globalThis so both paths share one
// registry.
const THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.discordThreadBindingsState");
let threadBindingsState: ThreadBindingsGlobalState | undefined;

function createThreadBindingsGlobalState(): ThreadBindingsGlobalState {
  return {
    managersByAccountId: new Map<string, ThreadBindingManager>(),
    bindingsByThreadId: new Map<string, ThreadBindingRecord>(),
    bindingsBySessionKey: new Map<string, Set<string>>(),
    tokensByAccountId: new Map<string, string>(),
    recentUnboundWebhookEchoesByBindingKey: new Map<
      string,
      { webhookId: string; expiresAt: number }
    >(),
    reusableWebhooksByAccountChannel: new Map<
      string,
      { webhookId: string; webhookToken: string }
    >(),
    persistByAccountId: new Map<string, boolean>(),
    loadedBindings: false,
    lastPersistedAtMs: 0,
  };
}

function resolveThreadBindingsGlobalState(): ThreadBindingsGlobalState {
  if (!threadBindingsState) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    threadBindingsState =
      (globalStore[THREAD_BINDINGS_STATE_KEY] as ThreadBindingsGlobalState | undefined) ??
      createThreadBindingsGlobalState();
    globalStore[THREAD_BINDINGS_STATE_KEY] = threadBindingsState;
  }
  return threadBindingsState;
}

const THREAD_BINDINGS_STATE = resolveThreadBindingsGlobalState();

export const MANAGERS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.managersByAccountId;
export const BINDINGS_BY_THREAD_ID = THREAD_BINDINGS_STATE.bindingsByThreadId;
export const BINDINGS_BY_SESSION_KEY = THREAD_BINDINGS_STATE.bindingsBySessionKey;
export const TOKENS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.tokensByAccountId;
export const RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY =
  THREAD_BINDINGS_STATE.recentUnboundWebhookEchoesByBindingKey;
export const REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL =
  THREAD_BINDINGS_STATE.reusableWebhooksByAccountChannel;
export const PERSIST_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.persistByAccountId;
export const THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS = 15_000;

export function rememberThreadBindingToken(params: { accountId?: string; token?: string }) {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const token = params.token?.trim();
  if (!token) {
    return;
  }
  TOKENS_BY_ACCOUNT_ID.set(normalizedAccountId, token);
}

export function forgetThreadBindingToken(accountId?: string) {
  TOKENS_BY_ACCOUNT_ID.delete(normalizeAccountId(accountId));
}

export function getThreadBindingToken(accountId?: string): string | undefined {
  return TOKENS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
}

export function shouldDefaultPersist(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

export function resolveThreadBindingsPath(): string {
  return path.join(resolveStateDir(process.env), "discord", "thread-bindings.json");
}

export function normalizeTargetKind(
  raw: unknown,
  targetSessionKey: string,
): ThreadBindingTargetKind {
  if (raw === "subagent" || raw === "acp") {
    return raw;
  }
  return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}

export function normalizeThreadId(raw: unknown): string | undefined {
  return normalizeOptionalStringifiedId(raw);
}

export function toBindingRecordKey(params: { accountId: string; threadId: string }): string {
  return `${normalizeAccountId(params.accountId)}:${params.threadId.trim()}`;
}

export function resolveBindingRecordKey(params: {
  accountId?: string;
  threadId: string;
}): string | undefined {
  const threadId = normalizeThreadId(params.threadId);
  if (!threadId) {
    return undefined;
  }
  return toBindingRecordKey({
    accountId: normalizeAccountId(params.accountId),
    threadId,
  });
}

function normalizePersistedBinding(threadIdKey: string, raw: unknown): ThreadBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<PersistedThreadBindingRecord>;
  const threadId = normalizeThreadId(value.threadId ?? threadIdKey);
  const channelId = normalizeOptionalString(value.channelId) ?? "";
  const targetSessionKey =
    normalizeOptionalString(value.targetSessionKey) ??
    normalizeOptionalString(value.sessionKey) ??
    "";
  if (!threadId || !channelId || !targetSessionKey) {
    return null;
  }
  const accountId = normalizeAccountId(value.accountId);
  const targetKind = normalizeTargetKind(value.targetKind, targetSessionKey);
  const agentIdRaw = normalizeOptionalString(value.agentId) ?? "";
  const agentId = agentIdRaw || resolveAgentIdFromSessionKey(targetSessionKey);
  const label = normalizeOptionalString(value.label);
  const webhookId = normalizeOptionalString(value.webhookId);
  const webhookToken = normalizeOptionalString(value.webhookToken);
  const boundBy = normalizeOptionalString(value.boundBy) ?? "system";
  const boundAt =
    typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
      ? Math.floor(value.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof value.lastActivityAt === "number" && Number.isFinite(value.lastActivityAt)
      ? Math.max(0, Math.floor(value.lastActivityAt))
      : boundAt;
  const idleTimeoutMs =
    typeof value.idleTimeoutMs === "number" && Number.isFinite(value.idleTimeoutMs)
      ? Math.max(0, Math.floor(value.idleTimeoutMs))
      : undefined;
  const maxAgeMs =
    typeof value.maxAgeMs === "number" && Number.isFinite(value.maxAgeMs)
      ? Math.max(0, Math.floor(value.maxAgeMs))
      : undefined;
  const metadata =
    value.metadata && typeof value.metadata === "object" ? { ...value.metadata } : undefined;
  const legacyExpiresAt =
    typeof (value as { expiresAt?: unknown }).expiresAt === "number" &&
    Number.isFinite((value as { expiresAt?: unknown }).expiresAt)
      ? Math.max(0, Math.floor((value as { expiresAt?: number }).expiresAt ?? 0))
      : undefined;

  let migratedIdleTimeoutMs = idleTimeoutMs;
  let migratedMaxAgeMs = maxAgeMs;
  if (
    migratedIdleTimeoutMs === undefined &&
    migratedMaxAgeMs === undefined &&
    legacyExpiresAt != null
  ) {
    if (legacyExpiresAt <= 0) {
      migratedIdleTimeoutMs = 0;
      migratedMaxAgeMs = 0;
    } else {
      const baseBoundAt = boundAt > 0 ? boundAt : lastActivityAt;
      // Legacy expiresAt represented an absolute timestamp; map it to max-age and disable idle timeout.
      migratedIdleTimeoutMs = 0;
      migratedMaxAgeMs = Math.max(1, legacyExpiresAt - Math.max(0, baseBoundAt));
    }
  }

  return {
    accountId,
    channelId,
    threadId,
    targetKind,
    targetSessionKey,
    agentId,
    label,
    webhookId,
    webhookToken,
    boundBy,
    boundAt,
    lastActivityAt,
    idleTimeoutMs: migratedIdleTimeoutMs,
    maxAgeMs: migratedMaxAgeMs,
    metadata,
  };
}

export function normalizeThreadBindingDurationMs(raw: unknown, defaultsTo: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return defaultsTo;
  }
  const durationMs = Math.floor(raw);
  if (durationMs < 0) {
    return defaultsTo;
  }
  return durationMs;
}

export function resolveThreadBindingIdleTimeoutMs(params: {
  record: Pick<ThreadBindingRecord, "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number {
  const explicit = params.record.idleTimeoutMs;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return Math.max(0, Math.floor(params.defaultIdleTimeoutMs));
}

export function resolveThreadBindingMaxAgeMs(params: {
  record: Pick<ThreadBindingRecord, "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number {
  const explicit = params.record.maxAgeMs;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return Math.max(0, Math.floor(params.defaultMaxAgeMs));
}

export function resolveThreadBindingInactivityExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "lastActivityAt" | "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number | undefined {
  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
    record: params.record,
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
  });
  if (idleTimeoutMs <= 0) {
    return undefined;
  }
  const lastActivityAt = Math.floor(params.record.lastActivityAt);
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
    return undefined;
  }
  return lastActivityAt + idleTimeoutMs;
}

export function resolveThreadBindingMaxAgeExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "boundAt" | "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number | undefined {
  const maxAgeMs = resolveThreadBindingMaxAgeMs({
    record: params.record,
    defaultMaxAgeMs: params.defaultMaxAgeMs,
  });
  if (maxAgeMs <= 0) {
    return undefined;
  }
  const boundAt = Math.floor(params.record.boundAt);
  if (!Number.isFinite(boundAt) || boundAt <= 0) {
    return undefined;
  }
  return boundAt + maxAgeMs;
}

function linkSessionBinding(targetSessionKey: string, bindingKey: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key) ?? new Set<string>();
  threads.add(bindingKey);
  BINDINGS_BY_SESSION_KEY.set(key, threads);
}

function unlinkSessionBinding(targetSessionKey: string, bindingKey: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key);
  if (!threads) {
    return;
  }
  threads.delete(bindingKey);
  if (threads.size === 0) {
    BINDINGS_BY_SESSION_KEY.delete(key);
  }
}

export function toReusableWebhookKey(params: { accountId: string; channelId: string }): string {
  return `${normalizeLowercaseStringOrEmpty(params.accountId)}:${params.channelId.trim()}`;
}

export function rememberReusableWebhook(record: ThreadBindingRecord) {
  const webhookId = record.webhookId?.trim();
  const webhookToken = record.webhookToken?.trim();
  if (!webhookId || !webhookToken) {
    return;
  }
  const key = toReusableWebhookKey({
    accountId: record.accountId,
    channelId: record.channelId,
  });
  REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.set(key, { webhookId, webhookToken });
}

export function rememberRecentUnboundWebhookEcho(record: ThreadBindingRecord) {
  const webhookId = record.webhookId?.trim();
  if (!webhookId) {
    return;
  }
  const bindingKey = resolveBindingRecordKey({
    accountId: record.accountId,
    threadId: record.threadId,
  });
  if (!bindingKey) {
    return;
  }
  RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.set(bindingKey, {
    webhookId,
    expiresAt: Date.now() + RECENT_UNBOUND_WEBHOOK_ECHO_WINDOW_MS,
  });
}

function clearRecentUnboundWebhookEcho(bindingKeyRaw: string) {
  const key = bindingKeyRaw.trim();
  if (!key) {
    return;
  }
  RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.delete(key);
}

export function setBindingRecord(record: ThreadBindingRecord) {
  const bindingKey = toBindingRecordKey({
    accountId: record.accountId,
    threadId: record.threadId,
  });
  const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
  if (existing) {
    unlinkSessionBinding(existing.targetSessionKey, bindingKey);
  }
  BINDINGS_BY_THREAD_ID.set(bindingKey, record);
  linkSessionBinding(record.targetSessionKey, bindingKey);
  clearRecentUnboundWebhookEcho(bindingKey);
  rememberReusableWebhook(record);
}

export function removeBindingRecord(bindingKeyRaw: string): ThreadBindingRecord | null {
  const key = bindingKeyRaw.trim();
  if (!key) {
    return null;
  }
  const existing = BINDINGS_BY_THREAD_ID.get(key);
  if (!existing) {
    return null;
  }
  BINDINGS_BY_THREAD_ID.delete(key);
  unlinkSessionBinding(existing.targetSessionKey, key);
  return existing;
}

export function isRecentlyUnboundThreadWebhookMessage(params: {
  accountId?: string;
  threadId: string;
  webhookId?: string | null;
}): boolean {
  const webhookId = normalizeOptionalString(params.webhookId) ?? "";
  if (!webhookId) {
    return false;
  }
  const bindingKey = resolveBindingRecordKey({
    accountId: params.accountId,
    threadId: params.threadId,
  });
  if (!bindingKey) {
    return false;
  }
  const suppressed = RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.get(bindingKey);
  if (!suppressed) {
    return false;
  }
  if (suppressed.expiresAt <= Date.now()) {
    RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.delete(bindingKey);
    return false;
  }
  return suppressed.webhookId === webhookId;
}

function shouldPersistAnyBindingState(): boolean {
  for (const value of PERSIST_BY_ACCOUNT_ID.values()) {
    if (value) {
      return true;
    }
  }
  return false;
}

export function shouldPersistBindingMutations(): boolean {
  if (shouldPersistAnyBindingState()) {
    return true;
  }
  return fs.existsSync(resolveThreadBindingsPath());
}

export function saveBindingsToDisk(params: { force?: boolean; minIntervalMs?: number } = {}) {
  if (!params.force && !shouldPersistAnyBindingState()) {
    return;
  }
  const minIntervalMs =
    typeof params.minIntervalMs === "number" && Number.isFinite(params.minIntervalMs)
      ? Math.max(0, Math.floor(params.minIntervalMs))
      : 0;
  const now = Date.now();
  if (
    !params.force &&
    minIntervalMs > 0 &&
    THREAD_BINDINGS_STATE.lastPersistedAtMs > 0 &&
    now - THREAD_BINDINGS_STATE.lastPersistedAtMs < minIntervalMs
  ) {
    return;
  }
  const bindings: Record<string, PersistedThreadBindingRecord> = {};
  for (const [bindingKey, record] of BINDINGS_BY_THREAD_ID.entries()) {
    bindings[bindingKey] = { ...record };
  }
  const payload: PersistedThreadBindingsPayload = {
    version: THREAD_BINDINGS_VERSION,
    bindings,
  };
  saveJsonFile(resolveThreadBindingsPath(), payload);
  THREAD_BINDINGS_STATE.lastPersistedAtMs = now;
}

export function ensureBindingsLoaded() {
  if (THREAD_BINDINGS_STATE.loadedBindings) {
    return;
  }
  THREAD_BINDINGS_STATE.loadedBindings = true;
  BINDINGS_BY_THREAD_ID.clear();
  BINDINGS_BY_SESSION_KEY.clear();
  REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.clear();

  const raw = loadJsonFile(resolveThreadBindingsPath());
  if (!raw || typeof raw !== "object") {
    return;
  }
  const payload = raw as Partial<PersistedThreadBindingsPayload>;
  if (payload.version !== 1 || !payload.bindings || typeof payload.bindings !== "object") {
    return;
  }

  for (const [threadId, entry] of Object.entries(payload.bindings)) {
    const normalized = normalizePersistedBinding(threadId, entry);
    if (!normalized) {
      continue;
    }
    setBindingRecord(normalized);
  }
}

export function resolveBindingIdsForSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): string[] {
  const key = params.targetSessionKey.trim();
  if (!key) {
    return [];
  }
  const ids = BINDINGS_BY_SESSION_KEY.get(key);
  if (!ids) {
    return [];
  }
  const out: string[] = [];
  for (const bindingKey of ids.values()) {
    const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!record) {
      continue;
    }
    if (params.accountId && record.accountId !== params.accountId) {
      continue;
    }
    if (params.targetKind && record.targetKind !== params.targetKind) {
      continue;
    }
    out.push(bindingKey);
  }
  return out;
}

export function resolveDefaultThreadBindingDurations() {
  return {
    defaultIdleTimeoutMs: DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    defaultMaxAgeMs: DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  };
}

export function resetThreadBindingsForTests() {
  for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
    manager.stop();
  }
  MANAGERS_BY_ACCOUNT_ID.clear();
  BINDINGS_BY_THREAD_ID.clear();
  BINDINGS_BY_SESSION_KEY.clear();
  RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.clear();
  REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.clear();
  TOKENS_BY_ACCOUNT_ID.clear();
  PERSIST_BY_ACCOUNT_ID.clear();
  THREAD_BINDINGS_STATE.loadedBindings = false;
  THREAD_BINDINGS_STATE.lastPersistedAtMs = 0;
}
