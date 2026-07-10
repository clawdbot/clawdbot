// Telegram plugin module implements bot message behavior.
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramThreadParams, resolveTelegramStreamMode } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";

const telegramInboundLog = createSubsystemLogger("gateway/channels/telegram").child("inbound");

export function formatTelegramInboundLogLine(params: {
  from: string;
  to: string;
  chatType: string;
  body: string;
  mediaType?: string;
}): string {
  const kindLabel = params.mediaType ? `, ${params.mediaType}` : "";
  return `Inbound message ${params.from} -> ${params.to} (${params.chatType}${kindLabel}, ${params.body.length} chars)`;
}

type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  | "primaryCtx"
  | "allMedia"
  | "storeAllowFrom"
  | "options"
  | "cfg"
  | "historyLimit"
  | "dmPolicy"
  | "allowFrom"
  | "groupAllowFrom"
  | "ackReactionScope"
> & {
  runtime: RuntimeEnv;
  telegramDeps: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token" | "allowFrom" | "groupAllowFrom" | "replyToMode">;
};

export type TelegramMessageProcessorTurnContext = {
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  onDispatchStart?: () => Promise<void> | void;
};

export function resolveTelegramMessageTurnSettings(params: {
  accountId: string;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "allowFrom" | "groupAllowFrom" | "replyToMode">;
}) {
  const allowFrom = params.opts.allowFrom ?? params.telegramCfg.allowFrom;
  const telegramTextLimit =
    params.telegramCfg.richMessages === true ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT;
  return {
    ackReactionScope: params.cfg.messages?.ackReactionScope ?? "group-mentions",
    allowFrom,
    dmPolicy: params.telegramCfg.dmPolicy ?? "pairing",
    groupAllowFrom:
      params.opts.groupAllowFrom ??
      params.telegramCfg.groupAllowFrom ??
      params.telegramCfg.allowFrom ??
      allowFrom,
    historyLimit: Math.max(
      0,
      params.telegramCfg.historyLimit ??
        params.cfg.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    ),
    replyToMode: params.opts.replyToMode ?? params.telegramCfg.replyToMode ?? "off",
    streamMode: resolveTelegramStreamMode(params.telegramCfg),
    textLimit: Math.min(
      resolveTextChunkLimit(params.cfg, "telegram", params.accountId, {
        fallbackLimit: telegramTextLimit,
      }),
      telegramTextLimit,
    ),
  };
}

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    account,
    groupHistories,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    sendChatActionHandler,
    runtime,
    telegramDeps,
    opts,
  } = deps;
  const sessionRuntime = {
    ...(telegramDeps.buildChannelInboundEventContext
      ? { buildChannelInboundEventContext: telegramDeps.buildChannelInboundEventContext }
      : {}),
    ...(telegramDeps.readSessionUpdatedAt
      ? { readSessionUpdatedAt: telegramDeps.readSessionUpdatedAt }
      : {}),
    ...(telegramDeps.readAmbientTranscriptWatermark
      ? { readAmbientTranscriptWatermark: telegramDeps.readAmbientTranscriptWatermark }
      : {}),
    ...(telegramDeps.recordInboundSession
      ? { recordInboundSession: telegramDeps.recordInboundSession }
      : {}),
    ...(telegramDeps.resolveAmbientTranscriptWatermarkKey
      ? { resolveAmbientTranscriptWatermarkKey: telegramDeps.resolveAmbientTranscriptWatermarkKey }
      : {}),
    ...(telegramDeps.resolveInboundLastRouteSessionKey
      ? { resolveInboundLastRouteSessionKey: telegramDeps.resolveInboundLastRouteSessionKey }
      : {}),
    ...(telegramDeps.resolvePinnedMainDmOwnerFromAllowlist
      ? {
          resolvePinnedMainDmOwnerFromAllowlist: telegramDeps.resolvePinnedMainDmOwnerFromAllowlist,
        }
      : {}),
    resolveStorePath: telegramDeps.resolveStorePath,
  };
  const contextRuntime = telegramDeps.recordChannelActivity
    ? { recordChannelActivity: telegramDeps.recordChannelActivity }
    : undefined;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    turnContext: TelegramMessageProcessorTurnContext,
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
    replyChain?: TelegramReplyChainEntry[],
    promptContext?: TelegramPromptContextEntry[],
  ) => {
    const turnCfg = turnContext.cfg;
    const turnTelegramCfg = turnContext.telegramCfg;
    const turnSettings = resolveTelegramMessageTurnSettings({
      accountId: account.accountId,
      cfg: turnCfg,
      telegramCfg: turnTelegramCfg,
      opts,
    });
    const ingressReceivedAtMs =
      typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs)
        ? options.receivedAtMs
        : undefined;
    const ingressDebugEnabled =
      shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
    const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : undefined;
    const recordCurrentUpdateProcessingResult = (result: TelegramMessageProcessingResult) => {
      if (options?.spooledReplay === true) {
        return;
      }
      recordTelegramMessageProcessingResult(result);
    };
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      replyChain,
      promptContext,
      storeAllowFrom,
      options,
      bot,
      cfg: turnCfg,
      account,
      historyLimit: turnSettings.historyLimit,
      groupHistories,
      dmPolicy: turnSettings.dmPolicy,
      allowFrom: turnSettings.allowFrom,
      groupAllowFrom: turnSettings.groupAllowFrom,
      ackReactionScope: turnSettings.ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
      runtime: contextRuntime,
      sessionRuntime,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
        logVerbose(
          `telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      const result: TelegramMessageProcessingResult = { kind: "skipped" };
      recordCurrentUpdateProcessingResult(result);
      return result;
    }
    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
      );
    }
    if (
      context.ctxPayload.InboundEventKind !== "room_event" &&
      context.initialTypingCueSent !== true
    ) {
      void context.sendTyping().catch((err: unknown) => {
        logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
      });
    }
    telegramInboundLog.info(
      formatTelegramInboundLogLine({
        from: context.ctxPayload.From,
        to: context.primaryCtx.me?.username
          ? `@${context.primaryCtx.me.username}`
          : context.ctxPayload.To,
        chatType: context.ctxPayload.ChatType,
        body: context.ctxPayload.RawBody,
        mediaType: allMedia[0]?.contentType,
      }),
    );
    await turnContext.onDispatchStart?.();
    const spooledReplay =
      options?.spooledReplay === true || isTelegramSpooledReplayUpdate(primaryCtx.update);

    const runDispatch = async (params: {
      onTurnAdopted?: () => void | Promise<void>;
    }): Promise<TelegramMessageProcessingResult> => {
      try {
        const dispatchResult = await dispatchTelegramMessage({
          context,
          bot,
          cfg: context.cfg,
          runtime,
          replyToMode: turnSettings.replyToMode,
          streamMode: turnSettings.streamMode,
          textLimit: turnSettings.textLimit,
          telegramCfg: turnTelegramCfg,
          telegramDeps,
          opts,
          retryDispatchErrors: spooledReplay,
          suppressFailureFallback: spooledReplay,
          onTurnAdopted: params.onTurnAdopted,
        });
        if (dispatchResult?.kind === "failed-retryable") {
          const result: TelegramMessageProcessingResult = {
            kind: "failed-retryable",
            error: dispatchResult.error,
          };
          recordCurrentUpdateProcessingResult(result);
          return result;
        }
        if (ingressDebugEnabled && ingressReceivedAtMs) {
          logVerbose(
            `telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` +
              (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
          );
        }
        const result: TelegramMessageProcessingResult = { kind: "completed" };
        recordCurrentUpdateProcessingResult(result);
        return result;
      } catch (err) {
        runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
        if (!spooledReplay) {
          try {
            await bot.api.sendMessage(
              context.chatId,
              "Something went wrong while processing your request. Please try again.",
              buildTelegramThreadParams(context.threadSpec),
            );
          } catch {}
        }
        const result: TelegramMessageProcessingResult = {
          kind: "failed-retryable",
          error: err,
        };
        recordCurrentUpdateProcessingResult(result);
        return result;
      }
    };

    // Spooled ingress: complete the spool row at turn adoption (recovery state
    // persisted), not settle. The deferred participant hands ownership back to
    // the spool drain so the per-chat lane frees while the agent turn continues.
    if (spooledReplay) {
      const existingParticipant = getTelegramSpooledReplayDeferredParticipant();
      const participant =
        existingParticipant ??
        createTelegramSpooledReplayDeferredParticipant(
          `agent-turn:${context.chatId}:${context.ctxPayload.MessageSid ?? Date.now()}`,
        );
      if (participant) {
        let adopted = false;
        const settleIfNeeded = (result: TelegramMessageProcessingResult) => {
          if (adopted) {
            return;
          }
          participant.settle(result);
        };
        const run = async () => {
          const result = await runDispatch({
            onTurnAdopted: async () => {
              if (adopted) {
                return;
              }
              adopted = true;
              participant.settle({ kind: "completed" });
            },
          });
          settleIfNeeded(result);
          return result;
        };
        if (existingParticipant) {
          return await run();
        }
        void run();
        const detached: TelegramMessageProcessingResult = { kind: "completed" };
        return detached;
      }
    }

    return await runDispatch({});
  };
};
