// Config write flow helpers commit control-plane config edits, detect auth
// changes, write restart sentinels, and schedule gateway restarts when required.
import { isDeepStrictEqual } from "node:util";
import {
  createConfigIO,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  resolveConfigSnapshotHash,
} from "../../config/config.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { getActiveSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { isRecord } from "../../utils.js";
import { resolveEffectiveSharedGatewayAuth, resolveGatewayAuth } from "../auth.js";
import { invalidateConfigGetResponseCache } from "../config-get-response.js";
import { buildGatewayReloadPlan, isNoopGatewayReloadPlan } from "../config-reload-plan.js";
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

// Active secrets snapshots own authored leaves, while runtime config can add fixed siblings.
// Project only matching authored values so stale snapshots cannot drive disconnect decisions.
function projectAuthoredValuesOntoRuntimeOverlay(params: {
  source: unknown;
  activeSource: unknown;
  active: unknown;
  fallback: unknown;
}): unknown {
  const { source, active } = params;
  if (active === undefined) {
    return structuredClone(params.fallback);
  }
  if (!isRecord(source) || !isRecord(active)) {
    return structuredClone(
      isDeepStrictEqual(source, params.activeSource) ? active : params.fallback,
    );
  }
  const fallback = isRecord(params.fallback) ? params.fallback : {};
  const activeSource = isRecord(params.activeSource) ? params.activeSource : {};
  const sourceKeys = new Set(Object.keys(source));
  return Object.fromEntries([
    ...Object.entries(fallback).filter(([key]) => !sourceKeys.has(key)),
    ...Object.keys(source).map((key) => [
      key,
      projectAuthoredValuesOntoRuntimeOverlay({
        source: source[key],
        activeSource: activeSource[key],
        active: active[key],
        fallback: fallback[key],
      }),
    ]),
  ]);
}

/** Compares against the active secrets-expanded config when one is available. */
export function didActiveSharedGatewayAuthChange(params: {
  fallbackPrev: OpenClawConfig;
  fallbackSource?: OpenClawConfig;
  next: OpenClawConfig;
}): boolean {
  const active = getActiveSecretsRuntimeSnapshotState();
  if (!active) {
    return didSharedGatewayAuthChange(params.fallbackPrev, params.next);
  }
  const currentSourceGateway = (params.fallbackSource ?? active.sourceConfig).gateway;
  const activeSourceGateway = active.sourceConfig.gateway;
  const activeGateway = active.config.gateway;
  const fallbackGateway = params.fallbackPrev.gateway;
  const selectOwnedGatewayValue = <Key extends "auth" | "tailscale" | "trustedProxies">(
    key: Key,
  ): NonNullable<OpenClawConfig["gateway"]>[Key] =>
    currentSourceGateway && Object.hasOwn(currentSourceGateway, key)
      ? (projectAuthoredValuesOntoRuntimeOverlay({
          source: currentSourceGateway[key],
          activeSource: activeSourceGateway?.[key],
          active: activeGateway?.[key],
          fallback: fallbackGateway?.[key],
        }) as NonNullable<OpenClawConfig["gateway"]>[Key])
      : fallbackGateway?.[key];
  const activeSharedAuthConfig: OpenClawConfig = {
    ...params.fallbackPrev,
    gateway: {
      ...fallbackGateway,
      // Secrets snapshots only own authored leaves; retain runtime-only auth siblings.
      auth: selectOwnedGatewayValue("auth"),
      tailscale: selectOwnedGatewayValue("tailscale"),
      trustedProxies: selectOwnedGatewayValue("trustedProxies"),
    },
  };
  return didSharedGatewayAuthChange(activeSharedAuthConfig, params.next);
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

function resolveConfigRestartRequirement(params: {
  changedPaths: string[];
  nextConfig: OpenClawConfig;
}): { requiresRestart: boolean; scheduleDirectRestart: boolean } {
  const reloadSettings = resolveGatewayReloadSettings(params.nextConfig);
  const plan = buildGatewayReloadPlan(params.changedPaths, { candidateConfig: params.nextConfig });
  if (isNoopGatewayReloadPlan(plan)) {
    return { requiresRestart: false, scheduleDirectRestart: false };
  }
  if (reloadSettings.mode === "off") {
    return { requiresRestart: true, scheduleDirectRestart: true };
  }
  if (plan.restartGateway) {
    return { requiresRestart: true, scheduleDirectRestart: false };
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
    // The early RPC hash check is only advisory until this lock-time CAS. Without
    // it, concurrent writers can both succeed and overwrite each other's config.
    baseHash: resolveConfigSnapshotHash(params.snapshot) ?? undefined,
    writeOptions: {
      ...params.writeOptions,
      auditOrigin: "config-rpc",
      runtimeRefresh: {
        ...params.writeOptions.runtimeRefresh,
        includeAuthStoreRefs: false,
      },
    },
    afterWrite: { mode: "auto" },
  });
  // Watcher acceptance is debounced; clear now so the writer's immediate
  // follow-up config.get observes the committed bytes before that hook runs.
  invalidateConfigGetResponseCache();
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
