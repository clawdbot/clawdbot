import {
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ComponentData,
  type MentionableSelectMenuInteraction,
  type ModalInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "@buape/carbon";
import { ChannelType } from "discord-api-types/v10";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { logError } from "openclaw/plugin-sdk/text-runtime";
import {
  parseDiscordComponentCustomId,
  parseDiscordModalCustomId,
} from "../component-custom-id.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import {
  readStoreAllowFromForDmPolicy,
  resolvePinnedMainDmOwnerFromAllowlist,
  upsertChannelPairingRequest,
} from "./agent-components-helpers.runtime.js";
import {
  type DiscordGuildEntryResolved,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";
import { formatDiscordUserTag } from "./format.js";

export const AGENT_BUTTON_KEY = "agent";
export const AGENT_SELECT_KEY = "agentsel";

export type DiscordUser = Parameters<typeof formatDiscordUserTag>[0];

export type AgentComponentMessageInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | UserSelectMenuInteraction
  | MentionableSelectMenuInteraction
  | ChannelSelectMenuInteraction;

export type AgentComponentInteraction = AgentComponentMessageInteraction | ModalInteraction;

export type DiscordChannelContext = {
  channelName: string | undefined;
  channelSlug: string;
  channelType: number | undefined;
  isThread: boolean;
  parentId: string | undefined;
  parentName: string | undefined;
  parentSlug: string;
};

export type AgentComponentContext = {
  cfg: OpenClawConfig;
  accountId: string;
  discordConfig?: DiscordAccountConfig;
  runtime?: import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;
  token?: string;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  allowFrom?: string[];
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
};

export type ComponentInteractionContext = NonNullable<
  Awaited<ReturnType<typeof resolveComponentInteractionContext>>
>;

function formatUsername(user: { username: string; discriminator?: string | null }): string {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

function isThreadChannelType(channelType: number | undefined): boolean {
  return (
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread
  );
}

function readParsedComponentId(data: ComponentData): unknown {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return "cid" in data
    ? (data as Record<string, unknown>).cid
    : (data as Record<string, unknown>).componentId;
}

function normalizeComponentId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function mapOptionLabels(
  options: Array<{ value: string; label: string }> | undefined,
  values: string[],
) {
  if (!options || options.length === 0) {
    return values;
  }
  const map = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => map.get(value) ?? value);
}

/**
 * The component custom id only carries the logical button id. Channel binding
 * comes from Discord's trusted interaction payload.
 */
export function buildAgentButtonCustomId(componentId: string): string {
  return `${AGENT_BUTTON_KEY}:componentId=${encodeURIComponent(componentId)}`;
}

export function buildAgentSelectCustomId(componentId: string): string {
  return `${AGENT_SELECT_KEY}:componentId=${encodeURIComponent(componentId)}`;
}

export function resolveAgentComponentRoute(params: {
  ctx: AgentComponentContext;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  userId: string;
  channelId: string;
  parentId: string | undefined;
}) {
  return resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "discord",
    accountId: params.ctx.accountId,
    guildId: params.rawGuildId,
    memberRoleIds: params.memberRoleIds,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
      id: params.isDirectMessage ? params.userId : params.channelId,
    },
    parentPeer: params.parentId ? { kind: "channel", id: params.parentId } : undefined,
  });
}

export async function ackComponentInteraction(params: {
  interaction: AgentComponentInteraction;
  replyOpts: { ephemeral?: boolean };
  label: string;
}) {
  try {
    await params.interaction.reply({
      content: "✓",
      ...params.replyOpts,
    });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }
}

export function resolveDiscordChannelContext(
  interaction: AgentComponentInteraction,
): DiscordChannelContext {
  const channel = interaction.channel;
  const channelInfo = resolveDiscordChannelInfoSafe(channel);
  const channelName = channelInfo.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const channelType = channelInfo.type;
  const isThread = isThreadChannelType(channelType);

  let parentId: string | undefined;
  let parentName: string | undefined;
  let parentSlug = "";
  if (isThread) {
    parentId = channelInfo.parentId;
    parentName = channelInfo.parentName;
    if (parentName) {
      parentSlug = normalizeDiscordSlug(parentName);
    }
  }

  return { channelName, channelSlug, channelType, isThread, parentId, parentName, parentSlug };
}

export async function resolveComponentInteractionContext(params: {
  interaction: AgentComponentInteraction;
  label: string;
  defer?: boolean;
}) {
  const { interaction, label } = params;
  const channelId = interaction.rawData.channel_id;
  if (!channelId) {
    logError(`${label}: missing channel_id in interaction`);
    return null;
  }

  const user = interaction.user;
  if (!user) {
    logError(`${label}: missing user in interaction`);
    return null;
  }

  const shouldDefer = params.defer !== false && "defer" in interaction;
  let didDefer = false;
  if (shouldDefer) {
    try {
      await (interaction as AgentComponentMessageInteraction).defer({ ephemeral: true });
      didDefer = true;
    } catch (err) {
      logError(`${label}: failed to defer interaction: ${String(err)}`);
    }
  }
  const replyOpts = didDefer ? {} : { ephemeral: true };

  const username = formatUsername(user);
  const userId = user.id;
  const rawGuildId = interaction.rawData.guild_id;
  const channelType = resolveDiscordChannelContext(interaction).channelType;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isDirectMessage =
    channelType === ChannelType.DM || (!rawGuildId && !isGroupDm && channelType == null);
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];

  return {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
  };
}

export async function ensureGuildComponentMemberAllowed(params: {
  interaction: AgentComponentInteraction;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  channelId: string;
  rawGuildId: string | undefined;
  channelCtx: DiscordChannelContext;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
}) {
  const {
    interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel,
    unauthorizedReply,
  } = params;

  if (!rawGuildId) {
    return true;
  }

  async function replyUnauthorized() {
    try {
      await interaction.reply({
        content: unauthorizedReply,
        ...replyOpts,
      });
    } catch {}
  }

  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });

  if (channelConfig?.enabled === false) {
    await replyUnauthorized();
    return false;
  }
  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    await replyUnauthorized();
    return false;
  }
  if (channelConfig?.allowed === false) {
    await replyUnauthorized();
    return false;
  }

  const { memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender: {
      id: user.id,
      name: user.username,
      tag: user.discriminator ? `${user.username}#${user.discriminator}` : undefined,
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (memberAllowed) {
    return true;
  }

  logVerbose(`agent ${componentLabel}: blocked user ${user.id} (not in users/roles allowlist)`);
  await replyUnauthorized();
  return false;
}

export async function ensureComponentUserAllowed(params: {
  entry: DiscordComponentEntry;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
}) {
  const allowList = normalizeDiscordAllowList(params.entry.allowedUsers, [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return true;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (match.allowed) {
    return true;
  }

  logVerbose(
    `discord component ${params.componentLabel}: blocked user ${params.user.id} (not in allowedUsers)`,
  );
  try {
    await params.interaction.reply({
      content: params.unauthorizedReply,
      ...params.replyOpts,
    });
  } catch {}
  return false;
}

export async function ensureAgentComponentInteractionAllowed(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
}) {
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: params.rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId: params.channelId,
    rawGuildId: params.rawGuildId,
    channelCtx,
    memberRoleIds: params.memberRoleIds,
    user: params.user,
    replyOpts: params.replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply: params.unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    groupPolicy: resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: params.ctx.cfg.channels?.discord !== undefined,
      groupPolicy: params.ctx.discordConfig?.groupPolicy,
      defaultGroupPolicy: params.ctx.cfg.channels?.defaults?.groupPolicy,
    }).groupPolicy,
  });
  if (!memberAllowed) {
    return null;
  }
  return { parentId: channelCtx.parentId };
}

export function parseAgentComponentData(data: ComponentData): { componentId: string } | null {
  const raw = readParsedComponentId(data);
  const decodeSafe = (value: string): string => {
    if (!value.includes("%")) {
      return value;
    }
    if (!/%[0-9A-Fa-f]{2}/.test(value)) {
      return value;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const componentId =
    typeof raw === "string" ? decodeSafe(raw) : typeof raw === "number" ? String(raw) : null;
  if (!componentId) {
    return null;
  }
  return { componentId };
}

async function ensureDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  componentLabel: string;
  replyOpts: { ephemeral?: boolean };
}) {
  const { ctx, interaction, user, componentLabel, replyOpts } = params;
  const allowFromPrefixes = ["discord:", "user:", "pk:"];
  const resolveAllowMatch = (entries: string[]) => {
    const allowList = normalizeDiscordAllowList(entries, allowFromPrefixes);
    return allowList
      ? resolveDiscordAllowListMatch({
          allowList,
          candidate: {
            id: user.id,
            name: user.username,
            tag: formatDiscordUserTag(user),
          },
          allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig),
        })
      : { allowed: false };
  };
  const dmPolicy = ctx.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
    try {
      await interaction.reply({
        content: "DM interactions are disabled.",
        ...replyOpts,
      });
    } catch {}
    return false;
  }
  if (dmPolicy === "open") {
    return true;
  }

  if (dmPolicy === "allowlist") {
    const allowMatch = resolveAllowMatch(ctx.allowFrom ?? []);
    if (allowMatch.allowed) {
      return true;
    }
    logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
    try {
      await interaction.reply({
        content: `You are not authorized to use this ${componentLabel}.`,
        ...replyOpts,
      });
    } catch {}
    return false;
  }

  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "discord",
    accountId: ctx.accountId,
    dmPolicy,
  });
  const allowMatch = resolveAllowMatch([...(ctx.allowFrom ?? []), ...storeAllowFrom]);
  if (allowMatch.allowed) {
    return true;
  }

  if (dmPolicy === "pairing") {
    const pairingResult = await createChannelPairingChallengeIssuer({
      channel: "discord",
      upsertPairingRequest: async ({ id, meta }) => {
        return await upsertChannelPairingRequest({
          channel: "discord",
          id,
          accountId: ctx.accountId,
          meta,
        });
      },
    })({
      senderId: user.id,
      senderIdLine: `Your Discord user id: ${user.id}`,
      meta: {
        tag: formatDiscordUserTag(user),
        name: user.username,
      },
      sendPairingReply: async (text) => {
        await interaction.reply({
          content: text,
          ...replyOpts,
        });
      },
    });
    if (!pairingResult.created) {
      try {
        await interaction.reply({
          content: "Pairing already requested. Ask the bot owner to approve your code.",
          ...replyOpts,
        });
      } catch {}
    }
    return false;
  }

  logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
  try {
    await interaction.reply({
      content: `You are not authorized to use this ${componentLabel}.`,
      ...replyOpts,
    });
  } catch {}
  return false;
}

async function ensureGroupDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  componentLabel: string;
  replyOpts: { ephemeral?: boolean };
}) {
  const { ctx, interaction, channelId, componentLabel, replyOpts } = params;
  const groupDmEnabled = ctx.discordConfig?.dm?.groupEnabled ?? false;
  if (!groupDmEnabled) {
    logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (group DMs disabled)`);
    try {
      await interaction.reply({
        content: "Group DM interactions are disabled.",
        ...replyOpts,
      });
    } catch {}
    return false;
  }

  const channelCtx = resolveDiscordChannelContext(interaction);
  const allowed = resolveGroupDmAllow({
    channels: ctx.discordConfig?.dm?.groupChannels,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
  });
  if (allowed) {
    return true;
  }

  logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (not allowlisted)`);
  try {
    await interaction.reply({
      content: `You are not authorized to use this ${componentLabel}.`,
      ...replyOpts,
    });
  } catch {}
  return false;
}

export async function resolveInteractionContextWithDmAuth(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  label: string;
  componentLabel: string;
  defer?: boolean;
}) {
  const interactionCtx = await resolveComponentInteractionContext({
    interaction: params.interaction,
    label: params.label,
    defer: params.defer,
  });
  if (!interactionCtx) {
    return null;
  }
  if (interactionCtx.isDirectMessage) {
    const authorized = await ensureDmComponentAuthorized({
      ctx: params.ctx,
      interaction: params.interaction,
      user: interactionCtx.user,
      componentLabel: params.componentLabel,
      replyOpts: interactionCtx.replyOpts,
    });
    if (!authorized) {
      return null;
    }
  }
  if (interactionCtx.isGroupDm) {
    const authorized = await ensureGroupDmComponentAuthorized({
      ctx: params.ctx,
      interaction: params.interaction,
      channelId: interactionCtx.channelId,
      componentLabel: params.componentLabel,
      replyOpts: interactionCtx.replyOpts,
    });
    if (!authorized) {
      return null;
    }
  }
  return interactionCtx;
}

export function parseDiscordComponentData(
  data: ComponentData,
  customId?: string,
): { componentId: string; modalId?: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const rawComponentId = readParsedComponentId(data);
  const rawModalId =
    "mid" in data ? (data as { mid?: unknown }).mid : (data as { modalId?: unknown }).modalId;
  let componentId = normalizeComponentId(rawComponentId);
  let modalId = normalizeComponentId(rawModalId);
  if (!componentId && customId) {
    const parsed = parseDiscordComponentCustomId(customId);
    if (parsed) {
      componentId = parsed.componentId;
      modalId = parsed.modalId;
    }
  }
  if (!componentId) {
    return null;
  }
  return { componentId, modalId };
}

export function parseDiscordModalId(data: ComponentData, customId?: string): string | null {
  if (data && typeof data === "object") {
    const rawModalId =
      "mid" in data ? (data as { mid?: unknown }).mid : (data as { modalId?: unknown }).modalId;
    const modalId = normalizeComponentId(rawModalId);
    if (modalId) {
      return modalId;
    }
  }
  if (customId) {
    return parseDiscordModalCustomId(customId);
  }
  return null;
}

export function resolveInteractionCustomId(
  interaction: AgentComponentInteraction,
): string | undefined {
  if (!interaction?.rawData || typeof interaction.rawData !== "object") {
    return undefined;
  }
  if (!("data" in interaction.rawData)) {
    return undefined;
  }
  const data = (interaction.rawData as { data?: { custom_id?: unknown } }).data;
  const customId = data?.custom_id;
  if (typeof customId !== "string") {
    return undefined;
  }
  const trimmed = customId.trim();
  return trimmed ? trimmed : undefined;
}

export function mapSelectValues(entry: DiscordComponentEntry, values: string[]): string[] {
  if (entry.selectType === "string") {
    return mapOptionLabels(entry.options, values);
  }
  if (entry.selectType === "user") {
    return values.map((value) => `user:${value}`);
  }
  if (entry.selectType === "role") {
    return values.map((value) => `role:${value}`);
  }
  if (entry.selectType === "mentionable") {
    return values.map((value) => `mentionable:${value}`);
  }
  if (entry.selectType === "channel") {
    return values.map((value) => `channel:${value}`);
  }
  return values;
}

export function resolveModalFieldValues(
  field: DiscordModalEntry["fields"][number],
  interaction: ModalInteraction,
): string[] {
  const fields = interaction.fields;
  const optionLabels = field.options?.map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const required = field.required === true;
  try {
    switch (field.type) {
      case "text": {
        const value = required ? fields.getText(field.id, true) : fields.getText(field.id);
        return value ? [value] : [];
      }
      case "select":
      case "checkbox":
      case "radio": {
        const values = required
          ? fields.getStringSelect(field.id, true)
          : (fields.getStringSelect(field.id) ?? []);
        return mapOptionLabels(optionLabels, values);
      }
      case "role-select": {
        try {
          const roles = required
            ? fields.getRoleSelect(field.id, true)
            : (fields.getRoleSelect(field.id) ?? []);
          return roles.map((role) => role.name ?? role.id);
        } catch {
          const values = required
            ? fields.getStringSelect(field.id, true)
            : (fields.getStringSelect(field.id) ?? []);
          return values;
        }
      }
      case "user-select": {
        const users = required
          ? fields.getUserSelect(field.id, true)
          : (fields.getUserSelect(field.id) ?? []);
        return users.map((user) => formatDiscordUserTag(user));
      }
      default:
        return [];
    }
  } catch (err) {
    logError(`agent modal: failed to read field ${field.id}: ${String(err)}`);
    return [];
  }
}

export function formatModalSubmissionText(
  entry: DiscordModalEntry,
  interaction: ModalInteraction,
): string {
  const lines: string[] = [`Form "${entry.title}" submitted.`];
  for (const field of entry.fields) {
    const values = resolveModalFieldValues(field, interaction);
    if (values.length === 0) {
      continue;
    }
    lines.push(`- ${field.label}: ${values.join(", ")}`);
  }
  if (lines.length === 1) {
    lines.push("- (no values)");
  }
  return lines.join("\n");
}

export function resolveDiscordInteractionId(interaction: AgentComponentInteraction): string {
  const rawId =
    interaction.rawData && typeof interaction.rawData === "object" && "id" in interaction.rawData
      ? (interaction.rawData as { id?: unknown }).id
      : undefined;
  if (typeof rawId === "string" && rawId.trim()) {
    return rawId.trim();
  }
  if (typeof rawId === "number" && Number.isFinite(rawId)) {
    return String(rawId);
  }
  return `discord-interaction:${Date.now()}`;
}

export function resolveComponentCommandAuthorized(params: {
  ctx: AgentComponentContext;
  interactionCtx: ComponentInteractionContext;
  channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  allowNameMatching: boolean;
}) {
  const { ctx, interactionCtx, channelConfig, guildInfo } = params;
  if (interactionCtx.isDirectMessage) {
    return true;
  }

  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: ctx.allowFrom,
    sender: {
      id: interactionCtx.user.id,
      name: interactionCtx.user.username,
      tag: formatDiscordUserTag(interactionCtx.user),
    },
    allowNameMatching: params.allowNameMatching,
  });

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: interactionCtx.memberRoleIds,
    sender: {
      id: interactionCtx.user.id,
      name: interactionCtx.user.username,
      tag: formatDiscordUserTag(interactionCtx.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  const useAccessGroups = ctx.cfg.commands?.useAccessGroups !== false;
  const authorizers = useAccessGroups
    ? [
        { configured: ownerAllowList != null, allowed: ownerOk },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ]
    : [{ configured: hasAccessRestrictions, allowed: memberAllowed }];

  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers,
    modeWhenAccessGroupsOff: "configured",
  });
}

export { resolveDiscordGuildEntry, resolvePinnedMainDmOwnerFromAllowlist };
