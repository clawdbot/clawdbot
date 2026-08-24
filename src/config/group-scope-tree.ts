// Resolves canonical group policy scopes prepared by channel plugins.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import { resolveChannelGroups, resolveToolsBySender } from "./group-policy.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type ScopeNode = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  introHint?: string;
};

export type ScopeTree = {
  defaults?: ScopeNode;
  // Flat keys preserve channel-defined precedence: channels emit broad-to-narrow paths.
  // Nested trees cannot model Telegram, where a wildcard-group topic outranks
  // an exact-group scalar requireMention.
  scopes: Record<string, ScopeNode>;
};

export type ScopePath = string[];

export const encodeScopeSegment = (value: string) => `${value.length}:${value}`;

export function scopeKey(...segments: Array<readonly [prefix: string, value: string]>): string {
  return segments.map(([prefix, value]) => `${prefix}:${encodeScopeSegment(value)}`).join("/");
}

type ScopeToolPolicySender = Omit<Parameters<typeof resolveToolsBySender>[0], "toolsBySender">;

export function buildChannelGroupsScopeTree(
  cfg: OpenClawConfig,
  channel: ChannelId,
  accountId?: string | null,
): ScopeTree {
  // 13+ channels share the flat `groups` config shape; richer channels such as
  // Discord, Telegram, and Microsoft Teams ship their own builders.
  const groups = resolveChannelGroups(cfg, channel, accountId) ?? {};
  // The wildcard config is the fallback node, not a matchable exact scope.
  const { "*": defaults, ...scopes } = groups;
  return { defaults, scopes };
}

export function resolveScopeKeyCaseInsensitive(
  tree: ScopeTree,
  key: string | null | undefined,
): string | undefined {
  if (!key) {
    return undefined;
  }
  // Exact scope identity wins; keys are matched untrimmed for parity with the
  // legacy resolver. Wildcard never matches: builders move it to `defaults`.
  if (Object.hasOwn(tree.scopes, key)) {
    return key;
  }
  const target = normalizeLowercaseStringOrEmpty(key);
  return Object.keys(tree.scopes).find(
    (candidate) => normalizeLowercaseStringOrEmpty(candidate) === target,
  );
}

function resolveFromScopes<Value>(params: {
  tree: ScopeTree;
  path: ScopePath;
  resolveNode: (node: ScopeNode) => Value | undefined;
}): Value | undefined {
  for (let index = params.path.length - 1; index >= 0; index -= 1) {
    const key = params.path[index];
    if (key === undefined || !Object.hasOwn(params.tree.scopes, key)) {
      continue;
    }
    const node = params.tree.scopes[key];
    if (!node) {
      continue;
    }
    const value = params.resolveNode(node);
    if (value !== undefined) {
      return value;
    }
  }
  return params.tree.defaults ? params.resolveNode(params.tree.defaults) : undefined;
}

export function resolveScopeRequireMention(params: {
  tree: ScopeTree;
  path: ScopePath;
  requireMentionOverride?: boolean;
  overrideOrder?: "before-config" | "after-config";
  configuredScopeDefaultsToNoMention?: boolean;
}): boolean {
  // Runtime overrides stay in resolver parameters because channels derive them per message.
  const { requireMentionOverride, overrideOrder = "after-config" } = params;
  const configuredMention = resolveFromScopes({
    tree: params.tree,
    path: params.path,
    resolveNode: (node) => node.requireMention,
  });

  if (overrideOrder === "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  if (typeof configuredMention === "boolean") {
    return configuredMention;
  }
  if (overrideOrder !== "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  if (
    params.configuredScopeDefaultsToNoMention &&
    params.path.some((key) => Object.hasOwn(params.tree.scopes, key))
  ) {
    return false;
  }
  return true;
}

export function resolveScopeToolsPolicy(
  params: {
    tree: ScopeTree;
    path: ScopePath;
  } & ScopeToolPolicySender,
): GroupToolPolicyConfig | undefined {
  return resolveFromScopes({
    tree: params.tree,
    path: params.path,
    resolveNode: (node) =>
      (params.senderPolicyMode === "never"
        ? undefined
        : resolveToolsBySender({
            toolsBySender: node.toolsBySender,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            messageProvider: params.messageProvider,
          })) ?? node.tools,
  });
}

export function resolveScopeIntroHint(params: {
  tree: ScopeTree;
  path: ScopePath;
}): string | undefined {
  return resolveFromScopes({
    tree: params.tree,
    path: params.path,
    resolveNode: (node) => node.introHint,
  });
}
