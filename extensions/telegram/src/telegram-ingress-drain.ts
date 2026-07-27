// Telegram plugin module owns the channel-side durable ingress monitor adapter.
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  type ChannelIngressMonitorLifecycle,
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
import {
  resolveTelegramUpdateId,
  TELEGRAM_SPOOLED_UPDATE_COMPLETED_MAX_ENTRIES,
  TELEGRAM_SPOOLED_UPDATE_COMPLETED_TTL_MS,
  TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES,
  TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS,
  telegramQueueEventId,
} from "./telegram-ingress-spool.js";
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
const TELEGRAM_SPOOLED_DRAIN_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

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

function inspectTelegramSpooledUpdate(update: unknown, botInfo?: TelegramBotInfo) {
  const updateId = resolveTelegramUpdateId(update);
  if (updateId === null) {
    throw new TelegramIngressPayloadError("Telegram spooled update is missing numeric update_id.");
  }
  return {
    eventId: telegramQueueEventId(updateId),
    laneKey: telegramSpooledLaneKey(update, botInfo),
  };
}

export type TelegramIngressDrainLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

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
    inspect: (update) => inspectTelegramSpooledUpdate(update, params.botInfo),
    payload: {
      version: TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
      serialize: (update, { receivedAt }) => {
        const updateId = resolveTelegramUpdateId(update);
        if (updateId === null) {
          throw new TelegramIngressPayloadError(
            "Telegram spooled update is missing numeric update_id.",
          );
        }
        return { version: TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION, updateId, receivedAt, update };
      },
      deserialize: (payload) => payload.update,
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
      try {
        const result = await runWithTelegramSpooledReplayUpdate(
          update as object,
          async () => await params.dispatch(update, lifecycle),
          lifecycle,
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
        // Every spooled participant gets deferredWork. Wait for its terminal
        // result so failed-retryable releases and stalls cannot disappear.
        const participant = result.deferredWork;
        if (participant) {
          const terminal = await new Promise<TelegramMessageProcessingResult>((resolve, reject) => {
            const abortError = () =>
              lifecycle.abortSignal.reason instanceof Error
                ? lifecycle.abortSignal.reason
                : new Error("ingress-aborted");
            if (lifecycle.abortSignal.aborted) {
              reject(abortError());
              return;
            }
            const onAbort = () => reject(abortError());
            lifecycle.abortSignal.addEventListener("abort", onAbort, { once: true });
            void participant.task.then(
              (value) => {
                lifecycle.abortSignal.removeEventListener("abort", onAbort);
                resolve(value);
              },
              (error: unknown) => {
                lifecycle.abortSignal.removeEventListener("abort", onAbort);
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
          }).then(
            (value) => value,
            (error: unknown) => {
              if (lifecycle.abortSignal.aborted) {
                return { kind: "skipped" as const };
              }
              throw error;
            },
          );
          if (terminal.kind === "failed-retryable") {
            return { kind: "failed-retryable", error: terminal.error };
          }
          if (lifecycle.abortSignal.aborted) {
            return {
              kind: "failed-retryable",
              error:
                lifecycle.abortSignal.reason instanceof Error
                  ? lifecycle.abortSignal.reason
                  : new Error("ingress-aborted"),
            };
          }
        }
        await lifecycle.onAdopted();
        return { kind: "completed" };
      } catch (error) {
        return { kind: "failed-retryable", error };
      }
    },
    pollIntervalMs: params.pollIntervalMs ?? TELEGRAM_SPOOLED_DRAIN_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: TELEGRAM_SPOOLED_DRAIN_PRUNE_INTERVAL_MS,
      completedTtlMs: TELEGRAM_SPOOLED_UPDATE_COMPLETED_TTL_MS,
      completedMaxEntries: TELEGRAM_SPOOLED_UPDATE_COMPLETED_MAX_ENTRIES,
      failedTtlMs: TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS,
      failedMaxEntries: TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES,
    },
    drain: {
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
      ...(params.onLog ? { onLog: params.onLog } : {}),
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    admissionMode: "while-running",
    createStoppedError: () => new Error("Telegram ingress monitor is stopped."),
    ...(params.onError ? { onError: params.onError } : {}),
  });
}
