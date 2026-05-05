import { isDeepStrictEqual } from "node:util";
import {
  createConfigIO,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../../config/config.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { resolveEffectiveSharedGatewayAuth, resolveGatewayAuth } from "../auth.js";
import { buildGatewayReloadPlan } from "../config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../config-reload-settings.js";
import { formatControlPlaneActor, type ControlPlaneActor } from "../control-plane-audit.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestContext } from "./types.js";

export type ConfigWriteSnapshot = Awaited<
  ReturnType<typeof readConfigFileSnapshotForWrite>
>["snapshot"];
export type ConfigWriteOptions = Awaited<
  ReturnType<typeof readConfigFileSnapshotForWrite>
>["writeOptions"];

export function resolveGatewayConfigPath(snapshot?: Pick<ConfigWriteSnapshot, "path">): string {
  return snapshot?.path ?? createConfigIO().configPath;
}

function normalizeStringListForAuthCompare(items: readonly string[] | undefined): string[] {
  return [...(items ?? [])].toSorted();
}

function normalizeTrustedProxyAuthForCompare(auth: ReturnType<typeof resolveGatewayAuth>): {
  userHeader: string | undefined;
  requiredHeaders: string[];
  allowUsers: string[];
  allowLoopback: boolean | undefined;
} {
  return {
    userHeader: auth.trustedProxy?.userHeader,
    requiredHeaders: normalizeStringListForAuthCompare(auth.trustedProxy?.requiredHeaders),
    allowUsers: normalizeStringListForAuthCompare(auth.trustedProxy?.allowUsers),
    allowLoopback: auth.trustedProxy?.allowLoopback,
  };
}

export function didSharedGatewayAuthChange(prev: OpenClawConfig, next: OpenClawConfig): boolean {
  const prevResolvedAuth = resolveGatewayAuth({
    authConfig: prev.gateway?.auth,
    env: process.env,
    tailscaleMode: prev.gateway?.tailscale?.mode,
  });
  const nextResolvedAuth = resolveGatewayAuth({
    authConfig: next.gateway?.auth,
    env: process.env,
    tailscaleMode: next.gateway?.tailscale?.mode,
  });
  if (prevResolvedAuth.mode === "trusted-proxy" || nextResolvedAuth.mode === "trusted-proxy") {
    if (prevResolvedAuth.mode !== nextResolvedAuth.mode) {
      return true;
    }
    return (
      !isDeepStrictEqual(
        normalizeTrustedProxyAuthForCompare(prevResolvedAuth),
        normalizeTrustedProxyAuthForCompare(nextResolvedAuth),
      ) ||
      !isDeepStrictEqual(
        normalizeStringListForAuthCompare(prev.gateway?.trustedProxies),
        normalizeStringListForAuthCompare(next.gateway?.trustedProxies),
      )
    );
  }

  const prevAuth = resolveEffectiveSharedGatewayAuth({
    authConfig: prev.gateway?.auth,
    env: process.env,
    tailscaleMode: prev.gateway?.tailscale?.mode,
  });
  const nextAuth = resolveEffectiveSharedGatewayAuth({
    authConfig: next.gateway?.auth,
    env: process.env,
    tailscaleMode: next.gateway?.tailscale?.mode,
  });
  if (prevAuth === null || nextAuth === null) {
    return prevAuth !== nextAuth;
  }
  return prevAuth.mode !== nextAuth.mode || !isDeepStrictEqual(prevAuth.secret, nextAuth.secret);
}

export function didActiveSharedGatewayAuthChange(params: {
  fallbackPrev: OpenClawConfig;
  next: OpenClawConfig;
}): boolean {
  return didSharedGatewayAuthChange(
    getActiveSecretsRuntimeSnapshot()?.config ?? params.fallbackPrev,
    params.next,
  );
}

function queueSharedGatewayAuthDisconnect(
  shouldDisconnect: boolean,
  context?: GatewayRequestContext,
): void {
  if (!shouldDisconnect) {
    return;
  }
  queueMicrotask(() => {
    context?.disconnectClientsUsingSharedGatewayAuth?.();
  });
}

function queueSharedGatewayAuthGenerationRefresh(
  shouldRefresh: boolean,
  nextConfig: OpenClawConfig,
  context?: GatewayRequestContext,
): void {
  if (!shouldRefresh) {
    return;
  }
  queueMicrotask(() => {
    context?.enforceSharedGatewayAuthGenerationForConfigWrite?.(nextConfig);
  });
}

function shouldScheduleDirectConfigRestart(params: {
  changedPaths: string[];
  nextConfig: OpenClawConfig;
}): boolean {
  const reloadSettings = resolveGatewayReloadSettings(params.nextConfig);
  if (reloadSettings.mode === "off") {
    return true;
  }
  const plan = buildGatewayReloadPlan(params.changedPaths);
  if (reloadSettings.mode === "hot" && plan.restartGateway) {
    return true;
  }
  return false;
}

function resolveConfigRestartRequest(params: unknown): {
  sessionKey: string | undefined;
  note: string | undefined;
  restartDelayMs: number | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
} {
  const {
    sessionKey,
    deliveryContext: requestedDeliveryContext,
    threadId: requestedThreadId,
    note,
    restartDelayMs,
  } = parseRestartRequestParams(params);

  // Extract deliveryContext + threadId for routing after restart.
  // Uses generic :thread: parsing plus plugin-owned session grammars.
  const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
    extractDeliveryInfo(sessionKey);

  return {
    sessionKey,
    note,
    restartDelayMs,
    deliveryContext: requestedDeliveryContext ?? sessionDeliveryContext,
    threadId: requestedThreadId ?? sessionThreadId,
  };
}

function buildConfigRestartSentinelPayload(params: {
  kind: RestartSentinelPayload["kind"];
  mode: string;
  configPath: string;
  sessionKey: string | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
  note: string | undefined;
}): RestartSentinelPayload {
  return {
    kind: params.kind,
    status: "ok",
    ts: Date.now(),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    threadId: params.threadId,
    message: params.note ?? null,
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: params.mode,
      root: params.configPath,
    },
  };
}

async function tryWriteRestartSentinelPayload(
  payload: RestartSentinelPayload,
): Promise<string | null> {
  try {
    return await writeRestartSentinel(payload);
  } catch {
    return null;
  }
}

export async function commitGatewayConfigWrite(params: {
  snapshot: ConfigWriteSnapshot;
  writeOptions: ConfigWriteOptions;
  nextConfig: OpenClawConfig;
  context?: GatewayRequestContext;
  disconnectSharedAuthClients?: boolean;
}): Promise<{ path: string; queueFollowUp: () => void }> {
  await replaceConfigFile({
    nextConfig: params.nextConfig,
    writeOptions: params.writeOptions,
    afterWrite: { mode: "auto" },
  });
  return {
    path: resolveGatewayConfigPath(params.snapshot),
    queueFollowUp: () => {
      queueSharedGatewayAuthGenerationRefresh(true, params.nextConfig, params.context);
      queueSharedGatewayAuthDisconnect(Boolean(params.disconnectSharedAuthClients), params.context);
    },
  };
}

export async function resolveGatewayConfigRestartWriteResult(params: {
  requestParams: unknown;
  kind: RestartSentinelPayload["kind"];
  mode: "config.patch" | "config.apply";
  configPath: string;
  changedPaths: string[];
  nextConfig: OpenClawConfig;
  actor: ControlPlaneActor;
  context?: GatewayRequestContext;
}): Promise<{
  payload: RestartSentinelPayload;
  sentinelPath: string | null;
  restart: ReturnType<typeof scheduleGatewaySigusr1Restart> | undefined;
}> {
  const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
    resolveConfigRestartRequest(params.requestParams);
  const payload = buildConfigRestartSentinelPayload({
    kind: params.kind,
    mode: params.mode,
    configPath: params.configPath,
    sessionKey,
    deliveryContext,
    threadId,
    note,
  });
  const sentinelPath = await tryWriteRestartSentinelPayload(payload);
  const restart = shouldScheduleDirectConfigRestart({
    changedPaths: params.changedPaths,
    nextConfig: params.nextConfig,
  })
    ? scheduleGatewaySigusr1Restart({
        delayMs: restartDelayMs,
        reason: params.mode,
        audit: {
          actor: params.actor.actor,
          deviceId: params.actor.deviceId,
          clientIp: params.actor.clientIp,
          changedPaths: params.changedPaths,
        },
      })
    : undefined;
  if (restart?.coalesced) {
    params.context?.logGateway?.warn(
      `${params.mode} restart coalesced ${formatControlPlaneActor(params.actor)} delayMs=${restart.delayMs}`,
    );
  }
  return { payload, sentinelPath, restart };
}
