import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";

const IDENTIFY_WINDOW_MS = 5_000;

function normalizeMaxConcurrency(value: number | undefined): number {
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? 1 : Math.max(1, Math.floor(parsed));
}

class GatewayIdentifyLimiter {
  private nextAllowedAtByKey = new Map<number, number>();

  async wait(params: { shardId?: number; maxConcurrency?: number }): Promise<void> {
    const maxConcurrency = normalizeMaxConcurrency(params.maxConcurrency);
    const rateKey = (params.shardId ?? 0) % maxConcurrency;
    const now = Date.now();
    const nextAllowedAt = this.nextAllowedAtByKey.get(rateKey) ?? now;
    const waitMs = Math.max(0, nextAllowedAt - now);
    this.nextAllowedAtByKey.set(rateKey, Math.max(now, nextAllowedAt) + IDENTIFY_WINDOW_MS);
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      });
    }
  }

  reset(): void {
    this.nextAllowedAtByKey.clear();
  }
}

export const sharedGatewayIdentifyLimiter = new GatewayIdentifyLimiter();
