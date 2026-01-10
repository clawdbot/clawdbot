import type { ClawdbotConfig } from "../config/config.js";
import {
  getProviderPlugin,
  listProviderPlugins,
  normalizeProviderId,
  type ProviderId,
} from "../providers/plugins/index.js";
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
  const configured = listProviderPlugins()
    .map((plugin) => {
      if (!plugin.config.resolveAllowFrom) return null;
      const allowFrom = plugin.config.resolveAllowFrom({
        cfg,
        accountId: ctx.AccountId,
      });
      if (!Array.isArray(allowFrom) || allowFrom.length === 0) return null;
      return plugin.id;
    })
    .filter((value): value is ProviderId => Boolean(value));
  if (configured.length === 1) return configured[0];
  return undefined;
}

function formatAllowFromList(params: {
  plugin?: ReturnType<typeof getProviderPlugin>;
  cfg: ClawdbotConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  const { plugin, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) return [];
  if (plugin?.config.formatAllowFrom) {
    return plugin.config.formatAllowFrom({ cfg, accountId, allowFrom });
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
  const plugin = providerId ? getProviderPlugin(providerId) : undefined;
  const from = (ctx.From ?? "").trim();
  const to = (ctx.To ?? "").trim();
  const allowFromRaw = plugin?.config.resolveAllowFrom
    ? plugin.config.resolveAllowFrom({ cfg, accountId: ctx.AccountId })
    : [];
  const allowFromList = formatAllowFromList({
    plugin,
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
      plugin,
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
        plugin,
        cfg,
        accountId: ctx.AccountId,
        allowFrom: [senderRaw],
      })[0]
    : undefined;

  const enforceOwner = Boolean(plugin?.commands?.enforceOwnerForCommands);
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
