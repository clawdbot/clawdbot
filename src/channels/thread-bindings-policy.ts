import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getChannelPlugin } from "./plugins/index.js";

const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;

type SessionThreadBindingsConfigShape = {
  enabled?: unknown;
  idleHours?: unknown;
  maxAgeHours?: unknown;
  spawnSubagentSessions?: unknown;
  spawnAcpSessions?: unknown;
};

type ChannelThreadBindingsContainerShape = {
  threadBindings?: SessionThreadBindingsConfigShape;
  accounts?: Record<string, { threadBindings?: SessionThreadBindingsConfigShape } | undefined>;
};

export type ThreadBindingSpawnKind = "subagent" | "acp";

export type ThreadBindingSpawnPolicy = {
  channel: string;
  accountId: string;
  enabled: boolean;
  spawnEnabled: boolean;
};

function normalizeChannelId(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

export function supportsAutomaticThreadBindingSpawn(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

export function requiresNativeThreadContextForThreadHere(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

export function resolveThreadBindingPlacementForCurrentContext(params: {
  channel: string;
  threadId?: string;
}): "current" | "child" {
  if (resolveDefaultTopLevelPlacement(params.channel) !== "child") {
    return "current";
  }
  return params.threadId ? "current" : "child";
}

function resolveDefaultTopLevelPlacement(channel: string): "current" | "child" {
  const normalized = normalizeChannelId(channel);
  if (!normalized) {
    return "current";
  }
  return getChannelPlugin(normalized)?.conversationBindings?.defaultTopLevelPlacement ?? "current";
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

function normalizeThreadBindingHours(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  if (raw < 0) {
    return undefined;
  }
  return raw;
}

export function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  const idleHours =
    normalizeThreadBindingHours(params.channelIdleHoursRaw) ??
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ??
    DEFAULT_THREAD_BINDING_IDLE_HOURS;
  return Math.floor(idleHours * 60 * 60 * 1000);
}

export function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number {
  const maxAgeHours =
    normalizeThreadBindingHours(params.channelMaxAgeHoursRaw) ??
    normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ??
    DEFAULT_THREAD_BINDING_MAX_AGE_HOURS;
  return Math.floor(maxAgeHours * 60 * 60 * 1000);
}

type ThreadBindingLifecycleRecord = {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export function resolveThreadBindingLifecycle(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): {
  expiresAt?: number;
  reason?: "idle-expired" | "max-age-expired";
} {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;

  const inactivityExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return inactivityExpiresAt <= maxAgeExpiresAt
      ? { expiresAt: inactivityExpiresAt, reason: "idle-expired" }
      : { expiresAt: maxAgeExpiresAt, reason: "max-age-expired" };
  }
  if (inactivityExpiresAt != null) {
    return { expiresAt: inactivityExpiresAt, reason: "idle-expired" };
  }
  if (maxAgeExpiresAt != null) {
    return { expiresAt: maxAgeExpiresAt, reason: "max-age-expired" };
  }
  return {};
}

export function resolveThreadBindingEffectiveExpiresAt(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  return resolveThreadBindingLifecycle(params).expiresAt;
}

export function resolveThreadBindingsEnabled(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean {
  return (
    normalizeBoolean(params.channelEnabledRaw) ?? normalizeBoolean(params.sessionEnabledRaw) ?? true
  );
}

function resolveChannelThreadBindings(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
}): {
  root?: SessionThreadBindingsConfigShape;
  account?: SessionThreadBindingsConfigShape;
} {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channel] as
    | ChannelThreadBindingsContainerShape
    | undefined;
  const accountConfig = channelConfig?.accounts?.[params.accountId];
  return {
    root: channelConfig?.threadBindings,
    account: accountConfig?.threadBindings,
  };
}

function resolveSpawnFlagKey(
  kind: ThreadBindingSpawnKind,
): "spawnSubagentSessions" | "spawnAcpSessions" {
  return kind === "subagent" ? "spawnSubagentSessions" : "spawnAcpSessions";
}

export function resolveThreadBindingSpawnPolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  kind: ThreadBindingSpawnKind;
}): ThreadBindingSpawnPolicy {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  const enabled =
    normalizeBoolean(account?.enabled) ??
    normalizeBoolean(root?.enabled) ??
    normalizeBoolean(params.cfg.session?.threadBindings?.enabled) ??
    true;
  const spawnFlagKey = resolveSpawnFlagKey(params.kind);
  const spawnEnabledRaw =
    normalizeBoolean(account?.[spawnFlagKey]) ?? normalizeBoolean(root?.[spawnFlagKey]);
  const spawnEnabled = spawnEnabledRaw ?? resolveDefaultTopLevelPlacement(channel) !== "child";
  return {
    channel,
    accountId,
    enabled,
    spawnEnabled,
  };
}

export function resolveThreadBindingIdleTimeoutMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number {
  const { root, account } = resolveThreadBindingChannelScope(params);
  return resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
    sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours,
  });
}

export function resolveThreadBindingMaxAgeMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number {
  const { root, account } = resolveThreadBindingChannelScope(params);
  return resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
    sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours,
  });
}

function resolveThreadBindingChannelScope(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}) {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  return resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
}

export function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread bindings are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).`;
}

export function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  const spawnFlagKey = resolveSpawnFlagKey(params.kind);
  return `Thread-bound ${params.kind} spawns are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.${spawnFlagKey}=true to enable).`;
}
