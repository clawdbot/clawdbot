// Twitch plugin module implements access control behavior.
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressContextBinding,
  type ChannelIngressIdentitySubjectInput,
  type IngressReasonCode,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

type TwitchAccessControlResult =
  | {
      allowed: false;
      reason?: string;
      matchKey?: string;
      matchSource?: string;
    }
  | {
      allowed: true;
      channelIngress: Awaited<
        ReturnType<ReturnType<typeof createChannelIngressResolver>["message"]>
      >;
      reason?: string;
      matchKey?: string;
      matchSource?: string;
    };

type TwitchPolicyKind = "open" | "allowFrom" | "role";

const twitchUserIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  entryIdPrefix: "twitch-user-entry",
});

const twitchRoleIdentity = defineStableChannelIngressIdentity({
  // Roles authorize the sender; only the native user ID identifies the participant.
  key: "sender-id",
  normalizeEntry: () => null,
  aliases: ["moderator", "owner", "vip", "subscriber"].map((role) => ({
    key: `role-${role}`,
    kind: "role",
    normalizeEntry: (entry) => (normalizeTwitchRole(entry) === role ? role : null),
    normalizeSubject: normalizeTwitchRole,
  })),
  resolveEntryId: ({ entryIndex }) => `twitch-role-entry-${entryIndex + 1}`,
});

export async function checkTwitchAccessControl(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  accountId: string;
  botUsername: string;
  contextBinding?: ChannelIngressContextBinding;
}): Promise<TwitchAccessControlResult> {
  const { message, account, botUsername } = params;
  const policyKind = resolveTwitchPolicyKind(account);
  const resolved = await createChannelIngressResolver({
    channelId: "twitch",
    accountId: params.accountId,
    identity: policyKind === "role" ? twitchRoleIdentity : twitchUserIdentity,
  }).message({
    subject: twitchSubject(message),
    conversation: {
      kind: "group",
      id: message.channel,
    },
    contextBinding: params.contextBinding,
    event: { mayPair: false },
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: mentionsBot(message.message, botUsername),
    },
    dmPolicy: "open",
    groupPolicy: policyKind === "open" ? "open" : "allowlist",
    policy: {
      activation: {
        requireMention: account.requireMention ?? true,
        allowTextCommands: false,
        order: "before-sender",
      },
    },
    // Canonical wildcard input keeps admission and participant evidence aligned.
    groupAllowFrom:
      policyKind === "allowFrom"
        ? account.allowFrom
        : policyKind === "role"
          ? account.allowedRoles?.map((role) => (role === "all" ? "*" : role))
          : undefined,
  });
  const decision = resolved.ingress;

  if (decision.decisiveGateId === "activation" && decision.admission !== "dispatch") {
    return {
      allowed: false,
      reason: "message does not mention the bot (requireMention is enabled)",
    };
  }

  if (decision.admission === "dispatch") {
    if (policyKind === "allowFrom") {
      return {
        allowed: true,
        channelIngress: resolved,
        matchKey: params.message.userId,
        matchSource: "allowlist",
      };
    }
    if (policyKind === "role") {
      return {
        allowed: true,
        channelIngress: resolved,
        matchKey: params.account.allowedRoles?.join(","),
        matchSource: "role",
      };
    }
    return {
      allowed: true,
      channelIngress: resolved,
    };
  }

  if (policyKind === "allowFrom") {
    if (!params.message.userId) {
      return {
        allowed: false,
        reason: "sender user ID not available for allowlist check",
      };
    }
    return {
      allowed: false,
      reason: "sender is not in allowFrom allowlist",
    };
  }

  if (policyKind === "role") {
    return {
      allowed: false,
      reason: `sender does not have any of the required roles: ${params.account.allowedRoles?.join(", ") ?? ""}`,
    };
  }

  return {
    allowed: false,
    reason: reasonForTwitchIngressDecision(decision),
  };
}

function resolveTwitchPolicyKind(account: TwitchAccountConfig): TwitchPolicyKind {
  if (account.allowFrom !== undefined) {
    return "allowFrom";
  }
  if (account.allowedRoles && account.allowedRoles.length > 0) {
    return "role";
  }
  return "open";
}

function twitchSubject(message: TwitchChatMessage): ChannelIngressIdentitySubjectInput {
  return {
    stableId: message.userId,
    aliases: {
      "role-moderator": message.isMod ? "moderator" : undefined,
      "role-owner": message.isOwner ? "owner" : undefined,
      "role-vip": message.isVip ? "vip" : undefined,
      "role-subscriber": message.isSub ? "subscriber" : undefined,
    },
  };
}

function normalizeTwitchRole(value: string): string | null {
  const role = normalizeLowercaseStringOrEmpty(value);
  return role === "moderator" || role === "owner" || role === "vip" || role === "subscriber"
    ? role
    : null;
}

function reasonForTwitchIngressDecision(decision: { reasonCode: IngressReasonCode }): string {
  switch (decision.reasonCode) {
    case "activation_skipped":
      return "message does not mention the bot (requireMention is enabled)";
    case "group_policy_empty_allowlist":
    case "group_policy_not_allowlisted":
      return "sender is not in allowFrom allowlist";
    default:
      return decision.reasonCode;
  }
}

function mentionsBot(message: string, botUsername: string): boolean {
  const expected = normalizeLowercaseStringOrEmpty(botUsername);
  const mentionRegex = /@(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(message)) !== null) {
    const username = match[1] ? normalizeLowercaseStringOrEmpty(match[1]) : "";
    if (username === expected) {
      return true;
    }
  }

  return false;
}
