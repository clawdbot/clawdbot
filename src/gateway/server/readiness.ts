// Gateway readiness checker for channel health and startup sidecar state.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/** Snapshot returned by the gateway readiness probe. */
type ReadinessResult = {
  ready: boolean;
  failing: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
};

/** Function form used by HTTP readiness endpoints and tests. */
export type ReadinessChecker = () => ReadinessResult;

export type StartupResult =
  | { ok: true; status: "started"; uptimeMs: number }
  | { ok: false; status: "starting"; uptimeMs: number; pendingReason: string }
  | { ok: false; status: "draining"; uptimeMs: number };

/** Function form used by HTTP startup endpoints and tests. */
export type StartupChecker = () => StartupResult;

type GatewayStartupStateDeps = {
  startedAt: number;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: () => string | undefined;
  getGatewayDraining?: () => boolean;
};

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;

/** Create a startup checker that excludes downstream channel health. */
export function createStartupChecker(deps: GatewayStartupStateDeps): StartupChecker {
  return (): StartupResult => {
    const uptimeMs = Date.now() - deps.startedAt;
    if (deps.getGatewayDraining?.()) {
      return { ok: false, status: "draining", uptimeMs };
    }
    if (deps.getStartupPending?.()) {
      return {
        ok: false,
        status: "starting",
        uptimeMs,
        pendingReason: deps.getStartupPendingReason?.() ?? "startup-sidecars",
      };
    }
    return { ok: true, status: "started", uptimeMs };
  };
}

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
  autostartSuppressed: boolean,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  if (autostartSuppressed && health.reason === "not-running") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  // A failed ingress start lands in the same backoff window, so it gets the same
  // grace: the next start re-proves ingress, and once the ladder stops setting
  // restartPending the account stays red instead of hiding dead inbound.
  const restartableReason =
    health.reason === "not-running" || health.reason === "ingress-unavailable";
  const inRestartHandoff =
    accountSnapshot.restartPending === true && accountSnapshot.running !== true;
  return restartableReason && inRestartHandoff;
}

/** Create a cached readiness checker over channel runtime health. */
export function createReadinessChecker(
  deps: GatewayStartupStateDeps & {
    channelManager: ChannelManager;
    getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
    shouldSkipChannelReadiness?: () => boolean;
    cacheTtlMs?: number;
  },
): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const getStartup = createStartupChecker(deps);
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const startup = getStartup();
    const uptimeMs = startup.uptimeMs;
    const now = startedAt + uptimeMs;
    if (startup.status === "starting") {
      return withEventLoopHealth(
        { ready: false, failing: [startup.pendingReason], uptimeMs },
        deps.getEventLoopHealth,
      );
    }
    if (startup.status === "draining") {
      return withEventLoopHealth(
        { ready: false, failing: ["gateway-draining"], uptimeMs },
        deps.getEventLoopHealth,
      );
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return withEventLoopHealth({ ready: true, failing: [], uptimeMs }, deps.getEventLoopHealth);
    }
    if (
      cachedState &&
      !isFutureDateTimestampMs(cachedAt, { nowMs: now }) &&
      now - cachedAt < cacheTtlMs
    ) {
      return withEventLoopHealth({ ...cachedState, uptimeMs }, deps.getEventLoopHealth);
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const globallyAutostartSuppressed = channelManager.getAutostartSuppression() !== null;
    const failing: string[] = [];
    const suppressed: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      const autostartSuppressed =
        globallyAutostartSuppressed || channelManager.isAmbientAutostartSuppressed(channelId);
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && autostartSuppressed && health.reason === "not-running") {
          if (!suppressed.includes(channelId)) {
            suppressed.push(channelId);
          }
          continue;
        }
        if (
          !health.healthy &&
          !shouldIgnoreReadinessFailure(accountSnapshot, health, autostartSuppressed)
        ) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    cachedState = {
      ready: failing.length === 0,
      failing,
      ...(suppressed.length > 0 ? { suppressed } : {}),
    };
    return withEventLoopHealth({ ...cachedState, uptimeMs }, deps.getEventLoopHealth);
  };
}

function withEventLoopHealth(
  result: ReadinessResult,
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined,
): ReadinessResult {
  const eventLoop = getEventLoopHealth?.();
  return eventLoop ? { ...result, eventLoop } : result;
}
