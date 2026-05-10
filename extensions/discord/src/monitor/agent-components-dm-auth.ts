import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveComponentInteractionContext,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
import {
  readChannelIngressStoreAllowFromForDmPolicy,
  upsertChannelPairingRequest,
} from "./agent-components-helpers.runtime.js";
import { replySilently } from "./agent-components-reply.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  DiscordUser,
} from "./agent-components.types.js";
import { resolveGroupDmAllow } from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { formatDiscordUserTag } from "./format.js";

async function ensureDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  componentLabel: string;
  replyOpts: { ephemeral?: boolean };
}) {
  const { ctx, interaction, user, componentLabel, replyOpts } = params;
  const dmPolicy = ctx.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
    await replySilently(interaction, { content: "DM interactions are disabled.", ...replyOpts });
    return false;
  }
  const access = await resolveDiscordDmCommandAccess({
    accountId: ctx.accountId,
    dmPolicy,
    configuredAllowFrom: ctx.allowFrom ?? [],
    sender: {
      id: user.id,
      name: user.username,
      tag: formatDiscordUserTag(user),
    },
    allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig),
    cfg: ctx.cfg,
    token: ctx.token,
    readStoreAllowFrom: async ({ accountId, dmPolicy }) =>
      await readChannelIngressStoreAllowFromForDmPolicy({
        provider: "discord",
        accountId,
        dmPolicy,
      }),
    eventKind: "button",
  });
  if (access.senderAccess.decision === "allow") {
    return true;
  }
  if (access.senderAccess.decision !== "pairing") {
    logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
    await replySilently(interaction, {
      content: `You are not authorized to use this ${componentLabel}.`,
      ...replyOpts,
    });
    return false;
  }
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
