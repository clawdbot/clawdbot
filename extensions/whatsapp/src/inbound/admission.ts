import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { WhatsAppIdentity } from "../identity.js";
import type { DeprecatedWebInboundAdmissionTopLevelFields } from "./admission-types.js";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";

type WhatsAppInboundIngressDecision = Pick<
  ResolvedChannelMessageIngress["ingress"],
  "admission" | "decision" | "decisiveGateId" | "reasonCode"
>;

type WhatsAppInboundSenderAccess = Pick<
  ResolvedChannelMessageIngress["senderAccess"],
  "allowed" | "decision" | "reasonCode" | "providerMissingFallbackApplied"
>;

type WhatsAppInboundCommandAccess = Pick<
  ResolvedChannelMessageIngress["commandAccess"],
  "requested" | "authorized" | "shouldBlockControlCommand" | "reasonCode"
>;

type WhatsAppInboundActivationAccess = Pick<
  ResolvedChannelMessageIngress["activationAccess"],
  "ran" | "allowed" | "shouldSkip" | "reasonCode"
>;

type WhatsAppInboundAdmissionAccess = {
  ingress: WhatsAppInboundIngressDecision;
  senderAccess: WhatsAppInboundSenderAccess;
  commandAccess: WhatsAppInboundCommandAccess;
  activationAccess: WhatsAppInboundActivationAccess;
};

type WhatsAppInboundAdmissionPolicy = {
  account: {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  isSelfChat: boolean;
  isSamePhone: (value?: string | null) => boolean;
};

type DeprecatedFlatWhatsAppInboundAdmissionInput =
  Partial<DeprecatedWebInboundAdmissionTopLevelFields> & {
    platform?: {
      sender?: WhatsAppIdentity;
      senderE164?: string | null;
      senderJid?: string | null;
      senderName?: string | null;
    };
    senderE164?: string | null;
    senderJid?: string | null;
    senderName?: string | null;
  };

type WhatsAppInboundAdmissionCarrier = {
  admission?: WhatsAppInboundAdmission;
};

type AdmittedWhatsAppInboundMessage<T extends WhatsAppInboundAdmissionCarrier> = Omit<
  T,
  keyof DeprecatedWebInboundAdmissionTopLevelFields | "admission"
> & {
  admission: WhatsAppInboundAdmission;
};

/**
 * Public-safe accepted inbound facts resolved by access control.
 *
 * Keep this as an admission envelope around canonical channel ingress
 * projections. Later PRs can migrate consumers to these projections without
 * publishing raw allowlist material or session-dependent post-admission state.
 */
export type WhatsAppInboundAdmission = {
  accountId: string;
  isSelfChat: boolean;
  account: {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  conversation: {
    kind: "direct" | "group";
    id: string;
    groupSessionId: string;
  };
  sender: {
    id: string;
    isSamePhone: boolean;
  };
  ingress: WhatsAppInboundIngressDecision;
  senderAccess: WhatsAppInboundSenderAccess;
  commandAccess: WhatsAppInboundCommandAccess;
  activationAccess: WhatsAppInboundActivationAccess;
};

function copyAccount(
  account: WhatsAppInboundAdmissionPolicy["account"],
): WhatsAppInboundAdmission["account"] {
  const copied: WhatsAppInboundAdmission["account"] = {
    accountId: account.accountId,
    enabled: account.enabled,
    sendReadReceipts: account.sendReadReceipts,
  };
  if (account.name) {
    copied.name = account.name;
  }
  if (typeof account.selfChatMode === "boolean") {
    copied.selfChatMode = account.selfChatMode;
  }
  if (account.replyToMode) {
    copied.replyToMode = account.replyToMode;
  }
  return copied;
}

export function buildWhatsAppInboundAdmission(params: {
  policy: WhatsAppInboundAdmissionPolicy;
  access: WhatsAppInboundAdmissionAccess;
  isGroup: boolean;
  conversationId: string;
  senderId: string;
}): WhatsAppInboundAdmission {
  return {
    accountId: params.policy.account.accountId,
    isSelfChat: params.policy.isSelfChat,
    account: copyAccount(params.policy.account),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
      groupSessionId: resolveWhatsAppGroupConversationId(params.conversationId),
    },
    sender: {
      id: params.senderId,
      isSamePhone: params.policy.isSamePhone(params.senderId),
    },
    ingress: {
      admission: params.access.ingress.admission,
      decision: params.access.ingress.decision,
      decisiveGateId: params.access.ingress.decisiveGateId,
      reasonCode: params.access.ingress.reasonCode,
    },
    senderAccess: {
      allowed: params.access.senderAccess.allowed,
      decision: params.access.senderAccess.decision,
      reasonCode: params.access.senderAccess.reasonCode,
      providerMissingFallbackApplied: params.access.senderAccess.providerMissingFallbackApplied,
    },
    commandAccess: {
      requested: params.access.commandAccess.requested,
      authorized: params.access.commandAccess.authorized,
      shouldBlockControlCommand: params.access.commandAccess.shouldBlockControlCommand,
      reasonCode: params.access.commandAccess.reasonCode,
    },
    activationAccess: {
      ran: params.access.activationAccess.ran,
      allowed: params.access.activationAccess.allowed,
      shouldSkip: params.access.activationAccess.shouldSkip,
      reasonCode: params.access.activationAccess.reasonCode,
    },
  };
}

export function buildDeprecatedFlatWhatsAppInboundAdmission(
  msg: DeprecatedFlatWhatsAppInboundAdmissionInput,
): WhatsAppInboundAdmission {
  const conversationId = msg.conversationId || msg.from;
  if (!conversationId || !msg.accountId || !msg.chatType) {
    throw new Error(
      "WhatsApp legacy flat inbound messages must include deprecated top-level admission fields.",
    );
  }
  const accountId = msg.accountId;
  const admitted = msg.accessControlPassed !== false;
  const platformSender = msg.platform?.sender;
  const senderE164 = platformSender?.e164 ?? msg.platform?.senderE164 ?? msg.senderE164;
  const senderJid = platformSender?.jid ?? msg.platform?.senderJid ?? msg.senderJid;
  const senderName = platformSender?.name ?? msg.platform?.senderName ?? msg.senderName;
  const senderId =
    msg.chatType === "group"
      ? (senderE164 ?? senderJid ?? senderName ?? conversationId)
      : (senderE164 ?? conversationId);
  const reasonCode = admitted
    ? msg.chatType === "group"
      ? "group_policy_allowed"
      : "dm_policy_allowlisted"
    : "no_policy_match";

  // Compatibility only: deprecated listenerFactory flat inputs predate the
  // admission envelope, so convert them through the canonical admission builder.
  // Canonical nested inputs without admission remain malformed for runtime use.
  return buildWhatsAppInboundAdmission({
    policy: {
      account: {
        accountId,
        enabled: true,
        sendReadReceipts: true,
      },
      isSelfChat: false,
      isSamePhone: () => false,
    },
    access: {
      ingress: {
        admission: admitted ? "dispatch" : "drop",
        decision: admitted ? "allow" : "block",
        decisiveGateId: "legacy-flat-compat",
        reasonCode,
      },
      senderAccess: {
        allowed: admitted,
        decision: admitted ? "allow" : "block",
        reasonCode,
        providerMissingFallbackApplied: false,
      },
      commandAccess: {
        requested: false,
        authorized: false,
        shouldBlockControlCommand: false,
        reasonCode: "command_authorized",
      },
      activationAccess: {
        ran: false,
        allowed: admitted,
        shouldSkip: !admitted,
        reasonCode: admitted ? "activation_allowed" : "activation_skipped",
      },
    },
    isGroup: msg.chatType === "group",
    conversationId,
    senderId,
  });
}

export function requireWhatsAppInboundAdmission(
  params: WhatsAppInboundAdmissionCarrier,
): WhatsAppInboundAdmission {
  if (!params.admission) {
    throw new Error("WhatsApp inbound message is missing admission facts");
  }
  return params.admission;
}

export function requireAdmittedWhatsAppInboundMessage<T extends WhatsAppInboundAdmissionCarrier>(
  msg: T,
): AdmittedWhatsAppInboundMessage<T> {
  requireWhatsAppInboundAdmission(msg);
  return msg as AdmittedWhatsAppInboundMessage<T>;
}
