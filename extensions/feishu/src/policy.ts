import {
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { evaluateSenderGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { AllowlistMatch, ChannelGroupContext } from "../runtime-api.js";
import { detectIdType } from "./targets.js";
import type { FeishuConfig } from "./types.js";

export type FeishuAllowlistMatch = AllowlistMatch<"wildcard" | "id">;

const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/i;

function stripRepeatedFeishuProviderPrefixes(raw: string): string {
  let normalized = raw.trim();
  while (FEISHU_PROVIDER_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(FEISHU_PROVIDER_PREFIX_RE, "").trim();
  }
  return normalized;
}

function canonicalizeFeishuAllowlistKey(params: { kind: "chat" | "user"; value: string }): string {
  const value = params.value.trim();
  if (!value) {
    return "";
  }
  // A typed wildcard (`chat:*`, `user:*`, `open_id:*`, `dm:*`, `group:*`,
  // `channel:*`) collapses to the bare wildcard so it keeps matching across
  // both kinds, preserving the prior `normalizeFeishuTarget`-based behavior.
  if (value === "*") {
    return "*";
  }
  return `${params.kind}:${value}`;
}

function normalizeFeishuAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }

  const withoutProviderPrefix = stripRepeatedFeishuProviderPrefixes(trimmed);
  if (withoutProviderPrefix === "*") {
    return "*";
  }
  const lowered = normalizeOptionalLowercaseString(withoutProviderPrefix) ?? "";
  if (!lowered) {
    return "";
  }
  // Lowercase for prefix detection only; preserve the original ID casing in the
  // canonicalized key. Sender candidates pass through this same path so allowlist
  // entries and runtime IDs stay normalized symmetrically.
  if (
    lowered.startsWith("chat:") ||
    lowered.startsWith("group:") ||
    lowered.startsWith("channel:")
  ) {
    return canonicalizeFeishuAllowlistKey({
      kind: "chat",
      value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1),
    });
  }
  if (lowered.startsWith("user:") || lowered.startsWith("dm:")) {
    return canonicalizeFeishuAllowlistKey({
      kind: "user",
      value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1),
    });
  }
  if (lowered.startsWith("open_id:")) {
    return canonicalizeFeishuAllowlistKey({
      kind: "user",
      value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1),
    });
  }

  const detectedType = detectIdType(withoutProviderPrefix);
  if (detectedType === "chat_id") {
    return canonicalizeFeishuAllowlistKey({
      kind: "chat",
      value: withoutProviderPrefix,
    });
  }
  if (detectedType === "open_id" || detectedType === "user_id") {
    return canonicalizeFeishuAllowlistKey({
      kind: "user",
      value: withoutProviderPrefix,
    });
  }

  return "";
}

export function resolveFeishuAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): FeishuAllowlistMatch {
  const allowFrom = params.allowFrom
    .map((entry) => normalizeFeishuAllowEntry(String(entry)))
    .filter(Boolean);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  // Feishu allowlists are ID-based; mutable display names must never grant access.
  const senderCandidates = [params.senderId, ...(params.senderIds ?? [])]
    .map((entry) => normalizeFeishuAllowEntry(entry ?? ""))
    .filter(Boolean);

  for (const senderId of senderCandidates) {
    if (allowFrom.includes(senderId)) {
      return { allowed: true, matchKey: senderId, matchSource: "id" };
    }
  }

  return { allowed: false };
}

export function resolveFeishuGroupConfig(params: { cfg?: FeishuConfig; groupId?: string | null }) {
  const groups = params.cfg?.groups ?? {};
  const wildcard = groups["*"];
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return undefined;
  }

  const direct = groups[groupId];
  if (direct) {
    return direct;
  }

  const lowered = normalizeOptionalLowercaseString(groupId) ?? "";
  const matchKey = Object.keys(groups).find(
    (key) => normalizeOptionalLowercaseString(key) === lowered,
  );
  if (matchKey) {
    return groups[matchKey];
  }
  return wildcard;
}

export function hasExplicitFeishuGroupConfig(params: {
  cfg?: FeishuConfig;
  groupId?: string | null;
}): boolean {
  const groups = params.cfg?.groups ?? {};
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(groups, groupId) && groupId !== "*") {
    return true;
  }

  const lowered = normalizeOptionalLowercaseString(groupId) ?? "";
  return Object.keys(groups).some(
    (key) => key !== "*" && normalizeOptionalLowercaseString(key) === lowered,
  );
}

export function resolveFeishuGroupToolPolicy(params: ChannelGroupContext) {
  const cfg = params.cfg.channels?.feishu;
  if (!cfg) {
    return undefined;
  }

  const groupConfig = resolveFeishuGroupConfig({
    cfg,
    groupId: params.groupId,
  });

  return groupConfig?.tools;
}

export function isFeishuGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled" | "allowall";
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): boolean {
  return evaluateSenderGroupAccessForPolicy({
    groupPolicy: params.groupPolicy === "allowall" ? "open" : params.groupPolicy,
    groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
    senderId: params.senderId,
    isSenderAllowed: () => resolveFeishuAllowlistMatch(params).allowed,
  }).allowed;
}

export function resolveFeishuReplyPolicy(params: {
  isDirectMessage: boolean;
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  /**
   * Effective group policy resolved for this chat. When "open", requireMention
   * defaults to false so that non-text messages (e.g. images) that cannot carry
   * @-mentions are still delivered to the agent.
   */
  groupPolicy?: "open" | "allowlist" | "disabled" | "allowall";
}): { requireMention: boolean } {
  if (params.isDirectMessage) {
    return { requireMention: false };
  }

  const feishuCfg = params.cfg.channels?.feishu;
  const resolvedCfg = resolveMergedAccountConfig<FeishuConfig>({
    channelConfig: feishuCfg,
    accounts: feishuCfg?.accounts as Record<string, Partial<FeishuConfig>> | undefined,
    accountId: normalizeAccountId(params.accountId),
    normalizeAccountId,
    omitKeys: ["defaultAccount"],
  });
  const groupRequireMention = resolveFeishuGroupConfig({
    cfg: resolvedCfg,
    groupId: params.groupId,
  })?.requireMention;

  return {
    requireMention:
      typeof groupRequireMention === "boolean"
        ? groupRequireMention
        : typeof resolvedCfg.requireMention === "boolean"
          ? resolvedCfg.requireMention
          : params.groupPolicy !== "open",
  };
}
