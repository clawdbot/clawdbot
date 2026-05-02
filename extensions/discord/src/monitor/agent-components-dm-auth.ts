import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordDmAccessGroupEntries } from "./access-groups.js";
import {
  resolveComponentInteractionContext,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
import {
  readStoreAllowFromForDmPolicy,
  upsertChannelPairingRequest,
} from "./agent-components-helpers.runtime.js";
import { replySilently } from "./agent-components-reply.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  DiscordUser,
} from "./agent-components.types.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordAllowListMatch,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

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
  const resolveAllowMatchWithAccessGroups = async (entries: string[]) => {
    const staticMatch = resolveAllowMatch(entries);
    if (staticMatch.allowed) {
      return staticMatch;
    }
    const matchedGroups = await resolveDiscordDmAccessGroupEntries({
      cfg: ctx.cfg,
      allowFrom: entries,
      sender: { id: user.id },
      accountId: ctx.accountId,
      token: ctx.token,
      isSenderAllowed: (senderId, allowFrom) =>
        resolveAllowMatch(allowFrom).allowed || allowFrom.includes(senderId),
    });
    return matchedGroups.length > 0
      ? resolveAllowMatch([...entries, `discord:${user.id}`])
      : staticMatch;
  };
  const dmPolicy = ctx.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
    await replySilently(interaction, { content: "DM interactions are disabled.", ...replyOpts });
    return false;
  }
  if (dmPolicy === "allowlist") {
    const allowMatch = await resolveAllowMatchWithAccessGroups(ctx.allowFrom ?? []);
    if (allowMatch.allowed) {
      return true;
    }
    logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
    await replySilently(interaction, {
      content: `You are not authorized to use this ${componentLabel}.`,
      ...replyOpts,
    });
    return false;
  }

  const storeAllowFrom =
    dmPolicy === "open"
      ? []
      : await readStoreAllowFromForDmPolicy({
          provider: "discord",
          accountId: ctx.accountId,
          dmPolicy,
        });
  const allowMatch = resolveAllowMatch([...(ctx.allowFrom ?? []), ...storeAllowFrom]);
  const dynamicAllowMatch = allowMatch.allowed
    ? allowMatch
    : await resolveAllowMatchWithAccessGroups([...(ctx.allowFrom ?? []), ...storeAllowFrom]);
  if (dynamicAllowMatch.allowed) {
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
      await replySilently(interaction, {
        content: "Pairing already requested. Ask the bot owner to approve your code.",
        ...replyOpts,
      });
    }
    return false;
  }

  logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
  await replySilently(interaction, {
    content: `You are not authorized to use this ${componentLabel}.`,
    ...replyOpts,
  });
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
    await replySilently(interaction, {
      content: "Group DM interactions are disabled.",
      ...replyOpts,
    });
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
  await replySilently(interaction, {
    content: `You are not authorized to use this ${componentLabel}.`,
    ...replyOpts,
  });
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
