/** Resolved pair-loop guard settings in milliseconds for runtime checks. */
export type PairLoopGuardSettings = {
  /** Whether protection is active after config and channel capability gates. */
  enabled: boolean;
  /** Number of pair events allowed before cooldown starts. */
  maxEventsPerWindow: number;
  /** Rolling event window size in milliseconds. */
  windowMs: number;
  /** Suppression duration in milliseconds once the threshold is exceeded. */
  cooldownMs: number;
  /**
   * Bot events allowed per conversation inside the burst window. Absent
   * disables the conversation-wide budget while leaving pair protection active.
   */
  maxConversationBotEvents?: number;
};

/** User-facing pair-loop guard config accepted by channel plugins. */
export type PairLoopGuardConfig = {
  /** Enables or disables loop protection for the channel/account scope. */
  enabled?: boolean;
  /** Number of pair events allowed before cooldown starts. */
  maxEventsPerWindow?: number;
  /** Rolling event window size in seconds for config files. */
  windowSeconds?: number;
  /** Suppression duration in seconds for config files. */
  cooldownSeconds?: number;
  /**
   * Bot events allowed in one conversation within a rolling 10-minute burst
   * window before suppression. Covers N-party storms the unordered pair
   * budget cannot see: with 3+ bots no single pair crosses maxEventsPerWindow
   * while the conversation as a whole runs away. Trips only when 2+ peer
   * senders are each actively posting, so two-party exchanges and one-off
   * stray posts stay governed by the pair budget alone.
   */
  maxConversationBotEvents?: number;
};

const PAIR_LOOP_GUARD_CONFIG_KEYS = [
  "enabled",
  "maxEventsPerWindow",
  "windowSeconds",
  "cooldownSeconds",
  "maxConversationBotEvents",
] as const satisfies ReadonlyArray<keyof PairLoopGuardConfig>;

/** Result of recording one pair interaction against the loop guard. */
export type PairLoopGuardResult =
  | { suppressed: false }
  | { suppressed: true; cooldownUntilMs: number };

/** Snapshot entry for observability and tests. */
export type PairLoopGuardSnapshotEntry = {
  /** Internal pair key containing scope, conversation, and unordered participant ids. */
  key: string;
  /** Number of retained events in the current window. */
  recentCount: number;
  /** Epoch milliseconds when cooldown ends, or zero when inactive. */
  cooldownUntilMs: number;
};

type PairLoopGuardEntry = {
  recentEvents: Array<{ timestampMs: number; eventId?: string }>;
  windowMs: number;
  cooldownStartedAtMs: number;
  cooldownUntilMs: number;
};

type ConversationBurstEntry = {
  events: Array<{ tsMs: number; senderId: string }>;
  cooldownStartedAtMs: number;
  cooldownUntilMs: number;
};

/** In-memory guard for suppressing repeated bidirectional bot pair loops. */
export type PairLoopGuard = {
  /** Records one sender/receiver interaction and reports whether it enters or is inside cooldown. */
  recordAndCheck: (params: {
    /** Channel/account/provider scope that owns this conversation. */
    scopeId: string;
    /** Conversation/thread identifier where the bidirectional exchange happened. */
    conversationId: string;
    /** Sender id for this event; paired with receiverId without direction. */
    senderId: string;
    /** Receiver id for this event; paired with senderId without direction. */
    receiverId: string;
    /** Stable provider event identity used to avoid double-counting retries. */
    eventId?: string;
    /** Resolved guard thresholds for the current channel/account. */
    settings: PairLoopGuardSettings;
    /** Optional test/runtime clock override in epoch milliseconds. */
    nowMs?: number;
  }) => PairLoopGuardResult;
  /** Clears all tracked pair state and scheduled pruning state. */
  clear: () => void;
  /** Returns tracked pair counters for diagnostics and tests without exposing mutable state. */
  snapshot: () => PairLoopGuardSnapshotEntry[];
};

const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const KEY_SEPARATOR = "\u0001";

/** Default plugin-facing loop guard config before per-channel overrides. */
export const DEFAULT_PAIR_LOOP_GUARD_CONFIG: Required<
  Omit<PairLoopGuardConfig, "maxConversationBotEvents">
> = {
  enabled: true,
  maxEventsPerWindow: 20,
  windowSeconds: 60,
  cooldownSeconds: 60,
};

/** Default runtime loop guard settings derived from the default config. */
export const DEFAULT_PAIR_LOOP_GUARD_SETTINGS: PairLoopGuardSettings = {
  enabled: DEFAULT_PAIR_LOOP_GUARD_CONFIG.enabled,
  maxEventsPerWindow: DEFAULT_PAIR_LOOP_GUARD_CONFIG.maxEventsPerWindow,
  windowMs: DEFAULT_PAIR_LOOP_GUARD_CONFIG.windowSeconds * 1000,
  cooldownMs: DEFAULT_PAIR_LOOP_GUARD_CONFIG.cooldownSeconds * 1000,
};

/**
 * Rolling window for the conversation burst budget. Longer than the pair
 * window so slow-cadence storms (agents replying once a minute) still
 * accumulate, while low-rate legitimate bot traffic drains out on its own.
 */
const CONVERSATION_BURST_WINDOW_MS = 10 * 60 * 1000;

/**
 * Burst suppression needs at least this many ACTIVE peer senders inside the
 * window. The receiving bot is never in the set, so 2 means 3+ bots total —
 * the smallest storm the pair budget structurally cannot see. Two-party
 * conversations (including agent-to-agent relays) never trip this budget.
 */
const CONVERSATION_BURST_MIN_ACTIVE_SENDERS = 2;

/**
 * A sender counts as an active storm participant only with this many events
 * inside the window. One-off posts from stray bots (CI, alerts) can never
 * reclassify a two-party exchange as a multi-party storm. Kept at 2 so a
 * rotating storm cannot stay invisible by spreading events across many
 * senders (at 3, any fan-out of 6+ bots posting twice each evades detection).
 */
const CONVERSATION_BURST_ACTIVE_SENDER_MIN_EVENTS = 2;

/** Bounds retained burst events per conversation against event floods. */
const MAX_CONVERSATION_BOT_EVENTS = 500;
const CONVERSATION_BURST_EVENT_CAP = MAX_CONVERSATION_BOT_EVENTS + 1;

/** Merges pair-loop configs from broad defaults to narrow overrides, ignoring undefined values. */
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
          case "maxConversationBotEvents":
            merged.maxConversationBotEvents = config.maxConversationBotEvents;
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

function conversationBurstLimit(value: unknown): number | undefined {
  const limit = positiveInteger(value);
  return limit !== undefined && limit <= MAX_CONVERSATION_BOT_EVENTS ? limit : undefined;
}

/** Resolves runtime loop guard settings from config/defaults and the channel default-enabled gate. */
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
  const maxConversationBotEvents =
    conversationBurstLimit(params.config?.maxConversationBotEvents) ??
    conversationBurstLimit(params.defaultsConfig?.maxConversationBotEvents);

  return {
    // Channel-level capability gates can disable protection even when config/defaults enable it.
    enabled: params.defaultEnabled && configuredEnabled,
    maxEventsPerWindow,
    windowMs: windowSeconds * 1000,
    cooldownMs: cooldownSeconds * 1000,
    ...(maxConversationBotEvents !== undefined ? { maxConversationBotEvents } : {}),
  };
}

function buildPairKey(params: {
  scopeId: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
}): string {
  // Sort sender/receiver so A->B and B->A count as the same bot loop pair.
  const lhs = params.senderId < params.receiverId ? params.senderId : params.receiverId;
  const rhs = params.senderId < params.receiverId ? params.receiverId : params.senderId;
  return [params.scopeId, params.conversationId, lhs, rhs].join(KEY_SEPARATOR);
}

function pruneRecentEvents(entry: PairLoopGuardEntry, nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs;
  entry.recentEvents = entry.recentEvents.filter((event) => event.timestampMs > cutoff);
}

function countCurrentWindowEvents(entry: PairLoopGuardEntry, nowMs: number): number {
  return entry.recentEvents.filter((event) => event.timestampMs <= nowMs).length;
}

/** Creates an in-memory pair-loop guard with bounded periodic pruning. */
export function createPairLoopGuard(params?: { pruneIntervalMs?: number }): PairLoopGuard {
  const tracked = new Map<string, PairLoopGuardEntry>();
  const burstTracked = new Map<string, ConversationBurstEntry>();
  const pruneIntervalMs = params?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  let nextPruneAtMs = 0;

  function pruneInactiveTrackedPairs(nowMs: number): void {
    if (pruneIntervalMs <= 0 || nowMs < nextPruneAtMs) {
      return;
    }
    nextPruneAtMs = nowMs + pruneIntervalMs;
    for (const [key, entry] of tracked) {
      pruneRecentEvents(entry, nowMs, entry.windowMs);
      if (entry.recentEvents.length === 0 && entry.cooldownUntilMs <= nowMs) {
        tracked.delete(key);
      }
    }
    for (const [key, entry] of burstTracked) {
      entry.events = entry.events.filter(
        (event) => event.tsMs > nowMs - CONVERSATION_BURST_WINDOW_MS,
      );
      if (entry.events.length === 0 && entry.cooldownUntilMs <= nowMs) {
        burstTracked.delete(key);
      }
    }
  }

  function recordConversationBurstAndCheck(paramsLocal: {
    scopeId: string;
    conversationId: string;
    senderId: string;
    receiverId: string;
    settings: PairLoopGuardSettings;
    nowMs: number;
  }): PairLoopGuardResult {
    const limit = conversationBurstLimit(paramsLocal.settings.maxConversationBotEvents);
    if (limit === undefined) {
      return { suppressed: false };
    }
    // recordAndCheck already rejected non-positive cooldowns before this call.
    const cooldownMs = Math.floor(paramsLocal.settings.cooldownMs);
    // Keyed per receiving bot so one conversation event fanned out to several
    // receivers is counted once per receiver, never multiplied for any of them.
    const key = [paramsLocal.scopeId, paramsLocal.conversationId, paramsLocal.receiverId].join(
      KEY_SEPARATOR,
    );
    const nowMs = paramsLocal.nowMs;
    let entry = burstTracked.get(key);
    if (!entry) {
      entry = { events: [], cooldownStartedAtMs: 0, cooldownUntilMs: 0 };
      burstTracked.set(key, entry);
    }
    entry.events = entry.events.filter(
      (event) => event.tsMs > nowMs - CONVERSATION_BURST_WINDOW_MS,
    );
    entry.events.push({ tsMs: nowMs, senderId: paramsLocal.senderId });
    if (entry.events.length > CONVERSATION_BURST_EVENT_CAP) {
      entry.events.splice(0, entry.events.length - CONVERSATION_BURST_EVENT_CAP);
    }
    if (entry.cooldownStartedAtMs <= nowMs && entry.cooldownUntilMs > nowMs) {
      return { suppressed: true, cooldownUntilMs: entry.cooldownUntilMs };
    }
    // Mirror the pair budget's reordered-event tolerance: only events at or
    // before this event's timestamp count against it.
    const inWindow = entry.events.filter((event) => event.tsMs <= nowMs);
    if (inWindow.length <= limit) {
      return { suppressed: false };
    }
    const senderEventCounts = new Map<string, number>();
    for (const event of inWindow) {
      senderEventCounts.set(event.senderId, (senderEventCounts.get(event.senderId) ?? 0) + 1);
    }
    let activeSenders = 0;
    for (const count of senderEventCounts.values()) {
      if (count >= CONVERSATION_BURST_ACTIVE_SENDER_MIN_EVENTS) {
        activeSenders += 1;
      }
    }
    if (activeSenders < CONVERSATION_BURST_MIN_ACTIVE_SENDERS) {
      return { suppressed: false };
    }
    entry.cooldownStartedAtMs = nowMs;
    entry.cooldownUntilMs = nowMs + cooldownMs;
    // Unlike the pair budget, tripped events stay in the window: a storm that
    // keeps posting through cooldown re-trips immediately on expiry, while the
    // window drains on its own once the conversation actually goes quiet.
    return { suppressed: true, cooldownUntilMs: entry.cooldownUntilMs };
  }

  function recordAndCheck(paramsLocal: {
    scopeId: string;
    conversationId: string;
    senderId: string;
    receiverId: string;
    eventId?: string;
    settings: PairLoopGuardSettings;
    nowMs?: number;
  }): PairLoopGuardResult {
    if (!paramsLocal.settings.enabled) {
      return { suppressed: false };
    }
    if (
      !paramsLocal.scopeId ||
      !paramsLocal.conversationId ||
      !paramsLocal.senderId ||
      !paramsLocal.receiverId
    ) {
      return { suppressed: false };
    }
    if (paramsLocal.senderId === paramsLocal.receiverId) {
      return { suppressed: false };
    }

    const maxEventsPerWindow = Math.floor(paramsLocal.settings.maxEventsPerWindow);
    const windowMs = Math.floor(paramsLocal.settings.windowMs);
    const cooldownMs = Math.floor(paramsLocal.settings.cooldownMs);
    if (maxEventsPerWindow <= 0 || windowMs <= 0 || cooldownMs <= 0) {
      return { suppressed: false };
    }

    const nowMs = paramsLocal.nowMs ?? Date.now();
    pruneInactiveTrackedPairs(nowMs);

    const key = buildPairKey(paramsLocal);
    let entry = tracked.get(key);
    if (!entry) {
      entry = {
        recentEvents: [],
        windowMs,
        cooldownStartedAtMs: 0,
        cooldownUntilMs: 0,
      };
      tracked.set(key, entry);
    }
    entry.windowMs = windowMs;
    pruneRecentEvents(entry, nowMs, windowMs);
    const eventId = paramsLocal.eventId?.trim();
    if (eventId && entry.recentEvents.some((event) => event.eventId === eventId)) {
      return { suppressed: false };
    }
    // The burst bucket records each unique event even when the pair budget
    // suppresses it, so a live storm remains armed through pair cooldown gaps.
    const burstResult = recordConversationBurstAndCheck({ ...paramsLocal, nowMs });
    if (entry.cooldownStartedAtMs <= nowMs && entry.cooldownUntilMs > nowMs) {
      return { suppressed: true, cooldownUntilMs: entry.cooldownUntilMs };
    }

    entry.recentEvents.push({
      timestampMs: nowMs,
      ...(eventId ? { eventId } : {}),
    });
    if (countCurrentWindowEvents(entry, nowMs) > maxEventsPerWindow) {
      entry.cooldownStartedAtMs = nowMs;
      entry.cooldownUntilMs = nowMs + cooldownMs;
      // Keep only future records during cooldown; past events should not extend suppression.
      entry.recentEvents = entry.recentEvents.filter((event) => event.timestampMs > nowMs);
      return { suppressed: true, cooldownUntilMs: entry.cooldownUntilMs };
    }

    return burstResult;
  }

  return {
    recordAndCheck,
    clear: () => {
      tracked.clear();
      burstTracked.clear();
      nextPruneAtMs = 0;
    },
    snapshot: () =>
      Array.from(tracked.entries()).map(([key, entry]) => ({
        key,
        recentCount: entry.recentEvents.length,
        cooldownUntilMs: entry.cooldownUntilMs,
      })),
  };
}
