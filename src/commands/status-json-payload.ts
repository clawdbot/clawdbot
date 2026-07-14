// Builds the stable JSON payload for `openclaw status --json`.
// Optional deep fields are included only when their upstream probes actually ran.

import {
  buildRuntimeReadiness,
  buildUnobservedGatewayConditions,
  type CanonicalReadinessResult,
} from "../readiness/conditions.js";
import { resolveStatusUpdateChannelInfo } from "./status-all/format.js";
import {
  buildStatusGatewayJsonPayloadFromSurface,
  type StatusOverviewSurface,
} from "./status-overview-surface.ts";

function resolveReadiness(value: unknown): CanonicalReadinessResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const direct = value as Partial<CanonicalReadinessResult>;
  if (
    typeof direct.ready === "boolean" &&
    Array.isArray(direct.conditions) &&
    Array.isArray(direct.failures) &&
    Array.isArray(direct.advisories)
  ) {
    return direct as CanonicalReadinessResult;
  }
  const readiness = (value as { readiness?: unknown }).readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return undefined;
  }
  return readiness as CanonicalReadinessResult;
}

function withScannedGatewayReadiness(
  readiness: CanonicalReadinessResult,
  gatewayReachable: boolean,
): CanonicalReadinessResult {
  const gatewayCondition: CanonicalReadinessResult["conditions"][number] = gatewayReachable
    ? {
        type: "GatewayResponding",
        status: "True",
        requirement: "required",
        reason: "GatewayResponding",
        message: "Gateway accepted the readiness request.",
      }
    : {
        type: "GatewayResponding",
        status: "False",
        requirement: "required",
        reason: "GatewayUnavailable",
        message: "Gateway did not respond to the readiness request.",
      };
  const conditions = [
    ...readiness.conditions.filter((condition) => condition.type !== "GatewayResponding"),
    gatewayCondition,
  ];
  const failures = Array.from(
    new Set(
      conditions
        .filter((condition) => condition.requirement === "required" && condition.status !== "True")
        .map((entry) => entry.reason),
    ),
  );
  const advisories = Array.from(
    new Set(
      conditions
        .filter((condition) => condition.requirement === "advisory" && condition.status !== "True")
        .map((entry) => entry.reason),
    ),
  );
  return {
    ...readiness,
    conditions,
    failures,
    advisories,
    ready: failures.length === 0,
  };
}

/** Combines scan summary, overview surface, services, agents, diagnostics, and optional deep probes. */
export function buildStatusJsonPayload(params: {
  summary: Record<string, unknown>;
  surface: StatusOverviewSurface;
  osSummary: unknown;
  memory: unknown;
  memoryPlugin: unknown;
  agents: unknown;
  secretDiagnostics: string[];
  securityAudit?: unknown;
  readiness?: unknown;
  health?: unknown;
  usage?: unknown;
  lastHeartbeat?: unknown;
  pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
}) {
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: params.surface.cfg.update?.channel ?? undefined,
    update: params.surface.update,
  });
  const summaryReadiness = resolveReadiness(params.summary);
  const readiness =
    resolveReadiness(params.health) ??
    resolveReadiness(params.readiness) ??
    resolveReadiness(params.surface.gatewayProbe?.health) ??
    (summaryReadiness
      ? withScannedGatewayReadiness(summaryReadiness, params.surface.gatewayReachable)
      : undefined) ??
    buildRuntimeReadiness({
      configLoaded: true,
      gateway: params.surface.gatewayReachable ? "responding" : "unavailable",
      coreConditions: buildUnobservedGatewayConditions(),
    });
  return {
    ...params.summary,
    readiness,
    os: params.osSummary,
    update: params.surface.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    gateway: buildStatusGatewayJsonPayloadFromSurface({ surface: params.surface }),
    gatewayService: params.surface.gatewayService,
    nodeService: params.surface.nodeService,
    agents: params.agents,
    secretDiagnostics: params.secretDiagnostics,
    ...(params.securityAudit ? { securityAudit: params.securityAudit } : {}),
    ...(params.pluginCompatibility
      ? {
          // Keep warnings grouped with a count so consumers can test compatibility status cheaply.
          pluginCompatibility: {
            count: params.pluginCompatibility.length,
            warnings: params.pluginCompatibility,
          },
        }
      : {}),
    ...(params.health || params.usage || params.lastHeartbeat
      ? {
          // Deep/usage fields stay absent in fast mode instead of appearing as null placeholders.
          health: params.health,
          usage: params.usage,
          lastHeartbeat: params.lastHeartbeat,
        }
      : {}),
  };
}
