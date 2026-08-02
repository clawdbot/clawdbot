// Canonical gateway health degradation shared by text health and status output.
import type { HealthSummary } from "../gateway/health/types.js";
import { formatDurationHuman } from "../infra/format-time/format-duration.js";

type GatewayHealthDiagnostic = {
  item: "Context engine" | "Delivery queue" | "Config hot reload";
  detail: string;
};

function buildContextEngineHealthDiagnostic(
  summary: HealthSummary,
): GatewayHealthDiagnostic | null {
  const quarantined = summary.contextEngines?.quarantined ?? [];
  if (quarantined.length === 0) {
    return null;
  }
  const engines = quarantined.map((entry) => entry.engineId).join(", ");
  return {
    item: "Context engine",
    detail: `warning (${quarantined.length} quarantined; downgraded to legacy: ${engines})`,
  };
}

function buildDeliveryQueueHealthDiagnostic(
  summary: HealthSummary,
  now: number,
): GatewayHealthDiagnostic | null {
  const failed = summary.deliveryQueues?.failed ?? [];
  const ingressFailed = summary.deliveryQueues?.ingressFailed ?? [];
  if (failed.length === 0 && ingressFailed.length === 0) {
    return null;
  }
  const counts = [
    ...failed.map((queue) => `${queue.queueName}: ${queue.count}`),
    ...ingressFailed.map(
      (queue) => `inbound ${queue.channelId}/${queue.accountId}: ${queue.count}`,
    ),
  ].join(", ");
  const oldest = [...failed, ...ingressFailed]
    .map((queue) => queue.oldestFailedAt)
    .filter((value): value is number => typeof value === "number");
  const oldestNote =
    oldest.length > 0 ? `; oldest ${formatDurationHuman(now - Math.min(...oldest))} ago` : "";
  return {
    item: "Delivery queue",
    detail: `warning (dead-lettered entries — ${counts}${oldestNote})`,
  };
}

function buildConfigReloadHealthDiagnostic(summary: HealthSummary): GatewayHealthDiagnostic | null {
  if (summary.configReload?.hotReloadStatus !== "disabled") {
    return null;
  }
  return {
    item: "Config hot reload",
    detail: "disabled (watcher retries exhausted; restart the gateway to restore it)",
  };
}

/** Collects gateway-owned operational failures for text health and status output. */
export function collectGatewayHealthDiagnostics(
  summary: HealthSummary,
  now = Date.now(),
): GatewayHealthDiagnostic[] {
  return [
    buildContextEngineHealthDiagnostic(summary),
    buildDeliveryQueueHealthDiagnostic(summary, now),
    buildConfigReloadHealthDiagnostic(summary),
  ].filter((diagnostic): diagnostic is GatewayHealthDiagnostic => diagnostic !== null);
}

/** Preserves the canonical `Item: detail` wording used by text health output. */
export function formatGatewayHealthDiagnostic(diagnostic: GatewayHealthDiagnostic): string {
  return `${diagnostic.item}: ${diagnostic.detail}`;
}

/** Formats context engine quarantine state for text health output. */
export function formatContextEngineHealthLine(summary: HealthSummary): string | null {
  const diagnostic = buildContextEngineHealthDiagnostic(summary);
  return diagnostic ? formatGatewayHealthDiagnostic(diagnostic) : null;
}

/** Formats dead-lettered delivery queue entries for text health output. */
export function formatDeliveryQueueHealthLine(
  summary: HealthSummary,
  now = Date.now(),
): string | null {
  const diagnostic = buildDeliveryQueueHealthDiagnostic(summary, now);
  return diagnostic ? formatGatewayHealthDiagnostic(diagnostic) : null;
}

/** Formats config hot-reload watcher degradation for text health output. */
export function formatConfigReloadHealthLine(summary: HealthSummary): string | null {
  const diagnostic = buildConfigReloadHealthDiagnostic(summary);
  return diagnostic ? formatGatewayHealthDiagnostic(diagnostic) : null;
}
