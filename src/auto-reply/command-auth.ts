import type { ChannelDock } from "../channels/dock.js";
import { getChannelDock, listChannelDocks } from "../channels/dock.js";
import type { ChannelId } from "../channels/plugins/types.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { MoltbotConfig } from "../config/config.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

function resolveProviderFromContext(ctx: MsgContext, cfg: MoltbotConfig): ChannelId | undefined {
  const direct =
    normalizeAnyChannelId(ctx.Provider) ??
    normalizeAnyChannelId(ctx.Surface) ??
    normalizeAnyChannelId(ctx.OriginatingChannel);
  if (direct) return direct;
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalized = normalizeAnyChannelId(candidate);
    if (normalized) return normalized;
  }
  const configured = listChannelDocks()
    .map((dock) => {
      if (!dock.config?.resolveAllowFrom) return null;
      const allowFrom = dock.config.resolveAllowFrom({
        cfg,
        accountId: ctx.AccountId,
      });
      if (!Array.isArray(allowFrom) || allowFrom.length === 0) return null;
      return dock.id;
    })
    .filter((value): value is ChannelId => Boolean(value));
  if (configured.length === 1) return configured[0];
  return undefined;
}

function formatAllowFromList(params: {
  dock?: ChannelDock;
  cfg: MoltbotConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  const { dock, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) return [];
  if (dock?.config?.formatAllowFrom) {
    return dock.config.formatAllowFrom({ cfg, accountId, allowFrom });
  }
  return allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeAllowFromEntry(params: {
  dock?: ChannelDock;
  cfg: MoltbotConfig;
  accountId?: string | null;
  value: string;
}): string[] {
  const normalized = formatAllowFromList({
    dock: params.dock,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: [params.value],
  });
  return normalized.filter((entry) => entry.trim().length > 0);
}

function resolveSenderCandidates(params: {
  dock?: ChannelDock;
  providerId?: ChannelId;
  cfg: MoltbotConfig;
  accountId?: string | null;
  senderId?: string | null;
  senderE164?: string | null;
  from?: string | null;
}): string[] {
  const { dock, cfg, accountId } = params;
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return;
    candidates.push(trimmed);
  };
  if (params.providerId === "whatsapp") {
    pushCandidate(params.senderE164);
    pushCandidate(params.senderId);
  } else {
    pushCandidate(params.senderId);
    pushCandidate(params.senderE164);
  }
  pushCandidate(params.from);

  const normalized: string[] = [];
  for (const sender of candidates) {
    const entries = normalizeAllowFromEntry({ dock, cfg, accountId, value: sender });
    for (const entry of entries) {
      if (!normalized.includes(entry)) normalized.push(entry);
    }
  }
  return normalized;
}

export function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: MoltbotConfig;
  commandAuthorized: boolean;
}): CommandAuthorization {
  const { ctx, cfg, commandAuthorized } = params;
  const providerId = resolveProviderFromContext(ctx, cfg);
  const dock = providerId ? getChannelDock(providerId) : undefined;
  const from = (ctx.From ?? "").trim();
  const to = (ctx.To ?? "").trim();
  const allowFromRaw = dock?.config?.resolveAllowFrom
    ? dock.config.resolveAllowFrom({ cfg, accountId: ctx.AccountId })
    : [];
  const allowFromList = formatAllowFromList({
    dock,
    cfg,
    accountId: ctx.AccountId,
    allowFrom: Array.isArray(allowFromRaw) ? allowFromRaw : [],
  });
  const allowAll =
    allowFromList.length === 0 || allowFromList.some((entry) => entry.trim() === "*");

  const ownerCandidates = allowAll ? [] : allowFromList.filter((entry) => entry !== "*");
  if (!allowAll && ownerCandidates.length === 0 && to) {
    const normalizedTo = normalizeAllowFromEntry({
      dock,
      cfg,
      accountId: ctx.AccountId,
      value: to,
    });
    if (normalizedTo.length > 0) ownerCandidates.push(...normalizedTo);
  }
  const ownerList = Array.from(new Set(ownerCandidates));

  const senderCandidates = resolveSenderCandidates({
    dock,
    providerId,
    cfg,
    accountId: ctx.AccountId,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    from,
  });
  const matchedSender = ownerList.length
    ? senderCandidates.find((candidate) => ownerList.includes(candidate))
    : undefined;
  const senderId = matchedSender ?? senderCandidates[0];

  const enforceOwner = Boolean(dock?.commands?.enforceOwnerForCommands);
  const isOwner = !enforceOwner || allowAll || ownerList.length === 0 || Boolean(matchedSender);
  const isAuthorizedSender = commandAuthorized && isOwner;

  return {
    providerId,
    ownerList,
    senderId: senderId || undefined,
    isAuthorizedSender,
    from: from || undefined,
    to: to || undefined,
  };
}
