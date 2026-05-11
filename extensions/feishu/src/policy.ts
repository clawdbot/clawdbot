import {
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentitySubjectInput,
  type ResolveChannelMessageIngressParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelGroupContext } from "../runtime-api.js";
import { detectIdType } from "./targets.js";
import type { FeishuConfig } from "./types.js";

type FeishuDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type FeishuGroupPolicy = "open" | "allowlist" | "disabled" | "allowall";
type NormalizedFeishuGroupPolicy = Exclude<FeishuGroupPolicy, "allowall">;

const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/i;
const FEISHU_TYPED_PREFIX_RE = /^(chat|group|channel|user|dm|open_id):/i;
const FEISHU_ID_KIND = "plugin:feishu-id" as const;
const feishuIngressIdentity = defineStableChannelIngressIdentity({
  key: "feishu-id",
  kind: FEISHU_ID_KIND,
  normalize: normalizeFeishuAllowEntry,
  sensitivity: "pii",
  aliases: [
    {
      key: "feishu-alt-id",
      kind: FEISHU_ID_KIND,
      normalizeEntry: () => null,
      normalizeSubject: normalizeFeishuAllowEntry,
      sensitivity: "pii",
    },
  ],
  isWildcardEntry: (entry) => normalizeFeishuAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex }) => `feishu-entry-${entryIndex + 1}`,
});

function normalizeFeishuAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }

  let withoutProviderPrefix = trimmed;
  while (FEISHU_PROVIDER_PREFIX_RE.test(withoutProviderPrefix)) {
    withoutProviderPrefix = withoutProviderPrefix.replace(FEISHU_PROVIDER_PREFIX_RE, "").trim();
  }
  if (withoutProviderPrefix === "*") {
    return "*";
  }
  const lowered = normalizeOptionalLowercaseString(withoutProviderPrefix) ?? "";
  if (!lowered) {
    return "";
  }
  const prefixed = lowered.match(FEISHU_TYPED_PREFIX_RE);
  if (prefixed?.[1]) {
    const kind = ["chat", "group", "channel"].includes(prefixed[1]) ? "chat" : "user";
    const value = withoutProviderPrefix.slice(prefixed[0].length).trim();
    return value === "*" ? "*" : value ? `${kind}:${value}` : "";
  }

  const detectedType = detectIdType(withoutProviderPrefix);
  if (detectedType === "chat_id") {
    return `chat:${withoutProviderPrefix}`;
  }
  if (detectedType === "open_id" || detectedType === "user_id") {
    return `user:${withoutProviderPrefix}`;
  }

  return "";
}

function normalizeFeishuDmPolicy(policy: string | null | undefined): FeishuDmPolicy {
  return policy === "open" ||
    policy === "pairing" ||
    policy === "allowlist" ||
    policy === "disabled"
    ? policy
    : "pairing";
}

function normalizeFeishuGroupPolicy(policy: FeishuGroupPolicy): NormalizedFeishuGroupPolicy {
  return policy === "allowall" ? "open" : policy;
}

function createFeishuIngressSubject(params: {
  primaryId?: string | null;
  alternateIds?: Array<string | null | undefined>;
}): ChannelIngressIdentitySubjectInput {
  const ids = [params.primaryId, ...(params.alternateIds ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return {
    stableId: ids[0],
    aliases: {
      "feishu-alt-id": ids[1],
    },
  };
}

function createFeishuIngressResolver(params: {
  cfg?: OpenClawConfig;
  accountId?: string | null;
  readAllowFromStore?: ResolveChannelMessageIngressParams["readStoreAllowFrom"];
}) {
  return createChannelIngressResolver({
    channelId: "feishu",
    accountId: normalizeAccountId(params.accountId) ?? "default",
    identity: feishuIngressIdentity,
    cfg: params.cfg,
    ...(params.readAllowFromStore ? { readStoreAllowFrom: params.readAllowFromStore } : {}),
  });
}

export async function resolveFeishuDmIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  readAllowFromStore?: () => Promise<Array<string | number>>;
  senderOpenId: string;
  senderUserId?: string | null;
  conversationId: string;
  mayPair: boolean;
  command?: { hasControlCommand: boolean };
}) {
  return await createFeishuIngressResolver({
    cfg: params.cfg,
    accountId: params.accountId,
    readAllowFromStore: params.readAllowFromStore,
  }).message({
    subject: createFeishuIngressSubject({
      primaryId: params.senderOpenId,
      alternateIds: [params.senderUserId],
    }),
    conversation: {
      kind: "direct",
      id: params.conversationId,
    },
    event: {
      mayPair: params.mayPair,
    },
    dmPolicy: normalizeFeishuDmPolicy(params.dmPolicy),
    groupPolicy: "disabled",
    allowFrom: params.allowFrom ?? [],
    ...(params.command ? { command: params.command } : {}),
  });
}

export async function resolveFeishuGroupConversationIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatId: string;
  groupPolicy: FeishuGroupPolicy;
  groupAllowFrom?: Array<string | number> | null;
  groupExplicitlyConfigured?: boolean;
}) {
  const groupPolicy = normalizeFeishuGroupPolicy(params.groupPolicy);
  const groupAllowFrom =
    groupPolicy === "allowlist" && params.groupExplicitlyConfigured
      ? [...(params.groupAllowFrom ?? []), params.chatId]
      : (params.groupAllowFrom ?? []);
  return await createFeishuIngressResolver({
    cfg: params.cfg,
    accountId: params.accountId,
  }).message({
    subject: createFeishuIngressSubject({
      primaryId: params.chatId,
    }),
    conversation: {
      kind: "group",
      id: params.chatId,
    },
    dmPolicy: "disabled",
    groupPolicy,
    groupAllowFrom,
  });
}

export async function resolveFeishuGroupSenderActivationIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatId: string;
  allowFrom?: Array<string | number> | null;
  senderOpenId: string;
  senderUserId?: string | null;
  requireMention: boolean;
  mentionedBot: boolean;
  command?: { hasControlCommand: boolean };
}) {
  const groupAllowFrom = params.allowFrom ?? [];
  return await createFeishuIngressResolver({
    cfg: params.cfg,
    accountId: params.accountId,
  }).message({
    subject: createFeishuIngressSubject({
      primaryId: params.senderOpenId,
      alternateIds: [params.senderUserId],
    }),
    conversation: {
      kind: "group",
      id: params.chatId,
    },
    dmPolicy: "disabled",
    groupPolicy: groupAllowFrom.length > 0 ? "allowlist" : "open",
    groupAllowFrom,
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: params.mentionedBot,
    },
    policy: {
      activation: {
        requireMention: params.requireMention,
        allowTextCommands: false,
      },
    },
    ...(params.command ? { command: params.command } : {}),
  });
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
