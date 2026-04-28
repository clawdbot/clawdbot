import type { Activity, UpdatePresenceData } from "@buape/carbon/gateway";
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
} from "openclaw/plugin-sdk/config-types";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordPresenceUpdate } from "./presence.js";

const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;
const MIN_UPDATE_INTERVAL_MS = 1_000;

export type DiscordAutoPresenceState = "healthy" | "degraded" | "exhausted";

type ResolvedDiscordAutoPresenceConfig = {
  enabled: boolean;
  intervalMs: number;
  minUpdateIntervalMs: number;
  healthyText?: string;
  degradedText?: string;
  exhaustedText?: string;
};

export type DiscordAutoPresenceDecision = {
  state: DiscordAutoPresenceState;
  unavailableReason?: AuthProfileFailureReason | null;
  presence: UpdatePresenceData;
};

type PresenceGateway = {
  isConnected: boolean;
  updatePresence: (payload: UpdatePresenceData) => void;
};

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
    healthyText: normalizeOptionalText(config?.healthyText),
    degradedText: normalizeOptionalText(config?.degradedText),
    exhaustedText: normalizeOptionalText(config?.exhaustedText),
  };
}

function buildCustomStatusActivity(text: string): Activity {
  return {
    name: CUSTOM_STATUS_NAME,
    type: DEFAULT_CUSTOM_ACTIVITY_TYPE,
    state: text,
  };
}

function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string | undefined {
  const rendered = template
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key: string) => vars[key] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return rendered.length > 0 ? rendered : undefined;
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

function formatUnavailableReason(reason: AuthProfileFailureReason | null): string {
  if (!reason) {
    return "unknown";
  }
  return reason.replace(/_/g, " ");
}

function resolveAuthAvailability(params: { store: AuthProfileStore; now: number }): {
  state: DiscordAutoPresenceState;
  unavailableReason?: AuthProfileFailureReason | null;
} {
  const profileIds = Object.keys(params.store.profiles);
  if (profileIds.length === 0) {
    return { state: "degraded", unavailableReason: null };
  }

  clearExpiredCooldowns(params.store, params.now);

  const hasUsableProfile = profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, params.now),
  );
  if (hasUsableProfile) {
    return { state: "healthy", unavailableReason: null };
  }

  const unavailableReason = resolveProfilesUnavailableReason({
    store: params.store,
    profileIds,
    now: params.now,
  });

  if (isExhaustedUnavailableReason(unavailableReason)) {
    return {
      state: "exhausted",
      unavailableReason,
    };
  }

  return {
    state: "degraded",
    unavailableReason,
  };
}

function resolvePresenceActivities(params: {
  state: DiscordAutoPresenceState;
  cfg: ResolvedDiscordAutoPresenceConfig;
  basePresence: UpdatePresenceData | null;
  unavailableReason?: AuthProfileFailureReason | null;
}): Activity[] {
  const reasonLabel = formatUnavailableReason(params.unavailableReason ?? null);

  if (params.state === "healthy") {
    if (params.cfg.healthyText) {
      return [buildCustomStatusActivity(params.cfg.healthyText)];
    }
    return params.basePresence?.activities ?? [];
  }

  if (params.state === "degraded") {
    const template = params.cfg.degradedText ?? "runtime degraded";
    const text = renderTemplate(template, { reason: reasonLabel });
    return text ? [buildCustomStatusActivity(text)] : [];
  }

  const defaultTemplate = isExhaustedUnavailableReason(params.unavailableReason ?? null)
    ? "token exhausted"
    : "model unavailable ({reason})";
  const template = params.cfg.exhaustedText ?? defaultTemplate;
  const text = renderTemplate(template, { reason: reasonLabel });
  return text ? [buildCustomStatusActivity(text)] : [];
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

export function resolveDiscordAutoPresenceDecision(params: {
  discordConfig: Pick<
    DiscordAccountConfig,
    "autoPresence" | "activity" | "status" | "activityType" | "activityUrl"
  >;
  authStore: AuthProfileStore;
  gatewayConnected: boolean;
  now?: number;
}): DiscordAutoPresenceDecision | null {
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
  const state = params.gatewayConnected ? availability.state : "degraded";
  const unavailableReason = params.gatewayConnected
    ? availability.unavailableReason
    : (availability.unavailableReason ?? "unknown");

  const activities = resolvePresenceActivities({
    state,
    cfg: autoPresence,
    basePresence,
    unavailableReason,
  });

  return {
    state,
    unavailableReason,
    presence: {
      since: null,
      activities,
      status: resolvePresenceStatus(state),
      afk: false,
    },
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

export type DiscordAutoPresenceController = {
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
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
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
  const setIntervalFn = params.setIntervalFn ?? setInterval;
  const clearIntervalFn = params.clearIntervalFn ?? clearInterval;

  let timer: ReturnType<typeof setInterval> | undefined;
  let lastAppliedSignature: string | null = null;
  let lastAppliedAt = 0;

  const runEvaluation = (options?: { force?: boolean }) => {
    let decision: DiscordAutoPresenceDecision | null = null;
    try {
      decision = resolveDiscordAutoPresenceDecision({
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

    if (!decision || !params.gateway.isConnected) {
      return;
    }

    const forceApply = options?.force === true;
    const ts = now();
    const signature = stablePresenceSignature(decision.presence);
    if (!forceApply && signature === lastAppliedSignature) {
      return;
    }
    if (!forceApply && lastAppliedAt > 0 && ts - lastAppliedAt < autoCfg.minUpdateIntervalMs) {
      return;
    }

    params.gateway.updatePresence(decision.presence);
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
      timer = setIntervalFn(() => runEvaluation(), autoCfg.intervalMs);
    },
    stop: () => {
      if (!timer) {
        return;
      }
      clearIntervalFn(timer);
      timer = undefined;
    },
  };
}

export const __testing = {
  resolveAutoPresenceConfig,
  resolveAuthAvailability,
  stablePresenceSignature,
};
