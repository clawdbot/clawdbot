import { ChannelType } from "discord-api-types/v10";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
// Discord plugin module implements runtime.messaging.shared behavior.
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { mergeDiscordAccountConfig, resolveDefaultDiscordAccountId } from "../accounts.js";
import { createDiscordRuntimeAccountContext } from "../client.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveGroupDmAllow,
  resolveDiscordChannelConfigWithFallback,
  type DiscordGuildEntryResolved,
} from "../monitor/allow-list.js";
import {
  type ActionGate,
  readStringParam,
  type DiscordActionConfig,
  type OpenClawConfig,
  withNormalizedTimestamp,
} from "../runtime-api.js";
import type { DiscordReactOpts } from "../send.types.js";
import { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type DiscordMessagingActionOptions = {
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  readContext?: {
    requesterAccountId?: string | null;
    currentChannelProvider?: string | null;
    currentChannelId?: string | null;
  };
};

export type DiscordMessagingActionContext = {
  action: string;
  params: Record<string, unknown>;
  isActionEnabled: ActionGate<DiscordActionConfig>;
  cfg: OpenClawConfig;
  options?: DiscordMessagingActionOptions;
  accountId?: string;
  resolveChannelId: () => string;
  assertReadTargetAllowed: (params: { guildId?: string; channelId: string }) => Promise<void>;
  assertGuildReadTargetAllowed: (params: {
    guildId: string;
    channelTargetRequiredMessage?: string;
    filteredResults?: boolean;
  }) => Promise<void>;
  filterGuildChannelList: <T>(params: { guildId: string; channels: T[] }) => Promise<T[]>;
  resolveReactionChannelId: () => Promise<string>;
  withOpts: (extra?: Record<string, unknown>) => { cfg: OpenClawConfig; accountId?: string };
  withReactionRuntimeOptions: <T extends Record<string, unknown> = Record<string, never>>(
    extra?: T,
  ) => DiscordReactOpts & T;
  normalizeMessage: (message: unknown) => unknown;
};

function hasDiscordGuildEntries(
  guilds: DiscordGuildEntryResolved["channels"] | undefined,
): guilds is NonNullable<DiscordGuildEntryResolved["channels"]> {
  return Boolean(guilds && Object.keys(guilds).length > 0);
}

function allowsAllDiscordGuildChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): boolean {
  const wildcard = channels?.["*"];
  if (!wildcard || wildcard.enabled === false) {
    return false;
  }
  return Object.values(channels ?? {}).every((entry) => entry?.enabled !== false);
}

function resolveDiscordActionGuildEntry(params: {
  guilds?: Record<string, DiscordGuildEntryResolved | undefined>;
  guildId?: string;
  guildName?: string;
  includeWildcard?: boolean;
}): DiscordGuildEntryResolved | null {
  const guildId = params.guildId?.trim();
  if (!params.guilds) {
    return null;
  }
  if (guildId && params.guilds[guildId]) {
    return { ...params.guilds[guildId], id: guildId };
  }
  if (guildId) {
    const byConfiguredId = Object.values(params.guilds).find((guild) => guild?.id === guildId);
    if (byConfiguredId) {
      return { ...byConfiguredId, id: guildId };
    }
  }
  const guildSlug = params.guildName ? normalizeDiscordSlug(params.guildName) : "";
  if (guildSlug) {
    const bySlug =
      params.guilds[guildSlug] ??
      Object.values(params.guilds).find((guild) => guild?.slug === guildSlug);
    if (bySlug) {
      return { ...bySlug, id: guildId, slug: guildSlug || bySlug.slug };
    }
  }
  if (params.includeWildcard === false) {
    return null;
  }
  const wildcard = params.guilds["*"];
  return wildcard ? { ...wildcard, id: guildId } : null;
}

type DiscordReadTargetContext = {
  channelId: string;
  metadataKnown: boolean;
  ancestryComplete: boolean;
  channelType?: number;
  guildId?: string;
  channelName?: string;
  channelSlug: string;
  ancestors: DiscordReadAncestor[];
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: "channel" | "thread";
};

type DiscordReadAncestor = {
  channelId: string;
  channelName?: string;
  channelSlug: string;
};

async function resolveDiscordReadAncestry(params: {
  channelId: string;
  parentId?: string;
  loadChannel: (channelId: string) => Promise<unknown>;
}): Promise<{ ancestors: DiscordReadAncestor[]; complete: boolean }> {
  const ancestors: DiscordReadAncestor[] = [];
  const visited = new Set([params.channelId]);
  let parentId = params.parentId;
  // Discord hierarchy is bounded at thread -> channel -> category. Preserve
  // that bound so malformed metadata cannot expand authorization-time I/O.
  for (let depth = 0; parentId && depth < 2; depth++) {
    if (visited.has(parentId)) {
      return { ancestors, complete: false };
    }
    visited.add(parentId);
    const parent = await params.loadChannel(parentId);
    if (!parent) {
      ancestors.push({
        channelId: parentId,
        channelSlug: normalizeDiscordSlug(parentId) || parentId,
      });
      return { ancestors, complete: false };
    }
    const parentName = readDiscordChannelStringField(parent, "name");
    ancestors.push({
      channelId: parentId,
      ...(parentName ? { channelName: parentName } : {}),
      channelSlug: parentName ? normalizeDiscordSlug(parentName) : parentId,
    });
    parentId = readDiscordChannelStringField(parent, "parent_id", "parentId");
  }
  return { ancestors, complete: !parentId };
}

function readDiscordChannelStringField(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function readDiscordChannelType(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const type = (value as Record<string, unknown>).type;
  return typeof type === "number" ? type : undefined;
}

function isDiscordThreadChannel(value: unknown): boolean {
  const type = readDiscordChannelType(value);
  return type === 10 || type === 11 || type === 12;
}

function isDiscordReadAncestryAllowed(params: {
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  for (const ancestor of params.target.ancestors) {
    const config = resolveDiscordChannelConfigWithFallback({
      guildInfo: params.guildInfo,
      channelId: ancestor.channelId,
      channelName: ancestor.channelName,
      channelSlug: ancestor.channelSlug,
    });
    if (config?.matchSource === "direct" && !config.allowed) {
      return false;
    }
  }
  return (
    params.target.ancestryComplete ||
    !hasExplicitlyDisabledDiscordChannels(params.guildInfo?.channels)
  );
}

function isDiscordReadTargetAllowedInGuild(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  if (!params.target.metadataKnown) {
    if (hasExplicitlyDisabledDiscordChannels(params.guildInfo?.channels)) {
      return false;
    }
    return isDiscordReadTargetExplicitlyAllowedById(params);
  }
  if (!isDiscordReadAncestryAllowed(params)) {
    return false;
  }
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo: params.guildInfo,
    channelId: params.target.channelId,
    channelName: params.target.channelName,
    channelSlug: params.target.channelSlug,
    parentId: params.target.parentId,
    parentName: params.target.parentName,
    parentSlug: params.target.parentSlug,
    scope: params.target.scope,
  });
  if (channelConfig?.allowed === false) {
    return false;
  }
  return isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(params.guildInfo),
    channelAllowlistConfigured: hasDiscordGuildEntries(params.guildInfo?.channels),
    channelAllowed: true,
  });
}

function isDiscordReadTargetExplicitlyAllowedById(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  const channelEntry = params.guildInfo?.channels?.[params.target.channelId];
  if (!channelEntry || channelEntry.enabled === false) {
    return false;
  }
  return isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(params.guildInfo),
    channelAllowlistConfigured: true,
    channelAllowed: true,
  });
}

function hasExplicitlyDisabledDiscordChannelConfig(
  guilds: Record<string, DiscordGuildEntryResolved | undefined> | undefined,
): boolean {
  return Object.values(guilds ?? {}).some((guild) =>
    hasExplicitlyDisabledDiscordChannels(guild?.channels),
  );
}

function hasExplicitlyDisabledDiscordChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): boolean {
  return Object.values(channels ?? {}).some((channel) => channel.enabled === false);
}

export function createDiscordMessagingActionContext(params: {
  action: string;
  input: Record<string, unknown>;
  isActionEnabled: ActionGate<DiscordActionConfig>;
  cfg: OpenClawConfig;
  options?: DiscordMessagingActionOptions;
}): DiscordMessagingActionContext {
  const accountId = readStringParam(params.input, "accountId");
  const cfgOptions = { cfg: params.cfg };
  const accountConfig = mergeDiscordAccountConfig(
    params.cfg,
    accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const guilds = accountConfig.guilds as Record<string, DiscordGuildEntryResolved | undefined>;
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: accountConfig.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const directOperator = params.options?.conversationReadOrigin === "direct-operator";
  const currentReadContext = params.options?.readContext;
  const directDmEnabled =
    accountConfig.dm?.enabled !== false && (accountConfig.dmPolicy ?? "pairing") !== "disabled";
  const withOpts = (extra?: Record<string, unknown>) =>
    createDiscordActionOptions({ cfg: params.cfg, accountId, extra });
  const resolvedReactionAccountId = accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const isCurrentReadTarget = (channelId: string): boolean => {
    const requesterAccountId = currentReadContext?.requesterAccountId?.trim();
    const currentChannelId = currentReadContext?.currentChannelId?.trim();
    if (
      currentReadContext?.currentChannelProvider?.trim().toLowerCase() !== "discord" ||
      !requesterAccountId ||
      !currentChannelId ||
      normalizeAccountId(requesterAccountId) !== normalizeAccountId(resolvedReactionAccountId)
    ) {
      return false;
    }
    try {
      return discordMessagingActionRuntime.resolveDiscordChannelId(currentChannelId) === channelId;
    } catch {
      return false;
    }
  };
  const reactionRuntimeOptions = resolvedReactionAccountId
    ? createDiscordRuntimeAccountContext({
        cfg: params.cfg,
        accountId: resolvedReactionAccountId,
      })
    : cfgOptions;
  const guildNameById = new Map<string, string | null>();
  const resolveGuildName = async (guildId: string): Promise<string | null> => {
    if (guildNameById.has(guildId)) {
      return guildNameById.get(guildId) ?? null;
    }
    try {
      const guildInfo = await discordMessagingActionRuntime.fetchGuildInfoDiscord(
        guildId,
        withOpts(),
      );
      const guildName = readDiscordChannelStringField(guildInfo, "name") ?? null;
      guildNameById.set(guildId, guildName);
      return guildName;
    } catch {
      guildNameById.set(guildId, null);
      return null;
    }
  };
  const resolveReadGuildEntry = async (
    guildId?: string,
  ): Promise<DiscordGuildEntryResolved | null> => {
    const direct = resolveDiscordActionGuildEntry({
      guilds,
      guildId,
      includeWildcard: false,
    });
    if (direct || !guildId) {
      return direct;
    }
    const guildName = await resolveGuildName(guildId);
    const named = resolveDiscordActionGuildEntry({
      guilds,
      guildId,
      guildName: guildName ?? undefined,
      includeWildcard: false,
    });
    if (named) {
      return named;
    }
    return resolveDiscordActionGuildEntry({ guilds, guildId });
  };
  const resolveReadTargetContext = async (channelId: string): Promise<DiscordReadTargetContext> => {
    const fallback: DiscordReadTargetContext = {
      channelId,
      channelSlug: normalizeDiscordSlug(channelId) || channelId,
      metadataKnown: false,
      ancestryComplete: false,
      ancestors: [],
    };
    let channelInfo: unknown;
    try {
      channelInfo = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
        channelId,
        withOpts(),
      );
    } catch {
      return fallback;
    }
    const channelName = readDiscordChannelStringField(channelInfo, "name");
    const target: DiscordReadTargetContext = {
      channelId,
      channelSlug: channelName ? normalizeDiscordSlug(channelName) : fallback.channelSlug,
      metadataKnown: true,
      ancestryComplete: true,
      ancestors: [],
    };
    const channelType = readDiscordChannelType(channelInfo);
    if (channelType !== undefined) {
      target.channelType = channelType;
    }
    const targetGuildId = readDiscordChannelStringField(channelInfo, "guild_id", "guildId");
    if (targetGuildId) {
      target.guildId = targetGuildId;
    }
    if (channelName) {
      target.channelName = channelName;
    }
    if (isDiscordThreadChannel(channelInfo)) {
      target.scope = "thread";
    }
    const ancestry = await resolveDiscordReadAncestry({
      channelId,
      parentId: readDiscordChannelStringField(channelInfo, "parent_id", "parentId"),
      loadChannel: async (parentId) => {
        try {
          return await discordMessagingActionRuntime.fetchChannelInfoDiscord(parentId, withOpts());
        } catch {
          return undefined;
        }
      },
    });
    target.ancestors = ancestry.ancestors;
    target.ancestryComplete = ancestry.complete;
    const immediateParent = target.ancestors[0];
    if (!immediateParent) {
      return target;
    }
    target.parentId = immediateParent.channelId;
    if (immediateParent.channelName) {
      target.parentName = immediateParent.channelName;
    }
    target.parentSlug = immediateParent.channelSlug;
    return target;
  };
  const isExpandedReadTargetEnabled = (
    guildInfo: DiscordGuildEntryResolved | null,
    target: DiscordReadTargetContext,
    currentConversation: boolean,
  ): boolean => {
    const groupDmEnabled =
      accountConfig.dm?.groupEnabled === true &&
      (currentConversation ||
        resolveGroupDmAllow({
          channels: accountConfig.dm?.groupChannels,
          channelId: target.channelId,
          channelName: target.channelName,
          channelSlug: target.channelSlug,
        }));
    if (!target.metadataKnown) {
      // Without provider metadata, the target might be a guild channel, DM, or
      // group DM. Every plausible scope must allow it before provider content reads.
      return (
        groupPolicy !== "disabled" &&
        directDmEnabled &&
        groupDmEnabled &&
        !hasExplicitlyDisabledDiscordChannelConfig(guilds)
      );
    }
    if (!target.guildId) {
      if (target.channelType === ChannelType.GroupDM) {
        return groupDmEnabled;
      }
      if (target.channelType === ChannelType.DM) {
        return directDmEnabled;
      }
      return directDmEnabled && groupDmEnabled;
    }
    if (groupPolicy === "disabled") {
      return false;
    }
    if (!isDiscordReadAncestryAllowed({ guildInfo, target })) {
      return false;
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: target.channelId,
      channelName: target.channelName,
      channelSlug: target.channelSlug,
      parentId: target.parentId,
      parentName: target.parentName,
      parentSlug: target.parentSlug,
      scope: target.scope,
    });
    return !channelConfig?.matchSource || channelConfig.allowed;
  };
  return {
    action: params.action,
    params: params.input,
    isActionEnabled: params.isActionEnabled,
    cfg: params.cfg,
    options: params.options,
    accountId,
    resolveChannelId: () =>
      discordMessagingActionRuntime.resolveDiscordChannelId(
        readStringParam(params.input, "channelId", {
          required: true,
        }),
      ),
    assertReadTargetAllowed: async ({ guildId, channelId }) => {
      const targetChannelId = discordMessagingActionRuntime.resolveDiscordChannelId(channelId);
      const target = await resolveReadTargetContext(targetChannelId);
      const currentConversation = isCurrentReadTarget(targetChannelId);
      if (guildId) {
        if (target.metadataKnown && target.guildId !== guildId) {
          throw new Error("Discord read target channel is not allowed.");
        }
        const guildInfo = await resolveReadGuildEntry(guildId);
        if (
          (directOperator && isExpandedReadTargetEnabled(guildInfo, target, false)) ||
          (currentConversation && isExpandedReadTargetEnabled(guildInfo, target, true))
        ) {
          return;
        }
        if (
          !isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo,
            target,
          })
        ) {
          throw new Error("Discord read target channel is not allowed.");
        }
        return;
      }
      if (target.guildId) {
        const guildInfo = await resolveReadGuildEntry(target.guildId);
        if (
          (directOperator && isExpandedReadTargetEnabled(guildInfo, target, false)) ||
          (currentConversation && isExpandedReadTargetEnabled(guildInfo, target, true))
        ) {
          return;
        }
        if (
          !isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo,
            target,
          })
        ) {
          throw new Error("Discord read target channel is not allowed.");
        }
        return;
      }
      // Known non-guild targets must never borrow a guild wildcard or channel
      // allowlist. Unknown metadata may use only the helper's fail-closed,
      // stable-ID path while every plausible non-guild scope remains enabled.
      const allowed =
        !target.metadataKnown &&
        Object.values(guilds ?? {}).some((guildInfo) =>
          isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo: guildInfo ?? null,
            target,
          }),
        );
      if (
        (directOperator && isExpandedReadTargetEnabled(null, target, false)) ||
        (currentConversation && isExpandedReadTargetEnabled(null, target, true))
      ) {
        return;
      }
      if (!allowed) {
        throw new Error("Discord read target channel is not allowed.");
      }
    },
    assertGuildReadTargetAllowed: async ({
      guildId,
      channelTargetRequiredMessage,
      filteredResults,
    }) => {
      const guildInfo = await resolveReadGuildEntry(guildId);
      if (
        directOperator &&
        groupPolicy !== "disabled" &&
        (filteredResults === true || !hasExplicitlyDisabledDiscordChannels(guildInfo?.channels))
      ) {
        return;
      }
      if (
        !isDiscordGroupAllowedByPolicy({
          groupPolicy,
          guildAllowlisted: Boolean(guildInfo),
          channelAllowlistConfigured: false,
          channelAllowed: true,
        })
      ) {
        throw new Error("Discord read target channel is not allowed.");
      }
      if (
        hasDiscordGuildEntries(guildInfo?.channels) &&
        !allowsAllDiscordGuildChannels(guildInfo.channels)
      ) {
        throw new Error(
          channelTargetRequiredMessage ??
            "Discord message search requires channelId or channelIds so each read target can be authorized.",
        );
      }
    },
    filterGuildChannelList: async ({ guildId, channels }) => {
      if (!directOperator) {
        return channels;
      }
      const guildInfo = await resolveReadGuildEntry(guildId);
      const channelById = new Map(
        channels.flatMap((channel) => {
          const channelId = readDiscordChannelStringField(channel, "id");
          return channelId ? [[channelId, channel] as const] : [];
        }),
      );
      const visibleChannels: typeof channels = [];
      for (const channel of channels) {
        const channelId = readDiscordChannelStringField(channel, "id");
        if (!channelId) {
          continue;
        }
        const channelName = readDiscordChannelStringField(channel, "name");
        const channelType = readDiscordChannelType(channel);
        const target: DiscordReadTargetContext = {
          channelId,
          channelSlug: channelName ? normalizeDiscordSlug(channelName) : channelId,
          guildId,
          metadataKnown: true,
          ancestryComplete: true,
          ancestors: [],
          ...(channelName ? { channelName } : {}),
          ...(channelType !== undefined ? { channelType } : {}),
          ...(isDiscordThreadChannel(channel) ? { scope: "thread" as const } : {}),
        };
        const ancestry = await resolveDiscordReadAncestry({
          channelId,
          parentId: readDiscordChannelStringField(channel, "parent_id", "parentId"),
          loadChannel: async (parentId) => channelById.get(parentId),
        });
        target.ancestors = ancestry.ancestors;
        target.ancestryComplete = ancestry.complete;
        const immediateParent = target.ancestors[0];
        if (immediateParent) {
          target.parentId = immediateParent.channelId;
          if (immediateParent.channelName) {
            target.parentName = immediateParent.channelName;
          }
          target.parentSlug = immediateParent.channelSlug;
        }
        if (!isDiscordReadAncestryAllowed({ guildInfo, target })) {
          continue;
        }
        const channelConfig = resolveDiscordChannelConfigWithFallback({
          guildInfo,
          channelId,
          channelName,
          channelSlug: target.channelSlug,
          parentId: target.parentId,
          parentName: target.parentName,
          parentSlug: target.parentSlug,
          scope: target.scope,
        });
        if (!channelConfig?.matchSource || channelConfig.allowed) {
          visibleChannels.push(channel);
        }
      }
      return visibleChannels;
    },
    resolveReactionChannelId: async () => {
      const target =
        readStringParam(params.input, "channelId") ??
        readStringParam(params.input, "to", { required: true });
      return await discordMessagingActionRuntime.resolveDiscordReactionTargetChannelId({
        target,
        cfg: params.cfg,
        accountId: resolvedReactionAccountId,
      });
    },
    withOpts,
    withReactionRuntimeOptions: (extra) =>
      ({
        ...(reactionRuntimeOptions ?? cfgOptions),
        ...extra,
      }) as DiscordReactOpts & NonNullable<typeof extra>,
    normalizeMessage: (message: unknown) => {
      if (!message || typeof message !== "object") {
        return message;
      }
      return withNormalizedTimestamp(
        message as Record<string, unknown>,
        (message as { timestamp?: unknown }).timestamp,
      );
    },
  };
}
