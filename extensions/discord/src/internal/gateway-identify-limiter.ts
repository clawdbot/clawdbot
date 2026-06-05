// Discord plugin module implements gateway identify limiter behavior.
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";

const IDENTIFY_WINDOW_MS = 5_000;

type IdentifyRateState = {
  lastObservedAt: number;
  nextAllowedAt: number;
};

function normalizeMaxConcurrency(value: number | undefined): number {
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? 1 : Math.max(1, Math.floor(parsed));
}

class GatewayIdentifyLimiter {
  private stateByKey = new Map<number, IdentifyRateState>();

  async wait(params: { shardId?: number; maxConcurrency?: number }): Promise<void> {
    const maxConcurrency = normalizeMaxConcurrency(params.maxConcurrency);
    const rateKey = (params.shardId ?? 0) % maxConcurrency;
    const now = Date.now();
    const state = this.stateByKey.get(rateKey);
    const clockMovedBackward = state !== undefined && now < state.lastObservedAt;
    const nextAllowedAt =
      state === undefined
        ? now
        : clockMovedBackward
          ? now + IDENTIFY_WINDOW_MS
          : state.nextAllowedAt;
    const waitMs = Math.max(0, nextAllowedAt - now);
    this.stateByKey.set(rateKey, {
      lastObservedAt: now,
      nextAllowedAt: Math.max(now, nextAllowedAt) + IDENTIFY_WINDOW_MS,
    });
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      });
    }
  }

  reset(): void {
    this.stateByKey.clear();
  }
}

export const sharedGatewayIdentifyLimiter = new GatewayIdentifyLimiter();
