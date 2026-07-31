// Telegram polling restart policy stays shared by the session and focused tests.
import { computeBackoff } from "openclaw/plugin-sdk/runtime-env";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 30_000,
  maxMs: 600_000,
  factor: 2,
  jitter: 0.2,
};

const TELEGRAM_POLL_STOP_TIMEOUT_COOLDOWN_POLICY = {
  initialMs: 120_000,
  maxMs: 600_000,
  factor: 2,
  jitter: 0.2,
};
const TELEGRAM_POLL_STOP_TIMEOUT_BURST_LIMIT = 2;

type TelegramRestartBackoffState = {
  restartAttempts: number;
  stopTimeoutBurst: number;
  stopTimeoutCooldownAttempts: number;
};

export function createTelegramRestartBackoffState(): TelegramRestartBackoffState {
  return {
    restartAttempts: 0,
    stopTimeoutBurst: 0,
    stopTimeoutCooldownAttempts: 0,
  };
}

export function resetTelegramRestartBackoffState(state: TelegramRestartBackoffState): void {
  state.restartAttempts = 0;
  state.stopTimeoutBurst = 0;
  state.stopTimeoutCooldownAttempts = 0;
}

export function resolveTelegramRestartDelayMs(
  state: TelegramRestartBackoffState,
  opts: { stopTimedOut?: boolean } = {},
): { delayMs: number; stopTimeoutSuffix: string } {
  state.restartAttempts += 1;
  let delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, state.restartAttempts);
  let stopTimeoutSuffix = "";
  if (opts.stopTimedOut) {
    state.stopTimeoutBurst += 1;
    if (state.stopTimeoutBurst >= TELEGRAM_POLL_STOP_TIMEOUT_BURST_LIMIT) {
      state.stopTimeoutCooldownAttempts += 1;
      const cooldownMs = computeBackoff(
        TELEGRAM_POLL_STOP_TIMEOUT_COOLDOWN_POLICY,
        state.stopTimeoutCooldownAttempts,
      );
      delayMs = Math.max(delayMs, cooldownMs);
      stopTimeoutSuffix = ` Stop timeout burst=${state.stopTimeoutBurst}; applying cooldown.`;
    }
  } else {
    state.stopTimeoutBurst = 0;
    state.stopTimeoutCooldownAttempts = 0;
  }
  return { delayMs, stopTimeoutSuffix };
}
