import type { WhatsAppInboundAdmission } from "./admission.js";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";
import { createAcceptedWhatsAppSendResult } from "./send-result.test-helper.js";
import type { WebInboundCallbackMessage, WebInboundMessage } from "./types.js";

type WhatsAppInboundEvent = WebInboundCallbackMessage["event"];
type WhatsAppInboundPayload = WebInboundCallbackMessage["payload"];
type WhatsAppInboundPlatform = WebInboundCallbackMessage["platform"];

type TestWhatsAppInboundAdmissionOverrides = Partial<
  Omit<
    WhatsAppInboundAdmission,
    | "account"
    | "conversation"
    | "sender"
    | "ingress"
    | "senderAccess"
    | "commandAccess"
    | "activationAccess"
  >
> & {
  account?: Partial<WhatsAppInboundAdmission["account"]>;
  conversation?: Partial<WhatsAppInboundAdmission["conversation"]>;
  sender?: Partial<WhatsAppInboundAdmission["sender"]>;
  ingress?: Partial<WhatsAppInboundAdmission["ingress"]>;
  senderAccess?: Partial<WhatsAppInboundAdmission["senderAccess"]>;
  commandAccess?: Partial<WhatsAppInboundAdmission["commandAccess"]>;
  activationAccess?: Partial<WhatsAppInboundAdmission["activationAccess"]>;
};

type TestInboundMessageOverrides = Partial<
  Omit<WebInboundCallbackMessage, "event" | "payload" | "platform" | "admission">
> & {
  admission?: TestWhatsAppInboundAdmissionOverrides;
  event?: Partial<WhatsAppInboundEvent>;
  payload?: Partial<WhatsAppInboundPayload>;
  platform?: Partial<WhatsAppInboundPlatform>;
};

function createTestWhatsAppInboundAdmission(
  overrides: TestWhatsAppInboundAdmissionOverrides = {},
): WhatsAppInboundAdmission {
  const conversationId = overrides.conversation?.id ?? "+15551234567";
  const accountId = overrides.accountId ?? overrides.account?.accountId ?? "default";
  const kind = overrides.conversation?.kind ?? "direct";

  return {
    channelIngress: overrides.channelIngress,
    accountId,
    isSelfChat: overrides.isSelfChat ?? false,
    account: {
      accountId,
      enabled: true,
      sendReadReceipts: true,
      ...overrides.account,
    },
    conversation: {
      kind,
      id: conversationId,
      groupSessionId:
        overrides.conversation?.groupSessionId ??
        resolveWhatsAppGroupConversationId(conversationId),
    },
    sender: {
      id: overrides.sender?.id ?? conversationId,
      isSamePhone: overrides.sender?.isSamePhone ?? false,
    },
    ingress: {
      admission: "dispatch",
      decision: "allow",
      decisiveGateId: "activation",
      reasonCode: "activation_allowed",
      ...overrides.ingress,
    },
    senderAccess: {
      allowed: true,
      decision: "allow",
      reasonCode: "dm_policy_allowlisted",
      providerMissingFallbackApplied: false,
      ...overrides.senderAccess,
    },
    commandAccess: {
      requested: false,
      authorized: false,
      shouldBlockControlCommand: false,
      reasonCode: "command_authorized",
      ...overrides.commandAccess,
    },
    activationAccess: {
      ran: true,
      allowed: true,
      shouldSkip: false,
      reasonCode: "activation_allowed",
      ...overrides.activationAccess,
    },
  };
}

export function createTestWebInboundMessage(
  overrides: TestInboundMessageOverrides = {},
): WebInboundMessage {
  const { admission: admissionOverrides, event, payload, platform, ...message } = overrides;
  const admission = createTestWhatsAppInboundAdmission(admissionOverrides);
  return {
    event: {
      id: "msg-1",
      ...event,
    },
    payload: {
      body: "hello",
      ...payload,
    },
    platform: {
      chatJid: "+15551234567",
      recipientJid: "+15559876543",
      sendComposing: async () => {},
      reply: async () => createAcceptedWhatsAppSendResult("text", "reply-1"),
      sendMedia: async () => createAcceptedWhatsAppSendResult("media", "media-1"),
      ...platform,
    },
    admission,
    ...message,
  };
}

export function createTestWebAudioInboundMessage(
  overrides: TestInboundMessageOverrides = {},
): WebInboundMessage {
  const { event, payload, platform, ...message } = overrides;
  const media = Object.hasOwn(payload ?? {}, "media")
    ? payload?.media
    : {
        type: "audio/ogg; codecs=opus",
        path: "/tmp/voice.ogg",
        kind: "audio" as const,
      };
  return createTestWebInboundMessage({
    event: {
      id: "msg-1",
      timestamp: 1700000000,
      ...event,
    },
    payload: {
      body: "",
      media,
      ...payload,
    },
    platform: {
      chatJid: "+15550000002",
      recipientJid: "+15550000001",
      ...platform,
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "+15550000002",
      },
      ingress: {
        decision: "allow",
      },
    },
    ...message,
  });
}
