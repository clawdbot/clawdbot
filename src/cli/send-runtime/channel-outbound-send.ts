import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundDeliveryFormattingOptions } from "../../infra/outbound/formatting.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type RuntimeSendOpts = {
  cfg?: OpenClawConfig;
  blocks?: unknown;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  threadId?: string | number | null;
  messageThreadId?: string | number;
  threadTs?: string | number;
  replyToId?: string | number | null;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  formatting?: OutboundDeliveryFormattingOptions;
  gifPlayback?: boolean;
  gatewayClientScopes?: readonly string[];
  textMode?: "markdown" | "html";
};

function resolveRuntimeThreadId(opts: RuntimeSendOpts): string | number | undefined {
  return opts.messageThreadId ?? opts.threadId ?? opts.threadTs ?? undefined;
}

function resolveRuntimeReplyToId(opts: RuntimeSendOpts): string | undefined {
  const raw = opts.replyToMessageId ?? opts.replyToId;
  return raw == null ? undefined : normalizeOptionalString(String(raw));
}

export function createChannelOutboundRuntimeSend(params: {
  channelId: ChannelId;
  unavailableMessage: string;
}) {
  return {
    sendMessage: async (to: string, text: string, opts: RuntimeSendOpts = {}) => {
      const outbound = await loadChannelOutboundAdapter(params.channelId);
      const threadId = resolveRuntimeThreadId(opts);
      const replyToId = resolveRuntimeReplyToId(opts);
      const buildContext = () => ({
        cfg: opts.cfg ?? getRuntimeConfig(),
        to,
        text,
        mediaUrl: opts.mediaUrl,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        accountId: opts.accountId,
        threadId,
        replyToId,
        silent: opts.silent,
        forceDocument: opts.forceDocument,
        formatting:
          opts.formatting ?? (opts.textMode === "html" ? { parseMode: "HTML" } : undefined),
        gifPlayback: opts.gifPlayback,
        gatewayClientScopes: opts.gatewayClientScopes,
      });
      const hasMedia = Boolean(opts.mediaUrl);
      if (opts.blocks && outbound?.sendPayload) {
        return await outbound.sendPayload({
          ...buildContext(),
          payload: {
            text,
            channelData: {
              [params.channelId]: {
                blocks: opts.blocks,
              },
            },
          },
        });
      }
      if (hasMedia && outbound?.sendMedia) {
        return await outbound.sendMedia(buildContext());
      }
      if (!outbound?.sendText) {
        throw new Error(params.unavailableMessage);
      }
      return await outbound.sendText(buildContext());
    },
  };
}
