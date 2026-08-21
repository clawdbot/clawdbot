// Small value formatters for status overview rows.
// These helpers keep terse row text consistent between compact and full status reports.

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { redactSecretDegradationReason } from "../secrets/runtime-degraded-state.js";
import type { StatusSummary } from "../status/types.js";
import { redactStatusSecrets } from "./status-all/format.js";

/** Combines authoritative owner details with distinct command-local human diagnostics. */
export function buildStatusSecretDiagnostics(
  owners: NonNullable<StatusSummary["degradedSecretOwners"]>,
  diagnostics: string[],
): string[] {
  const safeText = (value: string) =>
    truncateUtf16Safe(sanitizeTerminalText(redactStatusSecrets(value)), 160);
  const ownerPaths = new Set(owners.flatMap((owner) => owner.paths));
  const ownerDiagnostics = new Map(
    owners.map((owner) => [
      `${owner.ownerKind}\0${owner.ownerId}`,
      `${owner.degradationState ?? "cold"} ${owner.ownerKind}:${safeText(owner.ownerId)} (${owner.paths.slice(0, 3).map(safeText).join(", ")}${owner.paths.length > 3 ? ", …" : ""}): ${safeText(redactSecretDegradationReason(owner.reason))}`,
    ]),
  );
  const localDiagnostics = diagnostics.filter((diagnostic) => {
    const ownerPath =
      /^.+?: (.+?) is unavailable in this command path(?:;|$)/.exec(diagnostic)?.[1] ??
      diagnostic.split(":", 1)[0];
    return ownerPath === undefined || !ownerPaths.has(ownerPath);
  });
  return [...ownerDiagnostics.values(), ...new Set(localDiagnostics.map(safeText))];
}

type AgentStatusLike = {
  bootstrapPendingCount: number;
  totalSessions: number;
  agents: Array<{
    id: string;
    lastActiveAgeMs?: number | null;
  }>;
};

type PluginCompatibilityNoticeLike = {
  pluginId?: string | null;
  plugin?: string | null;
};

type SummarySessionsLike = {
  count: number;
  paths: string[];
  defaults: {
    model?: string | null;
    contextTokens?: number | null;
  };
};

function countActiveStatusAgents(params: {
  agentStatus: AgentStatusLike;
  activeThresholdMs?: number;
}) {
  const activeThresholdMs = params.activeThresholdMs ?? 10 * 60_000;
  // "Active" means a recent session update, not merely a configured agent.
  return params.agentStatus.agents.filter(
    (agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= activeThresholdMs,
  ).length;
}

/** Formats the status-all agents overview cell. */
export function buildStatusAllAgentsValue(params: {
  agentStatus: AgentStatusLike;
  activeThresholdMs?: number;
}) {
  const activeAgents = countActiveStatusAgents(params);
  return `${params.agentStatus.agents.length} total · ${params.agentStatus.bootstrapPendingCount} bootstrapping · ${activeAgents} active · ${params.agentStatus.totalSessions} sessions`;
}

/** Formats the secrets diagnostics count for overview output. */
export function buildStatusSecretsValue(count: number) {
  return count > 0 ? `${count} diagnostic${count === 1 ? "" : "s"}` : "none";
}

/** Formats queued system-event count for overview output. */
export function buildStatusEventsValue(params: { queuedSystemEvents: string[] }) {
  return params.queuedSystemEvents.length > 0
    ? `${params.queuedSystemEvents.length} queued`
    : "none";
}

/** Formats whether deep probe data was collected. */
export function buildStatusProbesValue(params: {
  health?: unknown;
  ok: (value: string) => string;
  muted: (value: string) => string;
}) {
  return params.health ? params.ok("enabled") : params.muted("skipped (use --deep)");
}

/** Formats plugin compatibility notices as a compact count by notice and plugin. */
export function buildStatusPluginCompatibilityValue(params: {
  notices: PluginCompatibilityNoticeLike[];
  ok: (value: string) => string;
  warn: (value: string) => string;
}) {
  if (params.notices.length === 0) {
    return params.ok("none");
  }
  const pluginCount = new Set(
    params.notices.map((notice) => notice.pluginId ?? notice.plugin ?? ""),
  ).size;
  return params.warn(
    `${params.notices.length} notice${params.notices.length === 1 ? "" : "s"} · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`,
  );
}

/** Formats active session count, default model/context, and backing store summary. */
export function buildStatusSessionsOverviewValue(params: {
  sessions: SummarySessionsLike;
  formatKTokens: (value: number) => string;
}) {
  const defaultCtx = params.sessions.defaults.contextTokens
    ? ` (${params.formatKTokens(params.sessions.defaults.contextTokens)} ctx)`
    : "";
  const storeLabel =
    params.sessions.paths.length > 1
      ? `${params.sessions.paths.length} stores`
      : (params.sessions.paths[0] ?? "unknown");
  return `${params.sessions.count} active · default ${params.sessions.defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`;
}
