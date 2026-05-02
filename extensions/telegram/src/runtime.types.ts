import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { TelegramMonitorFn } from "./monitor.types.js";

export type TelegramProbeFn = typeof import("./probe.js").probeTelegram;
type TelegramAuditCollectFn = typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
type TelegramAuditMembershipFn = typeof import("./audit.js").auditTelegramGroupMembership;
type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramResolveTokenFn = typeof import("./token.js").resolveTelegramToken;
type BasePluginRuntimeChannel = PluginRuntime extends { channel: infer T } ? T : never;

type TelegramChannelRuntime = {
  probeTelegram?: TelegramProbeFn;
  collectTelegramUnmentionedGroupIds?: TelegramAuditCollectFn;
  auditTelegramGroupMembership?: TelegramAuditMembershipFn;
  monitorTelegramProvider?: TelegramMonitorFn;
  sendMessageTelegram?: TelegramSendFn;
  resolveTelegramToken?: TelegramResolveTokenFn;
  messageActions?: ChannelMessageActionAdapter;
};

interface TelegramRuntimeChannel extends BasePluginRuntimeChannel {
  telegram?: TelegramChannelRuntime;
}

export interface TelegramRuntime extends PluginRuntime {
  channel: TelegramRuntimeChannel;
}
