import {
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { evaluateSenderGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { AllowlistMatch, ChannelGroupContext, GroupToolPolicyConfig } from "../runtime-api.js";
import { normalizeFeishuTarget } from "./targets.js";
import type { FeishuConfig, FeishuGroupConfig } from "./types.js";

export type FeishuAllowlistMatch = AllowlistMatch<"wildcard" | "id">;

function normalizeFeishuAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  const withoutProviderPrefix = trimmed.replace(/^feishu:/i, "");
  const normalized = normalizeFeishuTarget(withoutProviderPrefix) ?? withoutProviderPrefix;
  return normalizeOptionalLowercaseString(normalized) ?? "";
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

export function resolveFeishuGroupConfig(params: {
  cfg?: FeishuConfig;
  groupId?: string | null;
}): FeishuGroupConfig | undefined {
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

export function resolveFeishuGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.feishu as FeishuConfig | undefined;
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

  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;
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
