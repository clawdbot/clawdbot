import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

type SessionUsageQuery = {
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  timeZone: "local" | "utc";
  agentId?: string;
};

function formatUtcOffset(timezoneOffsetMinutes: number): string {
  const offsetFromUtcMinutes = -timezoneOffsetMinutes;
  const sign = offsetFromUtcMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetFromUtcMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
}

export function buildSessionUsageDateParams(timeZone: "local" | "utc") {
  return timeZone === "utc"
    ? { mode: "utc" }
    : {
        mode: "specific",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffset: formatUtcOffset(new Date().getTimezoneOffset()),
      };
}

function buildSessionUsageParams(query: SessionUsageQuery): Record<string, unknown> {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    ...(query.agentId ? { agentId: query.agentId } : { agentScope: "all" }),
    ...buildSessionUsageDateParams(query.timeZone),
    groupBy: query.scope,
    limit: 1000,
    includeContextWeight: true,
  };
}

export function requestSessionUsage(
  client: SessionRequestClient,
  query: SessionUsageQuery,
): Promise<SessionsUsageResult> {
  return client.request<SessionsUsageResult>("sessions.usage", buildSessionUsageParams(query));
}

export function requestSessionUsageTimeSeries(
  client: SessionRequestClient,
  key: string,
): Promise<SessionUsageTimeSeries | null> {
  return client
    .request<SessionUsageTimeSeries | undefined>("sessions.usage.timeseries", { key })
    .then((result) => result ?? null);
}

export function requestSessionUsageLogs(
  client: SessionRequestClient,
  key: string,
): Promise<{ logs?: unknown }> {
  return client.request<{ logs?: unknown }>("sessions.usage.logs", {
    key,
    limit: 1000,
  });
}
