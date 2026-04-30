const IDENTIFY_WINDOW_MS = 5_000;

export class GatewayIdentifyLimiter {
  private nextAllowedAtByKey = new Map<number, number>();

  async wait(params: { shardId?: number; maxConcurrency?: number }): Promise<void> {
    const maxConcurrency = Math.max(1, Math.floor(params.maxConcurrency ?? 1));
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
