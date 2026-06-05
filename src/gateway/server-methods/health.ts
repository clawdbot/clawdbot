// Health gateway methods return cached or refreshed status summaries while
// detecting stale channel runtime state against live gateway snapshots.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { ChannelHealthSummary, HealthSummary } from "../../commands/health.types.js";
import { getStatusSummary } from "../../commands/status.js";
import { listContextEngineQuarantines } from "../../context-engine/registry.js";
import { getGatewayModelPricingHealth } from "../model-pricing-cache-state.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";

function cachedAccountForRuntimeSnapshot(params: {
  cachedChannel: ChannelHealthSummary | undefined;
  accountId: string | undefined;
}): ChannelHealthSummary | undefined {
  const accountId = params.accountId;
  if (accountId && params.cachedChannel?.accounts?.[accountId]) {
    return params.cachedChannel.accounts[accountId];
  }
  return undefined;
}

function cachedLifecycleDiffersFromRuntime(params: {
  cachedAccount: ChannelHealthSummary | undefined;
  runtimeSnapshot: ChannelAccountSnapshot;
}): boolean {
  for (const key of ["running", "connected"] as const) {
    const runtimeValue = params.runtimeSnapshot[key];
    if (typeof runtimeValue !== "boolean") {
      continue;
    }
    if (params.cachedAccount?.[key] !== runtimeValue) {
      return true;
    }
  }
  return false;
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
    for (const [accountId, runtimeSnapshot] of Object.entries(accounts)) {
      if (!runtimeSnapshot) {
        continue;
      }
      if (
        cachedLifecycleDiffersFromRuntime({
          cachedAccount: cachedAccountForRuntimeSnapshot({
            cachedChannel,
            accountId,
          }),
          runtimeSnapshot,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Merges cheap live runtime facts into a cached health summary before responding. */
function mergeCachedHealthRuntimeState(params: {
  cached: HealthSummary;
  eventLoop?: HealthSummary["eventLoop"];
}): HealthSummary {
  const { contextEngines: _cachedContextEngines, ...cached } = params.cached;
  const quarantinedContextEngines: NonNullable<HealthSummary["contextEngines"]>["quarantined"] = [];
  for (const entry of listContextEngineQuarantines()) {
    const summary: NonNullable<HealthSummary["contextEngines"]>["quarantined"][number] = {
      engineId: entry.engineId,
      operation: entry.operation,
      reason: entry.reason,
      failedAt: entry.failedAt.getTime(),
    };
    if (entry.owner) {
      summary.owner = entry.owner;
    }
    quarantinedContextEngines.push(summary);
  }
  return {
    ...cached,
    ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
    ...(quarantinedContextEngines.length > 0
      ? { contextEngines: { quarantined: quarantinedContextEngines } }
      : {}),
    modelPricing: getGatewayModelPricingHealth({
      enabled: params.cached.modelPricing?.state !== "disabled",
    }),
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
        cachedDiffersFromRuntime = false;
      }
    }
    if (
      !wantsProbe &&
      cached &&
      !cachedDiffersFromRuntime &&
      now - cached.ts < HEALTH_REFRESH_INTERVAL_MS
    ) {
      respond(
        true,
        mergeCachedHealthRuntimeState({
          cached,
          eventLoop: context.getEventLoopHealth?.(),
        }),
        undefined,
        { cached: true },
      );
      // Serve the fresh-enough cache immediately but still refresh in the
      // background so the next caller sees updated expensive probe data.
      void refreshHealthSnapshot({ probe: false, includeSensitive }).catch((err: unknown) =>
        logHealth.error(`background health refresh failed: ${formatError(err)}`),
      );
      return;
    }
    try {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe, includeSensitive });
      respond(true, snap, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  status: async ({ respond, client, params, context }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const status = await getStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
      includeChannelSummary: params.includeChannelSummary !== false,
    });
    if (context.getEventLoopHealth) {
      status.eventLoop = context.getEventLoopHealth();
    }
    respond(true, status, undefined);
  },
};
