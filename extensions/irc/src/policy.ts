// Irc plugin module implements policy behavior.
import {
  resolveScopeKeyCaseInsensitive,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import type { IrcChannelConfig } from "./types.js";

type IrcGroupMatch = {
  allowed: boolean;
  groupConfig?: IrcChannelConfig;
  wildcardConfig?: IrcChannelConfig;
  hasConfiguredGroups: boolean;
};

function resolveIrcGroupScope(params: {
  groups?: Record<string, IrcChannelConfig>;
  target: string;
}) {
  const { "*": wildcard, ...groups } = params.groups ?? {};
  // This adapter historically reads tools only; do not widen it to toolsBySender.
  const project = (entry: IrcChannelConfig) => ({
    requireMention: entry.requireMention,
    tools: entry.tools,
  });
  const tree: ScopeTree = {
    defaults: wildcard ? project(wildcard) : undefined,
    scopes: Object.fromEntries(Object.entries(groups).map(([key, entry]) => [key, project(entry)])),
  };
  // Legacy IRC matching checks exact keys before case-insensitive keys;
  // the canonical helper preserves that order.
  const key = resolveScopeKeyCaseInsensitive(tree, params.target);
  return { tree, path: key ? [key] : [] };
}

export function resolveIrcGroupMatch(params: {
  groups?: Record<string, IrcChannelConfig>;
  target: string;
}): IrcGroupMatch {
  const { path } = resolveIrcGroupScope(params);
  const key = path[0];
  const groupConfig = key ? params.groups?.[key] : undefined;
  const wildcardConfig = params.groups?.["*"];
  return {
    allowed: Boolean(groupConfig ?? wildcardConfig),
    groupConfig,
    wildcardConfig,
    hasConfiguredGroups: Object.keys(params.groups ?? {}).length > 0,
  };
}

export function resolveIrcGroupRequireMention(params: {
  groups?: Record<string, IrcChannelConfig>;
  target: string;
}): boolean {
  const { tree, path } = resolveIrcGroupScope(params);
  return resolveScopeRequireMention({ tree, path });
}

export function resolveIrcGroupToolPolicy(params: {
  groups?: Record<string, IrcChannelConfig>;
  target: string;
}): GroupToolPolicyConfig | undefined {
  const { tree, path } = resolveIrcGroupScope(params);
  return resolveScopeToolsPolicy({ tree, path });
}
