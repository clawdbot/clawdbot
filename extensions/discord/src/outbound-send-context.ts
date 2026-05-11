import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { createReplyToFanout, type ReplyToResolution } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-send-deps";
import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withDiscordDeliveryRetry } from "./delivery-retry.js";

type DiscordSendRuntime = typeof import("./send.js");

export type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
export type DiscordVoiceSendFn = DiscordSendRuntime["sendVoiceMessageDiscord"];
type DiscordFormattingOptions = {
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: NonNullable<Parameters<DiscordSendFn>[2]>["tableMode"];
  chunkMode?: NonNullable<Parameters<DiscordSendFn>[2]>["chunkMode"];
};

let discordSendRuntimePromise: Promise<DiscordSendRuntime> | undefined;

export async function loadDiscordSendRuntime(): Promise<DiscordSendRuntime> {
  discordSendRuntimePromise ??= import("./send.js");
  return await discordSendRuntimePromise;
}

export function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

export function resolveDiscordFormattingOptions(ctx: {
  formatting?: DiscordFormattingOptions;
}): DiscordFormattingOptions {
  const formatting = ctx.formatting;
  return {
    textLimit: formatting?.textLimit,
    maxLinesPerMessage: formatting?.maxLinesPerMessage,
    tableMode: formatting?.tableMode,
    chunkMode: formatting?.chunkMode,
  };
}

export async function createDiscordPayloadSendContext(ctx: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  replyToIdSource?: ReplyToResolution["source"];
  replyToMode?: ReplyToMode;
  formatting?: DiscordFormattingOptions;
  threadId?: string | number | null;
}): Promise<{
  target: string;
  formatting: DiscordFormattingOptions;
  resolveReplyTo: () => string | undefined;
  send: DiscordSendFn;
  sendVoice: DiscordVoiceSendFn;
  withRetry: <T>(fn: () => Promise<T>) => Promise<T>;
}> {
  const runtime = await loadDiscordSendRuntime();
  return {
    target: resolveDiscordOutboundTarget({ to: ctx.to, threadId: ctx.threadId }),
    formatting: resolveDiscordFormattingOptions(ctx),
    resolveReplyTo: createReplyToFanout({
      replyToId: ctx.replyToId,
      replyToIdSource: ctx.replyToIdSource,
      replyToMode: ctx.replyToMode,
    }),
    send: resolveOutboundSendDep<DiscordSendFn>(ctx.deps, "discord") ?? runtime.sendMessageDiscord,
    sendVoice:
      resolveOutboundSendDep<DiscordVoiceSendFn>(ctx.deps, "discordVoice") ??
      runtime.sendVoiceMessageDiscord,
    withRetry: async (fn) =>
      await withDiscordDeliveryRetry({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        fn,
      }),
  };
}
