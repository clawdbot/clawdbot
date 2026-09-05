import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";

type FeishuConfig = NonNullable<NonNullable<ClawdbotConfig["channels"]>["feishu"]>;
type FeishuMessage = FeishuMessageEvent["message"];
type FeishuSender = FeishuMessageEvent["sender"];
type TestConfigBase = Record<string, unknown> & {
  channels?: Record<string, unknown>;
};
type FeishuSecretRefPolicyCase = {
  name: string;
  provider: string;
  defaultEnv?: string;
  providers: NonNullable<NonNullable<ClawdbotConfig["secrets"]>["providers"]>;
  configured: boolean;
};

export const FEISHU_SELECTED_SECRET_ENV = "FEISHU_SECRET_REF_SELECTED_TEST";
export const FEISHU_SIBLING_SECRET_ENV = "FEISHU_SECRET_REF_SIBLING_TEST";

export const feishuSecretRefPolicyCases: FeishuSecretRefPolicyCase[] = [
  {
    name: "unconfigured provider alias",
    provider: "unconfigured",
    providers: {},
    configured: false,
  },
  {
    name: "provider configured with a non-env source",
    provider: "corp-env",
    providers: { "corp-env": { source: "file", path: "/unused" } },
    configured: false,
  },
  {
    name: "provider allowlist excluding the selected credential",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "env", allowlist: [FEISHU_SIBLING_SECRET_ENV] } },
    configured: false,
  },
  {
    name: "configured env provider allowing the selected credential",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "env", allowlist: [FEISHU_SELECTED_SECRET_ENV] } },
    configured: true,
  },
  {
    name: "selected env provider with an empty allowlist",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "env", allowlist: [] } },
    configured: false,
  },
  {
    name: "literal env default shadowing a file provider",
    provider: "default",
    providers: { default: { source: "file", path: "/unused" } },
    configured: true,
  },
  {
    name: "selected env default shadowing an exec provider",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "exec", command: "/unused" } },
    configured: true,
  },
  {
    name: "selected env default shadowing a store provider",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "store" } },
    configured: true,
  },
];

export function createFeishuTestConfig(
  feishu: FeishuConfig,
  base: TestConfigBase = {},
): ClawdbotConfig {
  return {
    ...base,
    channels: { ...base.channels, feishu },
  } as ClawdbotConfig;
}

export function createFeishuSecretRefPolicyConfig({
  provider,
  providers,
  defaultEnv,
}: FeishuSecretRefPolicyCase): ClawdbotConfig {
  return createFeishuTestConfig(
    {
      accounts: {
        selected: {
          appId: "selected-app",
          appSecret: { source: "env", provider, id: FEISHU_SELECTED_SECRET_ENV },
        },
        sibling: {
          appId: "sibling-app",
          appSecret: { source: "env", provider: "sibling-env", id: FEISHU_SIBLING_SECRET_ENV },
        },
      },
    },
    {
      secrets: {
        defaults: defaultEnv ? { env: defaultEnv } : undefined,
        providers: {
          ...providers,
          "sibling-env": { source: "env", allowlist: [FEISHU_SIBLING_SECRET_ENV] },
        },
      },
    },
  );
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
