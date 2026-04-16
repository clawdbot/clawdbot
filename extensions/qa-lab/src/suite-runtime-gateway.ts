import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { QaConfigSnapshot, QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

async function fetchJson<T>(url: string): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-suite-fetch-json",
  });
  try {
    if (!response.ok) {
      throw new Error(`request failed ${response.status}: ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

async function waitForGatewayHealthy(env: Pick<QaSuiteRuntimeEnv, "gateway">, timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url: `${env.gateway.baseUrl}/readyz`,
        policy: { allowPrivateNetwork: true },
        auditContext: "qa-lab-suite-wait-for-gateway-healthy",
      });
      try {
        if (response.ok) {
          return;
        }
      } finally {
        await release();
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function waitForTransportReady(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  timeoutMs = 45_000,
) {
  await env.transport.waitReady({
    gateway: env.gateway,
    timeoutMs,
  });
}

async function waitForQaChannelReady(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  timeoutMs = 45_000,
) {
  await waitForTransportReady(env, timeoutMs);
}

async function waitForConfigRestartSettle(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  restartDelayMs = 1_000,
  timeoutMs = 60_000,
) {
  await sleep(restartDelayMs + 750);
  await waitForGatewayHealthy(env, timeoutMs);
}

function formatGatewayPrimaryErrorText(error: unknown) {
  const text = formatErrorMessage(error);
  const gatewayLogsIndex = text.indexOf("\nGateway logs:");
  return (gatewayLogsIndex >= 0 ? text.slice(0, gatewayLogsIndex) : text).trim();
}

function isGatewayRestartRace(error: unknown) {
  const text = formatGatewayPrimaryErrorText(error);
  return (
    text.includes("gateway closed (1012)") ||
    text.includes("gateway closed (1006") ||
    text.includes("abnormal closure") ||
    text.includes("service restart")
  );
}

function isConfigHashConflict(error: unknown) {
  return formatGatewayPrimaryErrorText(error).includes("config changed since last load");
}

function getGatewayRetryAfterMs(error: unknown) {
  const text = formatGatewayPrimaryErrorText(error);
  const millisecondsMatch = /retryAfterMs["=: ]+(\d+)/i.exec(text);
  if (millisecondsMatch) {
    const parsed = Number(millisecondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const secondsMatch = /retry after (\d+)s/i.exec(text);
  if (secondsMatch) {
    const parsed = Number(secondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1_000;
    }
  }
  return null;
}

async function readConfigSnapshot(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const snapshot = (await env.gateway.call(
    "config.get",
    {},
    { timeoutMs: 60_000 },
  )) as QaConfigSnapshot;
  if (!snapshot.hash || !snapshot.config) {
    throw new Error("config.get returned no hash/config");
  }
  return {
    hash: snapshot.hash,
    config: snapshot.config,
  } satisfies { hash: string; config: Record<string, unknown> };
}

async function runConfigMutation(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">;
  action: "config.patch" | "config.apply";
  raw: string;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
}) {
  const restartDelayMs = params.restartDelayMs ?? 1_000;
  let lastConflict: unknown = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const snapshot = await readConfigSnapshot(params.env);
    try {
      const result = await params.env.gateway.call(
        params.action,
        {
          raw: params.raw,
          baseHash: snapshot.hash,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
          ...(params.note ? { note: params.note } : {}),
          restartDelayMs,
        },
        { timeoutMs: 45_000 },
      );
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return result;
    } catch (error) {
      if (isConfigHashConflict(error)) {
        lastConflict = error;
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      const retryAfterMs = getGatewayRetryAfterMs(error);
      if (retryAfterMs && attempt < 8) {
        await sleep(retryAfterMs + 500);
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      if (!isGatewayRestartRace(error)) {
        throw error;
      }
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return { ok: true, restarted: true };
    }
  }
  throw lastConflict ?? new Error(`${params.action} failed after retrying config hash conflicts`);
}

async function patchConfig(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">;
  patch: Record<string, unknown>;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.patch",
    raw: JSON.stringify(params.patch, null, 2),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

async function applyConfig(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">;
  nextConfig: Record<string, unknown>;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.apply",
    raw: JSON.stringify(params.nextConfig, null, 2),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

export {
  applyConfig,
  fetchJson,
  formatGatewayPrimaryErrorText,
  getGatewayRetryAfterMs,
  isConfigHashConflict,
  isGatewayRestartRace,
  patchConfig,
  readConfigSnapshot,
  runConfigMutation,
  waitForConfigRestartSettle,
  waitForGatewayHealthy,
  waitForQaChannelReady,
  waitForTransportReady,
};
