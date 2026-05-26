import type { SessionScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../routing/session-key.js";
import { resolveEventSessionKey, scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../security/dm-policy-shared.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { isRecord } from "../shared/record-coerce.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

type UnknownRecord = Record<string, unknown>;

export type EventSessionRoutingPolicy = {
  mainKey?: string;
  sessionScope?: SessionScope;
  dmScope?: string | null;
  allowFrom?: ReadonlyArray<string | number> | null;
  channel?: string | null;
  accountId?: string | null;
  preserveSessionKey?: boolean;
};

type DirectSessionTarget = {
  agentId: string;
  channel?: string;
  accountId?: string;
  peerId: string;
};

function readAllowFrom(value: unknown): Array<string | number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const allowFrom = value.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : undefined;
}

function readDmAllowFrom(value: unknown): Array<string | number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readAllowFrom(value.dm);
}

function readAccountConfig(value: unknown): UnknownRecord | undefined {
  return isRecord(value) && isRecord(value.config) ? value.config : undefined;
}

function firstConfiguredAllowFrom(
  ...candidates: Array<Array<string | number> | undefined>
): Array<string | number> | undefined {
  return candidates.find((candidate) => candidate !== undefined);
}

function normalizeEntry(value: string): string | undefined {
  return normalizeLowercaseStringOrEmpty(value) || undefined;
}

export function parseDirectAgentSessionTarget(
  sessionKey: string | undefined | null,
): DirectSessionTarget | null {
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const directSessionKey = baseSessionKey ?? sessionKey;
  const parsed = parseAgentSessionKey(directSessionKey);
  if (!parsed || deriveSessionChatTypeFromKey(directSessionKey) !== "direct") {
    return null;
  }
  const parts = parsed.rest.split(":");
  const directIndex = parts.findIndex((part) => part === "direct" || part === "dm");
  if (directIndex < 0 || directIndex > 2 || directIndex >= parts.length - 1) {
    return null;
  }
  const peerId = normalizeLowercaseStringOrEmpty(parts.slice(directIndex + 1).join(":"));
  if (!peerId) {
    return null;
  }
  return {
    agentId: parsed.agentId,
    ...(directIndex >= 1 ? { channel: normalizeLowercaseStringOrEmpty(parts[0]) } : {}),
    ...(directIndex >= 2 ? { accountId: normalizeLowercaseStringOrEmpty(parts[1]) } : {}),
    peerId,
  };
}

export function resolveEventSessionAllowFrom(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string | null;
  channel?: string | null;
  accountId?: string | null;
}): Array<string | number> | undefined {
  const cfg = params.cfg;
  if (!cfg?.channels) {
    return undefined;
  }
  const target = parseDirectAgentSessionTarget(params.sessionKey);
  const channelKey = normalizeLowercaseStringOrEmpty(params.channel ?? target?.channel);
  if (!channelKey) {
    return undefined;
  }
  const channelConfig = isRecord(cfg.channels) ? cfg.channels[channelKey] : undefined;
  if (!isRecord(channelConfig)) {
    return undefined;
  }
  const accountId = normalizeLowercaseStringOrEmpty(params.accountId ?? target?.accountId);
  const accountConfig =
    accountId && isRecord(channelConfig.accounts) ? channelConfig.accounts[accountId] : undefined;
  const accountNestedConfig = readAccountConfig(accountConfig);
  return firstConfiguredAllowFrom(
    readDmAllowFrom(accountConfig),
    readDmAllowFrom(accountNestedConfig),
    readAllowFrom(accountConfig),
    readAllowFrom(accountNestedConfig),
    readDmAllowFrom(channelConfig),
    readAllowFrom(channelConfig),
  );
}

function shouldPreserveDirectSessionKeyFromRoute(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  target: DirectSessionTarget | null;
}): boolean {
  if (!params.cfg || !params.target?.channel) {
    return false;
  }
  try {
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: params.target.channel,
      accountId: params.target.accountId,
      peer: { kind: "direct", id: params.target.peerId },
    });
    const { baseSessionKey } = parseThreadSessionSuffix(params.sessionKey);
    const normalizedRouteSessionKey = normalizeLowercaseStringOrEmpty(route.sessionKey);
    return (
      route.lastRoutePolicy === "session" &&
      (normalizedRouteSessionKey === normalizeLowercaseStringOrEmpty(params.sessionKey) ||
        (baseSessionKey !== undefined &&
          normalizedRouteSessionKey === normalizeLowercaseStringOrEmpty(baseSessionKey)))
    );
  } catch {
    return false;
  }
}

export function resolveEventSessionRoutingPolicy(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string | null;
  channel?: string | null;
  accountId?: string | null;
  dmScope?: string | null;
  allowFrom?: ReadonlyArray<string | number> | null;
}): EventSessionRoutingPolicy {
  const target = parseDirectAgentSessionTarget(params.sessionKey);
  const channel = normalizeLowercaseStringOrEmpty(params.channel ?? target?.channel) || undefined;
  const accountId =
    normalizeLowercaseStringOrEmpty(params.accountId ?? target?.accountId) || undefined;
  const allowFrom =
    params.allowFrom ??
    resolveEventSessionAllowFrom({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      channel,
      accountId,
    });
  return {
    mainKey: params.cfg?.session?.mainKey,
    sessionScope: params.cfg?.session?.scope,
    dmScope: params.dmScope ?? params.cfg?.session?.dmScope,
    allowFrom,
    channel,
    accountId,
    preserveSessionKey: params.sessionKey
      ? shouldPreserveDirectSessionKeyFromRoute({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          target,
        })
      : false,
  };
}

export function resolveMainScopedEventSessionKey(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  agentId?: string | null;
  policy?: EventSessionRoutingPolicy;
}): string | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || params.policy?.preserveSessionKey === true) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const target = parseDirectAgentSessionTarget(sessionKey);
  if (!parsed || !target) {
    return null;
  }
  const resolvedAgentId = normalizeAgentId(params.agentId ?? target.agentId);
  if (normalizeAgentId(target.agentId) !== resolvedAgentId) {
    return null;
  }
  const policy =
    params.policy ??
    resolveEventSessionRoutingPolicy({
      cfg: params.cfg,
      sessionKey,
    });
  const allowFrom = Array.from(policy.allowFrom ?? []);
  const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: policy.dmScope ?? params.cfg?.session?.dmScope,
    allowFrom,
    normalizeEntry,
  });
  if (!pinnedOwner || normalizeEntry(target.peerId) !== pinnedOwner) {
    return null;
  }
  if (
    shouldPreserveDirectSessionKeyFromRoute({
      cfg: params.cfg,
      sessionKey,
      target,
    })
  ) {
    return null;
  }
  if (policy.sessionScope === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({
    agentId: resolvedAgentId,
    mainKey: policy.mainKey ?? params.cfg?.session?.mainKey,
  });
}

export function resolveEventSessionKeyForPolicy(
  sessionKey: string,
  policy?: EventSessionRoutingPolicy,
): string {
  const cronScoped = resolveEventSessionKey(sessionKey, policy?.mainKey, policy?.sessionScope);
  if (cronScoped !== sessionKey) {
    return cronScoped;
  }
  return resolveMainScopedEventSessionKey({ sessionKey, policy }) ?? sessionKey;
}

export function scopedHeartbeatWakeOptionsForPolicy<T extends object>(
  sessionKey: string,
  wakeOptions: T,
  policy?: EventSessionRoutingPolicy,
): T | (T & { sessionKey: string }) | (T & { agentId: string }) {
  const cronScoped = resolveEventSessionKey(sessionKey, policy?.mainKey, policy?.sessionScope);
  if (cronScoped !== sessionKey) {
    return scopedHeartbeatWakeOptions(
      sessionKey,
      wakeOptions,
      policy?.mainKey,
      policy?.sessionScope,
    );
  }
  const mainScoped = resolveMainScopedEventSessionKey({ sessionKey, policy });
  if (mainScoped) {
    if (mainScoped === "global") {
      const agentId = parseAgentSessionKey(sessionKey)?.agentId;
      return agentId ? { ...wakeOptions, agentId } : wakeOptions;
    }
    return { ...wakeOptions, sessionKey: mainScoped };
  }
  return scopedHeartbeatWakeOptions(sessionKey, wakeOptions, policy?.mainKey, policy?.sessionScope);
}
