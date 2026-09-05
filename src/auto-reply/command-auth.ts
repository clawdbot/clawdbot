/** Command authorization helpers for owner and allowlist checks. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  getLoadedChannelPluginById,
  getLoadedChannelPluginForRead,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { shouldUseFromAsSenderFallback } from "./sender-identity.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

type CommandAuthorizationParams = {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
};

type CommandSenderAccess = "denied" | "reset-only" | "commands";

type ProviderResolution = {
  providerId: ChannelId;
  hadResolutionError: boolean;
};

type AllowFromParams = {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
};

type ProviderAllowFromResolution = {
  allowFrom: Array<string | number>;
  allowFromList: string[];
  hadResolutionError: boolean;
};

type AllowFromAccountConfig = {
  allowFrom?: Array<string | number>;
  dm?: { allowFrom?: Array<string | number> };
};

type AllowFromChannelConfig = AllowFromAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, AllowFromAccountConfig | undefined>;
};

type OwnerAuthorizationState = {
  commandOwnerCandidates: string[];
  explicitOwners: string[];
};

function resolveProviderFromContext(
  ctx: MsgContext,
  cfg: OpenClawConfig,
): { providerId: ChannelId | undefined; hadResolutionError: boolean } {
  const explicitMessageChannels = [ctx.Surface, ctx.OriginatingChannel, ctx.Provider]
    .map((value) => normalizeMessageChannel(value))
    .filter((value): value is string => Boolean(value));
  const explicitMessageChannel = explicitMessageChannels.find(
    (value) => value !== INTERNAL_MESSAGE_CHANNEL,
  );
  if (!explicitMessageChannel && explicitMessageChannels.includes(INTERNAL_MESSAGE_CHANNEL)) {
    return { providerId: undefined, hadResolutionError: false };
  }
  const direct =
    normalizeAnyChannelId(explicitMessageChannel ?? undefined) ??
    (explicitMessageChannel as ChannelId | undefined) ??
    normalizeAnyChannelId(ctx.Provider) ??
    normalizeAnyChannelId(ctx.Surface) ??
    normalizeAnyChannelId(ctx.OriginatingChannel);
  if (direct) {
    return { providerId: direct, hadResolutionError: false };
  }
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalizedCandidateChannel = normalizeMessageChannel(candidate);
    if (normalizedCandidateChannel === INTERNAL_MESSAGE_CHANNEL) {
      return { providerId: undefined, hadResolutionError: false };
    }
    const normalized =
      normalizeAnyChannelId(normalizedCandidateChannel ?? undefined) ??
      (normalizedCandidateChannel as ChannelId | undefined) ??
      normalizeAnyChannelId(candidate);
    if (normalized) {
      return { providerId: normalized, hadResolutionError: false };
    }
  }
  const inferredProviders = probeInferredProviders(ctx, cfg);
  const inferred = inferredProviders.candidates[0];
  if (inferredProviders.candidates.length === 1 && inferred) {
    return inferred;
  }
  return {
    providerId: undefined,
    hadResolutionError:
      inferredProviders.droppedResolutionError ||
      inferredProviders.candidates.some((entry) => entry.hadResolutionError),
  };
}

function probeInferredProviders(ctx: MsgContext, cfg: OpenClawConfig) {
  let droppedResolutionError = false;
  const candidates: ProviderResolution[] = [];
  for (const plugin of listLoadedChannelPlugins()) {
    const resolved = resolveProviderAllowFrom({
      plugin,
      cfg,
      accountId: ctx.AccountId,
    });
    if (resolved.allowFromList.length > 0) {
      candidates.push({ providerId: plugin.id, hadResolutionError: resolved.hadResolutionError });
    } else if (resolved.hadResolutionError) {
      droppedResolutionError = true;
    }
  }
  return { candidates, droppedResolutionError };
}

function formatAllowFromList(
  params: AllowFromParams & { allowFrom: Array<string | number> },
): string[] {
  const { plugin, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) {
    return [];
  }
  if (plugin?.config?.formatAllowFrom) {
    return plugin.config.formatAllowFrom({ cfg, accountId, allowFrom });
  }
  return normalizeStringEntries(allowFrom);
}

function normalizeAllowFromEntry(params: AllowFromParams & { value: string }): string[] {
  return formatAllowFromList({ ...params, allowFrom: [params.value] }).filter((entry) =>
    Boolean(entry.trim()),
  );
}

function isWildcardAllowFromEntry(entry: string): boolean {
  return entry.trim() === "*";
}

function hasWildcardAllowFrom(list: string[]): boolean {
  return list.some((entry) => isWildcardAllowFromEntry(entry));
}

function stripWildcardAllowFrom(list: string[]): string[] {
  return list.filter((entry) => !isWildcardAllowFromEntry(entry));
}

function resolveProviderAllowFrom(
  params: AllowFromParams & {
    providerId?: ChannelId;
    forceFallbackResolutionError?: boolean;
  },
): ProviderAllowFromResolution {
  const { plugin, cfg, accountId } = params;
  // An unloaded channel has no trusted allowlist owner unless failed provider inference forces it.
  const providerId = params.forceFallbackResolutionError
    ? (params.providerId ?? plugin?.id)
    : plugin?.id;
  const resolveFallback = () => resolveFallbackAllowFrom({ cfg, providerId, accountId });
  let hadResolutionError = Boolean(params.forceFallbackResolutionError);
  let allowFrom: Array<string | number>;

  if (hadResolutionError || !plugin?.config?.resolveAllowFrom) {
    allowFrom = resolveFallback();
  } else {
    try {
      const resolved = plugin.config.resolveAllowFrom({ cfg, accountId });
      if (resolved == null || Array.isArray(resolved)) {
        allowFrom = resolved ?? [];
      } else {
        console.warn(
          `[command-auth] resolveAllowFrom returned an invalid allowFrom for provider "${providerId}", falling back to config allowFrom: invalid_result`,
        );
        hadResolutionError = true;
        allowFrom = resolveFallback();
      }
    } catch (err) {
      console.warn(
        `[command-auth] resolveAllowFrom threw for provider "${providerId}", falling back to config allowFrom: ${describeAllowFromResolutionError(err)}`,
      );
      hadResolutionError = true;
      allowFrom = resolveFallback();
    }
  }
  return {
    allowFrom,
    allowFromList: formatAllowFromList({ plugin, cfg, accountId, allowFrom }),
    hadResolutionError,
  };
}

function describeAllowFromResolutionError(err: unknown): string {
  if (err instanceof Error) {
    const name = normalizeOptionalString(err.name) ?? "";
    return name || "Error";
  }
  return "unknown_error";
}

function resolveOwnerAllowFromList(
  params: AllowFromParams & { providerId?: ChannelId; allowFrom?: Array<string | number> },
): string[] {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const filtered: string[] = [];
  for (const entry of raw) {
    const trimmed = normalizeOptionalString(String(entry ?? "")) ?? "";
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex > 0) {
      const prefix = trimmed.slice(0, separatorIndex);
      const channel = normalizeAnyChannelId(prefix);
      if (channel) {
        // Channel-prefixed entries require a known matching provider; webchat leaves it unset.
        if (!params.providerId || channel !== params.providerId) {
          continue;
        }
        const remainder = trimmed.slice(separatorIndex + 1).trim();
        if (remainder) {
          filtered.push(remainder);
        }
        continue;
      }
    }
    filtered.push(trimmed);
  }
  return formatAllowFromList({ ...params, allowFrom: filtered });
}

/**
 * Resolves the commands.allowFrom list for a given provider.
 * Returns the provider-specific list if defined, otherwise the "*" global list.
 * Returns null if commands.allowFrom is not configured at all (fall back to channel allowFrom).
 */
function resolveCommandsAllowFromList(
  params: AllowFromParams & { providerId?: ChannelId },
): string[] | null {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return null; // Not configured, fall back to channel allowFrom
  }

  // Check provider-specific list first, then fall back to global "*"
  const providerKey = params.providerId ?? "";
  const providerList = commandsAllowFrom[providerKey];
  const globalList = commandsAllowFrom["*"];

  const rawList = Array.isArray(providerList) ? providerList : globalList;
  if (!Array.isArray(rawList)) {
    return null; // No applicable list found
  }

  return formatAllowFromList({ ...params, allowFrom: rawList });
}

function resolveOwnerCandidatesForCommands(
  params: AllowFromParams & { to?: string; allowAll: boolean; allowFromList: string[] },
): string[] {
  if (params.allowAll) {
    return [];
  }
  const ownerCandidatesForCommands = stripWildcardAllowFrom(params.allowFromList);
  if (ownerCandidatesForCommands.length > 0 || !params.to) {
    return ownerCandidatesForCommands;
  }
  return normalizeAllowFromEntry({ ...params, value: params.to });
}

function resolveOwnerAuthorizationState(
  params: AllowFromParams & {
    providerId?: ChannelId;
    to?: string;
    allowFromList: string[];
    hadResolutionError: boolean;
    configOwnerAllowFrom?: Array<string | number>;
    contextOwnerAllowFrom?: Array<string | number>;
  },
): OwnerAuthorizationState {
  const configOwnerAllowFromList = resolveOwnerAllowFromList({
    ...params,
    allowFrom: params.configOwnerAllowFrom,
  });
  const contextOwnerAllowFromList = resolveOwnerAllowFromList({
    ...params,
    allowFrom: params.contextOwnerAllowFrom,
  });
  const allowAll =
    !params.hadResolutionError &&
    (params.allowFromList.length === 0 || hasWildcardAllowFrom(params.allowFromList));
  const channelCommandOwners = resolveOwnerCandidatesForCommands({ ...params, allowAll });
  const explicitOwners = Array.from(new Set(stripWildcardAllowFrom(configOwnerAllowFromList)));
  const contextCommandOwners = stripWildcardAllowFrom(contextOwnerAllowFromList);
  // Channel and context lists can authorize commands within one transport, but only the global
  // owner list grants owner-only command and action authority.
  const commandOwnerCandidates = Array.from(
    new Set(
      explicitOwners.length > 0
        ? explicitOwners
        : contextCommandOwners.length > 0
          ? contextCommandOwners
          : channelCommandOwners,
    ),
  );
  return {
    commandOwnerCandidates,
    explicitOwners,
  };
}

function resolveCommandSenderAuthorization(params: {
  commandAuthorized: boolean;
  enforceOwnerForCommands: boolean;
  isOwnerForCommands: boolean;
  senderCandidates: string[];
  commandsAllowFromList: string[] | null;
  providerResolutionError: boolean;
  commandsAllowFromConfigured: boolean;
}): CommandSenderAccess {
  if (params.enforceOwnerForCommands && !params.isOwnerForCommands) {
    return "denied";
  }
  if (
    params.commandsAllowFromList !== null ||
    (params.providerResolutionError && params.commandsAllowFromConfigured)
  ) {
    const commandsAllowFromList = params.commandsAllowFromList;
    const commandsAllowAll =
      !params.providerResolutionError &&
      Boolean(commandsAllowFromList && hasWildcardAllowFrom(commandsAllowFromList));
    const matchedCommandsAllowFrom = commandsAllowFromList?.length
      ? params.senderCandidates.find((candidate) => commandsAllowFromList.includes(candidate))
      : undefined;
    return !params.providerResolutionError &&
      (commandsAllowAll || Boolean(matchedCommandsAllowFrom))
      ? "commands"
      : "denied";
  }
  if (!params.commandAuthorized) {
    return "denied";
  }
  // Global ownership does not revoke channel-admitted session resets; explicit
  // channel owner enforcement and commands.allowFrom have already been applied.
  return params.isOwnerForCommands ? "commands" : "reset-only";
}

function resolveSenderCandidates(
  params: AllowFromParams & {
    senderId?: string | null;
    senderE164?: string | null;
    from?: string | null;
    chatType?: string | null;
  },
): string[] {
  const { plugin, cfg, accountId } = params;
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (!trimmed) {
      return;
    }
    candidates.push(trimmed);
  };
  if (plugin?.commands?.preferSenderE164ForCommands) {
    pushCandidate(params.senderE164);
    pushCandidate(params.senderId);
  } else {
    pushCandidate(params.senderId);
    pushCandidate(params.senderE164);
  }
  if (
    candidates.length === 0 &&
    shouldUseFromAsSenderFallback({ from: params.from, chatType: params.chatType })
  ) {
    pushCandidate(params.from);
  }

  const normalized: string[] = [];
  for (const sender of candidates) {
    const entries = normalizeAllowFromEntry({ plugin, cfg, accountId, value: sender });
    for (const entry of entries) {
      if (!normalized.includes(entry)) {
        normalized.push(entry);
      }
    }
  }
  return normalized;
}

function resolveFallbackAllowFrom(params: {
  cfg: OpenClawConfig;
  providerId?: ChannelId;
  accountId?: string | null;
}): Array<string | number> {
  const providerId = normalizeOptionalString(params.providerId);
  if (!providerId) {
    return [];
  }
  const channels = params.cfg.channels as
    | Record<string, AllowFromChannelConfig | undefined>
    | undefined;
  const channelCfg = channels?.[providerId];
  const accountCfg =
    resolveFallbackAccountConfig(channelCfg?.accounts, params.accountId) ??
    resolveFallbackDefaultAccountConfig(channelCfg);
  const allowFrom =
    accountCfg?.allowFrom ??
    accountCfg?.dm?.allowFrom ??
    channelCfg?.allowFrom ??
    channelCfg?.dm?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : [];
}

function resolveFallbackAccountConfig(
  accounts: AllowFromChannelConfig["accounts"],
  accountId?: string | null,
) {
  const normalizedAccountId = normalizeOptionalLowercaseString(accountId);
  if (!accounts || !normalizedAccountId) {
    return undefined;
  }
  // Preserve existing inherited-key precedence before the canonical own-key/case-insensitive lookup.
  return accounts[normalizedAccountId] ?? resolveAccountEntry(accounts, normalizedAccountId);
}

function resolveFallbackDefaultAccountConfig(channelCfg: AllowFromChannelConfig | undefined) {
  const accounts = channelCfg?.accounts;
  if (!accounts) {
    return undefined;
  }
  const preferred =
    resolveFallbackAccountConfig(accounts, channelCfg?.defaultAccount) ??
    resolveFallbackAccountConfig(accounts, "default");
  if (preferred) {
    return preferred;
  }
  const definedAccounts = Object.values(accounts).filter(Boolean);
  return definedAccounts.length === 1 ? definedAccounts[0] : undefined;
}

function resolveCommandAuthorizationState(params: CommandAuthorizationParams): {
  authorization: CommandAuthorization;
  access: CommandSenderAccess;
} {
  const { ctx, cfg, commandAuthorized } = params;
  const { providerId, hadResolutionError: providerResolutionError } = resolveProviderFromContext(
    ctx,
    cfg,
  );
  const plugin = providerId ? getLoadedChannelPluginById(providerId) : undefined;
  const from = normalizeOptionalString(ctx.From) ?? "";
  const to = normalizeOptionalString(ctx.To) ?? "";
  const commandsAllowFromConfigured = Boolean(
    cfg.commands?.allowFrom && typeof cfg.commands.allowFrom === "object",
  );

  // Check if commands.allowFrom is configured (separate command authorization)
  const commandsAllowFromList = resolveCommandsAllowFromList({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
  });

  const resolvedAllowFrom = resolveProviderAllowFrom({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
    forceFallbackResolutionError: providerResolutionError,
  });
  const ownerState = resolveOwnerAuthorizationState({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
    to,
    allowFromList: resolvedAllowFrom.allowFromList,
    hadResolutionError: resolvedAllowFrom.hadResolutionError,
    configOwnerAllowFrom: cfg.commands?.ownerAllowFrom,
    contextOwnerAllowFrom: ctx.OwnerAllowFrom,
  });

  const senderCandidates = resolveSenderCandidates({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    from,
    chatType: ctx.ChatType,
  });
  const matchedSender = ownerState.explicitOwners.length
    ? senderCandidates.find((candidate) => ownerState.explicitOwners.includes(candidate))
    : undefined;
  const matchedCommandOwner = ownerState.commandOwnerCandidates.length
    ? senderCandidates.find((candidate) => ownerState.commandOwnerCandidates.includes(candidate))
    : undefined;
  const senderId = matchedSender ?? matchedCommandOwner ?? senderCandidates[0];

  const enforceOwner = Boolean(plugin?.commands?.enforceOwnerForCommands);
  const senderIsOwnerByIdentity = Boolean(matchedSender);
  const senderIsOwnerByScope =
    isInternalMessageChannel(ctx.Provider) &&
    Array.isArray(ctx.GatewayClientScopes) &&
    ctx.GatewayClientScopes.includes("operator.admin");
  const ownerAllowlistConfigured = ownerState.explicitOwners.length > 0;
  const senderIsOwner = senderIsOwnerByIdentity || senderIsOwnerByScope;
  const requireOwner = enforceOwner || ownerAllowlistConfigured;
  const isOwnerForCommands = !requireOwner
    ? true
    : ownerAllowlistConfigured
      ? senderIsOwner
      : senderIsOwnerByScope || Boolean(matchedCommandOwner);
  // Literal turns cannot regain command access through an allowlist; inline
  // command consumers must preserve their text while owner facts remain intact.
  const access =
    ctx.CommandInterpretationSuppressed === true
      ? "denied"
      : resolveCommandSenderAuthorization({
          commandAuthorized,
          enforceOwnerForCommands: enforceOwner,
          isOwnerForCommands,
          senderCandidates,
          commandsAllowFromList,
          providerResolutionError,
          commandsAllowFromConfigured,
        });

  return {
    authorization: {
      providerId,
      ownerList: ownerState.explicitOwners,
      senderId: senderId || undefined,
      senderIsOwner,
      isAuthorizedSender: access === "commands",
      from: from || undefined,
      to: to || undefined,
    },
    access,
  };
}

export function resolveCommandAuthorization(
  params: CommandAuthorizationParams,
): CommandAuthorization {
  return resolveCommandAuthorizationState(params).authorization;
}

/** Recheck admitted sender identity against the current global owner list. */
export function isConfiguredCommandOwner(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
): boolean {
  const providerId = normalizeAnyChannelId(requester.channel) ?? requester.channel;
  const plugin = providerId ? getLoadedChannelPluginForRead(providerId) : undefined;
  const params = { cfg, plugin, providerId, accountId: requester.accountId };
  const owners = stripWildcardAllowFrom(resolveOwnerAllowFromList(params));
  return resolveSenderCandidates({ ...params, senderId: requester.senderId }).some((sender) =>
    owners.includes(sender),
  );
}

/** Resolves reset admission without granting other command or owner authority. */
export function isResetAuthorizedForContext(params: CommandAuthorizationParams): boolean {
  if (resolveCommandAuthorizationState(params).access === "denied") {
    return false;
  }
  const provider = params.ctx.Provider;
  const internalGatewayCaller = provider
    ? isInternalMessageChannel(provider)
    : isInternalMessageChannel(params.ctx.Surface);
  if (!internalGatewayCaller) {
    return true;
  }
  const scopes = params.ctx.GatewayClientScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return true;
  }
  return scopes.includes("operator.admin");
}
