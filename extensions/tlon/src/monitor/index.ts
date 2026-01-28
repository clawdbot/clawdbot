import { format } from "node:util";

import type { RuntimeEnv, ReplyPayload, MoltbotConfig } from "clawdbot/plugin-sdk";

import { getTlonRuntime } from "../runtime.js";
import { resolveTlonAccount } from "../types.js";
import { normalizeShip, parseChannelNest } from "../targets.js";
import { authenticate } from "../urbit/auth.js";
import { UrbitSSEClient } from "../urbit/sse-client.js";
import { sendDm, sendGroupMessage } from "../urbit/send.js";
import { cacheMessage, getChannelHistory } from "./history.js";
import { createProcessedMessageTracker } from "./processed-messages.js";
import {
  extractMessageText,
  formatModelName,
  isBotMentioned,
  isDmAllowed,
  isSummarizationRequest,
} from "./utils.js";
import { fetchAllChannels } from "./discovery.js";

export type MonitorTlonOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

type ChannelAuthorization = {
  mode?: "restricted" | "open";
  allowedShips?: string[];
};

function resolveChannelAuthorization(
  cfg: MoltbotConfig,
  channelNest: string,
): { mode: "restricted" | "open"; allowedShips: string[] } {
  const tlonConfig = cfg.channels?.tlon as
    | {
        authorization?: { channelRules?: Record<string, ChannelAuthorization> };
        defaultAuthorizedShips?: string[];
      }
    | undefined;
  const rules = tlonConfig?.authorization?.channelRules ?? {};
  const rule = rules[channelNest];
  const allowedShips = rule?.allowedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];
  const mode = rule?.mode ?? "restricted";
  return { mode, allowedShips };
}

export async function monitorTlonProvider(opts: MonitorTlonOpts = {}): Promise<void> {
  const core = getTlonRuntime();
  const cfg = core.config.loadConfig() as MoltbotConfig;
  if (cfg.channels?.tlon?.enabled === false) return;

  const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => {
      logger.info(formatRuntimeMessage(...args));
    },
    error: (...args) => {
      logger.error(formatRuntimeMessage(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const account = resolveTlonAccount(cfg, opts.accountId ?? undefined);
  if (!account.enabled) return;
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured (ship/url/code required)");
  }

  const botShipName = normalizeShip(account.ship);
  runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);

  let api: UrbitSSEClient | null = null;
  try {
    runtime.log?.(`[tlon] Attempting authentication to ${account.url}...`);
    const cookie = await authenticate(account.url, account.code);
    api = new UrbitSSEClient(account.url, cookie, {
      ship: botShipName,
      logger: {
        log: (message) => runtime.log?.(message),
        error: (message) => runtime.error?.(message),
      },
    });
  } catch (error: any) {
    runtime.error?.(`[tlon] Failed to authenticate: ${error?.message ?? String(error)}`);
    throw error;
  }

  const processedTracker = createProcessedMessageTracker(2000);
  let groupChannels: string[] = [];

  if (account.autoDiscoverChannels !== false) {
    try {
      const discoveredChannels = await fetchAllChannels(api, runtime);
      if (discoveredChannels.length > 0) {
        groupChannels = discoveredChannels;
      }
    } catch (error: any) {
      runtime.error?.(`[tlon] Auto-discovery failed: ${error?.message ?? String(error)}`);
    }
  }

  if (groupChannels.length === 0 && account.groupChannels.length > 0) {
    groupChannels = account.groupChannels;
    runtime.log?.(`[tlon] Using manual groupChannels config: ${groupChannels.join(", ")}`);
  }

  if (groupChannels.length > 0) {
    runtime.log?.(
      `[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`,
    );
  } else {
    runtime.log?.("[tlon] No group channels to monitor (DMs only)");
  }

  const handleIncomingDM = async (update: any) => {
    try {
      const memo = update?.response?.add?.memo;
      if (!memo) return;

      const messageId = update.id as string | undefined;
      if (!processedTracker.mark(messageId)) return;

      const senderShip = normalizeShip(memo.author ?? "");
      if (!senderShip || senderShip === botShipName) return;

      const messageText = extractMessageText(memo.content);
      if (!messageText) return;

      if (!isDmAllowed(senderShip, account.dmAllowlist)) {
        runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
        return;
      }

      await processMessage({
        messageId: messageId ?? "",
        senderShip,
        messageText,
        isGroup: false,
        timestamp: memo.sent || Date.now(),
      });
    } catch (error: any) {
      runtime.error?.(`[tlon] Error handling DM: ${error?.message ?? String(error)}`);
    }
  };

  const handleIncomingGroupMessage = (channelNest: string) => async (update: any) => {
    try {
      const parsed = parseChannelNest(channelNest);
      if (!parsed) return;

      const essay = update?.response?.post?.["r-post"]?.set?.essay;
      const memo = update?.response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.memo;
      if (!essay && !memo) return;

      const content = memo || essay;
      const isThreadReply = Boolean(memo);
      const messageId = isThreadReply
        ? update?.response?.post?.["r-post"]?.reply?.id
        : update?.response?.post?.id;

      if (!processedTracker.mark(messageId)) return;

      const senderShip = normalizeShip(content.author ?? "");
      if (!senderShip || senderShip === botShipName) return;

      const messageText = extractMessageText(content.content);
      if (!messageText) return;

      cacheMessage(channelNest, {
        author: senderShip,
        content: messageText,
        timestamp: content.sent || Date.now(),
        id: messageId,
      });

      const mentioned = isBotMentioned(messageText, botShipName);
      if (!mentioned) return;

      const { mode, allowedShips } = resolveChannelAuthorization(cfg, channelNest);
      if (mode === "restricted") {
        if (allowedShips.length === 0) {
          runtime.log?.(`[tlon] Access denied: ${senderShip} in ${channelNest} (no allowlist)`);
          return;
        }
        const normalizedAllowed = allowedShips.map(normalizeShip);
        if (!normalizedAllowed.includes(senderShip)) {
          runtime.log?.(
            `[tlon] Access denied: ${senderShip} in ${channelNest} (allowed: ${allowedShips.join(", ")})`,
          );
          return;
        }
      }

      const seal = isThreadReply
        ? update?.response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.seal
        : update?.response?.post?.["r-post"]?.set?.seal;

      const parentId = seal?.["parent-id"] || seal?.parent || null;

      await processMessage({
        messageId: messageId ?? "",
        senderShip,
        messageText,
        isGroup: true,
        groupChannel: channelNest,
        groupName: `${parsed.hostShip}/${parsed.channelName}`,
        timestamp: content.sent || Date.now(),
        parentId,
      });
    } catch (error: any) {
      runtime.error?.(`[tlon] Error handling group message: ${error?.message ?? String(error)}`);
    }
  };

  const processMessage = async (params: {
    messageId: string;
    senderShip: string;
    messageText: string;
    isGroup: boolean;
    groupChannel?: string;
    groupName?: string;
    timestamp: number;
    parentId?: string | null;
  }) => {
    const { messageId, senderShip, isGroup, groupChannel, groupName, timestamp, parentId } = params;
    let messageText = params.messageText;

    if (isGroup && groupChannel && isSummarizationRequest(messageText)) {
      try {
        const history = await getChannelHistory(api!, groupChannel, 50, runtime);
        if (history.length === 0) {
          const noHistoryMsg =
            "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
          if (isGroup) {
            const parsed = parseChannelNest(groupChannel);
            if (parsed) {
              await sendGroupMessage({
                api: api!,
                fromShip: botShipName,
                hostShip: parsed.hostShip,
                channelName: parsed.channelName,
                text: noHistoryMsg,
              });
            }
          } else {
            await sendDm({ api: api!, fromShip: botShipName, toShip: senderShip, text: noHistoryMsg });
          }
          return;
        }

        const historyText = history
          .map((msg) => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author}: ${msg.content}`)
          .join("\n");

        messageText =
          `Please summarize this channel conversation (${history.length} recent messages):\n\n${historyText}\n\n` +
          "Provide a concise summary highlighting:\n" +
          "1. Main topics discussed\n" +
          "2. Key decisions or conclusions\n" +
          "3. Action items if any\n" +
          "4. Notable participants";
      } catch (error: any) {
        const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${error?.message ?? String(error)}`;
        if (isGroup && groupChannel) {
          const parsed = parseChannelNest(groupChannel);
          if (parsed) {
            await sendGroupMessage({
              api: api!,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: errorMsg,
            });
          }
        } else {
          await sendDm({ api: api!, fromShip: botShipName, toShip: senderShip, text: errorMsg });
        }
        return;
      }
    }

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "tlon",
      accountId: opts.accountId ?? undefined,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? groupChannel ?? senderShip : senderShip,
      },
    });

    const fromLabel = isGroup ? `${senderShip} in ${groupName}` : senderShip;
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Tlon",
      from: fromLabel,
      timestamp,
      body: messageText,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: messageText,
      CommandBody: messageText,
      From: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
      To: `tlon:${botShipName}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderShip,
      SenderId: senderShip,
      Provider: "tlon",
      Surface: "tlon",
      MessageSid: messageId,
      OriginatingChannel: "tlon",
      OriginatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
    });

    const dispatchStartTime = Date.now();

    const responsePrefix = core.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId)
      .responsePrefix;
    const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix,
        humanDelay,
        deliver: async (payload: ReplyPayload) => {
          let replyText = payload.text;
          if (!replyText) return;

          const showSignature = account.showModelSignature ?? cfg.channels?.tlon?.showModelSignature ?? false;
          if (showSignature) {
            const modelInfo =
              payload.metadata?.model || payload.model || route.model || cfg.agents?.defaults?.model?.primary;
            replyText = `${replyText}\n\n_[Generated by ${formatModelName(modelInfo)}]_`;
          }

          if (isGroup && groupChannel) {
            const parsed = parseChannelNest(groupChannel);
            if (!parsed) return;
            await sendGroupMessage({
              api: api!,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: replyText,
              replyToId: parentId ?? undefined,
            });
          } else {
            await sendDm({ api: api!, fromShip: botShipName, toShip: senderShip, text: replyText });
          }
        },
        onError: (err, info) => {
          const dispatchDuration = Date.now() - dispatchStartTime;
          runtime.error?.(
            `[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`,
          );
        },
      },
    });
  };

  const subscribedChannels = new Set<string>();
  const subscribedDMs = new Set<string>();

  async function subscribeToChannel(channelNest: string) {
    if (subscribedChannels.has(channelNest)) return;
    const parsed = parseChannelNest(channelNest);
    if (!parsed) {
      runtime.error?.(`[tlon] Invalid channel format: ${channelNest}`);
      return;
    }

    try {
      await api!.subscribe({
        app: "channels",
        path: `/${channelNest}`,
        event: handleIncomingGroupMessage(channelNest),
        err: (error) => {
          runtime.error?.(`[tlon] Group subscription error for ${channelNest}: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.(`[tlon] Group subscription ended for ${channelNest}`);
          subscribedChannels.delete(channelNest);
        },
      });
      subscribedChannels.add(channelNest);
      runtime.log?.(`[tlon] Subscribed to group channel: ${channelNest}`);
    } catch (error: any) {
      runtime.error?.(`[tlon] Failed to subscribe to ${channelNest}: ${error?.message ?? String(error)}`);
    }
  }

  async function subscribeToDM(dmShip: string) {
    if (subscribedDMs.has(dmShip)) return;
    try {
      await api!.subscribe({
        app: "chat",
        path: `/dm/${dmShip}`,
        event: handleIncomingDM,
        err: (error) => {
          runtime.error?.(`[tlon] DM subscription error for ${dmShip}: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.(`[tlon] DM subscription ended for ${dmShip}`);
          subscribedDMs.delete(dmShip);
        },
      });
      subscribedDMs.add(dmShip);
      runtime.log?.(`[tlon] Subscribed to DM with ${dmShip}`);
    } catch (error: any) {
      runtime.error?.(`[tlon] Failed to subscribe to DM with ${dmShip}: ${error?.message ?? String(error)}`);
    }
  }

  async function refreshChannelSubscriptions() {
    try {
      const dmShips = await api!.scry("/chat/dm.json");
      if (Array.isArray(dmShips)) {
        for (const dmShip of dmShips) {
          await subscribeToDM(dmShip);
        }
      }

      if (account.autoDiscoverChannels !== false) {
        const discoveredChannels = await fetchAllChannels(api!, runtime);
        for (const channelNest of discoveredChannels) {
          await subscribeToChannel(channelNest);
        }
      }
    } catch (error: any) {
      runtime.error?.(`[tlon] Channel refresh failed: ${error?.message ?? String(error)}`);
    }
  }

  try {
    runtime.log?.("[tlon] Subscribing to updates...");

    let dmShips: string[] = [];
    try {
      const dmList = await api!.scry("/chat/dm.json");
      if (Array.isArray(dmList)) {
        dmShips = dmList;
        runtime.log?.(`[tlon] Found ${dmShips.length} DM conversation(s)`);
      }
    } catch (error: any) {
      runtime.error?.(`[tlon] Failed to fetch DM list: ${error?.message ?? String(error)}`);
    }

    for (const dmShip of dmShips) {
      await subscribeToDM(dmShip);
    }

    for (const channelNest of groupChannels) {
      await subscribeToChannel(channelNest);
    }

    runtime.log?.("[tlon] All subscriptions registered, connecting to SSE stream...");
    await api!.connect();
    runtime.log?.("[tlon] Connected! All subscriptions active");

    const pollInterval = setInterval(() => {
      if (!opts.abortSignal?.aborted) {
        refreshChannelSubscriptions().catch((error) => {
          runtime.error?.(`[tlon] Channel refresh error: ${error?.message ?? String(error)}`);
        });
      }
    }, 2 * 60 * 1000);

    if (opts.abortSignal) {
      await new Promise((resolve) => {
        opts.abortSignal.addEventListener(
          "abort",
          () => {
            clearInterval(pollInterval);
            resolve(null);
          },
          { once: true },
        );
      });
    } else {
      await new Promise(() => {});
    }
  } finally {
    try {
      await api?.close();
    } catch (error: any) {
      runtime.error?.(`[tlon] Cleanup error: ${error?.message ?? String(error)}`);
    }
  }
}
