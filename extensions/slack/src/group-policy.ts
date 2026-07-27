// Slack plugin module implements group policy behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ScopeNode,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import { normalizeHyphenSlug } from "openclaw/plugin-sdk/string-normalization-runtime";
import { mergeSlackAccountConfig, resolveDefaultSlackAccountId } from "./accounts.js";

type SlackChannelPolicyEntry = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export function buildSlackChannelPolicyScope<T extends ScopeNode>(params: {
  channels?: Record<string, T>;
  candidates: readonly string[];
}) {
  // Whole-entry selection: an exact channel hides every wildcard field.
  // The wildcard is a normal scope selected only after all candidates miss.
  const channels: Record<string, T> = params.channels ?? {};
  const tree: ScopeTree = { scopes: channels };
  const matchKey =
    params.candidates.find(
      (candidate) => candidate !== "*" && Object.hasOwn(tree.scopes, candidate),
    ) ?? (Object.hasOwn(tree.scopes, "*") ? "*" : undefined);
  const matchSource: "direct" | "wildcard" | undefined =
    matchKey === undefined ? undefined : matchKey === "*" ? "wildcard" : "direct";
  return {
    tree,
    path: matchKey ? [matchKey] : [],
    entry: matchKey ? channels[matchKey] : undefined,
    wildcardEntry: channels["*"],
    matchKey,
    matchSource,
  };
}

function resolveSlackGroupPolicyScope(params: ChannelGroupContext) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const channels = mergeSlackAccountConfig(params.cfg, accountId).channels as
    | Record<string, SlackChannelPolicyEntry>
    | undefined;
  const channelId = params.groupId?.trim();
  const channelName = params.groupChannel?.replace(/^#/, "");
  const candidates = [
    channelId,
    channelName ? `#${channelName}` : undefined,
    channelName,
    normalizeHyphenSlug(channelName),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return buildSlackChannelPolicyScope({ channels, candidates });
}

export function resolveSlackGroupRequireMention(params: ChannelGroupContext): boolean {
  // The adapter intentionally ignores root requireMention; the monitor resolves that default.
  return resolveScopeRequireMention(resolveSlackGroupPolicyScope(params));
}

export function resolveSlackGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const scope = resolveSlackGroupPolicyScope(params);
  // No messageProvider: this path historically never matched channel-prefixed sender keys.
  return resolveScopeToolsPolicy({
    ...scope,
    senderPolicyMode: params.senderPolicyMode,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
