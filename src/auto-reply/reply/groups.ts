import { getChannelDock } from "../../channels/dock.js";
import {
  getChatChannelMeta,
  normalizeChannelId,
} from "../../channels/registry.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type {
  GroupKeyResolution,
  SessionEntry,
} from "../../config/sessions.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";

export function resolveGroupRequireMention(params: {
  cfg: ClawdbotConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): boolean {
  const { cfg, ctx, groupResolution } = params;
  const rawChannel = groupResolution?.channel ?? ctx.Provider?.trim();
  const channel = normalizeChannelId(rawChannel);
  if (!channel) return true;
  const groupId = groupResolution?.id ?? ctx.From?.replace(/^group:/, "");
  const groupRoom = ctx.GroupRoom?.trim() ?? ctx.GroupSubject?.trim();
  const groupSpace = ctx.GroupSpace?.trim();
  const requireMention = getChannelDock(
    channel,
  )?.groups?.resolveRequireMention?.({
    cfg,
    groupId,
    groupRoom,
    groupSpace,
    accountId: ctx.AccountId,
  });
  if (typeof requireMention === "boolean") return requireMention;
  return true;
}

export function defaultGroupActivation(
  requireMention: boolean,
): "always" | "mention" {
  return requireMention === false ? "always" : "mention";
}

export function buildGroupIntro(params: {
  cfg: ClawdbotConfig;
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  defaultActivation: "always" | "mention";
  silentToken: string;
}): string {
  const activation =
    normalizeGroupActivation(params.sessionEntry?.groupActivation) ??
    params.defaultActivation;
  const subject = params.sessionCtx.GroupSubject?.trim();
  const members = params.sessionCtx.GroupMembers?.trim();
  const rawProvider = params.sessionCtx.Provider?.trim();
  const providerKey = rawProvider?.toLowerCase() ?? "";
  const providerId = normalizeChannelId(rawProvider);
  const providerLabel = (() => {
    if (!providerKey) return "chat";
    if (isInternalMessageChannel(providerKey)) return "WebChat";
    if (providerId) return getChatChannelMeta(providerId).label;
    return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
  })();
  const subjectLine = subject
    ? `You are replying inside the ${providerLabel} group "${subject}".`
    : `You are replying inside a ${providerLabel} group chat.`;
  const membersLine = members ? `Group members: ${members}.` : undefined;
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  const groupId = params.sessionCtx.From?.replace(/^group:/, "");
  const groupRoom = params.sessionCtx.GroupRoom?.trim() ?? subject;
  const groupSpace = params.sessionCtx.GroupSpace?.trim();
  const providerIdsLine = providerId
    ? getChannelDock(providerId)?.groups?.resolveGroupIntroHint?.({
        cfg: params.cfg,
        groupId,
        groupRoom,
        groupSpace,
        accountId: params.sessionCtx.AccountId,
      })
    : undefined;
  const silenceLine =
    activation === "always"
      ? `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so Clawdbot stays silent. Do not add any other words, punctuation, tags, markdown/code blocks, or explanations.`
      : undefined;
  const cautionLine =
    activation === "always"
      ? "Be extremely selective: reply only when directly addressed or clearly helpful. Otherwise stay silent."
      : undefined;
  const lurkLine =
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.";
  const styleLine =
    "Write like a human. Avoid Markdown tables. Don't type literal \\n sequences; use real line breaks sparingly.";
  return [
    subjectLine,
    membersLine,
    activationLine,
    providerIdsLine,
    silenceLine,
    cautionLine,
    lurkLine,
    styleLine,
  ]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
