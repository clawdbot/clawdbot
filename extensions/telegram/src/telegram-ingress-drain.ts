// Telegram plugin module owns the channel-side durable ingress monitor adapter.
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
  type ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clampPositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  fitsTelegramCallbackData,
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import type { TelegramBotInfo } from "./bot-info.js";
import {
  runWithTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  getCachedTelegramForumFlag,
  resolveTelegramForumThreadId,
  resolveTelegramMessageForumFlagHint,
} from "./bot/helpers.js";
import {
  getPreparedTelegramPollAnswer,
  isEligibleTelegramPollAnswerUpdate,
  prepareTelegramPollAnswerContext,
  recordPreparedTelegramPollAnswer,
  settleTelegramPollAnswerContext,
} from "./poll-answer-context.js";
import { hasTelegramQuestionCallbackPrefix } from "./question-callback-data.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import { resolveTelegramIngressNonRetryableFailure } from "./telegram-ingress-non-retryable.js";
import { resolveTelegramUpdateId, telegramQueueEventId } from "./telegram-ingress-spool.js";
import {
  TelegramIngressPayloadError,
  TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";
import { createShouldSupersedeTelegramSpooledPending } from "./telegram-ingress-supersede.js";

const TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
const TELEGRAM_SPOOLED_DRAIN_START_LIMIT = 100;
const TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT = TELEGRAM_SPOOLED_DRAIN_START_LIMIT * 10;
const TELEGRAM_SPOOLED_DRAIN_POLL_INTERVAL_MS = 500;

export function resolveTelegramAdoptionStallTimeoutMs(params: {
  configured?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const candidates = [
    params.configured,
    Number(params.env?.[TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV]),
  ];
  for (const candidate of candidates) {
    const timeoutMs = clampPositiveTimerTimeoutMs(candidate);
    if (timeoutMs !== undefined) {
      return timeoutMs;
    }
  }
  return DEFAULT_INGRESS_ADOPTION_STALL_MS;
}

function telegramSpooledLaneKey(update: unknown, botInfo?: TelegramBotInfo): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
    ...(botInfo ? { me: botInfo } : {}),
  });
}

function inspectTelegramSpooledUpdate(
  update: unknown,
  botInfo?: TelegramBotInfo,
  claimedLaneKey?: string,
) {
  const updateId = resolveTelegramUpdateId(update);
  if (updateId === null) {
    throw new TelegramIngressPayloadError("Telegram spooled update is missing numeric update_id.");
  }
  const derivedLaneKey = telegramSpooledLaneKey(update, botInfo);
  const preservePreIdentityControlLane =
    botInfo !== undefined &&
    claimedLaneKey?.endsWith(":control") === true &&
    claimedLaneKey !== derivedLaneKey &&
    claimedLaneKey === telegramSpooledLaneKey(update);
  return {
    eventId: telegramQueueEventId(updateId),
    // Admission can precede getMe(). Preserve only the exact control lane that
    // the same payload derived before identity became available.
    laneKey: preservePreIdentityControlLane ? claimedLaneKey : derivedLaneKey,
  };
}

function isNonemptyTelegramCallbackValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedTelegramCallbackData(value: unknown): value is string {
  return isNonemptyTelegramCallbackValue(value) && fitsTelegramCallbackData(value);
}

function canReconcileTelegramLegacyLane(params: {
  record: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>;
  storedLaneKey: string;
  derivedLaneKey: string;
  accountId: string;
  botInfo?: TelegramBotInfo;
}): boolean {
  if (
    params.record.channelId !== "telegram" ||
    params.record.accountId !== normalizeTelegramStateAccountId(params.accountId)
  ) {
    return false;
  }
  const update = params.record.payload.update;
  if (!update || typeof update !== "object") {
    return false;
  }
  type TelegramLaneMessage = {
    chat?: { id?: unknown; is_forum?: unknown; type?: unknown };
    business_connection_id?: unknown;
    date?: unknown;
    direct_messages_topic?: unknown;
    from?: { id?: unknown; is_bot?: unknown };
    guest_query_id?: unknown;
    message_id?: unknown;
    message_thread_id?: unknown;
    is_topic_message?: unknown;
    sender_chat?: unknown;
  };
  type TelegramLaneCallback = {
    id?: unknown;
    data?: unknown;
    chat_instance?: unknown;
    inline_message_id?: unknown;
    from?: { id?: unknown; is_bot?: unknown };
    message?: TelegramLaneMessage;
  };
  const candidate = update as {
    message?: TelegramLaneMessage;
    edited_message?: TelegramLaneMessage;
    callback_query?: TelegramLaneCallback;
  };
  const callback = candidate.callback_query;
  if (callback !== undefined) {
    if (!callback || typeof callback !== "object") {
      return false;
    }
    const senderId = callback.from?.id;
    const callbackMessage = callback.message;
    if (
      candidate.message !== undefined ||
      candidate.edited_message !== undefined ||
      !isNonemptyTelegramCallbackValue(callback.id) ||
      !isBoundedTelegramCallbackData(callback.data) ||
      !isNonemptyTelegramCallbackValue(callback.chat_instance) ||
      callback.inline_message_id !== undefined ||
      typeof senderId !== "number" ||
      !Number.isSafeInteger(senderId) ||
      senderId <= 0 ||
      callback.from?.is_bot !== false ||
      !params.botInfo ||
      callbackMessage?.from?.id !== params.botInfo.id ||
      callbackMessage.from.is_bot !== true ||
      callbackMessage.business_connection_id !== undefined ||
      callbackMessage.guest_query_id !== undefined ||
      callbackMessage.sender_chat !== undefined ||
      callbackMessage.direct_messages_topic !== undefined ||
      typeof callbackMessage.date !== "number" ||
      !Number.isSafeInteger(callbackMessage.date) ||
      callbackMessage.date <= 0 ||
      typeof callbackMessage.message_id !== "number" ||
      !Number.isSafeInteger(callbackMessage.message_id) ||
      callbackMessage.message_id <= 0
    ) {
      return false;
    }
  }
  const message = candidate.message ?? candidate.edited_message ?? callback?.message;
  if (message == null) {
    return false;
  }
  const chatId = message?.chat?.id;
  const chatType = message?.chat?.type;
  const threadId = message?.message_thread_id;
  const callbackData = typeof callback?.data === "string" ? callback.data : undefined;
  const typedApproval = parseTelegramApprovalCallbackData(callbackData);
  const isPrivateChat = chatType === "private" && typeof chatId === "number" && chatId > 0;
  const isGroupChat =
    (chatType === "group" || chatType === "supergroup") && typeof chatId === "number" && chatId < 0;
  const hasValidThreadId =
    typeof threadId === "number" && Number.isSafeInteger(threadId) && threadId > 0;
  const chatTypeHint =
    chatType === "channel" ||
    chatType === "group" ||
    chatType === "private" ||
    chatType === "supergroup"
      ? chatType
      : undefined;
  const forumFlag =
    resolveTelegramMessageForumFlagHint({
      chatType: chatTypeHint,
      isForum: typeof message.chat?.is_forum === "boolean" ? message.chat.is_forum : undefined,
      isTopicMessage:
        typeof message.is_topic_message === "boolean" ? message.is_topic_message : undefined,
    }) ?? (typeof chatId === "number" ? getCachedTelegramForumFlag(chatId) : undefined);
  const isForumGroup = isGroupChat && forumFlag === true;
  if (
    typeof chatId !== "number" ||
    !Number.isSafeInteger(chatId) ||
    (typedApproval ? !isPrivateChat && !isGroupChat : !isPrivateChat && !isForumGroup) ||
    (!typedApproval && !hasValidThreadId && !isForumGroup) ||
    (typedApproval && threadId !== undefined && !hasValidThreadId)
  ) {
    return false;
  }
  const baseLaneKey = `telegram:${chatId}`;
  const legacyThreadId = isGroupChat
    ? resolveTelegramForumThreadId({
        isForum: forumFlag,
        messageThreadId: hasValidThreadId ? threadId : undefined,
      })
    : hasValidThreadId
      ? threadId
      : undefined;
  const topicLaneKey = legacyThreadId ? `${baseLaneKey}:topic:${legacyThreadId}` : undefined;
  const canonicalLaneKey = typedApproval
    ? `${baseLaneKey}:approval`
    : isForumGroup || params.botInfo?.has_topics_enabled === true
      ? topicLaneKey
      : baseLaneKey;
  const previousLaneKey = canonicalLaneKey === baseLaneKey ? topicLaneKey : baseLaneKey;

  // Signed releases stored typed approvals in ordinary chat/forum lanes. Admit only a
  // valid, authenticated owner callback into its dedicated privileged lane.
  return (
    (typedApproval
      ? params.storedLaneKey === baseLaneKey || params.storedLaneKey === topicLaneKey
      : !hasTelegramApprovalCallbackPrefix(callbackData) &&
        !hasTelegramQuestionCallbackPrefix(callbackData) &&
        params.storedLaneKey === previousLaneKey) &&
    params.derivedLaneKey === canonicalLaneKey &&
    telegramSpooledLaneKey(update, params.botInfo) === canonicalLaneKey
  );
}

type TelegramIngressDrainLifecycle = Omit<
  ChannelIngressMonitorLifecycle,
  "admission" | "onFailed" | "onCancelled"
> & {
  onFailed: (error: unknown) => void | Promise<void>;
  onCancelled: () => void | Promise<void>;
};

type TelegramIngressDrainDispatch = (
  update: unknown,
  lifecycle: TelegramIngressDrainLifecycle,
) => Promise<TelegramMessageProcessingResult | void> | TelegramMessageProcessingResult | void;

type CreateTelegramIngressMonitorParams = {
  queue: ChannelIngressQueue<TelegramSpooledUpdatePayload>;
  /** Required for authorization-gated supersede (numeric allowlist). */
  cfg: OpenClawConfig;
  accountId: string;
  botInfo?: TelegramBotInfo;
  adoptionStallTimeoutMs?: number;
  pollIntervalMs?: number;
  dispatch: TelegramIngressDrainDispatch;
  onDurableAdmission?: (update: unknown, context: { isNew: boolean }) => void | Promise<void>;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
  abortSignal?: AbortSignal;
};

/**
 * Shared polling/webhook monitor over Telegram's channel-owned durable spool.
 *
 * The transports keep durable admission because offset advancement and webhook
 * acknowledgement depend on that exact boundary; requestDrain() bridges the
 * committed spool append into the shared pump.
 */
export function createTelegramIngressMonitor(params: CreateTelegramIngressMonitorParams) {
  return createChannelIngressMonitor<
    unknown,
    TelegramSpooledUpdatePayload,
    TelegramSpooledUpdatePayload
  >({
    queue: params.queue,
    inspect: (update, context) => {
      if (
        context.phase === "admission" &&
        typeof update === "object" &&
        update !== null &&
        isEligibleTelegramPollAnswerUpdate(update)
      ) {
        prepareTelegramPollAnswerContext({ update, accountId: params.accountId });
      }
      return inspectTelegramSpooledUpdate(
        update,
        params.botInfo,
        context.phase === "claim" ? context.claimedLaneKey : undefined,
      );
    },
    payload: {
      version: TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
      serialize: (update, { receivedAt }) => {
        const updateId = resolveTelegramUpdateId(update);
        if (updateId === null) {
          throw new TelegramIngressPayloadError(
            "Telegram spooled update is missing numeric update_id.",
          );
        }
        const preparedPollAnswer =
          typeof update === "object" && update !== null
            ? getPreparedTelegramPollAnswer(update)
            : undefined;
        return {
          version: TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
          updateId,
          receivedAt,
          update,
          ...(preparedPollAnswer ? { preparedPollAnswer } : {}),
        };
      },
      deserialize: (payload) => {
        const update = payload.update;
        if (payload.preparedPollAnswer && typeof update === "object" && update !== null) {
          recordPreparedTelegramPollAnswer(update, payload.preparedPollAnswer);
        }
        return update;
      },
      encode: ({ body }) => body,
      decode: (payload) => ({ version: payload.version, body: payload }),
      createClaimError: (kind, claim) =>
        new TelegramIngressPayloadError(
          kind === "invalid-version"
            ? `Telegram ingress row ${claim.id} has an unsupported payload version.`
            : `Telegram ingress row ${claim.id} changed update identity.`,
        ),
    },
    deliver: async (update, lifecycle) => {
      // The monitor supplies both callbacks; optional public fields preserve
      // structural compatibility for channel lifecycles that do not need them.
      const telegramLifecycle = lifecycle as TelegramIngressDrainLifecycle;
      try {
        const result = await runWithTelegramSpooledReplayUpdate(
          update as object,
          async () => {
            await settleTelegramPollAnswerContext({
              update: update as object,
              accountId: params.accountId,
            });
            return await params.dispatch(update, telegramLifecycle);
          },
          telegramLifecycle,
        );
        const outcome = result.value;
        if (outcome && typeof outcome === "object" && "kind" in outcome) {
          if (outcome.kind === "failed-retryable") {
            return { kind: "failed-retryable", error: outcome.error };
          }
          if (outcome.kind === "completed" || outcome.kind === "skipped") {
            await lifecycle.onAdopted();
            return { kind: "completed" };
          }
        }
        // Every spooled participant gets deferredWork. Forward its terminal
        // result without retaining Telegram's ingress serialization lane.
        const participant = result.deferredWork;
        if (participant) {
          let abortedWhilePending = participant.wasOwnerAbortedWhilePending();
          const onAbort = () => {
            if (!participant.isSettled()) {
              abortedWhilePending = true;
            }
          };
          telegramLifecycle.abortSignal.addEventListener("abort", onAbort, { once: true });
          const removeAbortListener = () => {
            telegramLifecycle.abortSignal.removeEventListener("abort", onAbort);
          };
          const settleAfterOwnerAbort = async (error?: unknown) => {
            // A lost owner did not finish a delivery attempt. Preserve only the
            // rollback failure for which replay is unsafe after a dispatch key
            // committed but could not be removed.
            if (
              error !== undefined &&
              resolveTelegramIngressNonRetryableFailure(error)?.reason ===
                "dispatch-dedupe-rollback-failed"
            ) {
              await telegramLifecycle.onFailed(error);
              return;
            }
            await telegramLifecycle.onCancelled();
          };
          // Two-arg then: the rejection arm must observe only a participant.task
          // rejection. Chaining it as .catch would also swallow onFailed/onAdopted
          // settlement errors and re-drive them through onFailed with an
          // infrastructure error — applying the wrong disposition, or silently
          // discarding a wedged tombstone once the phase moved past pre-adoption.
          void participant.task
            .then(
              async (terminal) => {
                removeAbortListener();
                if (abortedWhilePending) {
                  await settleAfterOwnerAbort(
                    terminal.kind === "failed-retryable" ? terminal.error : undefined,
                  );
                  return;
                }
                if (terminal.kind === "failed-retryable") {
                  await telegramLifecycle.onFailed(terminal.error);
                  return;
                }
                await lifecycle.onAdopted();
              },
              async (error: unknown) => {
                removeAbortListener();
                if (abortedWhilePending) {
                  await settleAfterOwnerAbort(error);
                  return;
                }
                await telegramLifecycle.onFailed(
                  error instanceof Error ? error : new Error(String(error)),
                );
              },
            )
            .catch((error: unknown) => {
              params.onLog?.(
                `telegram ingress: deferred settlement failed for update ${
                  resolveTelegramUpdateId(update) ?? "unknown"
                }: ${String(error)}`,
              );
            });
          return { kind: "deferred" };
        }
        if (!participant) {
          // A dispatched update that records no outcome and defers no participant
          // was consumed silently; completing here tombstones the spool row with
          // attempts=0 and no trace, so keep a diagnostic trail for regressions.
          params.onLog?.(
            `telegram ingress: update ${resolveTelegramUpdateId(update) ?? "unknown"} completed without a recorded processing outcome`,
          );
        }
        await lifecycle.onAdopted();
        return { kind: "completed" };
      } catch (error) {
        return { kind: "failed-retryable", error };
      }
    },
    pollIntervalMs: params.pollIntervalMs ?? TELEGRAM_SPOOLED_DRAIN_POLL_INTERVAL_MS,
    retention: {
      completedMaxEntries: 1_000,
      failedMaxEntries: 1_000,
    },
    drain: {
      deferredLaneOccupancy: "release",
      adoptionStallTimeoutMs: params.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      orderBy: "id",
      scanLimit: TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT,
      startLimit: TELEGRAM_SPOOLED_DRAIN_START_LIMIT,
      resolveNonRetryableFailure: resolveTelegramIngressNonRetryableFailure,
      shouldSupersedePending: createShouldSupersedeTelegramSpooledPending({
        cfg: params.cfg,
        accountId: params.accountId,
        ...(params.botInfo?.username ? { botUsername: params.botInfo.username } : {}),
      }),
      deriveLaneKey: (record) => telegramSpooledLaneKey(record.payload.update, params.botInfo),
      reconcileStoredLaneKey: (record, storedLaneKey, derivedLaneKey) =>
        canReconcileTelegramLegacyLane({
          record,
          storedLaneKey,
          derivedLaneKey,
          accountId: params.accountId,
          botInfo: params.botInfo,
        }),
      ...(params.onLog ? { onLog: params.onLog } : {}),
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    admissionMode: "while-running",
    createStoppedError: () => new Error("Telegram ingress monitor is stopped."),
    ...(params.onDurableAdmission ? { onDurableAdmission: params.onDurableAdmission } : {}),
    ...(params.onError ? { onError: params.onError } : {}),
  });
}
