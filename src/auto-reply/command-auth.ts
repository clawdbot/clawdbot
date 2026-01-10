import type { ClawdbotConfig } from "../config/config.js";
import type { ProviderDock } from "../providers/dock.js";
import { getProviderDock, listProviderDocks } from "../providers/dock.js";
import type { ProviderId } from "../providers/plugins/types.js";
import { normalizeProviderId } from "../providers/registry.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ProviderId;
  ownerList: string[];
  senderId?: string;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

function resolveProviderFromContext(
  ctx: MsgContext,
  cfg: ClawdbotConfig,
): ProviderId | undefined {
  const direct =
    normalizeProviderId(ctx.Provider) ??
    normalizeProviderId(ctx.Surface) ??
    normalizeProviderId(ctx.OriginatingChannel);
  if (direct) return direct;
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalized = normalizeProviderId(candidate);
    if (normalized) return normalized;
  }
  const configured = listProviderDocks()
    .map((dock) => {
      if (!dock.config?.resolveAllowFrom) return null;
      const allowFrom = dock.config.resolveAllowFrom({
        cfg,
        accountId: ctx.AccountId,
      });
      if (!Array.isArray(allowFrom) || allowFrom.length === 0) return null;
      return dock.id;
    })
    .filter((value): value is ProviderId => Boolean(value));
  if (configured.length === 1) return configured[0];
  return undefined;
}

function formatAllowFromList(params: {
  dock?: ProviderDock;
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
  const dock = providerId ? getProviderDock(providerId) : undefined;
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

  const senderRaw = ctx.SenderId ?? ctx.SenderE164 ?? from;
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
