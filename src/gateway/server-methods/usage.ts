// Gateway usage methods validate requests and assemble owner-scoped usage reports.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsUsageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadSessionLogs, loadSessionUsageTimeSeries } from "../../infra/session-cost-usage.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createUsageAggregateAccumulator } from "../../shared/usage-aggregates.js";
import type {
  SessionUsageEntry,
  SessionsUsageAggregates,
  SessionsUsageResult,
} from "../../shared/usage-types.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { createSessionListEntryFilter, isGatewayAdmin } from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { loadUsageStatusStaleWhileRevalidate } from "./models-auth-status-usage-cache.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import {
  formatDateLabel,
  resolveDateInterpretation,
  resolveDateRange,
  resolveDayBucket,
  type DateInterpretation,
  type DateRange,
} from "./usage-date-range.js";
import {
  costUsageCache,
  sessionsUsageCache,
  loadCostUsageSummaryCached,
  loadSessionsUsageResultCached,
} from "./usage-result-cache.js";
import { loadUsageSessionSummaries } from "./usage-session-loading.js";
import {
  resolveSessionUsageTarget,
  selectUsageSessions,
  UsageSessionInvalidRequestError,
  type UsageGroupingMode,
} from "./usage-session-selection.js";
import { assertValidParams } from "./validation.js";

function resolveSessionUsageFileOrRespond(
  key: string,
  respond: RespondFn,
  config: OpenClawConfig,
): (NonNullable<ReturnType<typeof resolveSessionUsageTarget>> & { config: OpenClawConfig }) | null {
  const sessionOwner = resolveRequestedSessionAgentId(config, key);
  if (!sessionOwner.ok) {
    respond(false, undefined, sessionOwner.error);
    return null;
  }
  let resolved: NonNullable<ReturnType<typeof resolveSessionUsageTarget>> | undefined;
  try {
    resolved = resolveSessionUsageTarget(key, config, sessionOwner.agentId);
  } catch {
    resolved = undefined;
  }
  if (!resolved) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
    );
    return null;
  }
  return { config, ...resolved };
}

function resolveUsageDateRangeOrRespond(
  params: Parameters<typeof resolveDateRange>[0],
  respond: RespondFn,
): { interpretation: DateInterpretation; range: DateRange } | null {
  const interpretation = resolveDateInterpretation(params);
  if (!interpretation.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, interpretation.error));
    return null;
  }

  const range = resolveDateRange(params, interpretation.value);
  if (!range.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, range.error));
    return null;
  }
  return { interpretation: interpretation.value, range: range.value };
}

// Exposed for unit tests (kept as a single export to avoid widening the public API surface).
export const testApi = {
  resolveDateRange,
  loadCostUsageSummaryCached,
  costUsageCache,
  sessionsUsageCache,
};

export type { SessionUsageEntry, SessionsUsageAggregates, SessionsUsageResult };

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond, context, client }) => {
    // Only clients with bounded retry machinery may receive an incomplete cold result.
    // In-process dispatch reuses the originating request's client, capabilities
    // included, so a plugin proxying this method inside a capable UI request
    // would inherit the marker without any way to converge it. Such a caller
    // must pass a capless client, the way board bindings force `client: null`.
    const coldRead = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
    )
      ? ("refresh-marker" as const)
      : undefined;
    const summary = await loadUsageStatusStaleWhileRevalidate({
      config: context.getRuntimeConfig(),
      coldRead,
    });
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params, context, client }) => {
    const dateRange = resolveUsageDateRangeOrRespond(params ?? {}, respond);
    if (!dateRange) {
      return;
    }
    const { interpretation: dateInterpretation, range } = dateRange;
    const config = context.getRuntimeConfig();
    if (!isGatewayAdmin(client ?? null) && operatorSessionCap(client ?? null, config) === "none") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Aggregate usage includes sessions hidden by your operator role; ask an administrator to review Gateway-wide usage.",
        ),
      );
      return;
    }
    const { startMs, endMs } = range;
    const agentId = normalizeOptionalString(params?.agentId);
    if (params?.agentScope === "all" && agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentScope=all cannot be combined with agentId"),
      );
      return;
    }
    const agentScope = params?.agentScope === "all" ? "all" : undefined;
    let effectiveAgentId = agentId;
    if (!agentScope && !effectiveAgentId) {
      const requestedAgent = resolveRequestedSessionAgentId(config, "main");
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      effectiveAgentId = requestedAgent.agentId;
    }
    const summary = await loadCostUsageSummaryCached({
      startMs,
      endMs,
      dayBucket: resolveDayBucket(dateInterpretation),
      config,
      agentId: effectiveAgentId,
      agentScope,
    });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params, context, client }) => {
    if (!assertValidParams(params, validateSessionsUsageParams, "sessions.usage", respond)) {
      return;
    }

    const p = params;
    const dateRange = resolveUsageDateRangeOrRespond(p, respond);
    if (!dateRange) {
      return;
    }
    const { interpretation: dateInterpretation, range } = dateRange;
    const config = context.getRuntimeConfig();
    const sessionCap = operatorSessionCap(client ?? null, config);
    const visibilityFilter =
      sessionCap === "none"
        ? createSessionListEntryFilter({ client: client ?? null, cfg: config })
        : undefined;
    const profileId = gatewayClientSessionCreator(client ?? null)?.id;
    const visibilityIdentity = sessionCap && profileId ? `${profileId}:${sessionCap}` : undefined;
    const { startMs, endMs, includeUntimestamped } = range;
    const dayBucket = resolveDayBucket(dateInterpretation);
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = normalizeOptionalString(p.key) ?? null;
    const requestedAgentId = normalizeOptionalString(p.agentId);
    const requestedAllAgents = p.agentScope === "all";
    if (requestedAllAgents && (requestedAgentId || specificKey)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agentScope=all cannot be combined with key or agentId",
        ),
      );
      return;
    }
    const specificSessionOwner = specificKey
      ? resolveRequestedSessionAgentId(config, specificKey, requestedAgentId)
      : undefined;
    if (specificSessionOwner && !specificSessionOwner.ok) {
      respond(false, undefined, specificSessionOwner.error);
      return;
    }
    const implicitAgent =
      !requestedAllAgents && !specificSessionOwner?.agentId && !requestedAgentId
        ? resolveRequestedSessionAgentId(config, "main")
        : undefined;
    if (implicitAgent && !implicitAgent.ok) {
      respond(false, undefined, implicitAgent.error);
      return;
    }
    const effectiveAgentId = requestedAllAgents
      ? undefined
      : normalizeAgentId(
          specificSessionOwner?.agentId ?? requestedAgentId ?? implicitAgent?.agentId,
        );
    const groupingMode: UsageGroupingMode =
      p.groupBy === "family" || p.includeHistorical === true ? "family" : "instance";

    let result: SessionsUsageResult;
    try {
      result = await loadSessionsUsageResultCached({
        configRef: config,
        ...(effectiveAgentId ? { agentId: effectiveAgentId } : { agentScope: "all" }),
        startMs,
        endMs,
        includeUntimestamped,
        dayBucket,
        limit,
        groupingMode,
        specificKey,
        includeContextWeight,
        ...(visibilityIdentity ? { visibilityIdentity } : {}),
        load: async () => {
          const now = Date.now();
          const mergedEntries = await selectUsageSessions({
            config,
            agentId: effectiveAgentId,
            specificKey,
            groupingMode,
            startMs,
            endMs,
            visibilityFilter,
          });

          // Load usage for each session
          const sessions: SessionUsageEntry[] = [];
          const accumulator = createUsageAggregateAccumulator();
          const { summaries: usageByEntryIndex, cacheStatus } = await loadUsageSessionSummaries({
            entries: mergedEntries,
            config,
            startMs,
            endMs,
            includeUntimestamped,
            dayBucket,
          });

          for (const [entryIndex, merged] of mergedEntries.entries()) {
            const agentId = merged.agentId;
            const usage = usageByEntryIndex[entryIndex] ?? null;
            const channel = sessionDeliveryChannel(merged.storeEntry);
            const origin = sessionDeliveryOrigin(merged.storeEntry);
            const chatType = merged.storeEntry?.chatType ?? origin?.chatType;
            // Aggregate every matched row before limiting the visible list.
            accumulator.add({ usage, agentId, channel });

            if (entryIndex < limit) {
              sessions.push({
                key: merged.key,
                label: merged.label,
                sessionId: merged.sessionId,
                scope: merged.scope ?? "instance",
                sessionFamilyKey: merged.sessionFamilyKey,
                currentSessionId: merged.currentSessionId,
                includedSessionIds: merged.includedSessionIds,
                historicalInstanceCount: merged.includedSessionIds?.length,
                updatedAt: merged.updatedAt,
                agentId,
                channel,
                chatType,
                origin,
                modelOverride: merged.storeEntry?.modelOverride,
                providerOverride: merged.storeEntry?.providerOverride,
                modelProvider: merged.storeEntry?.modelProvider,
                model: merged.storeEntry?.model,
                usage,
                hasContextWeight: Boolean(merged.storeEntry?.systemPromptReport),
                contextWeight: includeContextWeight
                  ? (merged.storeEntry?.systemPromptReport ?? null)
                  : undefined,
              });
            }
          }

          return {
            updatedAt: now,
            startDate: formatDateLabel(startMs, dateInterpretation),
            endDate: formatDateLabel(endMs, dateInterpretation),
            sessions,
            totals: accumulator.totals,
            aggregates: accumulator.finish(),
            cacheStatus,
          };
        },
      });
    } catch (err) {
      if (err instanceof UsageSessionInvalidRequestError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }
    respond(true, result, undefined);
  },
  "sessions.usage.timeseries": async ({ respond, params, context }) => {
    const key = normalizeOptionalString(params?.key) ?? null;
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"),
      );
      return;
    }

    const resolved = resolveSessionUsageFileOrRespond(key, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const timeseries = await loadSessionUsageTimeSeries({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      agentId,
      maxPoints: 200,
    });

    if (!timeseries) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${key}`),
      );
      return;
    }

    respond(true, timeseries, undefined);
  },
  "sessions.usage.logs": async ({ respond, params, context }) => {
    const key = normalizeOptionalString(params?.key) ?? null;
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
      return;
    }

    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const resolved = resolveSessionUsageFileOrRespond(key, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const logs = await loadSessionLogs({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      agentId,
      limit,
    });

    respond(true, { logs: logs ?? [] }, undefined);
  },
};
