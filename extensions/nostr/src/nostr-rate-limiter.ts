type FixedWindowRateLimiter = {
  isRateLimited: (key: string, nowMs?: number) => boolean;
  size: () => number;
  clear: () => void;
};

export function createFixedWindowRateLimiter(params: {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
}): FixedWindowRateLimiter {
  const windowMs = Math.max(1, Math.floor(params.windowMs));
  const maxRequests = Math.max(1, Math.floor(params.maxRequests));
  const maxTrackedKeys = Math.max(1, Math.floor(params.maxTrackedKeys));
  const state = new Map<string, { count: number; windowStartMs: number }>();

  const touch = (key: string, value: { count: number; windowStartMs: number }) => {
    state.delete(key);
    state.set(key, value);
  };

  const prune = (nowMs: number) => {
    for (const [key, entry] of state) {
      if (nowMs - entry.windowStartMs >= windowMs) {
        state.delete(key);
      }
    }
    while (state.size > maxTrackedKeys) {
      const oldest = state.keys().next().value;
      if (!oldest) {
        break;
      }
      state.delete(oldest);
    }
  };

  return {
    isRateLimited: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return false;
      }
      prune(nowMs);
      const existing = state.get(key);
      if (!existing || nowMs - existing.windowStartMs >= windowMs) {
        touch(key, { count: 1, windowStartMs: nowMs });
        return false;
      }
      const nextCount = existing.count + 1;
      touch(key, { count: nextCount, windowStartMs: existing.windowStartMs });
      return nextCount > maxRequests;
    },
    size: () => state.size,
    clear: () => state.clear(),
  };
}
