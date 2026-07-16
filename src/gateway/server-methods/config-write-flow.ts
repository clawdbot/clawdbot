// Config write flow helpers commit control-plane config edits, detect auth
// changes, write restart sentinels, and schedule gateway restarts when required.
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
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime-state.js";
import { resolveEffectiveSharedGatewayAuth, resolveGatewayAuth } from "../auth.js";
import { buildGatewayReloadPlan } from "../config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../config-reload-settings.js";
import { formatControlPlaneActor, type ControlPlaneActor } from "../control-plane-audit.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestContext } from "./types.js";

type ConfigWriteSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>["snapshot"];
type ConfigWriteOptions = Awaited<
  ReturnType<typeof readConfigFileSnapshotForWrite>
>["writeOptions"];

/** Resolves the on-disk config path used in config method responses. */
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

/** Compares the effective shared Gateway auth surface that active clients use. */
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

/** Compares against the active secrets-expanded config when one is available. */
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

function isNoopConfigReloadPlan(plan: ReturnType<typeof buildGatewayReloadPlan>): boolean {
  return (
    !plan.restartGateway &&
    plan.hotReasons.length === 0 &&
    !plan.reloadHooks &&
    !plan.restartGmailWatcher &&
    !plan.restartCron &&
    !plan.restartHeartbeat &&
    !plan.restartHealthMonitor &&
    !plan.reloadPlugins &&
    !plan.disposeMcpRuntimes &&
    plan.restartChannels.size === 0
  );
}

function resolveConfigRestartRequirement(params: {
  changedPaths: string[];
  nextConfig: OpenClawConfig;
}): { requiresRestart: boolean; scheduleDirectRestart: boolean } {
  const reloadSettings = resolveGatewayReloadSettings(params.nextConfig);
  const plan = buildGatewayReloadPlan(params.changedPaths);
  if (isNoopConfigReloadPlan(plan)) {
    return { requiresRestart: false, scheduleDirectRestart: false };
  }
  if (reloadSettings.mode === "off") {
    return { requiresRestart: true, scheduleDirectRestart: true };
  }
  if (reloadSettings.mode === "restart") {
    return { requiresRestart: true, scheduleDirectRestart: false };
  }
  if (plan.restartGateway) {
    return { requiresRestart: true, scheduleDirectRestart: reloadSettings.mode === "hot" };
  }
  return { requiresRestart: false, scheduleDirectRestart: false };
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
  requiresRestart: boolean;
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
      requiresRestart: params.requiresRestart,
    },
  };
}

async function tryWriteRestartSentinelPayload(payload: RestartSentinelPayload): Promise<boolean> {
  try {
    await writeRestartSentinel(payload);
    return true;
  } catch {
    return false;
  }
}

/** Persists a gateway config write and returns follow-up work that must run after response. */
export async function commitGatewayConfigWrite(params: {
  snapshot: ConfigWriteSnapshot;
  writeOptions: ConfigWriteOptions;
  nextConfig: OpenClawConfig;
  context?: GatewayRequestContext;
  disconnectSharedAuthClients?: boolean;
}): Promise<{
  path: string;
  config: OpenClawConfig;
  hash: string | null;
  queueFollowUp: () => void;
}> {
  const result = await replaceConfigFile({
    nextConfig: params.nextConfig,
    writeOptions: {
      ...params.writeOptions,
      runtimeRefresh: {
        ...params.writeOptions.runtimeRefresh,
        includeAuthStoreRefs: false,
      },
    },
    afterWrite: { mode: "auto" },
  });
  return {
    path: resolveGatewayConfigPath(params.snapshot),
    config: result.nextConfig,
    // Persisted hash of the re-read file (resolveConfigSnapshotHash), i.e.
    // exactly what a follow-up config.get reports — writers ack against it.
    hash: result.persistedHash,
    queueFollowUp: () => {
      // Defer generation refresh/disconnect until after the RPC response so
      // the writer receives the success payload before its connection is closed.
      queueSharedGatewayAuthGenerationRefresh(true, result.nextConfig, params.context);
      queueSharedGatewayAuthDisconnect(Boolean(params.disconnectSharedAuthClients), params.context);
    },
  };
}

/** Builds restart sentinel/queue state for config.patch and config.apply writes. */
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
  sentinelPersisted: boolean;
  restart: ReturnType<typeof scheduleGatewaySigusr1Restart> | undefined;
}> {
  const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
    resolveConfigRestartRequest(params.requestParams);
  const restartRequirement = resolveConfigRestartRequirement({
    changedPaths: params.changedPaths,
    nextConfig: params.nextConfig,
  });
  const payload = buildConfigRestartSentinelPayload({
    kind: params.kind,
    mode: params.mode,
    configPath: params.configPath,
    requiresRestart: restartRequirement.requiresRestart,
    sessionKey,
    deliveryContext,
    threadId,
    note,
  });
  const sentinelPersisted = await tryWriteRestartSentinelPayload(payload);
  const restart = restartRequirement.scheduleDirectRestart
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
  return { payload, sentinelPersisted, restart };
}
