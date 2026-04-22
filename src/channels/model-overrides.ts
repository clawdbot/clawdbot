import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  type ChannelMatchSource,
} from "./channel-config.js";
import { normalizeChatType } from "./chat-type.js";
import { getChannelPlugin } from "./plugins/registry.js";
import {
  resolveSessionConversation,
  resolveSessionConversationRef,
} from "./plugins/session-conversation.js";

export type ChannelModelOverride = {
  channel: string;
  model: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

type ChannelModelByChannelConfig = Record<string, Record<string, string>>;

type ChannelModelOverrideParams = {
  cfg: OpenClawConfig;
  channel?: string | null;
  groupId?: string | null;
  groupChatType?: string | null;
  groupChannel?: string | null;
  groupSubject?: string | null;
  parentSessionKey?: string | null;
};

function resolveProviderEntry(
  modelByChannel: ChannelModelByChannelConfig | undefined,
  channel: string,
): Record<string, string> | undefined {
  const normalized =
    normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "";
  return (
    modelByChannel?.[normalized] ??
    modelByChannel?.[
      Object.keys(modelByChannel ?? {}).find((key) => {
        const normalizedKey =
          normalizeMessageChannel(key) ?? normalizeOptionalLowercaseString(key) ?? "";
        return normalizedKey === normalized;
      }) ?? ""
    ]
  );
}

function buildChannelCandidates(
  params: Pick<
    ChannelModelOverrideParams,
    "channel" | "groupId" | "groupChatType" | "groupChannel" | "groupSubject" | "parentSessionKey"
  >,
): { keys: string[]; parentKeys: string[] } {
  const normalizedChannel =
    normalizeMessageChannel(params.channel ?? "") ??
    normalizeOptionalLowercaseString(params.channel);
  const groupId = normalizeOptionalString(params.groupId);
  const rawParentConversation = parseRawSessionConversationRef(params.parentSessionKey);
  const channelPlugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : undefined;
  const parentOverrideFallbacks =
    channelPlugin?.conversationBindings?.buildModelOverrideParentCandidates?.({
      parentConversationId: rawParentConversation?.rawId,
    }) ?? [];
  const sessionConversation = resolveSessionConversationRef(params.parentSessionKey, {
    bundledFallback: parentOverrideFallbacks.length === 0,
  });
  const groupConversationKind =
    normalizeChatType(params.groupChatType ?? undefined) === "channel"
      ? "channel"
      : sessionConversation?.kind === "channel"
        ? "channel"
        : "group";
  const groupConversation = resolveSessionConversation({
    channel: normalizedChannel ?? "",
    kind: groupConversationKind,
    rawId: groupId ?? "",
  });
  const groupChannel = normalizeOptionalString(params.groupChannel);
  const groupSubject = normalizeOptionalString(params.groupSubject);
  const channelBare = groupChannel ? groupChannel.replace(/^#/, "") : undefined;
  const subjectBare = groupSubject ? groupSubject.replace(/^#/, "") : undefined;
  const channelSlug = channelBare ? normalizeChannelSlug(channelBare) : undefined;
  const subjectSlug = subjectBare ? normalizeChannelSlug(subjectBare) : undefined;

  return {
    keys: buildChannelKeyCandidates(
      groupId,
      sessionConversation?.rawId,
      ...(groupConversation?.parentConversationCandidates ?? []),
      ...(sessionConversation?.parentConversationCandidates ?? []),
      ...parentOverrideFallbacks,
    ),
    parentKeys: buildChannelKeyCandidates(
      groupChannel,
      channelBare,
      channelSlug,
      groupSubject,
      subjectBare,
      subjectSlug,
    ),
  };
}

function buildGenericParentOverrideCandidates(sessionKey: string | null | undefined): string[] {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return [];
  }
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(raw.rawId);
  return buildChannelKeyCandidates(threadId ? baseSessionKey : raw.rawId);
}

function resolveDirectChannelModelMatch(params: {
  channel: string;
  providerEntries: Record<string, string>;
  groupId?: string | null;
  parentSessionKey?: string | null;
}): { model: string; matchKey?: string; matchSource?: ChannelMatchSource } | null {
  const directKeys = buildChannelKeyCandidates(
    params.groupId,
    ...buildGenericParentOverrideCandidates(params.parentSessionKey),
  );
  if (directKeys.length === 0) {
    return null;
  }
  const match = resolveChannelEntryMatchWithFallback({
    entries: params.providerEntries,
    keys: directKeys,
    parentKeys: [],
    wildcardKey: "*",
    normalizeKey: (value) => normalizeOptionalLowercaseString(value) ?? "",
  });
  const raw = match.entry ?? match.wildcardEntry;
  if (typeof raw !== "string") {
    return null;
  }
  const model = normalizeOptionalString(raw);
  if (!model) {
    return null;
  }
  return { model, matchKey: match.matchKey, matchSource: match.matchSource };
}

export function resolveChannelModelOverride(
  params: ChannelModelOverrideParams,
): ChannelModelOverride | null {
  const channel = normalizeOptionalString(params.channel);
  if (!channel) {
    return null;
  }
  const modelByChannel = params.cfg.channels?.modelByChannel as
    | ChannelModelByChannelConfig
    | undefined;
  if (!modelByChannel) {
    return null;
  }
  const providerEntries = resolveProviderEntry(modelByChannel, channel);
  if (!providerEntries) {
    return null;
  }
  const directMatch = resolveDirectChannelModelMatch({
    channel,
    providerEntries,
    groupId: params.groupId,
    parentSessionKey: params.parentSessionKey,
  });
  if (directMatch) {
    return {
      channel: normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "",
      model: directMatch.model,
      matchKey: directMatch.matchKey,
      matchSource: directMatch.matchSource,
    };
  }

  const { keys, parentKeys } = buildChannelCandidates(params);
  if (keys.length === 0 && parentKeys.length === 0) {
    return null;
  }
  const match = resolveChannelEntryMatchWithFallback({
    entries: providerEntries,
    keys,
    parentKeys,
    wildcardKey: "*",
    normalizeKey: (value) => normalizeOptionalLowercaseString(value) ?? "",
  });
  const raw = match.entry ?? match.wildcardEntry;
  if (typeof raw !== "string") {
    return null;
  }
  const model = normalizeOptionalString(raw);
  if (!model) {
    return null;
  }

  return {
    channel: normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "",
    model,
    matchKey: match.matchKey,
    matchSource: match.matchSource,
  };
}
