// Irc plugin module implements send behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { convertMarkdownTables, stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { resolveIrcAccount } from "./accounts.js";
import type { IrcClient } from "./client.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { normalizeIrcMessagingTarget } from "./normalize.js";
import { makeIrcMessageId } from "./protocol.js";
import { getIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendIrcOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
  client?: IrcClient;
  abortSignal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
};

type SendIrcMessage = {
  text: string;
  replyTo?: string;
};

export type SendIrcResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

function recordIrcOutboundActivity(accountId: string): void {
  try {
    getIrcRuntime().channel.activity.record({
      channel: "irc",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "IRC runtime not initialized") {
      throw error;
    }
  }
}

function resolveTarget(to: string, opts?: SendIrcOptions): string {
  const fromArg = normalizeIrcMessagingTarget(to);
  if (fromArg) {
    return fromArg;
  }
  const fromOpt = normalizeIrcMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return fromOpt;
  }
  throw new Error(`Invalid IRC target: ${to}`);
}

export async function sendIrcMessages(
  to: string,
  messages: readonly SendIrcMessage[],
  opts: SendIrcOptions,
  onDeliveryResult?: (result: SendIrcResult) => Promise<void> | void,
): Promise<SendIrcResult[]> {
  const cfg = requireRuntimeConfig(opts.cfg, "IRC send") as CoreConfig;
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const target = resolveTarget(to, opts);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "irc",
    accountId: account.accountId,
  });
  const preparedMessages = messages.map((message) => {
    const prepared = stripMarkdown(convertMarkdownTables(message.text.trim(), tableMode));
    if (!prepared.trim()) {
      throw new Error("Message must be non-empty for IRC sends");
    }
    return {
      payload: message.replyTo ? `${prepared}\n\n[reply:${message.replyTo}]` : prepared,
      replyTo: message.replyTo,
    };
  });
  if (preparedMessages.length === 0) {
    return [];
  }
  opts.abortSignal?.throwIfAborted();

  let transient: IrcClient | undefined;
  const client = opts.client?.isReady()
    ? opts.client
    : (transient = await connectIrcClient(
        buildIrcConnectOptions(account, {
          connectTimeoutMs: 12000,
          abortSignal: opts.abortSignal,
        }),
      ));

  const results: SendIrcResult[] = [];
  try {
    opts.abortSignal?.throwIfAborted();
    if (transient && (target.startsWith("#") || target.startsWith("&"))) {
      client.join(target);
    }
    for (const message of preparedMessages) {
      opts.abortSignal?.throwIfAborted();
      if (!client.isReady()) {
        throw new Error("IRC connection closed before send");
      }
      await opts.onPlatformSendDispatch?.();
      opts.abortSignal?.throwIfAborted();
      if (!client.isReady()) {
        throw new Error("IRC connection closed before send");
      }
      client.sendPrivmsg(target, message.payload);
      recordIrcOutboundActivity(account.accountId);

      const messageId = makeIrcMessageId();
      const result = {
        messageId,
        target,
        receipt: createMessageReceiptFromOutboundResults({
          results: [
            {
              channel: "irc",
              messageId,
              conversationId: target,
            },
          ],
          kind: "text",
          ...(message.replyTo ? { replyToId: message.replyTo } : {}),
        }),
      };
      results.push(result);
      await onDeliveryResult?.(result);
    }
    return results;
  } finally {
    transient?.quit("sent");
  }
}

export async function sendMessageIrc(
  to: string,
  text: string,
  opts: SendIrcOptions,
): Promise<SendIrcResult> {
  const result = (
    await sendIrcMessages(to, [{ text, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) }], opts)
  )[0];
  if (!result) {
    throw new Error("Message must be non-empty for IRC sends");
  }
  return result;
}
