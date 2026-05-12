import path from "node:path";
import { initCommands } from "../commands/slash-commands-impl.js";
import { createNodeSessionStoreReader } from "../group/activation.js";
import type { HistoryEntry } from "../group/history.js";
import { setOutboundAudioPort } from "../messaging/outbound.js";
import {
  clearTokenCache,
  getAccessToken,
  initApiConfig,
  onMessageSent,
  sendInputNotify as senderSendInputNotify,
  createRawInputNotifyFn,
  accountToCreds,
} from "../messaging/sender.js";
import { setRefIndex } from "../ref/store.js";
import { runDiagnostics } from "../utils/diagnostics.js";
import { runWithRequestContext } from "../utils/request-context.js";
import { createActiveCfgProvider } from "./active-cfg.js";
import { GatewayConnection } from "./gateway-connection.js";
import { buildInboundContext, clearGroupPendingHistory } from "./inbound-pipeline.js";
import { createInteractionHandler } from "./interaction-handler.js";
import type { QueuedMessage } from "./message-queue.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type {
  CoreGatewayContext,
  GatewayAccount,
  EngineLogger,
  RefAttachmentSummary,
} from "./types.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";

export type { CoreGatewayContext } from "./types.js";

export async function startGateway(ctx: CoreGatewayContext): Promise<void> {
  const { account, log, runtime, adapters } = ctx;

  setOutboundAudioPort(adapters.outboundAudio);
  initCommands(adapters.commands);

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(w);
    }
  }

  initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
  log?.debug?.(`API config: markdownSupport=${account.markdownSupport}`);

  onMessageSent(account.appId, (refIdx, meta) => {
    log?.info(
      `onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`,
    );
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  });

  const groupOpts = {
    enabled: ctx.group?.enabled ?? true,
    allowTextCommands: ctx.group?.allowTextCommands,
    isControlCommand: ctx.group?.isControlCommand,
    resolveIntroHint: ctx.group?.resolveIntroHint,
    sessionStoreReader: ctx.group?.sessionStoreReader,
  };
  const groupChatEnabled = groupOpts.enabled;
  const groupHistories: Map<string, HistoryEntry[]> | undefined = groupChatEnabled
    ? new Map()
    : undefined;
  const sessionStoreReader = groupChatEnabled
    ? (groupOpts.sessionStoreReader ?? createNodeSessionStoreReader())
    : undefined;

  // Live config provider: per-inbound lookup so binding edits applied
  // through the CLI take effect without a gateway restart (#69546).
  const activeCfgProvider = createActiveCfgProvider({ fallback: ctx.cfg });

  // ---- 7. Message handler ----
  const handleMessage = async (event: QueuedMessage): Promise<void> => {
    log?.info(`Processing message from ${event.senderId}: ${event.content}`, {
      accountId: account.accountId,
      messageId: event.messageId,
      senderId: event.senderId,
      type: event.type,
      groupOpenid: event.groupOpenid,
    });

    runtime.channel.activity.record({
      channel: "qqbot",
      accountId: account.accountId,
      direction: "inbound",
    });

    const activeCfg = activeCfgProvider.getActiveCfg();

    const inbound = await buildInboundContext(event, {
      account,
      cfg: activeCfg,
      log,
      runtime,
      startTyping: (ev) => startTypingForEvent(ev, account, log),
      groupHistories,
      sessionStoreReader,
      allowTextCommands: groupOpts.allowTextCommands,
      isControlCommand: groupOpts.isControlCommand,
      resolveGroupIntroHint: groupOpts.resolveIntroHint,
      adapters,
    });

    if (inbound.blocked) {
      log?.info(`Dropped inbound qqbot message: ${inbound.blockReason ?? "blocked by allowFrom"}`, {
        accountId: account.accountId,
        messageId: event.messageId,
        blockReason: inbound.blockReason,
      });
      inbound.typing.keepAlive?.stop();
      return;
    }

    if (inbound.skipped) {
      log?.info(
        `Skipped group inbound: reason=${inbound.skipReason ?? "unknown"} group=${event.groupOpenid ?? ""}`,
        {
          accountId: account.accountId,
          messageId: event.messageId,
          skipReason: inbound.skipReason,
          groupOpenid: event.groupOpenid,
        },
      );
      inbound.typing.keepAlive?.stop();
      return;
    }

    try {
      await runWithRequestContext(
        {
          accountId: account.accountId,
          target: inbound.qualifiedTarget,
          targetId: inbound.peerId,
          chatType: event.type,
        },
        () => dispatchOutbound(inbound, { runtime, cfg: activeCfg, account, log }),
      );
    } catch (err) {
      log?.error(`Message processing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inbound.typing.keepAlive?.stop();
      if (event.type === "group" && event.groupOpenid && inbound.group) {
        clearGroupPendingHistory({
          historyMap: groupHistories,
          groupOpenid: event.groupOpenid,
          historyLimit: inbound.group.historyLimit,
          historyPort: adapters.history,
        });
      }
    }
  };

  const handleInteraction = createInteractionHandler(account, ctx.runtime, log);

  const connection = new GatewayConnection({
    account,
    abortSignal: ctx.abortSignal,
    cfg: ctx.cfg,
    log,
    runtime,
    adapters,
    onReady: ctx.onReady,
    onResumed: ctx.onResumed,
    onError: ctx.onError,
    onInteraction: handleInteraction,
    handleMessage,
  });

  await connection.start();
}

// ============ Typing helper ============

/**
 * Start typing indicator for a C2C event.
 * Returns the refIdx from InputNotify and a TypingKeepAlive handle.
 */
async function startTypingForEvent(
  event: QueuedMessage,
  account: GatewayAccount,
  log?: EngineLogger,
): Promise<{ refIdx?: string; keepAlive: TypingKeepAlive | null }> {
  const isC2C = event.type === "c2c" || event.type === "dm";
  if (!isC2C) {
    return { keepAlive: null };
  }
  try {
    const creds = accountToCreds(account);
    const rawNotifyFn = createRawInputNotifyFn(account.appId);
    try {
      const resp = await senderSendInputNotify({
        openid: event.senderId,
        creds,
        msgId: event.messageId,
        inputSecond: TYPING_INPUT_SECOND,
      });
      const keepAlive = new TypingKeepAlive(
        () => getAccessToken(account.appId, account.clientSecret),
        () => clearTokenCache(account.appId),
        rawNotifyFn,
        event.senderId,
        event.messageId,
        log,
      );
      keepAlive.start();
      return { refIdx: resp.refIdx, keepAlive };
    } catch (notifyErr) {
      const errMsg = String(notifyErr);
      if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
        clearTokenCache(account.appId);
        const resp = await senderSendInputNotify({
          openid: event.senderId,
          creds,
          msgId: event.messageId,
          inputSecond: TYPING_INPUT_SECOND,
        });
        const keepAlive = new TypingKeepAlive(
          () => getAccessToken(account.appId, account.clientSecret),
          () => clearTokenCache(account.appId),
          rawNotifyFn,
          event.senderId,
          event.messageId,
          log,
        );
        keepAlive.start();
        return { refIdx: resp.refIdx, keepAlive };
      }
      throw notifyErr;
    }
  } catch (err) {
    log?.error(`sendInputNotify error: ${err instanceof Error ? err.message : String(err)}`);
    return { keepAlive: null };
  }
}
