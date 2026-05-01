import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/security-runtime";
import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
  normalizeSlackAllowOwnerEntry,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { inferSlackChannelType } from "./channel-type.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "./context.js";

type ResolvedAllowFromLists = {
  allowFrom: string[];
  allowFromLower: string[];
};

type SlackAllowFromCacheState = {
  baseSignature?: string;
  base?: ResolvedAllowFromLists;
  pairingKey?: string;
  pairing?: ResolvedAllowFromLists;
  pairingExpiresAtMs?: number;
  pairingPending?: Promise<ResolvedAllowFromLists>;
};

type SlackChannelMembersCacheEntry = {
  expiresAtMs: number;
  members?: Set<string>;
  pending?: Promise<Set<string>>;
};

let slackAllowFromCache = new WeakMap<SlackMonitorContext, SlackAllowFromCacheState>();
let slackChannelMembersCache = new WeakMap<
  SlackMonitorContext,
  Map<string, SlackChannelMembersCacheEntry>
>();
const DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS = 5000;
const DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS = 60_000;
const CHANNEL_MEMBERS_CACHE_MAX = 512;

function getPairingAllowFromCacheTtlMs(): number {
  const raw = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
  }
  return Math.max(0, Math.floor(parsed));
}

function getChannelMembersCacheTtlMs(): number {
  const raw = process.env.OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS;
  }
  return Math.max(0, Math.floor(parsed));
}

function getAllowFromCacheState(ctx: SlackMonitorContext): SlackAllowFromCacheState {
  const existing = slackAllowFromCache.get(ctx);
  if (existing) {
    return existing;
  }
  const next: SlackAllowFromCacheState = {};
  slackAllowFromCache.set(ctx, next);
  return next;
}

function getChannelMembersCache(
  ctx: SlackMonitorContext,
): Map<string, SlackChannelMembersCacheEntry> {
  const existing = slackChannelMembersCache.get(ctx);
  if (existing) {
    return existing;
  }
  const next = new Map<string, SlackChannelMembersCacheEntry>();
  slackChannelMembersCache.set(ctx, next);
  return next;
}

function pruneChannelMembersCache(cache: Map<string, SlackChannelMembersCacheEntry>): void {
  while (cache.size > CHANNEL_MEMBERS_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      return;
    }
    cache.delete(oldest.value);
  }
}

function buildBaseAllowFrom(ctx: SlackMonitorContext): ResolvedAllowFromLists {
  const allowFrom = normalizeAllowList(ctx.allowFrom);
  return {
    allowFrom,
    allowFromLower: normalizeAllowListLower(allowFrom),
  };
}

export async function resolveSlackEffectiveAllowFrom(
  ctx: SlackMonitorContext,
  options?: { includePairingStore?: boolean },
) {
  const includePairingStore = options?.includePairingStore === true;
  const cache = getAllowFromCacheState(ctx);
  const baseSignature = JSON.stringify(ctx.allowFrom);
  if (cache.baseSignature !== baseSignature || !cache.base) {
    cache.baseSignature = baseSignature;
    cache.base = buildBaseAllowFrom(ctx);
    cache.pairing = undefined;
    cache.pairingKey = undefined;
    cache.pairingExpiresAtMs = undefined;
    cache.pairingPending = undefined;
  }
  if (!includePairingStore) {
    return cache.base;
  }

  const ttlMs = getPairingAllowFromCacheTtlMs();
  const nowMs = Date.now();
  const pairingKey = `${ctx.accountId}:${ctx.dmPolicy}`;
  if (
    ttlMs > 0 &&
    cache.pairing &&
    cache.pairingKey === pairingKey &&
    (cache.pairingExpiresAtMs ?? 0) >= nowMs
  ) {
    return cache.pairing;
  }
  if (cache.pairingPending && cache.pairingKey === pairingKey) {
    return await cache.pairingPending;
  }

  const pairingPending = (async (): Promise<ResolvedAllowFromLists> => {
    let storeAllowFrom: string[] = [];
    try {
      const resolved = await readStoreAllowFromForDmPolicy({
        provider: "slack",
        accountId: ctx.accountId,
        dmPolicy: ctx.dmPolicy,
      });
      storeAllowFrom = Array.isArray(resolved) ? resolved : [];
    } catch {
      storeAllowFrom = [];
    }
    const allowFrom = normalizeAllowList([...(cache.base?.allowFrom ?? []), ...storeAllowFrom]);
    return {
      allowFrom,
      allowFromLower: normalizeAllowListLower(allowFrom),
    };
  })();

  cache.pairingKey = pairingKey;
  cache.pairingPending = pairingPending;
  try {
    const resolved = await pairingPending;
    if (ttlMs > 0) {
      cache.pairing = resolved;
      cache.pairingExpiresAtMs = nowMs + ttlMs;
    } else {
      cache.pairing = undefined;
      cache.pairingExpiresAtMs = undefined;
    }
    return resolved;
  } finally {
    if (cache.pairingPending === pairingPending) {
      cache.pairingPending = undefined;
    }
  }
}

export function clearSlackAllowFromCacheForTest(): void {
  slackAllowFromCache = new WeakMap<SlackMonitorContext, SlackAllowFromCacheState>();
  slackChannelMembersCache = new WeakMap<
    SlackMonitorContext,
    Map<string, SlackChannelMembersCacheEntry>
  >();
}

export function isSlackSenderAllowListed(params: {
  allowListLower: string[];
  senderId: string;
  senderName?: string;
  allowNameMatching?: boolean;
}) {
  const { allowListLower, senderId, senderName, allowNameMatching } = params;
  return (
    allowListLower.length === 0 ||
    allowListMatches({
      allowList: allowListLower,
      id: senderId,
      name: senderName,
      allowNameMatching,
    })
  );
}

async function fetchSlackChannelMemberIds(
  ctx: SlackMonitorContext,
  channelId: string,
): Promise<Set<string>> {
  const members = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await ctx.app.client.conversations.members({
      token: ctx.botToken,
      channel: channelId,
      limit: 999,
      ...(cursor ? { cursor } : {}),
    });
    for (const member of normalizeAllowListLower(response.members)) {
      members.add(member);
    }
    const nextCursor = response.response_metadata?.next_cursor?.trim();
    cursor = nextCursor ? nextCursor : undefined;
  } while (cursor);
  return members;
}

async function resolveSlackChannelMemberIds(
  ctx: SlackMonitorContext,
  channelId: string,
): Promise<Set<string>> {
  const cache = getChannelMembersCache(ctx);
  const key = `${ctx.accountId}:${channelId}`;
  const ttlMs = getChannelMembersCacheTtlMs();
  const nowMs = Date.now();
  const cached = cache.get(key);
  if (ttlMs > 0 && cached?.members && cached.expiresAtMs >= nowMs) {
    return cached.members;
  }
  if (cached?.pending) {
    return await cached.pending;
  }

  const pending = fetchSlackChannelMemberIds(ctx, channelId);
  cache.set(key, {
    expiresAtMs: ttlMs > 0 ? nowMs + ttlMs : 0,
    pending,
  });
  pruneChannelMembersCache(cache);
  try {
    const members = await pending;
    if (ttlMs > 0) {
      cache.set(key, {
        expiresAtMs: Date.now() + ttlMs,
        members,
      });
      pruneChannelMembersCache(cache);
    } else {
      cache.delete(key);
    }
    return members;
  } finally {
    const latest = cache.get(key);
    if (latest?.pending === pending) {
      cache.delete(key);
    }
  }
}

function resolveExplicitSlackOwnerIds(allowFromLower: string[]): string[] {
  const ownerIds = new Set<string>();
  for (const entry of allowFromLower) {
    const ownerId = normalizeSlackAllowOwnerEntry(entry);
    if (ownerId) {
      ownerIds.add(ownerId);
    }
  }
  return [...ownerIds];
}

export async function authorizeSlackBotRoomMessage(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  senderId: string;
  senderName?: string;
  channelUsers?: Array<string | number>;
  allowFromLower: string[];
}): Promise<boolean> {
  const channelUserAllowList = normalizeAllowListLower(params.channelUsers).filter(
    (entry) => entry !== "*",
  );
  if (
    channelUserAllowList.length > 0 &&
    allowListMatches({
      allowList: channelUserAllowList,
      id: params.senderId,
      name: params.senderName,
      allowNameMatching: params.ctx.allowNameMatching,
    })
  ) {
    return true;
  }

  const explicitOwnerIds = resolveExplicitSlackOwnerIds(params.allowFromLower);
  if (explicitOwnerIds.length === 0) {
    logVerbose(
      `slack: drop bot message ${params.senderId} in ${params.channelId} (no explicit owner id for presence check)`,
    );
    return false;
  }

  try {
    const channelMemberIds = await resolveSlackChannelMemberIds(params.ctx, params.channelId);
    if (explicitOwnerIds.some((ownerId) => channelMemberIds.has(ownerId))) {
      return true;
    }
    logVerbose(
      `slack: drop bot message ${params.senderId} in ${params.channelId} (no owner present)`,
    );
  } catch (error) {
    logVerbose(
      `slack: drop bot message ${params.senderId} in ${params.channelId} (owner presence lookup failed: ${formatErrorMessage(error)})`,
    );
  }
  return false;
}

export type SlackSystemEventAuthResult = {
  allowed: boolean;
  reason?:
    | "missing-sender"
    | "missing-expected-sender"
    | "sender-mismatch"
    | "channel-not-allowed"
    | "ambiguous-channel-type"
    | "dm-disabled"
    | "sender-not-allowlisted"
    | "sender-not-channel-allowed"
    | "sender-not-authorized";
  channelType?: "im" | "mpim" | "channel" | "group";
  channelName?: string;
};

export async function authorizeSlackSystemEventSender(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  expectedSenderId?: string;
  /** When true, requires expectedSenderId, rejects ambiguous channel types,
   *  and applies interactive-only owner allowFrom checks without changing the
   *  open-by-default channel behavior when no allowlists are configured. */
  interactiveEvent?: boolean;
}): Promise<SlackSystemEventAuthResult> {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return { allowed: false, reason: "missing-sender" };
  }

  const expectedSenderId = params.expectedSenderId?.trim();
  if (expectedSenderId && expectedSenderId !== senderId) {
    return { allowed: false, reason: "sender-mismatch" };
  }

  // Interactive events require an expected sender to cross-verify the actor.
  if (params.interactiveEvent && !expectedSenderId) {
    return { allowed: false, reason: "missing-expected-sender" };
  }

  const channelId = params.channelId?.trim();
  let channelType = normalizeSlackChannelType(params.channelType, channelId);
  let channelName: string | undefined;
  if (channelId) {
    const info: {
      name?: string;
      type?: "im" | "mpim" | "channel" | "group";
    } = await params.ctx.resolveChannelName(channelId).catch(() => ({}));
    channelName = info.name;
    const resolvedTypeSource = params.channelType ?? info.type;
    channelType = normalizeSlackChannelType(resolvedTypeSource, channelId);
    if (
      !params.ctx.isChannelAllowed({
        channelId,
        channelName,
        channelType,
      })
    ) {
      return {
        allowed: false,
        reason: "channel-not-allowed",
        channelType,
        channelName,
      };
    }

    // For interactive events, reject when channel type could not be positively
    // determined from either the explicit type or the channel ID prefix. This
    // prevents a DM from being misclassified as "channel" and skipping
    // DM-specific authorization.
    if (params.interactiveEvent) {
      const inferredFromId = inferSlackChannelType(channelId);
      const sourceNormalized =
        typeof resolvedTypeSource === "string"
          ? resolvedTypeSource.toLowerCase().trim()
          : undefined;
      const sourceIsKnownType =
        sourceNormalized === "im" ||
        sourceNormalized === "mpim" ||
        sourceNormalized === "channel" ||
        sourceNormalized === "group";
      if (inferredFromId === undefined && !sourceIsKnownType) {
        return {
          allowed: false,
          reason: "ambiguous-channel-type",
          channelType,
          channelName,
        };
      }
    }
  }

  const senderInfo: { name?: string } = await params.ctx
    .resolveUserName(senderId)
    .catch(() => ({}));
  const senderName = senderInfo.name;

  const resolveAllowFromLower = async (includePairingStore = false) =>
    (await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore })).allowFromLower;

  if (channelType === "im") {
    if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
      return { allowed: false, reason: "dm-disabled", channelType, channelName };
    }
    const allowFromLower = await resolveAllowFromLower(true);
    const senderAllowListed = isSlackSenderAllowListed({
      allowListLower: allowFromLower,
      senderId,
      senderName,
      allowNameMatching: params.ctx.allowNameMatching,
    });
    if (!senderAllowListed) {
      return {
        allowed: false,
        reason: "sender-not-allowlisted",
        channelType,
        channelName,
      };
    }
  } else if (!channelId) {
    // No channel context. Preserve the existing open default unless a global
    // allowFrom list is configured.
    const allowFromLower = await resolveAllowFromLower(false);
    if (allowFromLower.length > 0) {
      const senderAllowListed = isSlackSenderAllowListed({
        allowListLower: allowFromLower,
        senderId,
        senderName,
        allowNameMatching: params.ctx.allowNameMatching,
      });
      if (!senderAllowListed) {
        return { allowed: false, reason: "sender-not-allowlisted" };
      }
    }
  } else {
    const allowFromLower = await resolveAllowFromLower(false);
    const ownerAllowlistConfigured = allowFromLower.length > 0;
    const allowFromLowerWithoutWildcard = allowFromLower.filter((entry) => entry !== "*");
    const channelConfig = resolveSlackChannelConfig({
      channelId,
      channelName,
      channels: params.ctx.channelsConfig,
      channelKeys: params.ctx.channelsConfigKeys,
      defaultRequireMention: params.ctx.defaultRequireMention,
      allowNameMatching: params.ctx.allowNameMatching,
    });
    const channelUsersAllowlistConfigured =
      Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
    const ownerMatch = ownerAllowlistConfigured
      ? resolveSlackAllowListMatch({
          allowList: allowFromLower,
          id: senderId,
          name: senderName,
          allowNameMatching: params.ctx.allowNameMatching,
        })
      : { allowed: false };
    const ownerAllowed = ownerMatch.allowed;
    const ownerExplicitlyAllowed =
      allowFromLowerWithoutWildcard.length > 0 &&
      resolveSlackAllowListMatch({
        allowList: allowFromLowerWithoutWildcard,
        id: senderId,
        name: senderName,
        allowNameMatching: params.ctx.allowNameMatching,
      }).allowed;
    if (channelUsersAllowlistConfigured) {
      const channelUserAllowed = resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: senderId,
        userName: senderName,
        allowNameMatching: params.ctx.allowNameMatching,
      });
      if (channelUserAllowed || (params.interactiveEvent && ownerExplicitlyAllowed)) {
        return {
          allowed: true,
          channelType,
          channelName,
        };
      }
      return {
        allowed: false,
        reason:
          params.interactiveEvent && ownerAllowlistConfigured
            ? "sender-not-authorized"
            : "sender-not-channel-allowed",
        channelType,
        channelName,
      };
    }
    if (params.interactiveEvent && ownerAllowed) {
      return {
        allowed: true,
        channelType,
        channelName,
      };
    }
    if (params.interactiveEvent && ownerAllowlistConfigured) {
      return {
        allowed: false,
        reason: "sender-not-allowlisted",
        channelType,
        channelName,
      };
    }
  }

  return {
    allowed: true,
    channelType,
    channelName,
  };
}
