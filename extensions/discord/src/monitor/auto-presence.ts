// Discord plugin module implements auto presence behavior.
import {
  clearExpiredCooldowns,
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  type AuthProfileFailureReason,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type {
  DiscordAccountConfig,
  DiscordAutoPresenceConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import type { Activity, UpdatePresenceData } from "../internal/gateway.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";

const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;
const MIN_UPDATE_INTERVAL_MS = 1_000;

type DiscordAutoPresenceState = "healthy" | "degraded" | "exhausted";

type ResolvedDiscordAutoPresenceConfig = {
  enabled: boolean;
  intervalMs: number;
  minUpdateIntervalMs: number;
};

type PresenceGateway = {
  isConnected: boolean;
  updatePresence: (payload: UpdatePresenceData) => void;
};

function clampPositiveInt(value: unknown, fallback: number, minValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return fallback;
  }
  return Math.max(minValue, rounded);
}

function resolveAutoPresenceConfig(
  config?: DiscordAutoPresenceConfig,
): ResolvedDiscordAutoPresenceConfig {
  const intervalMs = clampPositiveInt(config?.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  const minUpdateIntervalMs = clampPositiveInt(
    config?.minUpdateIntervalMs,
    DEFAULT_MIN_UPDATE_INTERVAL_MS,
    MIN_UPDATE_INTERVAL_MS,
  );

  return {
    enabled: config?.enabled === true,
    intervalMs,
    minUpdateIntervalMs,
  };
}

function buildCustomStatusActivity(text: string): Activity {
  return {
    name: CUSTOM_STATUS_NAME,
    type: DEFAULT_CUSTOM_ACTIVITY_TYPE,
    state: text,
  };
}

function isExhaustedUnavailableReason(reason: AuthProfileFailureReason | null): boolean {
  if (!reason) {
    return false;
  }
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "billing" ||
    reason === "auth" ||
    reason === "auth_permanent"
  );
}

function resolveAuthAvailability(params: {
  store: AuthProfileStore;
  now: number;
}): DiscordAutoPresenceState {
  const profileIds = Object.keys(params.store.profiles);
  if (profileIds.length === 0) {
    return "degraded";
  }

  clearExpiredCooldowns(params.store, params.now);

  const hasUsableProfile = profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, params.now),
  );
  if (hasUsableProfile) {
    return "healthy";
  }

  const unavailableReason = resolveProfilesUnavailableReason({
    store: params.store,
    profileIds,
    now: params.now,
  });

  return isExhaustedUnavailableReason(unavailableReason) ? "exhausted" : "degraded";
}

function resolvePresenceActivities(params: {
  state: DiscordAutoPresenceState;
  basePresence: UpdatePresenceData | null;
}): Activity[] {
  if (params.state === "healthy") {
    return params.basePresence?.activities ?? [];
  }

  return [
    buildCustomStatusActivity(params.state === "degraded" ? "runtime degraded" : "token exhausted"),
  ];
}

function resolvePresenceStatus(state: DiscordAutoPresenceState): UpdatePresenceData["status"] {
  if (state === "healthy") {
    return "online";
  }
  if (state === "exhausted") {
    return "dnd";
  }
  return "idle";
}

function resolveDiscordAutoPresenceUpdate(params: {
  discordConfig: Pick<
    DiscordAccountConfig,
    "autoPresence" | "activity" | "status" | "activityType" | "activityUrl"
  >;
  authStore: AuthProfileStore;
  gatewayConnected: boolean;
  now?: number;
}): UpdatePresenceData | null {
  const autoPresence = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
  if (!autoPresence.enabled) {
    return null;
  }

  const now = params.now ?? Date.now();
  const basePresence = resolveDiscordPresenceUpdate(params.discordConfig);

  const availability = resolveAuthAvailability({
    store: params.authStore,
    now,
  });
  const state = params.gatewayConnected ? availability : "degraded";

  const activities = resolvePresenceActivities({
    state,
    basePresence,
  });

  return {
    since: null,
    activities,
    status: resolvePresenceStatus(state),
    afk: false,
  };
}

function stablePresenceSignature(payload: UpdatePresenceData): string {
  return JSON.stringify({
    status: payload.status,
    afk: payload.afk,
    since: payload.since,
    activities: payload.activities.map((activity) => ({
      type: activity.type,
      name: activity.name,
      state: activity.state,
      url: activity.url,
    })),
  });
}

type DiscordAutoPresenceController = {
  start: () => void;
  stop: () => void;
  refresh: () => void;
  runNow: () => void;
  enabled: boolean;
};

export function createDiscordAutoPresenceController(params: {
  accountId: string;
  discordConfig: Pick<
    DiscordAccountConfig,
    "autoPresence" | "activity" | "status" | "activityType" | "activityUrl"
  >;
  gateway: PresenceGateway;
  loadAuthStore?: () => AuthProfileStore;
  now?: () => number;
  log?: (message: string) => void;
}): DiscordAutoPresenceController {
  const autoCfg = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
  if (!autoCfg.enabled) {
    return {
      enabled: false,
      start: () => undefined,
      stop: () => undefined,
      refresh: () => undefined,
      runNow: () => undefined,
    };
  }

  const loadAuthStore = params.loadAuthStore ?? (() => ensureAuthProfileStore());
  const now = params.now ?? (() => Date.now());

  let timer: ReturnType<typeof setInterval> | undefined;
  let lastAppliedSignature: string | null = null;
  let lastAppliedAt = 0;

  const runEvaluation = (options?: { force?: boolean }) => {
    let presence: UpdatePresenceData | null;
    try {
      presence = resolveDiscordAutoPresenceUpdate({
        discordConfig: params.discordConfig,
        authStore: loadAuthStore(),
        gatewayConnected: params.gateway.isConnected,
        now: now(),
      });
    } catch (err) {
      params.log?.(
        warn(
          `discord: auto-presence evaluation failed for account ${params.accountId}: ${String(err)}`,
        ),
      );
      return;
    }

    if (!presence || !params.gateway.isConnected) {
      return;
    }

    const forceApply = options?.force === true;
    const ts = now();
    const signature = stablePresenceSignature(presence);
    if (!forceApply && signature === lastAppliedSignature) {
      return;
    }
    if (!forceApply && lastAppliedAt > 0 && ts - lastAppliedAt < autoCfg.minUpdateIntervalMs) {
      return;
    }

    params.gateway.updatePresence(presence);
    lastAppliedSignature = signature;
    lastAppliedAt = ts;
  };

  return {
    enabled: true,
    runNow: () => runEvaluation(),
    refresh: () => runEvaluation({ force: true }),
    start: () => {
      if (timer) {
        return;
      }
      runEvaluation({ force: true });
      timer = setInterval(() => runEvaluation(), autoCfg.intervalMs);
    },
    stop: () => {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
    },
  };
}
