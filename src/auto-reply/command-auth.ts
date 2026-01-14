import type { ChannelDock } from "../channels/dock.js";
import { getChannelDock, listChannelDocks } from "../channels/dock.js";
import type { ChannelId } from "../channels/plugins/types.js";
import { normalizeChannelId } from "../channels/registry.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

function resolveProviderFromContext(
  ctx: MsgContext,
  cfg: ClawdbotConfig,
): ChannelId | undefined {
  const direct =
    normalizeChannelId(ctx.Provider) ??
    normalizeChannelId(ctx.Surface) ??
    normalizeChannelId(ctx.OriginatingChannel);
  if (direct) return direct;
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalized = normalizeChannelId(candidate);
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
  cfg: ClawdbotConfig;
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

export function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
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
    allowFromList.length === 0 ||
    allowFromList.some((entry) => entry.trim() === "*");

  const ownerCandidates = allowAll
    ? []
    : allowFromList.filter((entry) => entry !== "*");
  if (!allowAll && ownerCandidates.length === 0 && to) {
    const normalizedTo = formatAllowFromList({
      dock,
      cfg,
      accountId: ctx.AccountId,
      allowFrom: [to],
    })[0];
    if (normalizedTo) ownerCandidates.push(normalizedTo);
  }
  const ownerList = ownerCandidates;

  const senderIdCandidate = ctx.SenderId?.trim() ?? "";
  const senderE164Candidate = ctx.SenderE164?.trim() ?? "";
  const senderRaw = senderIdCandidate || senderE164Candidate || from;
  const senderId = senderRaw
    ? formatAllowFromList({
        dock,
        cfg,
        accountId: ctx.AccountId,
        allowFrom: [senderRaw],
      })[0]
    : undefined;

  const enforceOwner = Boolean(dock?.commands?.enforceOwnerForCommands);
  const isOwner =
    !enforceOwner ||
    allowAll ||
    ownerList.length === 0 ||
    (senderId ? ownerList.includes(senderId) : false);
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
