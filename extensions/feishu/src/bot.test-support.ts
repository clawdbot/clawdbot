import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";

type FeishuConfig = NonNullable<NonNullable<ClawdbotConfig["channels"]>["feishu"]>;
type FeishuMessage = FeishuMessageEvent["message"];
type FeishuSender = FeishuMessageEvent["sender"];
type TestConfigBase = Record<string, unknown> & {
  channels?: Record<string, unknown>;
};

export function createFeishuTestConfig(
  feishu: FeishuConfig,
  base: TestConfigBase = {},
): ClawdbotConfig {
  return {
    ...base,
    channels: { ...base.channels, feishu },
  } as ClawdbotConfig;
}

export function createFeishuTestEvent(params: {
  messageId: string;
  sender?: FeishuSender;
  senderOpenId?: string;
  senderUserId?: string;
  senderType?: FeishuSender["sender_type"];
  chatId?: string;
  chatType?: FeishuMessage["chat_type"];
  messageType?: FeishuMessage["message_type"];
  text?: string;
  content?: string;
  message?: Partial<FeishuMessage>;
}): FeishuMessageEvent {
  const {
    messageId,
    sender,
    senderOpenId = "ou-attacker",
    senderUserId,
    senderType,
    chatId = "oc-dm",
    chatType = "p2p",
    messageType = "text",
    text = "hello",
    content,
    message,
  } = params;
  return {
    sender: sender ?? {
      sender_id: {
        open_id: senderOpenId,
        ...(senderUserId ? { user_id: senderUserId } : {}),
      },
      ...(senderType ? { sender_type: senderType } : {}),
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: messageType,
      ...message,
      content: content ?? message?.content ?? JSON.stringify({ text }),
    },
  };
}

export function createFeishuTestRoute(
  overrides: Partial<ResolvedAgentRoute> = {},
): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
    ...overrides,
  };
}
