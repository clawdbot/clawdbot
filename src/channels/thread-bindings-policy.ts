// Thread-binding policy resolution for channel/account session spawning.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  resolveThreadBindingLifecycle as resolveSharedThreadBindingLifecycle,
  type ThreadBindingLifecycleRecord,
} from "../shared/thread-binding-lifecycle.js";
import { getLoadedChannelPlugin } from "./plugins/index.js";
import { resolveBundledChannelThreadBindingDefaultPlacement } from "./plugins/thread-binding-api.js";

export { resolveThreadBindingLifecycle } from "../shared/thread-binding-lifecycle.js";

const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;

type SessionThreadBindingsConfigShape = {
  enabled?: unknown;
  idleHours?: unknown;
  maxAgeHours?: unknown;
  spawnSessions?: unknown;
  spawnSubagentSessions?: unknown;
  spawnAcpSessions?: unknown;
  defaultSpawnContext?: unknown;
};

type ChannelThreadBindingsContainerShape = {
  threadBindings?: SessionThreadBindingsConfigShape;
  accounts?: Record<string, { threadBindings?: SessionThreadBindingsConfigShape } | undefined>;
};

/** Thread-bound session type controlled by spawn policy. */
type ThreadBindingSpawnKind = "subagent" | "acp";

/** Effective per-channel/account policy for creating thread-bound sessions. */
type ThreadBindingSpawnPolicy = {
  channel: string;
  accountId: string;
  enabled: boolean;
  spawnEnabled: boolean;
  defaultSpawnContext: ThreadBindingSpawnContext;
};

/** Starting transcript mode for a spawned thread-bound session. */
type ThreadBindingSpawnContext = "isolated" | "fork";

function normalizeChannelId(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

/** Returns true when top-level commands should spawn in a child thread by default. */
export function supportsAutomaticThreadBindingSpawn(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

/** Returns true when /thread here needs a native channel thread to exist first. */
export function requiresNativeThreadContextForThreadHere(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

/** Resolves whether a thread binding should attach to the current thread or create a child. */
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
  return (
    // Loaded plugin metadata wins; bundled metadata is the startup-safe fallback.
    getLoadedChannelPlugin(normalized)?.conversationBindings?.defaultTopLevelPlacement ??
    resolveBundledChannelThreadBindingDefaultPlacement(normalized) ??
    "current"
  );
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

function resolveThreadBindingHoursMs(raw: unknown, fallbackHours: number): number {
  const hours = normalizeThreadBindingHours(raw) ?? fallbackHours;
  const durationMs = Math.floor(hours * 60 * 60 * 1000);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }
  return Math.min(durationMs, MAX_DATE_TIMESTAMP_MS);
}

/** Resolves thread-binding idle timeout with channel/account override before session default. */
export function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  return resolveThreadBindingHoursMs(
    params.channelIdleHoursRaw,
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ?? DEFAULT_THREAD_BINDING_IDLE_HOURS,
  );
}

/** Resolves thread-binding max age with channel/account override before session default. */
export function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number {
  return resolveThreadBindingHoursMs(
    params.channelMaxAgeHoursRaw,
    normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ??
      DEFAULT_THREAD_BINDING_MAX_AGE_HOURS,
  );
}

/** Computes the effective expiry timestamp for a thread-binding lifecycle record. */
export function resolveThreadBindingEffectiveExpiresAt(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  return resolveSharedThreadBindingLifecycle(params).expiresAt;
}

/** Resolves the effective enabled flag for thread bindings. */
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

function normalizeSpawnContext(value: unknown): ThreadBindingSpawnContext | undefined {
  return value === "isolated" || value === "fork" ? value : undefined;
}

/** Resolves effective spawn policy from account, channel, then global thread-binding config. */
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
    normalizeBoolean(account?.[spawnFlagKey]) ??
    normalizeBoolean(account?.spawnSessions) ??
    normalizeBoolean(root?.[spawnFlagKey]) ??
    normalizeBoolean(root?.spawnSessions) ??
    normalizeBoolean(params.cfg.session?.threadBindings?.spawnSessions);
  const spawnEnabled = spawnEnabledRaw ?? true;
  const defaultSpawnContext =
    normalizeSpawnContext(account?.defaultSpawnContext) ??
    normalizeSpawnContext(root?.defaultSpawnContext) ??
    normalizeSpawnContext(params.cfg.session?.threadBindings?.defaultSpawnContext) ??
    "fork";
  return {
    channel,
    accountId,
    enabled,
    spawnEnabled,
    defaultSpawnContext,
  };
}

/** Resolves idle timeout for a concrete channel/account config scope. */
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

/** Resolves max age for a concrete channel/account config scope. */
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

/** Formats the user-facing error for disabled thread bindings. */
export function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread bindings are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).`;
}

/** Formats the user-facing error for disabled thread-bound session spawning. */
export function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread-bound session spawns are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.spawnSessions=true to enable).`;
}
