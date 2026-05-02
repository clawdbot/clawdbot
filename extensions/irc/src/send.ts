import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
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
};

type SendIrcResult = {
  messageId: string;
  target: string;
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

export async function sendMessageIrc(
  to: string,
  text: string,
  opts: SendIrcOptions,
): Promise<SendIrcResult> {
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
  const prepared = convertMarkdownTables(text.trim(), tableMode);
  const payload = opts.replyTo ? `${prepared}\n\n[reply:${opts.replyTo}]` : prepared;

  if (!payload.trim()) {
    throw new Error("Message must be non-empty for IRC sends");
  }

  const client = opts.client;
  if (client?.isReady()) {
    client.sendPrivmsg(target, payload);
  } else {
    const transient = await connectIrcClient(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: 12000,
      }),
    );
    transient.sendPrivmsg(target, payload);
    transient.quit("sent");
  }

  recordIrcOutboundActivity(account.accountId);

  return {
    messageId: makeIrcMessageId(),
    target,
  };
}
