import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { loadConfig } from "../../config/config.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type RuntimeSendOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  messageThreadId?: string | number;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  gatewayClientScopes?: readonly string[];
};

export function createChannelOutboundRuntimeSend(params: {
  channelId: ChannelId;
  unavailableMessage: string;
}) {
  return {
    sendMessage: async (to: string, text: string, opts: RuntimeSendOpts = {}) => {
      const outbound = await loadChannelOutboundAdapter(params.channelId);
      const hasMedia = Boolean(opts.mediaUrl);
      if (hasMedia && outbound?.sendMedia) {
        return await outbound.sendMedia({
          cfg: opts.cfg ?? loadConfig(),
          to,
          text,
          mediaUrl: opts.mediaUrl,
          mediaAccess: opts.mediaAccess,
          mediaLocalRoots: opts.mediaLocalRoots,
          mediaReadFile: opts.mediaReadFile,
          accountId: opts.accountId,
          threadId: opts.messageThreadId,
          replyToId:
            opts.replyToMessageId == null
              ? undefined
              : normalizeOptionalString(String(opts.replyToMessageId)),
          silent: opts.silent,
          forceDocument: opts.forceDocument,
          gifPlayback: opts.gifPlayback,
          gatewayClientScopes: opts.gatewayClientScopes,
        });
      }
      if (!outbound?.sendText) {
        throw new Error(params.unavailableMessage);
      }
      return await outbound.sendText({
        cfg: opts.cfg ?? loadConfig(),
        to,
        text,
        mediaUrl: opts.mediaUrl,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        accountId: opts.accountId,
        threadId: opts.messageThreadId,
        replyToId:
          opts.replyToMessageId == null
            ? undefined
            : normalizeOptionalString(String(opts.replyToMessageId)),
        silent: opts.silent,
        forceDocument: opts.forceDocument,
        gifPlayback: opts.gifPlayback,
        gatewayClientScopes: opts.gatewayClientScopes,
      });
    },
  };
}
