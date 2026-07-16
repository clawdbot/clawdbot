// Qa Lab plugin module implements suite runtime gateway behavior.
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteInfraError, toQaErrorObject } from "./errors.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaConfigSnapshot, QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";

type QaGatewayMutationEnv = Pick<
  QaSuiteRuntimeEnv,
  "gateway" | "transport" | "providerMode" | "primaryModel" | "alternateModel"
>;

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
    return await readProviderJsonResponse<T>(response, "qa-lab-suite-fetch-json");
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
  throw new QaSuiteInfraError("gateway_ready_timeout", `timed out after ${timeoutMs}ms`);
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
  settleBufferMs = 750,
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const readyAfterMs = restartDelayMs + settleBufferMs;
  let lastHealthError: unknown = null;

  // A delay beyond this mutation's observation window intentionally keeps the
  // current process alive so scenarios can prove config reads without restart.
  if (restartDelayMs >= timeoutMs) {
    await waitForGatewayHealthy(env, timeoutMs);
    await waitForTransportReady(env, timeoutMs);
    return;
  }

  while (Date.now() < deadline) {
    try {
      await waitForGatewayHealthy(env, Math.max(1, Math.min(1_000, deadline - Date.now())));
      if (Date.now() - startedAt >= readyAfterMs) {
        const remainingMs = Math.max(1, deadline - Date.now());
        await waitForTransportReady(env, remainingMs);
        return;
      }
    } catch (error) {
      lastHealthError = error;
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }

  throw new QaSuiteInfraError(
    "transport_ready_timeout",
    `timed out after ${timeoutMs}ms waiting for config restart readiness${
      lastHealthError ? `: ${formatErrorMessage(lastHealthError)}` : ""
    }`,
  );
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

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => areJsonValuesEqual(entry, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();
    if (!areJsonValuesEqual(leftKeys, rightKeys)) {
      return false;
    }
    return leftKeys.every((key) => areJsonValuesEqual(left[key], right[key]));
  }
  return false;
}

function withoutQaConfigApplyVolatileFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const comparable = structuredClone(config);
  // config.apply updates root metadata on write. Retries should not turn a
  // completed apply into a metadata-only write/restart loop.
  delete comparable.meta;
  return comparable;
}

function isConfigApplyNoopForSnapshot(config: Record<string, unknown>, raw: string): boolean {
  let nextConfig: unknown;
  try {
    nextConfig = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isPlainObject(nextConfig)) {
    return false;
  }
  return areJsonValuesEqual(
    withoutQaConfigApplyVolatileFields(config),
    withoutQaConfigApplyVolatileFields(nextConfig),
  );
}

function isConfigPatchNoopForSnapshot(config: Record<string, unknown>, raw: string): boolean {
  let patch: unknown;
  try {
    patch = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isPlainObject(patch)) {
    return false;
  }
  return areJsonValuesEqual(applyQaMergePatch(config, patch), config);
}

function isConfigMutationNoopForSnapshot(
  action: "config.patch" | "config.apply",
  config: Record<string, unknown>,
  raw: string,
) {
  return action === "config.patch"
    ? isConfigPatchNoopForSnapshot(config, raw)
    : isConfigApplyNoopForSnapshot(config, raw);
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
  env: QaGatewayMutationEnv;
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
  restartSettleBufferMs?: number;
  replacePaths?: readonly string[];
}) {
  const restartDelayMs = params.restartDelayMs ?? 1_000;
  const timeoutMs = liveTurnTimeoutMs(params.env, 180_000);
  let lastConflict: unknown = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const snapshot = await readConfigSnapshot(params.env);
    if (isConfigMutationNoopForSnapshot(params.action, snapshot.config, params.raw)) {
      // QA scenarios do best-effort cleanup in finally blocks. Skipping
      // client-known no-op patches keeps that cleanup from burning the
      // control-plane write budget and making later capability checks flaky.
      return { ok: true, noop: true };
    }
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
          ...(params.replacePaths?.length ? { replacePaths: params.replacePaths } : {}),
        },
        { timeoutMs },
      );
      await waitForConfigRestartSettle(
        params.env,
        restartDelayMs,
        timeoutMs,
        params.restartSettleBufferMs,
      );
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
        await sleep(resolveQaGatewayTimeoutWithGraceMs(retryAfterMs, 500));
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      if (!isGatewayRestartRace(error)) {
        throw error;
      }
      await waitForConfigRestartSettle(
        params.env,
        restartDelayMs,
        timeoutMs,
        params.restartSettleBufferMs,
      );
      const postRestartSnapshot = await readConfigSnapshot(params.env);
      if (isConfigMutationNoopForSnapshot(params.action, postRestartSnapshot.config, params.raw)) {
        return { ok: true, restarted: true };
      }
      lastConflict = new Error(
        `${params.action} restart race settled before the config mutation was visible`,
      );
      continue;
    }
  }
  throw toQaErrorObject(
    lastConflict ?? new Error(`${params.action} failed after retrying config hash conflicts`),
    "Non-Error thrown",
  );
}

async function patchConfig(params: {
  env: QaGatewayMutationEnv;
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
  restartSettleBufferMs?: number;
  replacePaths?: readonly string[];
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.patch",
    raw: JSON.stringify(params.patch, null, 2),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
    restartSettleBufferMs: params.restartSettleBufferMs,
    replacePaths: params.replacePaths,
  });
}

async function applyConfig(params: {
  env: QaGatewayMutationEnv;
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

async function restartGatewayWithConfigPatch(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway">;
  patch: Record<string, unknown>;
}) {
  const restart = params.env.gateway.restartAfterStateMutation;
  if (!restart) {
    throw new Error("qa gateway child cannot restart after state mutation");
  }
  await restart(async ({ configPath }) => {
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw || "{}") as Record<string, unknown>;
    const nextConfig = applyQaMergePatch(config, params.patch);
    await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  });
}

export {
  applyConfig,
  fetchJson,
  patchConfig,
  readConfigSnapshot,
  restartGatewayWithConfigPatch,
  waitForConfigRestartSettle,
  waitForGatewayHealthy,
  waitForQaChannelReady,
  waitForTransportReady,
};
