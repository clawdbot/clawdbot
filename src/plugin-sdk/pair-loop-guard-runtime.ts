export type PairLoopGuardSettings = {
  enabled: boolean;
  maxEventsPerWindow: number;
  windowMs: number;
  cooldownMs: number;
};

export type PairLoopGuardConfig = {
  enabled?: boolean;
  maxEventsPerWindow?: number;
  windowSeconds?: number;
  cooldownSeconds?: number;
};

const PAIR_LOOP_GUARD_CONFIG_KEYS = [
  "enabled",
  "maxEventsPerWindow",
  "windowSeconds",
  "cooldownSeconds",
] as const satisfies ReadonlyArray<keyof PairLoopGuardConfig>;

export type PairLoopGuardResult =
  | { suppressed: false }
  | { suppressed: true; cooldownUntilMs: number };

export type PairLoopGuardSnapshotEntry = {
  key: string;
  recentCount: number;
  cooldownUntilMs: number;
};

type PairLoopGuardEntry = {
  recentMs: number[];
  windowMs: number;
  cooldownStartedAtMs: number;
  cooldownUntilMs: number;
};

export type PairLoopGuard = {
  recordAndCheck: (params: {
    scopeId: string;
    conversationId: string;
    senderId: string;
    receiverId: string;
    settings: PairLoopGuardSettings;
    nowMs?: number;
  }) => PairLoopGuardResult;
  clear: () => void;
  snapshot: () => PairLoopGuardSnapshotEntry[];
};

const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const KEY_SEPARATOR = "\u0001";

export const DEFAULT_PAIR_LOOP_GUARD_CONFIG: Required<PairLoopGuardConfig> = {
  enabled: true,
  maxEventsPerWindow: 20,
  windowSeconds: 60,
  cooldownSeconds: 60,
};

export const DEFAULT_PAIR_LOOP_GUARD_SETTINGS: PairLoopGuardSettings = {
  enabled: DEFAULT_PAIR_LOOP_GUARD_CONFIG.enabled,
  maxEventsPerWindow: DEFAULT_PAIR_LOOP_GUARD_CONFIG.maxEventsPerWindow,
  windowMs: DEFAULT_PAIR_LOOP_GUARD_CONFIG.windowSeconds * 1000,
  cooldownMs: DEFAULT_PAIR_LOOP_GUARD_CONFIG.cooldownSeconds * 1000,
};

export function mergePairLoopGuardConfig(
  ...configs: Array<PairLoopGuardConfig | undefined>
): PairLoopGuardConfig | undefined {
  const merged: PairLoopGuardConfig = {};
  let hasValue = false;
  for (const config of configs) {
    if (!config) {
      continue;
    }
    for (const key of PAIR_LOOP_GUARD_CONFIG_KEYS) {
      if (config[key] !== undefined) {
        switch (key) {
          case "enabled":
            merged.enabled = config.enabled;
            break;
          case "maxEventsPerWindow":
            merged.maxEventsPerWindow = config.maxEventsPerWindow;
            break;
          case "windowSeconds":
            merged.windowSeconds = config.windowSeconds;
            break;
          case "cooldownSeconds":
            merged.cooldownSeconds = config.cooldownSeconds;
            break;
        }
        hasValue = true;
      }
    }
  }
  return hasValue ? merged : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function resolvePairLoopGuardSettings(params: {
  config?: PairLoopGuardConfig;
  defaultsConfig?: PairLoopGuardConfig;
  defaultEnabled: boolean;
}): PairLoopGuardSettings {
  const configuredEnabled =
    typeof params.config?.enabled === "boolean"
      ? params.config.enabled
      : typeof params.defaultsConfig?.enabled === "boolean"
        ? params.defaultsConfig.enabled
        : DEFAULT_PAIR_LOOP_GUARD_CONFIG.enabled;
  const maxEventsPerWindow =
    positiveInteger(params.config?.maxEventsPerWindow) ??
    positiveInteger(params.defaultsConfig?.maxEventsPerWindow) ??
    DEFAULT_PAIR_LOOP_GUARD_CONFIG.maxEventsPerWindow;
  const windowSeconds =
    positiveInteger(params.config?.windowSeconds) ??
    positiveInteger(params.defaultsConfig?.windowSeconds) ??
    DEFAULT_PAIR_LOOP_GUARD_CONFIG.windowSeconds;
  const cooldownSeconds =
    positiveInteger(params.config?.cooldownSeconds) ??
    positiveInteger(params.defaultsConfig?.cooldownSeconds) ??
    DEFAULT_PAIR_LOOP_GUARD_CONFIG.cooldownSeconds;

  return {
    enabled: params.defaultEnabled && configuredEnabled,
    maxEventsPerWindow,
    windowMs: windowSeconds * 1000,
    cooldownMs: cooldownSeconds * 1000,
  };
}

function buildPairKey(params: {
  scopeId: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
}): string {
  const lhs = params.senderId < params.receiverId ? params.senderId : params.receiverId;
  const rhs = params.senderId < params.receiverId ? params.receiverId : params.senderId;
  return [params.scopeId, params.conversationId, lhs, rhs].join(KEY_SEPARATOR);
}

function pruneRecentTimestamps(entry: PairLoopGuardEntry, nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs;
  entry.recentMs = entry.recentMs.filter((timestampMs) => timestampMs > cutoff);
}

function countCurrentWindowEvents(entry: PairLoopGuardEntry, nowMs: number): number {
  return entry.recentMs.filter((timestampMs) => timestampMs <= nowMs).length;
}

export function createPairLoopGuard(params?: { pruneIntervalMs?: number }): PairLoopGuard {
  const tracked = new Map<string, PairLoopGuardEntry>();
  const pruneIntervalMs = params?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  let nextPruneAtMs = 0;

  function pruneInactiveTrackedPairs(nowMs: number): void {
    if (pruneIntervalMs <= 0 || nowMs < nextPruneAtMs) {
      return;
    }
    nextPruneAtMs = nowMs + pruneIntervalMs;
    for (const [key, entry] of tracked) {
      pruneRecentTimestamps(entry, nowMs, entry.windowMs);
      if (entry.recentMs.length === 0 && entry.cooldownUntilMs <= nowMs) {
        tracked.delete(key);
      }
    }
  }

  function recordAndCheck(params: {
    scopeId: string;
    conversationId: string;
    senderId: string;
    receiverId: string;
    settings: PairLoopGuardSettings;
    nowMs?: number;
  }): PairLoopGuardResult {
    if (!params.settings.enabled) {
      return { suppressed: false };
    }
    if (!params.scopeId || !params.conversationId || !params.senderId || !params.receiverId) {
      return { suppressed: false };
    }
    if (params.senderId === params.receiverId) {
      return { suppressed: false };
    }

    const maxEventsPerWindow = Math.floor(params.settings.maxEventsPerWindow);
    const windowMs = Math.floor(params.settings.windowMs);
    const cooldownMs = Math.floor(params.settings.cooldownMs);
    if (maxEventsPerWindow <= 0 || windowMs <= 0 || cooldownMs <= 0) {
      return { suppressed: false };
    }

    const nowMs = params.nowMs ?? Date.now();
    pruneInactiveTrackedPairs(nowMs);

    const key = buildPairKey(params);
    let entry = tracked.get(key);
    if (!entry) {
      entry = { recentMs: [], windowMs, cooldownStartedAtMs: 0, cooldownUntilMs: 0 };
      tracked.set(key, entry);
    }
    if (entry.cooldownStartedAtMs <= nowMs && entry.cooldownUntilMs > nowMs) {
      return { suppressed: true, cooldownUntilMs: entry.cooldownUntilMs };
    }

    entry.windowMs = windowMs;
    pruneRecentTimestamps(entry, nowMs, windowMs);
    entry.recentMs.push(nowMs);
    if (countCurrentWindowEvents(entry, nowMs) > maxEventsPerWindow) {
      entry.cooldownStartedAtMs = nowMs;
      entry.cooldownUntilMs = nowMs + cooldownMs;
      entry.recentMs = entry.recentMs.filter((timestampMs) => timestampMs > nowMs);
      return { suppressed: true, cooldownUntilMs: entry.cooldownUntilMs };
    }

    return { suppressed: false };
  }

  return {
    recordAndCheck,
    clear: () => {
      tracked.clear();
      nextPruneAtMs = 0;
    },
    snapshot: () =>
      Array.from(tracked.entries()).map(([key, entry]) => ({
        key,
        recentCount: entry.recentMs.length,
        cooldownUntilMs: entry.cooldownUntilMs,
      })),
  };
}
