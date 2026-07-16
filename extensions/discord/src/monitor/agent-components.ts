import {
  Button,
  ChannelSelectMenu,
  MentionableSelectMenu,
  Modal,
  RoleSelectMenu,
  StringSelectMenu,
  UserSelectMenu,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ComponentData,
  type MentionableSelectMenuInteraction,
  type ModalInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type TopLevelComponents,
  type UserSelectMenuInteraction,
} from "@buape/carbon";
import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle, ChannelType } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { createNonExitingRuntime, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { logDebug, logError } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { createDiscordRestClient } from "../client.js";
import {
  parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomIdForCarbon,
} from "../component-custom-id.js";
import { resolveDiscordComponentEntry, resolveDiscordModalEntry } from "../components-registry.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  dispatchDiscordPluginInteractiveHandler,
  type DiscordInteractiveHandlerContext,
} from "../interactive-dispatch.js";
import { editDiscordComponentMessage } from "../send.components.js";
import {
  AGENT_BUTTON_KEY,
  AGENT_SELECT_KEY,
  ackComponentInteraction,
  type AgentComponentContext,
  type AgentComponentInteraction,
  type AgentComponentMessageInteraction,
  ensureAgentComponentInteractionAllowed,
  ensureComponentUserAllowed,
  ensureGuildComponentMemberAllowed,
  formatModalSubmissionText,
  mapSelectValues,
  parseAgentComponentData,
  parseDiscordComponentData,
  parseDiscordModalId,
  resolveAgentComponentRoute,
  resolveComponentCommandAuthorized,
  resolveDiscordChannelContext,
  resolveDiscordInteractionId,
  resolveInteractionContextWithDmAuth,
  resolveInteractionCustomId,
  resolveModalFieldValues,
  resolvePinnedMainDmOwnerFromAllowlist,
  type ComponentInteractionContext,
  type DiscordChannelContext,
} from "./agent-components-helpers.js";
import {
  enqueueSystemEvent,
  readSessionUpdatedAt,
  resolveStorePath,
} from "./agent-components.deps.runtime.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";
import {
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
} from "./inbound-context.js";
import { buildDirectLabel, buildGuildLabel } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";

let conversationRuntimePromise: Promise<typeof import("./agent-components.runtime.js")> | undefined;
let componentsRuntimePromise: Promise<typeof import("../components.js")> | undefined;
let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;
let replyPipelineRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/channel-reply-pipeline")>
  | undefined;
let typingRuntimePromise: Promise<typeof import("./typing.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("./agent-components.runtime.js");
  return await conversationRuntimePromise;
}

async function loadComponentsRuntime() {
  componentsRuntimePromise ??= import("../components.js");
  return await componentsRuntimePromise;
}

async function _loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}
async function loadReplyPipelineRuntime() {
  replyPipelineRuntimePromise ??= import("openclaw/plugin-sdk/channel-reply-pipeline");
  return await replyPipelineRuntimePromise;
}

async function loadTypingRuntime() {
  typingRuntimePromise ??= import("./typing.js");
  return await typingRuntimePromise;
}

function resolveComponentGroupPolicy(
  ctx: AgentComponentContext,
): "open" | "disabled" | "allowlist" {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: ctx.cfg.channels?.discord !== undefined,
    groupPolicy: ctx.discordConfig?.groupPolicy,
    defaultGroupPolicy: ctx.cfg.channels?.defaults?.groupPolicy,
  }).groupPolicy;
}

function buildDiscordComponentConversationLabel(params: {
  interactionCtx: ComponentInteractionContext;
  interaction: AgentComponentInteraction;
  channelCtx: DiscordChannelContext;
}) {
  if (params.interactionCtx.isDirectMessage) {
    return buildDirectLabel(params.interactionCtx.user);
  }
  if (params.interactionCtx.isGroupDm) {
    return `Group DM #${params.channelCtx.channelName ?? params.interactionCtx.channelId} channel id:${params.interactionCtx.channelId}`;
  }
  return buildGuildLabel({
    guild: params.interaction.guild ?? undefined,
    channelName: params.channelCtx.channelName ?? params.interactionCtx.channelId,
    channelId: params.interactionCtx.channelId,
  });
}

function resolveDiscordComponentChatType(interactionCtx: ComponentInteractionContext) {
  if (interactionCtx.isDirectMessage) {
    return "direct";
  }
  if (interactionCtx.isGroupDm) {
    return "group";
  }
  return "channel";
}

export function resolveDiscordComponentOriginatingTo(
  interactionCtx: Pick<ComponentInteractionContext, "isDirectMessage" | "userId" | "channelId">,
) {
  return resolveDiscordConversationIdentity({
    isDirectMessage: interactionCtx.isDirectMessage,
    userId: interactionCtx.userId,
    channelId: interactionCtx.channelId,
  });
}

async function dispatchPluginDiscordInteractiveEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  isAuthorizedSender: boolean;
  data: string;
  kind: "button" | "select" | "modal";
  values?: string[];
  fields?: Array<{ id: string; name: string; values: string[] }>;
  messageId?: string;
}): Promise<"handled" | "unmatched"> {
  const normalizedConversationId =
    params.interactionCtx.rawGuildId || params.channelCtx.channelType === ChannelType.GroupDM
      ? `channel:${params.interactionCtx.channelId}`
      : `user:${params.interactionCtx.userId}`;
  let responded = false;
  let acknowledged = false;
  const updateOriginalMessage = async (input: {
    text?: string;
    components?: TopLevelComponents[];
  }) => {
    const payload = {
      ...(input.text !== undefined ? { content: input.text } : {}),
      ...(input.components !== undefined ? { components: input.components } : {}),
    };
    if (acknowledged) {
      // Carbon edits @original on reply() after acknowledge(), which preserves
      // plugin edit/clear flows without consuming a second interaction callback.
      await params.interaction.reply(payload);
      return;
    }
    if (!("update" in params.interaction) || typeof params.interaction.update !== "function") {
      throw new Error("Discord interaction cannot update the source message");
    }
    await params.interaction.update(payload);
  };
  const respond: DiscordInteractiveHandlerContext["respond"] = {
    acknowledge: async () => {
      if (responded) {
        return;
      }
      await params.interaction.acknowledge();
      acknowledged = true;
      responded = true;
    },
    reply: async ({ text, ephemeral = true }: { text: string; ephemeral?: boolean }) => {
      responded = true;
      await params.interaction.reply({
        content: text,
        ephemeral,
      });
    },
    followUp: async ({ text, ephemeral = true }: { text: string; ephemeral?: boolean }) => {
      responded = true;
      await params.interaction.followUp({
        content: text,
        ephemeral,
      });
    },
    editMessage: async (
      input: Parameters<DiscordInteractiveHandlerContext["respond"]["editMessage"]>[0],
    ) => {
      const { text, components } = input;
      responded = true;
      await updateOriginalMessage({
        text,
        components: components as TopLevelComponents[] | undefined,
      });
    },
    clearComponents: async (input?: { text?: string }) => {
      responded = true;
      await updateOriginalMessage({
        text: input?.text,
        components: [],
      });
    },
  };
  const conversationRuntime = await loadConversationRuntime();
  const pluginBindingApproval = conversationRuntime.parsePluginBindingApprovalCustomId(params.data);
  if (pluginBindingApproval) {
    const { buildPluginBindingResolvedText, resolvePluginConversationBindingApproval } =
      conversationRuntime;
    if (!pluginBindingApproval) {
      return "unmatched";
    }
    try {
      await respond.acknowledge();
    } catch {
      // Interaction may have expired; try to continue anyway.
    }
    const resolved = await resolvePluginConversationBindingApproval({
      approvalId: pluginBindingApproval.approvalId,
      decision: pluginBindingApproval.decision,
      senderId: params.interactionCtx.userId,
    });
    const approvalMessageId = params.messageId?.trim() || params.interaction.message?.id?.trim();
    if (approvalMessageId) {
      try {
        await editDiscordComponentMessage(
          normalizedConversationId,
          approvalMessageId,
          {
            text: buildPluginBindingResolvedText(resolved),
          },
          {
            accountId: params.ctx.accountId,
          },
        );
      } catch (err) {
        logError(`discord plugin binding approval: failed to clear prompt: ${String(err)}`);
      }
    }
    if (resolved.status !== "approved") {
      try {
        await respond.followUp({
          text: buildPluginBindingResolvedText(resolved),
          ephemeral: true,
        });
      } catch (err) {
        logError(`discord plugin binding approval: failed to follow up: ${String(err)}`);
      }
    }
    return "handled";
  }
  const dispatched = await dispatchDiscordPluginInteractiveHandler({
    data: params.data,
    interactionId: resolveDiscordInteractionId(params.interaction),
    ctx: {
      accountId: params.ctx.accountId,
      interactionId: resolveDiscordInteractionId(params.interaction),
      conversationId: normalizedConversationId,
      parentConversationId: params.channelCtx.parentId,
      guildId: params.interactionCtx.rawGuildId,
      senderId: params.interactionCtx.userId,
      senderUsername: params.interactionCtx.username,
      auth: { isAuthorizedSender: params.isAuthorizedSender },
      interaction: {
        kind: params.kind,
        messageId: params.messageId,
        values: params.values,
        fields: params.fields,
      },
    },
    respond,
    onMatched: async () => {
      try {
        await respond.acknowledge();
      } catch {
        // Interaction may have expired before the plugin handler ran.
      }
    },
  });
  if (!dispatched.matched) {
    return "unmatched";
  }
  if (dispatched.handled) {
    if (!responded) {
      try {
        await respond.acknowledge();
      } catch {
        // Interaction may have expired after the handler finished.
      }
    }
    return "handled";
  }
  return "unmatched";
}

async function dispatchDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  eventText: string;
  replyToId?: string;
  routeOverrides?: { sessionKey?: string; agentId?: string; accountId?: string };
}): Promise<void> {
  const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
  const runtime = ctx.runtime ?? createNonExitingRuntime();
  const route = resolveAgentComponentRoute({
    ctx,
    rawGuildId: interactionCtx.rawGuildId,
    memberRoleIds: interactionCtx.memberRoleIds,
    isDirectMessage: interactionCtx.isDirectMessage,
    isGroupDm: interactionCtx.isGroupDm,
    userId: interactionCtx.userId,
    channelId: interactionCtx.channelId,
    parentId: channelCtx.parentId,
  });
  const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
  const agentId = params.routeOverrides?.agentId ?? route.agentId;
  const accountId = params.routeOverrides?.accountId ?? route.accountId;
  const fromLabel = buildDiscordComponentConversationLabel({
    interactionCtx,
    interaction,
    channelCtx,
  });
  const chatType = resolveDiscordComponentChatType(interactionCtx);
  const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
  const senderUsername = interactionCtx.user.username;
  const senderTag = formatDiscordUserTag(interactionCtx.user);
  const groupChannel =
    !interactionCtx.isDirectMessage && channelCtx.channelSlug
      ? `#${channelCtx.channelSlug}`
      : undefined;
  const groupSubject = interactionCtx.isDirectMessage ? undefined : groupChannel;
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: interactionCtx.channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
  const { ownerAllowFrom } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: interactionCtx.user.id, name: interactionCtx.user.username, tag: senderTag },
    allowNameMatching,
    isGuild: !interactionCtx.isDirectMessage,
  });
  const groupSystemPrompt = buildDiscordGroupSystemPrompt(channelConfig);
  const pinnedMainDmOwner = interactionCtx.isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: ctx.cfg.session?.dmScope,
        allowFrom: channelConfig?.users ?? guildInfo?.users,
        normalizeEntry: (entry: string) => {
          const normalized = normalizeDiscordAllowList([entry], ["discord:", "user:", "pk:"]);
          const candidate = normalized?.ids.values().next().value;
          return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : undefined;
        },
      })
    : null;
  const commandAuthorized = resolveComponentCommandAuthorized({
    ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });
  const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const timestamp = Date.now();
  const combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp,
    body: eventText,
    chatType,
    senderLabel: senderName,
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const {
    createReplyReferencePlanner,
    dispatchReplyWithBufferedBlockDispatcher,
    finalizeInboundContext,
    resolveChunkMode,
    resolveTextChunkLimit,
    recordInboundSession,
  } = await (async () => {
    const conversationRuntime = await loadConversationRuntime();
    return {
      ...conversationRuntime,
    };
  })();

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: eventText,
    RawBody: eventText,
    CommandBody: eventText,
    From: interactionCtx.isDirectMessage
      ? `discord:${interactionCtx.userId}`
      : interactionCtx.isGroupDm
        ? `discord:group:${interactionCtx.channelId}`
        : `discord:channel:${interactionCtx.channelId}`,
    To: `channel:${interactionCtx.channelId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: interactionCtx.userId,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    GroupSystemPrompt: interactionCtx.isDirectMessage ? undefined : groupSystemPrompt,
    GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    MessageSid: interaction.rawData.id,
    Timestamp: timestamp,
    OriginatingChannel: "discord" as const,
    OriginatingTo:
      resolveDiscordComponentOriginatingTo(interactionCtx) ?? `channel:${interactionCtx.channelId}`,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    updateLastRoute: interactionCtx.isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "discord",
          to:
            resolveDiscordComponentOriginatingTo(interactionCtx) ?? `user:${interactionCtx.userId}`,
          accountId,
          mainDmOwnerPin: pinnedMainDmOwner
            ? {
                ownerRecipient: pinnedMainDmOwner,
                senderRecipient: interactionCtx.userId,
                onSkip: ({ ownerRecipient, senderRecipient }) => {
                  logVerbose(
                    `discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                  );
                },
              }
            : undefined,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`discord: failed updating component session meta: ${String(err)}`);
    },
  });

  const deliverTarget = `channel:${interactionCtx.channelId}`;
  const typingChannelId = interactionCtx.channelId;
  const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: ctx.cfg,
    agentId,
    channel: "discord",
    accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "discord",
    accountId,
  });
  const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, {
    fallbackLimit: 2000,
  });
  const token = ctx.token ?? "";
  const feedbackRest = createDiscordRestClient({
    cfg: ctx.cfg,
    token,
    accountId,
  }).rest;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(ctx.cfg, agentId);
  const replyToMode =
    ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
  const replyReference = createReplyReferencePlanner({
    replyToMode,
    startId: params.replyToId,
  });

  await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    replyOptions: { onModelSelected },
    dispatcherOptions: {
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
      deliver: async (payload) => {
        const replyToId = replyReference.use();
        await deliverDiscordReply({
          cfg: ctx.cfg,
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: interaction.client.rest,
          runtime,
          replyToId,
          replyToMode,
          textLimit,
          maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
            cfg: ctx.cfg,
            discordConfig: ctx.discordConfig,
            accountId,
          }),
          tableMode,
          chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
          mediaLocalRoots,
        });
        replyReference.markSent();
      },
      onReplyStart: async () => {
        try {
          const { sendTyping } = await loadTypingRuntime();
          await sendTyping({ rest: feedbackRest, channelId: typingChannelId });
        } catch (err) {
          logVerbose(`discord: typing failed for component reply: ${String(err)}`);
        }
      },
      onError: (err) => {
        logError(`discord component dispatch failed: ${String(err)}`);
      },
    },
  });
}

async function handleDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  componentLabel: string;
  values?: string[];
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: "This component is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const entry = resolveDiscordComponentEntry({ id: parsed.componentId, consume: false });
  if (!entry) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.componentLabel,
    defer: false,
  });
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.ctx.discordConfig);
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
  const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
    allowNameMatching,
    groupPolicy: resolveComponentGroupPolicy(params.ctx),
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
    allowNameMatching,
  });
  if (!componentAllowed) {
    return;
  }
  const commandAuthorized = resolveComponentCommandAuthorized({
    ctx: params.ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });

  const consumed = resolveDiscordComponentEntry({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  if (consumed.kind === "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  if (consumed.callbackData) {
    const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
      ctx: params.ctx,
      interaction: params.interaction,
      interactionCtx,
      channelCtx,
      isAuthorizedSender: commandAuthorized,
      data: consumed.callbackData,
      kind: consumed.kind === "select" ? "select" : "button",
      values,
      messageId: consumed.messageId ?? params.interaction.message?.id,
    });
    if (pluginDispatch === "handled") {
      return;
    }
  }
  // Preserve explicit callback payloads for button fallbacks so Discord
  // behaves like Telegram when buttons carry synthetic command text. Select
  // fallbacks still need their chosen values in the synthesized event text.
  const eventText =
    (consumed.kind === "button" ? consumed.callbackData?.trim() : undefined) ||
    (await loadComponentsRuntime()).formatDiscordComponentEventText({
      kind: consumed.kind === "select" ? "select" : "button",
      label: consumed.label,
      values,
    });

  try {
    await params.interaction.reply({ content: "✓", ...replyOpts });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }

  await dispatchDiscordComponentEvent({
    ctx: params.ctx,
    interaction: params.interaction,
    interactionCtx,
    channelCtx,
    guildInfo,
    eventText,
    replyToId: consumed.messageId ?? params.interaction.message?.id,
    routeOverrides: {
      sessionKey: consumed.sessionKey,
      agentId: consumed.agentId,
      accountId: consumed.accountId,
    },
  });
}

async function handleDiscordModalTrigger(params: {
  ctx: AgentComponentContext;
  interaction: ButtonInteraction;
  data: ComponentData;
  label: string;
  interactionCtx?: ComponentInteractionContext;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse modal trigger data`);
    try {
      await params.interaction.reply({
        content: "This button is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }
  const entry = resolveDiscordComponentEntry({ id: parsed.componentId, consume: false });
  if (!entry || entry.kind !== "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This button has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx =
    params.interactionCtx ??
    (await resolveInteractionContextWithDmAuth({
      ctx: params.ctx,
      interaction: params.interaction,
      label: params.label,
      componentLabel: "form",
      defer: false,
    }));
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const unauthorizedReply = "You are not authorized to use this form.";
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    groupPolicy: resolveComponentGroupPolicy(params.ctx),
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
  });
  if (!componentAllowed) {
    return;
  }

  const consumed = resolveDiscordComponentEntry({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = resolveDiscordModalEntry({ id: resolvedModalId, consume: false });
  if (!modalEntry) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  try {
    await params.interaction.showModal(
      (await loadComponentsRuntime()).createDiscordFormModal(modalEntry),
    );
  } catch (err) {
    logError(`${params.label}: failed to show modal: ${String(err)}`);
  }
}

export class AgentComponentButton extends Button {
  label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    // Parse componentId from Carbon's parsed ComponentData
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent button: failed to parse component data");
      try {
        await interaction.reply({
          content: "This button is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "agent button",
      componentLabel: "button",
      defer: false,
    });
    if (!interactionCtx) {
      return;
    }
    const {
      channelId,
      user,
      username,
      userId,
      replyOpts,
      rawGuildId,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
    } = interactionCtx;

    // Check user allowlist before processing component interaction
    // This prevents unauthorized users from injecting system events.
    const allowed = await ensureAgentComponentInteractionAllowed({
      ctx: this.ctx,
      interaction,
      channelId,
      rawGuildId,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "button",
      unauthorizedReply: "You are not authorized to use this button.",
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    const route = resolveAgentComponentRoute({
      ctx: this.ctx,
      rawGuildId,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      userId,
      channelId,
      parentId,
    });

    const eventText = `[Discord component: ${componentId} clicked by ${username} (${userId})]`;

    logDebug(`agent button: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:agent-button:${channelId}:${componentId}:${userId}`,
    });

    await ackComponentInteraction({ interaction, replyOpts, label: "agent button" });
  }
}

export class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    // Parse componentId from Carbon's parsed ComponentData
    const parsed = parseAgentComponentData(data);
    if (!parsed) {
      logError("agent select: failed to parse component data");
      try {
        await interaction.reply({
          content: "This select menu is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { componentId } = parsed;

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "agent select",
      componentLabel: "select menu",
      defer: false,
    });
    if (!interactionCtx) {
      return;
    }
    const {
      channelId,
      user,
      username,
      userId,
      replyOpts,
      rawGuildId,
      isDirectMessage,
      isGroupDm,
      memberRoleIds,
    } = interactionCtx;

    // Check user allowlist before processing component interaction.
    const allowed = await ensureAgentComponentInteractionAllowed({
      ctx: this.ctx,
      interaction,
      channelId,
      rawGuildId,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "select",
      unauthorizedReply: "You are not authorized to use this select menu.",
    });
    if (!allowed) {
      return;
    }
    const { parentId } = allowed;

    // Extract selected values
    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";

    const route = resolveAgentComponentRoute({
      ctx: this.ctx,
      rawGuildId,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      userId,
      channelId,
      parentId,
    });

    const eventText = `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`;

    logDebug(`agent select: enqueuing event for channel ${channelId}: ${eventText}`);

    enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:agent-select:${channelId}:${componentId}:${userId}`,
    });

    await ackComponentInteraction({ interaction, replyOpts, label: "agent select" });
  }
}

class DiscordComponentButton extends Button {
  label = "component";
  customId = "__openclaw_discord_component_button_wildcard__";
  style = ButtonStyle.Primary;
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
    if (parsed?.modalId) {
      const interactionCtx = await resolveInteractionContextWithDmAuth({
        ctx: this.ctx,
        interaction,
        label: "discord component button",
        componentLabel: "form",
        defer: false,
      });
      if (!interactionCtx) {
        return;
      }
      await handleDiscordModalTrigger({
        ctx: this.ctx,
        interaction,
        data,
        label: "discord component modal",
        interactionCtx,
      });
      return;
    }
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "button",
      label: "discord component button",
    });
  }
}

class DiscordComponentStringSelect extends StringSelectMenu {
  customId = "__openclaw_discord_component_string_select_wildcard__";
  options: APIStringSelectComponent["options"] = [];
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "select menu",
      label: "discord component select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentUserSelect extends UserSelectMenu {
  customId = "__openclaw_discord_component_user_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: UserSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "user select",
      label: "discord component user select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentRoleSelect extends RoleSelectMenu {
  customId = "__openclaw_discord_component_role_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: RoleSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "role select",
      label: "discord component role select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentMentionableSelect extends MentionableSelectMenu {
  customId = "__openclaw_discord_component_mentionable_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: MentionableSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "mentionable select",
      label: "discord component mentionable select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentChannelSelect extends ChannelSelectMenu {
  customId = "__openclaw_discord_component_channel_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ChannelSelectMenuInteraction, data: ComponentData): Promise<void> {
    await handleDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "channel select",
      label: "discord component channel select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentModal extends Modal {
  title = "OpenClaw form";
  customId = "__openclaw_discord_component_modal_wildcard__";
  components = [];
  customIdParser = parseDiscordModalCustomIdForCarbon;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ModalInteraction, data: ComponentData): Promise<void> {
    const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
    if (!modalId) {
      logError("discord component modal: missing modal id");
      try {
        await interaction.reply({
          content: "This form is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const modalEntry = resolveDiscordModalEntry({ id: modalId, consume: false });
    if (!modalEntry) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const interactionCtx = await resolveInteractionContextWithDmAuth({
      ctx: this.ctx,
      interaction,
      label: "discord component modal",
      componentLabel: "form",
      defer: false,
    });
    if (!interactionCtx) {
      return;
    }
    const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
    const guildInfo = resolveDiscordGuildEntry({
      guild: interaction.guild ?? undefined,
      guildId: rawGuildId,
      guildEntries: this.ctx.guildEntries,
    });
    const channelCtx = resolveDiscordChannelContext(interaction);
    const allowNameMatching = isDangerousNameMatchingEnabled(this.ctx.discordConfig);
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
    const memberAllowed = await ensureGuildComponentMemberAllowed({
      interaction,
      guildInfo,
      channelId,
      rawGuildId,
      channelCtx,
      memberRoleIds,
      user,
      replyOpts,
      componentLabel: "form",
      unauthorizedReply: "You are not authorized to use this form.",
      allowNameMatching,
      groupPolicy: resolveComponentGroupPolicy(this.ctx),
    });
    if (!memberAllowed) {
      return;
    }

    const modalAllowed = await ensureComponentUserAllowed({
      entry: {
        id: modalEntry.id,
        kind: "button",
        label: modalEntry.title,
        allowedUsers: modalEntry.allowedUsers,
      },
      interaction,
      user,
      replyOpts,
      componentLabel: "form",
      unauthorizedReply: "You are not authorized to use this form.",
      allowNameMatching,
    });
    if (!modalAllowed) {
      return;
    }
    const commandAuthorized = resolveComponentCommandAuthorized({
      ctx: this.ctx,
      interactionCtx,
      channelConfig,
      guildInfo,
      allowNameMatching,
    });

    const consumed = resolveDiscordModalEntry({
      id: modalId,
      consume: !modalEntry.reusable,
    });
    if (!consumed) {
      try {
        await interaction.reply({
          content: "This form has expired.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    if (consumed.callbackData) {
      const fields = consumed.fields.map((field) => ({
        id: field.id,
        name: field.name,
        values: resolveModalFieldValues(field, interaction),
      }));
      const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
        ctx: this.ctx,
        interaction,
        interactionCtx,
        channelCtx,
        isAuthorizedSender: commandAuthorized,
        data: consumed.callbackData,
        kind: "modal",
        fields,
        messageId: consumed.messageId,
      });
      if (pluginDispatch === "handled") {
        return;
      }
    }

    try {
      await interaction.acknowledge();
    } catch (err) {
      logError(`discord component modal: failed to acknowledge: ${String(err)}`);
    }

    const eventText = formatModalSubmissionText(consumed, interaction);
    await dispatchDiscordComponentEvent({
      ctx: this.ctx,
      interaction,
      interactionCtx,
      channelCtx,
      guildInfo,
      eventText,
      replyToId: consumed.messageId,
      routeOverrides: {
        sessionKey: consumed.sessionKey,
        agentId: consumed.agentId,
        accountId: consumed.accountId,
      },
    });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}

export function createDiscordComponentButton(ctx: AgentComponentContext): Button {
  return new DiscordComponentButton(ctx);
}

export function createDiscordComponentStringSelect(ctx: AgentComponentContext): StringSelectMenu {
  return new DiscordComponentStringSelect(ctx);
}

export function createDiscordComponentUserSelect(ctx: AgentComponentContext): UserSelectMenu {
  return new DiscordComponentUserSelect(ctx);
}

export function createDiscordComponentRoleSelect(ctx: AgentComponentContext): RoleSelectMenu {
  return new DiscordComponentRoleSelect(ctx);
}

export function createDiscordComponentMentionableSelect(
  ctx: AgentComponentContext,
): MentionableSelectMenu {
  return new DiscordComponentMentionableSelect(ctx);
}

export function createDiscordComponentChannelSelect(ctx: AgentComponentContext): ChannelSelectMenu {
  return new DiscordComponentChannelSelect(ctx);
}

export function createDiscordComponentModal(ctx: AgentComponentContext): Modal {
  return new DiscordComponentModal(ctx);
}
