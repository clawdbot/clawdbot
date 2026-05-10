import {
  type ChannelIngressEventInput,
  type ChannelIngressIdentifierKind,
  type ChannelIngressPolicyInput,
  type ChannelIngressStateInput,
  type ChannelIngressDecision,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  readChannelIngressStoreAllowFromForDmPolicy,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
  normalizeSlackAllowOwnerEntry,
  normalizeSlackSlug,
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { inferSlackChannelType } from "./channel-type.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "./context.js";

type SlackChannelMembersCacheEntry = {
  expiresAtMs: number;
  members?: Set<string>;
  pending?: Promise<Set<string>>;
};

type SlackIngressChannelType = "im" | "mpim" | "channel" | "group";
type SlackSystemEventAuthorization =
  | {
      allowed: true;
      channelType?: SlackIngressChannelType;
      channelName?: string;
    }
  | {
      allowed: false;
      reason: string;
      channelType?: SlackIngressChannelType;
      channelName?: string;
    };

let slackChannelMembersCache = new WeakMap<
  SlackMonitorContext,
  Map<string, SlackChannelMembersCacheEntry>
>();
const DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS = 60_000;
const CHANNEL_MEMBERS_CACHE_MAX = 512;
const SLACK_CHANNEL_ID = "slack";
const SLACK_USER_NAME_KIND =
  "plugin:slack-user-name" as const satisfies ChannelIngressIdentifierKind;

function normalizeSlackUserId(raw?: string | null): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  const mention = value.match(/^<@([a-z0-9_]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return value.replace(/^(slack:|user:)/, "");
}

function isSlackStableUserId(value: string): boolean {
  return /^[ubw][a-z0-9_]+$/i.test(value);
}

function normalizeSlackStableEntry(entry: string): string | null {
  const normalized = entry.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const userId = normalizeSlackUserId(normalized);
  return isSlackStableUserId(userId) ? userId : null;
}

function normalizeSlackNameEntry(entry: string): string | null {
  const normalized = entry.trim().toLowerCase();
  if (!normalized || normalizeSlackStableEntry(normalized)) {
    return null;
  }
  return normalized.replace(/^slack:/, "") || null;
}

function normalizeSlackNameSubject(value: string): string | null {
  return value.trim().toLowerCase() || null;
}

function normalizeSlackNameSlugEntry(entry: string): string | null {
  const name = normalizeSlackNameEntry(entry);
  if (!name) {
    return null;
  }
  const slug = normalizeSlackSlug(name);
  return slug && slug !== name ? slug : null;
}

const slackIngressIdentity = defineStableChannelIngressIdentity({
  key: "senderId",
  kind: "stable-id",
  normalizeEntry: normalizeSlackStableEntry,
  normalizeSubject: normalizeSlackUserId,
  sensitivity: "pii",
  aliases: (
    [
      ["senderName", normalizeSlackNameEntry],
      ["senderNameSlug", normalizeSlackNameSlugEntry],
    ] as const
  ).map(([key, normalizeEntry]) => ({
    key,
    kind: SLACK_USER_NAME_KIND,
    normalizeEntry,
    normalizeSubject: normalizeSlackNameSubject,
    dangerous: true,
    sensitivity: "pii" as const,
  })),
});

function createSlackIngressSubject(params: { senderId: string; senderName?: string }) {
  const senderId = normalizeSlackUserId(params.senderId);
  const senderName = params.senderName?.trim().toLowerCase();
  const senderNameSlug = senderName ? normalizeSlackSlug(senderName) : undefined;
  return {
    stableId: senderId,
    aliases: {
      senderName,
      senderNameSlug,
    },
  };
}

function createSlackIngressResolver(ctx: SlackMonitorContext) {
  return createChannelIngressResolver({
    channelId: SLACK_CHANNEL_ID,
    accountId: ctx.accountId,
    identity: slackIngressIdentity,
    cfg: ctx.cfg,
  });
}

function readSlackCacheTtlMs(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
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

function buildBaseAllowFrom(ctx: SlackMonitorContext): string[] {
  return normalizeAllowListLower(normalizeAllowList(ctx.allowFrom));
}

export async function resolveSlackEffectiveAllowFrom(
  ctx: SlackMonitorContext,
  options?: { includePairingStore?: boolean },
) {
  const base = buildBaseAllowFrom(ctx);
  if (options?.includePairingStore !== true) {
    return base;
  }
  let storeAllowFrom: string[] = [];
  try {
    const resolved = await readChannelIngressStoreAllowFromForDmPolicy({
      provider: "slack",
      accountId: ctx.accountId,
      dmPolicy: ctx.dmPolicy,
    });
    storeAllowFrom = Array.isArray(resolved) ? resolved : [];
  } catch {
    storeAllowFrom = [];
  }
  return normalizeAllowListLower([...base, ...storeAllowFrom]);
}

export function clearSlackAllowFromCacheForTest(): void {
  slackChannelMembersCache = new WeakMap<
    SlackMonitorContext,
    Map<string, SlackChannelMembersCacheEntry>
  >();
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
  const ttlMs = readSlackCacheTtlMs(
    "OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS",
    DEFAULT_CHANNEL_MEMBERS_CACHE_TTL_MS,
  );
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

function wildcardWhenOpen(entries: readonly string[]): string[] {
  return entries.length > 0 ? [...entries] : ["*"];
}

function slackIngressConversationKind(
  channelType: SlackIngressChannelType,
): "direct" | "group" | "channel" {
  return channelType === "im" ? "direct" : channelType === "mpim" ? "group" : "channel";
}

export async function resolveSlackCommandIngress(params: {
  ctx: SlackMonitorContext;
  senderId: string;
  senderName?: string;
  channelType: SlackIngressChannelType;
  channelId: string;
  ownerAllowFromLower: string[];
  channelUsers?: Array<string | number>;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  mentionFacts?: ChannelIngressStateInput["mentionFacts"];
  activation?: NonNullable<ChannelIngressPolicyInput["activation"]>;
  eventKind?: ChannelIngressEventInput["kind"];
  modeWhenAccessGroupsOff?: NonNullable<
    ChannelIngressPolicyInput["command"]
  >["modeWhenAccessGroupsOff"];
}) {
  const isDirectMessage = params.channelType === "im";
  const channelUsers = normalizeAllowListLower(params.channelUsers);
  const channelUsersConfigured = !isDirectMessage && channelUsers.length > 0;
  const result = await createSlackIngressResolver(params.ctx).message({
    subject: createSlackIngressSubject({
      senderId: params.senderId,
      senderName: params.senderName,
    }),
    conversation: {
      kind: slackIngressConversationKind(params.channelType),
      id: params.channelId,
    },
    event: {
      kind: params.eventKind ?? "message",
      authMode: "inbound",
      mayPair: false,
    },
    dmPolicy: isDirectMessage ? "open" : "disabled",
    groupPolicy: channelUsersConfigured ? "allowlist" : "open",
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: params.ctx.allowNameMatching ? "enabled" : "disabled",
      ...(params.activation ? { activation: params.activation } : {}),
    },
    mentionFacts: params.mentionFacts,
    allowFrom: isDirectMessage ? ["*"] : params.ownerAllowFromLower,
    groupAllowFrom: channelUsersConfigured ? channelUsers : [],
    command: {
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
      ...(isDirectMessage ? { commandOwnerAllowFrom: params.ownerAllowFromLower } : {}),
    },
  });
  return result;
}

async function decideSlackSystemIngress(params: {
  ctx: SlackMonitorContext;
  senderId: string;
  senderName?: string;
  channelType: SlackIngressChannelType;
  channelId?: string;
  ownerAllowFromLower: string[];
  channelUsers?: Array<string | number>;
  interactiveEvent: boolean;
}): Promise<ChannelIngressDecision> {
  const isDirectMessage = params.channelType === "im";
  const channelUsers = normalizeAllowListLower(params.channelUsers);
  const channelUsersConfigured = !isDirectMessage && channelUsers.length > 0;
  const ownerAllowFrom =
    params.interactiveEvent && channelUsersConfigured
      ? params.ownerAllowFromLower.filter((entry) => entry !== "*")
      : params.ownerAllowFromLower;
  const hasAnyCommandAllowlist = ownerAllowFrom.length > 0 || channelUsersConfigured;
  const groupAllowFrom = (() => {
    if (isDirectMessage) {
      return [];
    }
    if (params.interactiveEvent && hasAnyCommandAllowlist) {
      return channelUsersConfigured ? channelUsers : [];
    }
    if (channelUsersConfigured) {
      return channelUsers;
    }
    return params.channelId ? ["*"] : wildcardWhenOpen(params.ownerAllowFromLower);
  })();
  const result = await createSlackIngressResolver(params.ctx).message({
    subject: createSlackIngressSubject({
      senderId: params.senderId,
      senderName: params.senderName,
    }),
    conversation: {
      kind: slackIngressConversationKind(params.channelType),
      id: params.channelId ?? "slack-system",
    },
    event: {
      kind: params.interactiveEvent ? "button" : "system",
      authMode: params.interactiveEvent && hasAnyCommandAllowlist ? "command" : "inbound",
      mayPair: false,
    },
    dmPolicy: isDirectMessage ? "open" : "disabled",
    groupPolicy:
      params.interactiveEvent && hasAnyCommandAllowlist
        ? "open"
        : channelUsersConfigured || (!params.channelId && params.ownerAllowFromLower.length > 0)
          ? "allowlist"
          : "open",
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: params.ctx.allowNameMatching ? "enabled" : "disabled",
    },
    allowFrom: isDirectMessage ? wildcardWhenOpen(params.ownerAllowFromLower) : ownerAllowFrom,
    groupAllowFrom,
    command:
      params.interactiveEvent && hasAnyCommandAllowlist
        ? {
            useAccessGroups: true,
            allowTextCommands: true,
            modeWhenAccessGroupsOff: "configured",
            commandOwnerAllowFrom: ownerAllowFrom,
          }
        : undefined,
  });
  return result.ingress;
}

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
}): Promise<SlackSystemEventAuthorization> {
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
  const ingressChannelType = channelType ?? "channel";

  if (ingressChannelType === "im") {
    if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
      return { allowed: false, reason: "dm-disabled", channelType, channelName };
    }
  }

  const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, {
    includePairingStore: ingressChannelType === "im",
  });
  const channelConfig = channelId
    ? resolveSlackChannelConfig({
        channelId,
        channelName,
        channels: params.ctx.channelsConfig,
        channelKeys: params.ctx.channelsConfigKeys,
        defaultRequireMention: params.ctx.defaultRequireMention,
        allowNameMatching: params.ctx.allowNameMatching,
      })
    : null;
  const channelUsersAllowlistConfigured =
    Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
  const decision = await decideSlackSystemIngress({
    ctx: params.ctx,
    senderId,
    senderName,
    channelType: ingressChannelType,
    channelId,
    ownerAllowFromLower: allowFromLower,
    channelUsers: channelConfig?.users,
    interactiveEvent: params.interactiveEvent === true,
  });
  if (decision.decision === "allow") {
    return {
      allowed: true,
      channelType,
      channelName,
    };
  }
  if (channelType === "im" || !channelId) {
    return {
      allowed: false,
      reason: "sender-not-allowlisted",
      ...(channelId ? { channelType, channelName } : {}),
    };
  }
  return {
    allowed: false,
    reason:
      params.interactiveEvent && channelUsersAllowlistConfigured && allowFromLower.length > 0
        ? "sender-not-authorized"
        : channelUsersAllowlistConfigured
          ? "sender-not-channel-allowed"
          : "sender-not-allowlisted",
    channelType,
    channelName,
  };
}
