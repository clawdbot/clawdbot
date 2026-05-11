import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentitySubjectInput,
  type IngressReasonCode,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

type TwitchAccessControlResult = {
  allowed: boolean;
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
  key: "role-moderator",
  kind: "role",
  normalizeEntry: normalizeTwitchRole,
  normalizeSubject: normalizeTwitchRole,
  aliases: ["owner", "vip", "subscriber"].map((role) => ({
    key: `role-${role}`,
    kind: "role",
    normalizeEntry: () => null,
    normalizeSubject: normalizeTwitchRole,
  })),
  isWildcardEntry: (entry) => normalizeTwitchRole(entry) === "all",
  resolveEntryId: ({ entryIndex }) => `twitch-role-entry-${entryIndex + 1}`,
});

export async function checkTwitchAccessControl(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  botUsername: string;
}): Promise<TwitchAccessControlResult> {
  const { message, account, botUsername } = params;
  const policyKind = resolveTwitchPolicyKind(account);
  const resolved = await createChannelIngressResolver({
    channelId: "twitch",
    accountId: "default",
    identity: policyKind === "role" ? twitchRoleIdentity : twitchUserIdentity,
  }).message({
    subject:
      policyKind === "role"
        ? twitchRoleSubject(message)
        : ({ stableId: message.userId } satisfies ChannelIngressIdentitySubjectInput),
    conversation: {
      kind: "group",
      id: message.channel,
    },
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
    groupAllowFrom:
      policyKind === "allowFrom"
        ? account.allowFrom
        : policyKind === "role"
          ? account.allowedRoles
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
        matchKey: params.message.userId,
        matchSource: "allowlist",
      };
    }
    if (policyKind === "role") {
      return {
        allowed: true,
        matchKey: params.account.allowedRoles?.join(","),
        matchSource: "role",
      };
    }
    return {
      allowed: true,
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

function twitchRoleSubject(message: TwitchChatMessage): ChannelIngressIdentitySubjectInput {
  return {
    stableId: message.isMod ? "moderator" : undefined,
    aliases: {
      "role-owner": message.isOwner ? "owner" : undefined,
      "role-vip": message.isVip ? "vip" : undefined,
      "role-subscriber": message.isSub ? "subscriber" : undefined,
    },
  };
}

function normalizeTwitchRole(value: string): string | null {
  const role = normalizeLowercaseStringOrEmpty(value);
  if (role === "*") {
    return "all";
  }
  return role === "moderator" ||
    role === "owner" ||
    role === "vip" ||
    role === "subscriber" ||
    role === "all"
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
