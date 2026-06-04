// Matches approval requests against channel account and session bindings.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { resolveMaintenanceConfigFromInput } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;

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
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath, {
    maintenanceConfig: resolveMaintenanceConfigFromInput(params.cfg.session?.maintenance),
  });
  const entry = store[sessionKey];
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
  const channel = normalizeOptionalChannel(entry.origin?.provider ?? entry.lastChannel);
  const accountId = normalizeOptionalAccountId(entry.origin?.accountId ?? entry.lastAccountId);
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
