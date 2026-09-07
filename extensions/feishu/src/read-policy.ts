import {
  compileAllowlist,
  resolveAllowlistMatchByCandidates,
} from "openclaw/plugin-sdk/allow-from";
import { ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeFeishuChatType } from "./chat-type.js";
import {
  hasExplicitFeishuGroupConfig,
  normalizeFeishuAllowEntry,
  resolveFeishuGroupConfig,
} from "./policy.js";
import { detectIdType, normalizeFeishuTarget } from "./targets.js";
import type { FeishuChatType, ResolvedFeishuAccount } from "./types.js";

type FeishuActionReadContext = Pick<
  ChannelMessageActionContext,
  | "accountId"
  | "conversationReadOrigin"
  | "requesterAccountId"
  | "requesterSenderId"
  | "toolContext"
>;

type FeishuReadContext = FeishuActionReadContext | OpenClawPluginToolContext;

function isActionContext(ctx: FeishuReadContext): ctx is FeishuActionReadContext {
  return "toolContext" in ctx;
}

function normalizeChatId(raw?: string | null): string {
  if (!raw) {
    return "";
  }
  return normalizeFeishuTarget(raw) ?? raw.trim();
}

function normalizeFeishuAllowlist(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => normalizeFeishuAllowEntry(String(entry))).filter(Boolean);
}

function readContextFields(ctx: FeishuReadContext): {
  accountId?: string;
  currentChannelId?: string;
  currentProvider?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  directOperator: boolean;
} {
  if (isActionContext(ctx)) {
    return {
      accountId: normalizeOptionalString(ctx.accountId),
      currentChannelId: normalizeOptionalString(ctx.toolContext?.currentChannelId),
      currentProvider: normalizeOptionalString(ctx.toolContext?.currentChannelProvider),
      requesterAccountId: normalizeOptionalString(ctx.requesterAccountId),
      requesterSenderId: normalizeOptionalString(ctx.requesterSenderId),
      directOperator: ctx.conversationReadOrigin === "direct-operator",
    };
  }
  return {
    accountId: normalizeOptionalString(ctx.agentAccountId),
    currentChannelId: normalizeOptionalString(ctx.nativeChannelId),
    currentProvider: normalizeOptionalString(ctx.messageChannel ?? ctx.deliveryContext?.channel),
    requesterAccountId: normalizeOptionalString(ctx.deliveryContext?.accountId),
    requesterSenderId: normalizeOptionalString(ctx.requesterSenderId),
    directOperator: ctx.conversationReadOrigin === "direct-operator",
  };
}

function isCurrentChat(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  ctx: FeishuReadContext;
}): boolean {
  const context = readContextFields(params.ctx);
  return (
    context.currentProvider?.toLowerCase() === "feishu" &&
    context.requesterAccountId === params.account.accountId &&
    (context.accountId ?? params.account.accountId) === params.account.accountId &&
    normalizeChatId(context.currentChannelId) === normalizeChatId(params.chatId)
  );
}

function resolveFeishuReadGroupPolicy(cfg: OpenClawConfig, account: ResolvedFeishuAccount) {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.feishu !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
  }).groupPolicy;
}

export function isFeishuGroupReadAllowed(
  cfg: OpenClawConfig,
  account: ResolvedFeishuAccount,
  chatId: string,
  current: boolean,
): boolean {
  const policy = resolveFeishuReadGroupPolicy(cfg, account);
  if (policy === "disabled") {
    return false;
  }
  const group = resolveFeishuGroupConfig({ cfg: account.config, groupId: chatId });
  if (group?.enabled === false) {
    return false;
  }
  if (current) {
    return true;
  }
  if (policy === "open") {
    return true;
  }
  const explicitlyConfigured = hasExplicitFeishuGroupConfig({
    cfg: account.config,
    groupId: chatId,
  });
  const normalizedChatId = normalizeFeishuAllowEntry(chatId);
  return (
    explicitlyConfigured ||
    resolveAllowlistMatchByCandidates({
      allowList: normalizeFeishuAllowlist(account.config.groupAllowFrom),
      candidates: [{ value: normalizedChatId, source: "id" }],
    }).allowed
  );
}

export function isFeishuGroupReadEnabled(
  cfg: OpenClawConfig,
  account: ResolvedFeishuAccount,
  chatId: string,
): boolean {
  if (resolveFeishuReadGroupPolicy(cfg, account) === "disabled") {
    return false;
  }
  return resolveFeishuGroupConfig({ cfg: account.config, groupId: chatId })?.enabled !== false;
}

function isDmUniversallyAllowed(account: ResolvedFeishuAccount): boolean {
  // Feishu's canonical schema has no disabled DM mode; channel/account enabled owns shutdown.
  // Account overrides merge field-by-field, so only an allowFrom wildcard proves
  // universal non-current access under every supported ingress policy.
  return compileAllowlist(normalizeFeishuAllowlist(account.config.allowFrom)).wildcard;
}

export function assertFeishuChatReadAllowed(params: {
  cfg: OpenClawConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  chatType?: FeishuChatType;
  ctx: FeishuReadContext;
}): string {
  const authorization = resolveFeishuChatReadPreliminaryAuthorization(params);
  if (authorization.decision !== "allow") {
    throw new ToolAuthorizationError("Feishu read target is not allowed.");
  }
  return authorization.chatId;
}

type FeishuChatReadPreliminaryDecision = "allow" | "deny" | "needs-metadata";

export function resolveFeishuChatReadPreliminaryAuthorization(params: {
  cfg: OpenClawConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  chatType?: FeishuChatType;
  ctx: FeishuReadContext;
}): {
  chatId: string;
  decision: FeishuChatReadPreliminaryDecision;
} {
  const chatId = normalizeChatId(params.chatId);
  const resolvedChatType = normalizeFeishuChatType(params.chatType);
  const knownGroup =
    resolvedChatType === "group" ||
    (params.chatType === undefined &&
      hasExplicitFeishuGroupConfig({
        cfg: params.account.config,
        groupId: chatId,
      }));
  const knownDm = resolvedChatType === "p2p";
  const current = isCurrentChat({ account: params.account, chatId, ctx: params.ctx });
  const directOperator = readContextFields(params.ctx).directOperator;
  const groupAllowed = directOperator
    ? isFeishuGroupReadEnabled(params.cfg, params.account, chatId)
    : isFeishuGroupReadAllowed(params.cfg, params.account, chatId, current);
  const dmAllowed = directOperator || current || isDmUniversallyAllowed(params.account);
  if (knownGroup) {
    return { chatId, decision: groupAllowed ? "allow" : "deny" };
  }
  if (knownDm) {
    return { chatId, decision: dmAllowed ? "allow" : "deny" };
  }
  if (groupAllowed === dmAllowed) {
    return { chatId, decision: groupAllowed ? "allow" : "deny" };
  }
  return { chatId, decision: "needs-metadata" };
}

export type FeishuChatMemberReadAuthorization =
  | { kind: "group"; chatId: string }
  | {
      kind: "direct";
      chatId: string;
      memberId: string;
      memberIdType: "open_id" | "user_id";
    };

export function authorizeFeishuChatMemberRead(params: {
  cfg: OpenClawConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  chatType?: FeishuChatType;
  ctx: FeishuReadContext;
  memberId?: string;
  memberIdType?: "open_id" | "user_id" | "union_id";
}): FeishuChatMemberReadAuthorization {
  const chatId = assertFeishuChatReadAllowed(params);
  const chatType = normalizeFeishuChatType(params.chatType);
  if (chatType === "group") {
    return { kind: "group", chatId };
  }
  if (chatType !== "p2p") {
    throw new ToolAuthorizationError("Feishu chat member reads require a known chat type.");
  }
  if (!isCurrentChat({ account: params.account, chatId, ctx: params.ctx })) {
    throw new ToolAuthorizationError(
      "Feishu direct-chat member reads require the current conversation.",
    );
  }
  const requesterSenderId = normalizeChatId(readContextFields(params.ctx).requesterSenderId);
  if (!requesterSenderId) {
    throw new ToolAuthorizationError("Feishu direct-chat member identity is unavailable.");
  }
  const requesterSenderIdType = detectIdType(requesterSenderId);
  if (requesterSenderIdType !== "open_id" && requesterSenderIdType !== "user_id") {
    throw new ToolAuthorizationError("Feishu direct-chat member identity type is unavailable.");
  }
  if (params.memberIdType && params.memberIdType !== requesterSenderIdType) {
    throw new ToolAuthorizationError(
      "Feishu direct-chat member identifier type must match the current sender.",
    );
  }
  if (params.memberId && normalizeChatId(params.memberId) !== requesterSenderId) {
    throw new ToolAuthorizationError(
      "Feishu direct-chat member reads are limited to the current sender.",
    );
  }
  return {
    kind: "direct",
    chatId,
    memberId: requesterSenderId,
    memberIdType: requesterSenderIdType,
  };
}

export function canEnumerateAllFeishuGroups(
  cfg: OpenClawConfig,
  account: ResolvedFeishuAccount,
): boolean {
  const policy = resolveFeishuReadGroupPolicy(cfg, account);
  return (
    policy === "open" ||
    (policy === "allowlist" &&
      compileAllowlist(normalizeFeishuAllowlist(account.config.groupAllowFrom)).wildcard)
  );
}

export function canEnumerateAllFeishuPeers(account: ResolvedFeishuAccount): boolean {
  return isDmUniversallyAllowed(account);
}
