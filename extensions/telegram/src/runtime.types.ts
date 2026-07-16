import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { TelegramMonitorFn } from "./monitor.types.js";

export type TelegramProbeFn = typeof import("./probe.js").probeTelegram;
export type TelegramAuditCollectFn = typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
export type TelegramAuditMembershipFn = typeof import("./audit.js").auditTelegramGroupMembership;
export type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
export type TelegramResolveTokenFn = typeof import("./token.js").resolveTelegramToken;
type BasePluginRuntimeChannel = PluginRuntime extends { channel: infer T } ? T : never;

export type TelegramChannelRuntime = {
  probeTelegram?: TelegramProbeFn;
  collectTelegramUnmentionedGroupIds?: TelegramAuditCollectFn;
  auditTelegramGroupMembership?: TelegramAuditMembershipFn;
  monitorTelegramProvider?: TelegramMonitorFn;
  sendMessageTelegram?: TelegramSendFn;
  resolveTelegramToken?: TelegramResolveTokenFn;
  messageActions?: ChannelMessageActionAdapter;
};

export interface TelegramRuntimeChannel extends BasePluginRuntimeChannel {
  telegram?: TelegramChannelRuntime;
}

export interface TelegramRuntime extends PluginRuntime {
  channel: TelegramRuntimeChannel;
}
