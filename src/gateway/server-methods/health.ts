// Health gateway methods return cached or refreshed status summaries while
// detecting stale channel runtime state against live gateway snapshots.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { getStatusSummary } from "../../status/summary.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import { buildContextEngineHealthSummary } from "../health/context-engine.js";
import { buildDeliveryQueueHealthSummary } from "../health/delivery-queue.js";
import type { ChannelHealthSummary, HealthSummary } from "../health/types.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const requestRefreshStartedAt = new WeakMap<
  GatewayRequestContext["refreshHealthSnapshot"],
  number
>();

function shouldScheduleRequestRefresh(
  refresh: GatewayRequestContext["refreshHealthSnapshot"],
  now: number,
): boolean {
  const startedAt = requestRefreshStartedAt.get(refresh);
  if (
    startedAt !== undefined &&
    !isFutureDateTimestampMs(startedAt, { nowMs: now }) &&
    now - startedAt < HEALTH_REFRESH_INTERVAL_MS
  ) {
    return false;
  }
  // Scope the throttle to the Gateway refresh owner so independent servers do
  // not suppress each other while request bursts share one cadence.
  requestRefreshStartedAt.set(refresh, now);
  return true;
}

function cachedLifecycleDiffersFromRuntime(params: {
  cachedAccount: ChannelHealthSummary | undefined;
  runtimeSnapshot: ChannelAccountSnapshot;
}): boolean {
  for (const key of ["running", "connected", "lifecycle"] as const) {
    const runtimeValue = params.runtimeSnapshot[key];
    if (runtimeValue !== undefined && params.cachedAccount?.[key] !== runtimeValue) {
      return true;
    }
  }
  return params.cachedAccount === undefined;
}

/** Checks whether cached channel health is stale against the live runtime snapshot. */
function cachedHealthDiffersFromRuntime(
  cached: HealthSummary,
  runtime: ChannelRuntimeSnapshot,
): boolean {
  for (const [channelId, runtimeSnapshot] of Object.entries(runtime.channels)) {
    if (!runtimeSnapshot) {
      continue;
    }
    const cachedChannel = cached.channels[channelId];
    if (
      cachedLifecycleDiffersFromRuntime({
        cachedAccount: cachedChannel,
        runtimeSnapshot,
      })
    ) {
      return true;
    }
  }

  for (const [channelId, accounts] of Object.entries(runtime.channelAccounts)) {
    if (!accounts) {
      continue;
    }
    const cachedChannel = cached.channels[channelId];
    const cachedAccounts = cachedChannel?.accounts;
    if (
      Object.keys(cachedAccounts ?? {}).some((accountId) => !Object.hasOwn(accounts, accountId))
    ) {
      return true;
    }
    for (const [accountId, runtimeSnapshot] of Object.entries(accounts)) {
      if (!runtimeSnapshot) {
        continue;
      }
      if (
        cachedLifecycleDiffersFromRuntime({
          cachedAccount: cachedAccounts?.[accountId],
          runtimeSnapshot,
        })
      ) {
        return true;
      }
    }
  }

  // Hot-unloaded plugins vanish from both runtime maps before cached health expires.
  return Object.keys(cached.channels).some(
    (channelId) =>
      !Object.hasOwn(runtime.channels, channelId) &&
      !Object.hasOwn(runtime.channelAccounts, channelId),
  );
}

/** Merges cheap live runtime facts into a cached health summary before responding. */
function mergeCachedHealthRuntimeState(params: {
  cached: HealthSummary;
  eventLoop?: HealthSummary["eventLoop"];
  configReloadHotReloadStatus?: GatewayHotReloadStatus;
}): HealthSummary {
  const {
    contextEngines: _cachedContextEngines,
    deliveryQueues: _cachedDeliveryQueues,
    ...cached
  } = params.cached;
  // Dead-letter counts are cheap live reads. Preserve the grouped pressure
  // aggregate for the cache interval so routine health RPCs do not amplify it.
  const deliveryQueues = buildDeliveryQueueHealthSummary(
    _cachedDeliveryQueues?.ingressPressure ?? [],
  );
  const contextEngines = buildContextEngineHealthSummary();
  return {
    ...cached,
    ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
    ...(contextEngines ? { contextEngines } : {}),
    ...(deliveryQueues ? { deliveryQueues } : {}),
    ...(params.configReloadHotReloadStatus
      ? { configReload: { hotReloadStatus: params.configReloadHotReloadStatus } }
      : {}),
  };
}

/** Gateway handlers for health snapshots and status summaries. */
export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params, client }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
    const wantsProbe = params?.probe === true;
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const includeSensitive = scopes.includes(ADMIN_SCOPE);
    const now = Date.now();
    const cached = getHealthCache();
    let cachedDiffersFromRuntime = false;
    if (!wantsProbe && cached) {
      try {
        cachedDiffersFromRuntime = cachedHealthDiffersFromRuntime(
          cached,
          context.getRuntimeSnapshot(),
        );
      } catch {
        cachedDiffersFromRuntime = true;
      }
    }
    if (
      !wantsProbe &&
      cached &&
      !cachedDiffersFromRuntime &&
      !isFutureDateTimestampMs(cached.ts, { nowMs: now }) &&
      now - cached.ts < HEALTH_REFRESH_INTERVAL_MS
    ) {
      respond(
        true,
        mergeCachedHealthRuntimeState({
          cached,
          eventLoop: context.getEventLoopHealth?.(),
          configReloadHotReloadStatus: context.getConfigReloaderHotReloadStatus?.(),
        }),
        undefined,
        { cached: true },
      );
      if (shouldScheduleRequestRefresh(refreshHealthSnapshot, now)) {
        void refreshHealthSnapshot({ probe: false, includeSensitive }).catch((err: unknown) =>
          logHealth.error(`background health refresh failed: ${formatError(err)}`),
        );
      }
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe, includeSensitive });
      respond(true, snap, undefined);
    });
  },
  status: async ({ respond, client, params, context }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const hostDesktopStatus = await context.hostDesktopService?.status();
    const status = await getStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
      includeChannelSummary: params.includeChannelSummary !== false,
      ...(hostDesktopStatus ? { hostDesktopStatus } : {}),
    });
    if (context.getEventLoopHealth) {
      status.eventLoop = context.getEventLoopHealth();
    }
    const memory = process.memoryUsage();
    status.processMemory = {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    };
    respond(true, status, undefined);
  },
};
