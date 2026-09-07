/** Group/direct chat prompt context, activation, and silent-reply helpers. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import { findChatChannelMeta, normalizeChatChannelId } from "../../channels/registry.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyPolicy } from "../../shared/silent-reply-policy.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";
import type { PreparedReplyConversation } from "./prompt-session-context.js";

const groupsRuntimeLoader = createLazyImportLoader(() => import("./groups.runtime.js"));

function loadGroupsRuntime() {
  return groupsRuntimeLoader.load();
}

async function resolveRuntimeChannelId(raw?: string | null): Promise<string | null> {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  const { getChannelPlugin, normalizeChannelId } = await loadGroupsRuntime();
  try {
    if (getChannelPlugin(normalized)) {
      return normalized;
    }
  } catch {
    // Plugin registry may not be initialized in shared/test contexts.
  }
  try {
    return normalizeChannelId(raw) ?? normalized;
  } catch {
    return normalized;
  }
}

/** Resolves whether a group/channel turn requires an explicit mention. */
export async function resolveGroupRequireMention(params: {
  cfg: OpenClawConfig;
  group: PreparedReplyConversation["group"];
}): Promise<boolean> {
  const { cfg, group } = params;
  const channel = await resolveRuntimeChannelId(group.channel);
  if (!channel) {
    return true;
  }
  const { groupId, groupChannel, groupSpace, accountId } = group;
  let requireMention: boolean | undefined;
  const runtime = await loadGroupsRuntime();
  try {
    requireMention = runtime.getChannelPlugin(channel)?.groups?.resolveRequireMention?.({
      cfg,
      groupId,
      groupChannel,
      groupSpace,
      accountId,
    });
  } catch {
    requireMention = undefined;
  }
  if (typeof requireMention === "boolean") {
    return requireMention;
  }
  return resolveChannelGroupRequireMention({
    cfg,
    channel,
    groupId,
    accountId,
  });
}

/** Converts requireMention into the default prompt activation label. */
export function defaultGroupActivation(requireMention: boolean): "always" | "mention" {
  return !requireMention ? "always" : "mention";
}

function resolveProviderLabel(rawProvider: string | undefined): string {
  const providerKey = normalizeOptionalLowercaseString(rawProvider) ?? "";
  if (!providerKey) {
    return "chat";
  }
  if (isInternalMessageChannel(providerKey)) {
    return "WebChat";
  }
  const channelId = normalizeChatChannelId(providerKey);
  const label = channelId ? findChatChannelMeta(channelId)?.label : undefined;
  if (label) {
    return label;
  }
  return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
}

function resolveSharedChatNoun(chatType?: string | null): "group chat" | "channel" {
  return normalizeOptionalLowercaseString(chatType) === "channel" ? "channel" : "group chat";
}

/**
 * Builds trusted group/channel delivery guidance.
 *
 * Room names, members, and history are rendered separately as untrusted inbound
 * context. Legacy automatic delivery posts text final replies directly, but
 * files/images/attachments still need message(action=send).
 */
export function buildGroupChatContext(params: {
  sessionCtx: TemplateContext;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  silentReplyPolicy?: SilentReplyPolicy;
  silentToken?: string;
}): string {
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  const provider = normalizeOptionalLowercaseString(params.sessionCtx.Provider);
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";
  const sharedChatNoun = resolveSharedChatNoun(params.sessionCtx.ChatType);
  const destinationLabel = sharedChatNoun === "channel" ? "this channel" : "this group chat";

  const lines: string[] = [];
  lines.push(`You are in a ${providerLabel} ${sharedChatNoun}.`);
  if (messageToolOnly) {
    lines.push(
      `Normal final replies are private and are not automatically sent to ${destinationLabel}. To post visible output here, use the message tool with action=send; the target defaults to ${destinationLabel}.`,
    );
  } else {
    lines.push(
      `Your text replies are automatically sent to ${destinationLabel} unless the current-turn context says final replies stay private. For ordinary text, do not use the message tool to send to this same destination unless the current-turn context asks for visible output via message(action=send). Use message(action=send) only when you need to send files, images, or other attachments to this same ${sharedChatNoun === "channel" ? "channel/thread" : "group/topic"}.`,
    );
  }
  lines.push(
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.",
  );
  const channelId = normalizeChatChannelId(provider) ?? provider ?? "";
  const tableMode = getLoadedChannelPluginForRead(channelId)?.messaging?.defaultMarkdownTableMode;
  const tableGuidance =
    tableMode === "block" || tableMode === "off" ? "" : " Avoid Markdown tables.";
  lines.push(
    `Write like a human.${tableGuidance} Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.`,
  );
  lines.push("If addressed to someone else, stay silent unless invited or correcting key facts.");
  if (provider === "discord") {
    lines.push("Discord: wrap bare URLs like <https://example.com> to suppress embeds.");
  }
  lines.push(
    "When subagent or session-spawn tools are available and a directly requested group-chat task will require several tool calls, prefer delegating bounded side investigations early so the channel gets a responsive path forward. Keep the critical path local, avoid subagents for simple one-step work, and only surface concise group-visible updates when they add value.",
  );
  const canUseSilentReply =
    !messageToolOnly && params.silentToken && params.silentReplyPolicy !== "disallow";
  if (messageToolOnly) {
    lines.push(
      `If no visible ${sharedChatNoun === "channel" ? "channel" : "group"} response is needed, do not call message(action=send).`,
    );
  }
  if (canUseSilentReply) {
    lines.push(
      `If no text reply is needed, including after a reaction or other action, reply with exactly "${params.silentToken}" as the entire final answer, without commentary, punctuation, or formatting.`,
    );
  }
  return lines.join(" ");
}

/** Builds system prompt context for direct conversations. */
export function buildDirectChatContext(params: {
  sessionCtx: TemplateContext;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string {
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";
  const lines: string[] = [];
  lines.push(`You are in a ${providerLabel} direct conversation.`);
  if (messageToolOnly) {
    lines.push(
      "Normal final replies are private and are not automatically sent to this conversation. To post visible output here, use the message tool with action=send; the target defaults to this conversation.",
    );
    lines.push(
      "If no visible direct response is needed, do not call message(action=send). Your normal final answer stays private and will not be posted to the conversation.",
    );
    return lines.join(" ");
  }
  lines.push(
    "Your replies are automatically sent to this conversation unless the current-turn context says final replies stay private.",
  );
  return lines.join(" ");
}

/** Builds the channel-specific group intro injected into the system prompt. */
export function buildGroupIntro(params: {
  activation?: PreparedReplyConversation["activation"];
  defaultActivation: "always" | "mention";
}): string {
  const activation = normalizeGroupActivation(params.activation) ?? params.defaultActivation;
  if (activation === "always") {
    return "Activation: always-on (you receive every group message). You see every message; most need no response. When you do reply, address the specific sender noted in the message context.";
  }
  return "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Address the specific sender noted in the message context.";
}
