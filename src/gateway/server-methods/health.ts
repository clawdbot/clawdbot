import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { ChannelHealthSummary, HealthSummary } from "../../commands/health.types.js";
import { getStatusSummary } from "../../commands/status.js";
import { getGatewayModelPricingHealth } from "../model-pricing-cache-state.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
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

function mergeCachedHealthRuntimeState(params: {
  cached: HealthSummary;
  eventLoop?: HealthSummary["eventLoop"];
}): HealthSummary {
  return {
    ...params.cached,
    ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
    modelPricing: getGatewayModelPricingHealth({
      enabled: params.cached.modelPricing?.state !== "disabled",
    }),
  };
}

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
      void refreshHealthSnapshot({ probe: false, includeSensitive }).catch((err) =>
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
