export type LiveCacheFloor = {
  observedCacheRead?: number;
  observedCacheWrite?: number;
  observedHitRate?: number;
  minCacheRead?: number;
  minCacheReadOrWrite?: number;
  minCacheWrite?: number;
  minHitRate?: number;
  maxCacheRead?: number;
  maxCacheWrite?: number;
  warnOnly?: boolean;
};

export const LIVE_CACHE_REGRESSION_BASELINE = {
  anthropic: {
    disabled: {
      observedCacheRead: 0,
      observedCacheWrite: 0,
      maxCacheRead: 32,
      maxCacheWrite: 32,
    },
    image: {
      observedCacheRead: 5_660,
      observedCacheWrite: 85,
      observedHitRate: 0.985,
      minCacheRead: 4_500,
      minCacheWrite: 1,
      minHitRate: 0.97,
    },
    mcp: {
      observedCacheRead: 6_240,
      observedCacheWrite: 113,
      observedHitRate: 0.982,
      minCacheRead: 5_800,
      minCacheWrite: 1,
      minHitRate: 0.97,
    },
    stable: {
      observedCacheRead: 5_660,
      observedCacheWrite: 18,
      observedHitRate: 0.996,
      minCacheReadOrWrite: 5_400,
      minCacheWrite: 1,
    },
    tool: {
      observedCacheRead: 6_223,
      observedCacheWrite: 97,
      observedHitRate: 0.984,
      minCacheRead: 5_000,
      minCacheWrite: 1,
      minHitRate: 0.97,
    },
  },
  openai: {
    image: {
      observedCacheRead: 4_864,
      observedHitRate: 0.954,
      minCacheRead: 3_840,
      minHitRate: 0.82,
      warnOnly: true,
    },
    mcp: {
      observedCacheRead: 4_608,
      observedHitRate: 0.891,
      minCacheRead: 4_096,
      minHitRate: 0.85,
    },
    stable: {
      observedCacheRead: 4_864,
      observedHitRate: 0.966,
      minCacheRead: 4_608,
      minHitRate: 0.9,
    },
    tool: {
      observedCacheRead: 4_608,
      observedHitRate: 0.896,
      minCacheRead: 4_096,
      minHitRate: 0.85,
    },
  },
} as const satisfies Record<string, Record<string, LiveCacheFloor>>;
