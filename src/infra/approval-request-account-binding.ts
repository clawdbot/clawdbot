// Matches approval requests against channel account and session bindings.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.shared.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";
import {
  resolveApprovalRequestKind,
  type ApprovalRequestChannelRouteClass,
} from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";
import type { SystemAgentApprovalRequest } from "./system-agent-approvals.js";

export type ApprovalRequestLike = {
  id: string;
  request:
    | ExecApprovalRequest["request"]
    | PluginApprovalRequest["request"]
    | SystemAgentApprovalRequest["request"];
  createdAtMs: number;
  expiresAtMs: number;
};

function resolveApprovalForwardAccountIds(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
  defaultAccountId?: string | null;
}): string[] {
  const forwarding =
    resolveApprovalRequestKind(params.request) === "exec"
      ? params.cfg.approvals?.exec
      : params.cfg.approvals?.plugin;
  const channel = normalizeOptionalChannel(params.channel);
  if (!forwarding?.enabled || (forwarding.mode !== "targets" && forwarding.mode !== "both")) {
    return [];
  }
  if (
    !matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: forwarding.agentFilter,
      sessionFilter: forwarding.sessionFilter,
    })
  ) {
    return [];
  }
  const accountIds = (forwarding.targets ?? []).flatMap((target) => {
    if (normalizeOptionalChannel(target.channel) !== channel) {
      return [];
    }
    const accountId = normalizeOptionalAccountId(target.accountId ?? params.defaultAccountId);
    return accountId ? [accountId] : [];
  });
  return accountIds;
}

function hasApprovalForwardTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): boolean {
  const forwarding =
    resolveApprovalRequestKind(params.request) === "exec"
      ? params.cfg.approvals?.exec
      : params.cfg.approvals?.plugin;
  if (
    !forwarding?.enabled ||
    (forwarding.mode !== "targets" && forwarding.mode !== "both") ||
    !matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: forwarding.agentFilter,
      sessionFilter: forwarding.sessionFilter,
    })
  ) {
    return false;
  }
  const channel = normalizeOptionalChannel(params.channel);
  return (forwarding.targets ?? []).some(
    (target) => normalizeOptionalChannel(target.channel) === channel,
  );
}

/** Classifies whether native delivery has named channel-account owners. */
export function classifyApprovalRequestChannelRoute(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  defaultAccountId?: string | null;
}): ApprovalRequestChannelRouteClass {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (!expectedChannel) {
    return "unbound";
  }
  if (resolveApprovalRequestChannelAccountId(params)) {
    return "bound-or-explicit";
  }
  if (hasApprovalForwardTarget(params)) {
    return "bound-or-explicit";
  }
  return "unbound";
}

type ApprovalRequestSessionBinding = {
  channel?: string;
  accountId?: string;
};

type PersistedApprovalRequestSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

function normalizeOptionalChannel(value?: string | null): string | undefined {
  return normalizeMessageChannel(value);
}

/** Loads the persisted session entry referenced by an approval request, if still present. */
export function resolvePersistedApprovalRequestSessionEntry(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): PersistedApprovalRequestSessionEntry | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const entry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  if (!entry) {
    return null;
  }
  return { sessionKey, entry };
}

function resolvePersistedApprovalRequestSessionBinding(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ApprovalRequestSessionBinding | null {
  const persisted = resolvePersistedApprovalRequestSessionEntry(params);
  if (!persisted) {
    return null;
  }
  const { entry } = persisted;
  const origin = sessionDeliveryOrigin(entry);
  const context = deliveryContextFromSession(entry);
  const channel = normalizeOptionalChannel(context?.channel ?? origin?.provider);
  const accountId = normalizeOptionalAccountId(context?.accountId ?? origin?.accountId);
  return channel || accountId ? { channel, accountId } : null;
}

/** Resolves the account id an approval request belongs to for an optional channel filter. */
export function resolveApprovalRequestAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): string | null {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (expectedChannel && turnSourceChannel && turnSourceChannel !== expectedChannel) {
    return null;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  if (turnSourceAccountId) {
    return turnSourceAccountId;
  }

  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  const sessionChannel = sessionBinding?.channel;
  if (expectedChannel && sessionChannel && sessionChannel !== expectedChannel) {
    return null;
  }

  return sessionBinding?.accountId ?? null;
}

/** Resolves an approval request account only when the request can be routed to a channel. */
export function resolveApprovalRequestChannelAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
}): string | null {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (!expectedChannel) {
    return null;
  }
  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (!turnSourceChannel || turnSourceChannel === expectedChannel) {
    return resolveApprovalRequestAccountId(params);
  }

  // A conflicting turn-source channel is authoritative for live routing; only
  // fall back to the persisted session when that stored binding names this channel.
  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  return sessionBinding?.channel === expectedChannel ? (sessionBinding.accountId ?? null) : null;
}

/** Checks whether a channel/account pair is eligible to handle an approval request. */
export function doesApprovalRequestMatchChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
}): boolean {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (!expectedChannel) {
    return false;
  }

  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== expectedChannel) {
    return false;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  const expectedAccountId = normalizeOptionalAccountId(params.accountId);
  if (turnSourceAccountId) {
    return !expectedAccountId || expectedAccountId === turnSourceAccountId;
  }

  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  const sessionChannel = sessionBinding?.channel;
  if (sessionChannel && sessionChannel !== expectedChannel) {
    return false;
  }

  const boundAccountId = sessionBinding?.accountId;
  return !expectedAccountId || !boundAccountId || expectedAccountId === boundAccountId;
}

/** Selects the one channel account that owns a native approval request. */
export function doesApprovalRequestSelectChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
  defaultAccountId: string;
  eligibleAccountIds: readonly string[];
}): boolean {
  const accountId =
    normalizeOptionalAccountId(params.accountId) ??
    normalizeOptionalAccountId(params.defaultAccountId);
  if (!accountId) {
    return false;
  }
  const boundAccountId = resolveApprovalRequestChannelAccountId(params);
  if (accountId === normalizeOptionalAccountId(boundAccountId)) {
    return true;
  }
  const forwardAccountIds = resolveApprovalForwardAccountIds(params);
  if (forwardAccountIds.includes(accountId)) {
    return true;
  }
  if (boundAccountId || forwardAccountIds.length > 0) {
    return false;
  }
  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== normalizeOptionalChannel(params.channel)) {
    return false;
  }
  const eligibleAccountIds = params.eligibleAccountIds
    .map(normalizeOptionalAccountId)
    .filter((candidate): candidate is string => Boolean(candidate));
  return eligibleAccountIds.length === 1 && eligibleAccountIds[0] === accountId;
}
