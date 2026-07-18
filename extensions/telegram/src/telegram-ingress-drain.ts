// Telegram plugin module owns the channel-side durable ingress drain adapter.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clampPositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { TelegramBotInfo } from "./bot-info.js";
import {
  runWithTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { resolveTelegramIngressNonRetryableFailure } from "./telegram-ingress-non-retryable.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import { createShouldSupersedeTelegramSpooledPending } from "./telegram-ingress-supersede.js";

const TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
const TELEGRAM_SPOOLED_DRAIN_START_LIMIT = 100;
const TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT = TELEGRAM_SPOOLED_DRAIN_START_LIMIT * 10;

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

export type TelegramIngressDrainLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

type TelegramIngressDrainDispatch = (
  update: unknown,
  lifecycle: TelegramIngressDrainLifecycle,
) => Promise<TelegramMessageProcessingResult | void> | TelegramMessageProcessingResult | void;

type CreateTelegramIngressDrainParams = {
  queue: ChannelIngressQueue<TelegramSpooledUpdatePayload>;
  /** Required for authorization-gated supersede (numeric allowlist). */
  cfg: OpenClawConfig;
  accountId: string;
  botInfo?: TelegramBotInfo;
  adoptionStallTimeoutMs?: number;
  dispatch: TelegramIngressDrainDispatch;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
};

/**
 * Shared polling/webhook drain over the core channel-ingress worker.
 *
 * room_event ambient work shares the sequential lane with the parent chat so a
 * later user turn can supersede it pre-adoption; adopted user turns are never
 * touched (core drain supersede is pre-adoption only).
 */
export function createTelegramIngressDrain(
  params: CreateTelegramIngressDrainParams,
): ChannelIngressDrain {
  return createChannelIngressDrain<TelegramSpooledUpdatePayload>({
    queue: params.queue,
    adoptionStallTimeoutMs: params.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
    orderBy: "id",
    scanLimit: TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT,
    startLimit: TELEGRAM_SPOOLED_DRAIN_START_LIMIT,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    },
    resolveNonRetryableFailure: resolveTelegramIngressNonRetryableFailure,
    shouldSupersedePending: createShouldSupersedeTelegramSpooledPending({
      cfg: params.cfg,
      accountId: params.accountId,
      ...(params.botInfo?.username ? { botUsername: params.botInfo.username } : {}),
    }),
    deriveLaneKey: (record) => telegramSpooledLaneKey(record.payload.update, params.botInfo),
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    dispatchClaimedEvent: async (event, lifecycle) => {
      const bound = bindIngressLifecycleToReplyOptions(lifecycle);
      const drainLifecycle: TelegramIngressDrainLifecycle = {
        abortSignal: bound.turnAdoptionLifecycle.abortSignal,
        onAdopted: bound.turnAdoptionLifecycle.onAdopted,
        onDeferred: bound.turnAdoptionLifecycle.onDeferred,
        onAdoptionFinalizing: lifecycle.onAdoptionFinalizing,
        onAbandoned: bound.turnAdoptionLifecycle.onAbandoned,
      };
      try {
        const result = await runWithTelegramSpooledReplayUpdate(
          event.payload.update as object,
          async () => await params.dispatch(event.payload.update, drainLifecycle),
          drainLifecycle,
        );
        // Propagate explicit dispatch outcomes first.
        const outcome = result.value;
        if (outcome && typeof outcome === "object" && "kind" in outcome) {
          if (outcome.kind === "failed-retryable") {
            return { kind: "failed-retryable", error: outcome.error };
          }
          if (outcome.kind === "completed" || outcome.kind === "skipped") {
            return { kind: "completed" };
          }
        }
        // deferredWork exists for every spooled participant, not only genuine
        // queued followups. Await the terminal participant outcome (or drain
        // abort from guillotine/supersede) so failed-retryable releases and
        // stalls do not hang the dispatch task forever.
        const participant = result.deferredWork;
        if (participant) {
          const terminal = await new Promise<TelegramMessageProcessingResult>((resolve, reject) => {
            const abortError = () =>
              drainLifecycle.abortSignal.reason instanceof Error
                ? drainLifecycle.abortSignal.reason
                : new Error("ingress-aborted");
            if (drainLifecycle.abortSignal.aborted) {
              reject(abortError());
              return;
            }
            const onAbort = () => {
              reject(abortError());
            };
            drainLifecycle.abortSignal.addEventListener("abort", onAbort, { once: true });
            void participant.task.then(
              (value) => {
                drainLifecycle.abortSignal.removeEventListener("abort", onAbort);
                resolve(value);
              },
              (error: unknown) => {
                drainLifecycle.abortSignal.removeEventListener("abort", onAbort);
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
          }).then(
            (value) => value,
            (error: unknown) => {
              // Guillotine/supersede already own settleOnce — do not re-fail.
              if (drainLifecycle.abortSignal.aborted) {
                return { kind: "skipped" as const };
              }
              throw error;
            },
          );
          if (terminal.kind === "failed-retryable") {
            return { kind: "failed-retryable", error: terminal.error };
          }
          return { kind: "completed" };
        }
        return { kind: "completed" };
      } catch (error) {
        return { kind: "failed-retryable", error };
      }
    },
  });
}
