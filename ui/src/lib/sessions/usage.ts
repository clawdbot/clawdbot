import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";

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
    includeHistorical: query.scope === "family",
    limit: 1000,
    includeContextWeight: true,
  };
}

function isOlderGatewayWithoutUsageTimeZone(
  error: unknown,
  params: Record<string, unknown>,
): boolean {
  return (
    typeof params.timeZone === "string" &&
    typeof params.utcOffset === "string" &&
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("invalid sessions.usage params:") &&
    error.message.includes("unexpected property 'timeZone'")
  );
}

export async function requestSessionsUsage(
  client: SessionRequestClient,
  params: Record<string, unknown>,
): Promise<SessionsUsageResult> {
  try {
    return await client.request<SessionsUsageResult>("sessions.usage", params);
  } catch (error) {
    if (!isOlderGatewayWithoutUsageTimeZone(error, params)) {
      throw error;
    }
    // Protocol v4 gateways predating timeZone reject the additive field.
    // Retry with the accompanying fixed offset for mixed-version clients.
    const legacyParams = { ...params };
    delete legacyParams.timeZone;
    return await client.request<SessionsUsageResult>("sessions.usage", legacyParams);
  }
}

export function requestSessionUsage(
  client: SessionRequestClient,
  query: SessionUsageQuery,
): Promise<SessionsUsageResult> {
  return requestSessionsUsage(client, buildSessionUsageParams(query));
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
