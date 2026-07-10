// Telegram plugin module implements bot message behavior.
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
  sleepWithAbort,
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
  createTelegramSpooledReplayParticipant,
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramThreadParams, resolveTelegramStreamMode } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";
import { resolveSpooledUpdatePersistenceRetryDelayMs } from "./spooled-update-retry-policy.js";

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
  /** One-way cancellation from an outer spool owner into an isolated retry attempt. */
  spooledReplayAbortSignal?: AbortSignal;
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  finalizeSpooledReplayResult?: (
    result: TelegramMessageProcessingResult,
    phase: "adopted" | "terminal",
  ) => Promise<TelegramMessageProcessingResult>;
  completeSpooledReplayAfterIrrevocableAdoption?: (
    error: unknown,
  ) => Promise<TelegramMessageProcessingResult> | TelegramMessageProcessingResult;
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
    const spooledReplay =
      options?.spooledReplay === true || isTelegramSpooledReplayUpdate(primaryCtx.update);
    if (!spooledReplay) {
      await turnContext.onDispatchStart?.();
    }
    const runDispatch = async (params: {
      onTurnAdopted?: () => void | Promise<void>;
      onTurnDeferred?: () => void;
      onTurnAbandoned?: () => void;
      turnAbortSignal?: AbortSignal;
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
          onTurnDeferred: params.onTurnDeferred,
          onTurnAbandoned: params.onTurnAbandoned,
          turnAbortSignal: params.turnAbortSignal,
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
      const existingParticipant =
        turnContext.spooledReplayParticipant ??
        (options?.isolateSpooledReplaySettlement
          ? undefined
          : getTelegramSpooledReplayDeferredParticipant());
      const participant =
        existingParticipant ??
        (options?.isolateSpooledReplaySettlement
          ? undefined
          : createTelegramSpooledReplayDeferredParticipant(
              `agent-turn:${context.chatId}:${context.ctxPayload.MessageSid ?? Date.now()}`,
            )) ??
        createTelegramSpooledReplayParticipant(
          `agent-turn:${context.chatId}:${context.ctxPayload.MessageSid ?? Date.now()}`,
        );
      let adopted = false;
      let adoptionAttempted = false;
      let adoptionFinalizationError: unknown;
      let deferred = false;
      let settledResult: TelegramMessageProcessingResult | undefined;
      let settlement: Promise<TelegramMessageProcessingResult> | undefined;
      const settle = async (
        result: TelegramMessageProcessingResult,
        phase: "adopted" | "terminal",
      ): Promise<TelegramMessageProcessingResult> => {
        if (settledResult) {
          return settledResult;
        }
        if (settlement) {
          return await settlement;
        }
        settlement = (async () => {
          let finalized: TelegramMessageProcessingResult;
          try {
            finalized = turnContext.finalizeSpooledReplayResult
              ? await turnContext.finalizeSpooledReplayResult(result, phase)
              : result;
          } catch (error) {
            finalized = { kind: "failed-retryable", error };
          }
          // A deferred queue item still owns the turn when its admission
          // callback fails. Leave the spool participant pending so the queue
          // can retry admission without creating a second ingress owner.
          if (phase === "adopted" && finalized.kind !== "completed") {
            return finalized;
          }
          if (phase === "adopted" && finalized.kind === "completed") {
            adopted = true;
          }
          settledResult = finalized;
          participant.settle(finalized);
          return finalized;
        })();
        try {
          return await settlement;
        } finally {
          if (!settledResult) {
            settlement = undefined;
          }
        }
      };
      const run = async () => {
        const turnAbortSignal = turnContext.spooledReplayAbortSignal
          ? AbortSignal.any([participant.abortSignal, turnContext.spooledReplayAbortSignal])
          : participant.abortSignal;
        const result = await runDispatch({
          turnAbortSignal,
          onTurnAdopted: async () => {
            if (adopted) {
              return;
            }
            adoptionAttempted = true;
            const adoptedResult = await settle({ kind: "completed" }, "adopted");
            if (adoptedResult.kind !== "completed") {
              adoptionFinalizationError =
                adoptedResult.kind === "failed-retryable"
                  ? adoptedResult.error
                  : new Error("telegram spooled turn adoption was not completed");
              throw adoptedResult.kind === "failed-retryable"
                ? adoptedResult.error
                : new Error("telegram spooled turn adoption was not completed");
            }
          },
          onTurnDeferred: () => {
            deferred = true;
          },
          onTurnAbandoned: () => {
            if (!adopted) {
              void settle({ kind: "skipped" }, "terminal");
            }
          },
        });
        if (adopted) {
          return { kind: "completed" } satisfies TelegramMessageProcessingResult;
        }
        if (settledResult) {
          return settledResult;
        }
        if (adoptionAttempted && !deferred && result.kind === "completed") {
          runtime.error?.(
            danger(
              `telegram spooled turn adoption finalization failed after active steer commit: ${String(
                adoptionFinalizationError,
              )}`,
            ),
          );
          let retryError = adoptionFinalizationError;
          let retryAttempt = 0;
          while (!turnAbortSignal.aborted) {
            retryAttempt += 1;
            try {
              const completed =
                (await turnContext.completeSpooledReplayAfterIrrevocableAdoption?.(retryError)) ??
                ({ kind: "completed" } satisfies TelegramMessageProcessingResult);
              if (completed.kind === "completed") {
                adopted = true;
                settledResult = completed;
                participant.settle(completed);
                return completed;
              }
              retryError =
                completed.kind === "failed-retryable"
                  ? completed.error
                  : new Error("telegram spooled turn adoption was not completed");
            } catch (error) {
              retryError = error;
            }
            const delayMs = resolveSpooledUpdatePersistenceRetryDelayMs(retryAttempt);
            runtime.error?.(
              danger(
                `telegram spooled turn durable replay protection retry ${retryAttempt} failed after active steer commit; retrying in ${delayMs}ms: ${String(retryError)}`,
              ),
            );
            try {
              await sleepWithAbort(delayMs, turnAbortSignal);
            } catch {
              break;
            }
          }
          if (turnAbortSignal.aborted && !participant.abortSignal.aborted) {
            const abortResult: TelegramMessageProcessingResult =
              turnAbortSignal.reason === "skipped"
                ? { kind: "skipped" }
                : {
                    kind: "failed-retryable",
                    error:
                      turnAbortSignal.reason ??
                      new Error("telegram spooled replay owner cancelled"),
                  };
            participant.settle(abortResult);
          }
          return await participant.task;
        }
        if (deferred) {
          return await participant.task;
        }
        return await settle(result, "terminal");
      };
      // The participant is the ingress ownership boundary. Direct and buffered
      // callers both return when it is durably adopted or terminally rejected.
      void run();
      return await participant.task;
    }

    return await runDispatch({});
  };
};
