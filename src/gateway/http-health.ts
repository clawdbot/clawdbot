/**
 * HTTP health endpoints for container orchestration (K8s liveness/readiness).
 *
 * - GET /health      - Liveness probe: 200 if process alive
 * - GET /ready       - Readiness probe: 200 if channels ready, 503 if degraded
 * - GET /health/deep - Detailed status (auth-protected)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { VERSION } from "../version.js";
import type { HealthSummary } from "../commands/health.js";
import type { GatewayHealthConfig } from "../config/types.gateway.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken } from "./http-utils.js";
import { getHealthCache, refreshGatewayHealthSnapshot } from "./server/health-state.js";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type HealthResponse = {
  status: HealthStatus;
  version: string;
  uptimeMs: number;
  timestamp: string;
  checks?: {
    channels?: {
      total: number;
      configured: number;
      healthy: number;
      degraded: string[];
    };
    agents?: {
      total: number;
      default: string;
    };
  };
};

const startTime = Date.now();

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * Determine overall health status from channel health summaries.
 * - healthy: all configured channels have successful probes
 * - degraded: some channels have failed probes
 * - unhealthy: all channels have failed probes or critical failure
 */
function determineHealthStatus(health: HealthSummary | null): {
  status: HealthStatus;
  degradedChannels: string[];
} {
  if (!health) {
    return { status: "healthy", degradedChannels: [] };
  }

  const channels = health.channels ?? {};
  const channelIds = Object.keys(channels);
  const degradedChannels: string[] = [];

  for (const channelId of channelIds) {
    const channelSummary = channels[channelId];
    if (!channelSummary) continue;

    // Skip unconfigured channels
    if (channelSummary.configured === false) continue;

    // Check probe status
    const probe = channelSummary.probe as { ok?: boolean } | undefined;
    if (probe && probe.ok === false) {
      degradedChannels.push(channelId);
    }

    // Check account-level probes
    const accounts = channelSummary.accounts ?? {};
    for (const [accountId, accountSummary] of Object.entries(accounts)) {
      const accountProbe = accountSummary.probe as { ok?: boolean } | undefined;
      if (accountProbe && accountProbe.ok === false) {
        const key = `${channelId}:${accountId}`;
        if (!degradedChannels.includes(key)) {
          degradedChannels.push(key);
        }
      }
    }
  }

  const configuredCount = channelIds.filter((id) => channels[id]?.configured !== false).length;

  if (degradedChannels.length === 0) {
    return { status: "healthy", degradedChannels };
  }
  if (degradedChannels.length >= configuredCount && configuredCount > 0) {
    return { status: "unhealthy", degradedChannels };
  }
  return { status: "degraded", degradedChannels };
}

function buildHealthResponse(health: HealthSummary | null, includeChecks: boolean): HealthResponse {
  const uptimeMs = Date.now() - startTime;
  const { status, degradedChannels } = determineHealthStatus(health);

  const response: HealthResponse = {
    status,
    version: VERSION,
    uptimeMs,
    timestamp: new Date().toISOString(),
  };

  if (includeChecks && health) {
    const channels = health.channels ?? {};
    const channelIds = Object.keys(channels);
    const configuredCount = channelIds.filter((id) => channels[id]?.configured !== false).length;
    const healthyCount = configuredCount - degradedChannels.length;

    response.checks = {
      channels: {
        total: channelIds.length,
        configured: configuredCount,
        healthy: healthyCount,
        degraded: degradedChannels,
      },
      agents: {
        total: health.agents?.length ?? 0,
        default: health.defaultAgentId ?? "pi",
      },
    };
  }

  return response;
}

export type HealthEndpointsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export function createHealthEndpointsHandler(opts: {
  config?: GatewayHealthConfig;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies?: string[];
}): HealthEndpointsHandler {
  const { config, resolvedAuth, trustedProxies } = opts;
  const basePath = config?.basePath ?? "";
  const deepAuthRequired = config?.deepAuthRequired !== false;

  return async (req, res) => {
    if (config?.enabled === false) return false;

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // GET /health - Liveness probe (always 200 if process is running)
    if (path === `${basePath}/health` && req.method === "GET") {
      const health = getHealthCache();
      const response = buildHealthResponse(health, false);
      sendJson(res, 200, response);
      return true;
    }

    // GET /ready - Readiness probe (503 if degraded/unhealthy)
    if (path === `${basePath}/ready` && req.method === "GET") {
      const health = getHealthCache();
      const { status } = determineHealthStatus(health);
      const response = buildHealthResponse(health, false);

      const httpStatus = status === "healthy" ? 200 : 503;
      sendJson(res, httpStatus, response);
      return true;
    }

    // GET /health/deep - Detailed health with auth
    if (path === `${basePath}/health/deep` && req.method === "GET") {
      if (deepAuthRequired) {
        const token = getBearerToken(req);
        const authResult = await authorizeGatewayConnect({
          auth: resolvedAuth,
          connectAuth: token ? { token, password: token } : null,
          req,
          trustedProxies,
        });
        if (!authResult.ok) {
          sendJson(res, 401, {
            error: "Unauthorized",
            reason: authResult.reason ?? "Authentication required",
          });
          return true;
        }
      }

      // Refresh health snapshot for deep check
      const health = await refreshGatewayHealthSnapshot({ probe: true });
      const response = buildHealthResponse(health, true);
      sendJson(res, 200, response);
      return true;
    }

    return false;
  };
}
