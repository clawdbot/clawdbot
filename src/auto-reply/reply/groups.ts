import type { ClawdbotConfig } from "../../config/config.js";
import type {
  GroupKeyResolution,
  SessionEntry,
} from "../../config/sessions.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../../providers/plugins/index.js";
import { isInternalMessageProvider } from "../../utils/message-provider.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";

export function resolveGroupRequireMention(params: {
  cfg: ClawdbotConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): boolean {
  const { cfg, ctx, groupResolution } = params;
  const rawProvider = groupResolution?.provider ?? ctx.Provider?.trim();
  const provider = normalizeProviderId(rawProvider);
  if (!provider) return true;
  const groupId = groupResolution?.id ?? ctx.From?.replace(/^group:/, "");
  const groupRoom = ctx.GroupRoom?.trim() ?? ctx.GroupSubject?.trim();
  const groupSpace = ctx.GroupSpace?.trim();
  const requireMention = getProviderPlugin(
    provider,
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
  const providerId = normalizeProviderId(rawProvider);
  const plugin = providerId ? getProviderPlugin(providerId) : undefined;
  const providerLabel = (() => {
    if (!providerKey) return "chat";
    if (isInternalMessageProvider(providerKey)) return "WebChat";
    if (plugin) return plugin.meta.label ?? plugin.id;
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
  const providerIdsLine = plugin?.groups?.resolveGroupIntroHint?.({
    cfg: params.cfg,
    groupId,
    groupRoom,
    groupSpace,
    accountId: params.sessionCtx.AccountId,
  });
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
  return [
    subjectLine,
    membersLine,
    activationLine,
    providerIdsLine,
    silenceLine,
    cautionLine,
    lurkLine,
  ]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
