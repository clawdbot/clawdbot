// Telegram plugin module builds transport-shared durable ingress monitors.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramBotInfo } from "./bot-info.js";
import type { TelegramMessageProcessingResult } from "./bot-processing-outcome.js";
import {
  createTelegramIngressMonitor,
  resolveTelegramAdoptionStallTimeoutMs,
  type TelegramIngressDrainLifecycle,
} from "./telegram-ingress-drain.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";

type TelegramSpooledBot = {
  handleUpdate: (update: never) => Promise<void>;
};

type CreateTelegramTransportIngressMonitorParams = {
  spoolDir: string;
  bot: TelegramSpooledBot;
  cfg: OpenClawConfig;
  accountId: string;
  botInfo?: TelegramBotInfo;
  adoptionStallTimeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
  abortSignal?: AbortSignal;
  /**
   * Optional override for full dispatch (tests). Default: bot.handleUpdate under
   * the drain lifecycle via bot-message spooled replay path.
   */
  dispatchUpdate?: (
    update: unknown,
    lifecycle: TelegramIngressDrainLifecycle,
  ) => Promise<TelegramMessageProcessingResult | void>;
};

/**
 * One monitor for polling + webhook: channel-owned append, shared claim →
 * dispatch with turnAdoptionLifecycle → complete at adoption.
 */
export function createTelegramTransportIngressMonitor(
  params: CreateTelegramTransportIngressMonitorParams,
) {
  const queue = openTelegramIngressQueue(params.spoolDir);
  const adoptionStallTimeoutMs = resolveTelegramAdoptionStallTimeoutMs({
    configured: params.adoptionStallTimeoutMs,
    env: process.env,
  });
  return createTelegramIngressMonitor({
    queue,
    cfg: params.cfg,
    accountId: params.accountId,
    botInfo: params.botInfo,
    adoptionStallTimeoutMs,
    ...(params.pollIntervalMs === undefined ? {} : { pollIntervalMs: params.pollIntervalMs }),
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.onError ? { onError: params.onError } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    dispatch: async (update, lifecycle) => {
      if (params.dispatchUpdate) {
        return await params.dispatchUpdate(update, lifecycle);
      }
      // Lifecycle is also on the spooled ALS frame (runWithTelegramSpooledReplayUpdate).
      // bot-message merges it into turnAdoptionLifecycle for complete-at-adoption.
      await params.bot.handleUpdate(update as never);
    },
  });
}
