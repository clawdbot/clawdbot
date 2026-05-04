import { existsSync } from "node:fs";
import type { OpenClawConfig } from "../config/types.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { resolveGatewayProbeTarget } from "../gateway/probe-target.js";
import type { GatewayProbeResult, probeGateway as probeGatewayFn } from "../gateway/probe.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { isLoopbackIpAddress } from "../shared/net/ip.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
import { isProbeReachable } from "./gateway-status/helpers.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

const gatewayProbeModuleLoader = createLazyImportLoader(() => import("./status.gateway-probe.js"));
const probeGatewayModuleLoader = createLazyImportLoader(() => import("../gateway/probe.js"));
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));

function loadGatewayProbeModule() {
  return gatewayProbeModuleLoader.load();
}

function loadProbeGatewayModule() {
  return probeGatewayModuleLoader.load();
}

function loadGatewayCallModule() {
  return gatewayCallModuleLoader.load();
}

export type MemoryStatusSnapshot = MemoryProviderStatus & {
  agentId: string;
};

export type MemoryPluginStatus = {
  enabled: boolean;
  slot: string | null;
  reason?: string;
};

export type GatewayProbeSnapshot = {
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetailsWithResolvers>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: Awaited<ReturnType<typeof probeGatewayFn>> | null;
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  gatewayCallOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
};

type StatusMemorySearchManager = {
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  status(): MemoryProviderStatus;
  close?(): Promise<void>;
};

type StatusMemorySearchManagerResolver = (params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: "status";
}) => Promise<{
  manager: StatusMemorySearchManager | null;
}>;

function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

function shouldTryLocalStatusRpcFallback(params: {
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
}): params is {
  gatewayMode: "local";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult;
} {
  if (
    params.gatewayMode !== "local" ||
    !params.gatewayProbe ||
    params.gatewayProbe.ok ||
    !isLoopbackGatewayUrl(params.gatewayUrl)
  ) {
    return false;
  }
  const error = params.gatewayProbe.error?.toLowerCase() ?? "";
  return error.includes("timeout") || params.gatewayProbe.auth?.capability === "unknown";
}

async function applyLocalStatusRpcFallback(params: {
  cfg: OpenClawConfig;
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  timeoutMs: number;
  timeoutMsExplicit: boolean;
}): Promise<GatewayProbeResult | null> {
  if (!shouldTryLocalStatusRpcFallback(params)) {
    return params.gatewayProbe;
  }
  const boundedFallbackTimeoutMs = Math.min(2000, Math.max(1000, params.timeoutMs));
  const status = await loadGatewayCallModule()
    .then(({ callGateway }) =>
      callGateway({
        config: params.cfg,
        method: "status",
        token: params.gatewayProbeAuth.token,
        password: params.gatewayProbeAuth.password,
        timeoutMs: params.timeoutMsExplicit
          ? boundedFallbackTimeoutMs
          : Math.max(params.cfg.gateway?.handshakeTimeoutMs ?? 0, boundedFallbackTimeoutMs),
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      }),
    )
    .catch(() => null);
  if (!status) {
    return params.gatewayProbe;
  }
  const auth = params.gatewayProbe.auth;
  return {
    ...params.gatewayProbe,
    ok: true,
    status,
    auth:
      auth.capability === "unknown"
        ? {
            ...auth,
            capability: "read_only",
          }
        : auth,
  };
}

function hasExplicitMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  if (
    cfg.agents?.defaults &&
    Object.prototype.hasOwnProperty.call(cfg.agents.defaults, "memorySearch")
  ) {
    return true;
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  return agents.some(
    (agent) => agent?.id === agentId && Object.prototype.hasOwnProperty.call(agent, "memorySearch"),
  );
}

export function resolveMemoryPluginStatus(cfg: OpenClawConfig): MemoryPluginStatus {
  const pluginsEnabled = cfg.plugins?.enabled !== false;
  if (!pluginsEnabled) {
    return { enabled: false, slot: null, reason: "plugins disabled" };
  }
  const raw = normalizeOptionalString(cfg.plugins?.slots?.memory) ?? "";
  if (normalizeOptionalLowercaseString(raw) === "none") {
    return { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' };
  }
  return { enabled: true, slot: raw || defaultSlotIdForKey("memory") };
}

export async function resolveGatewayProbeSnapshot(params: {
  cfg: OpenClawConfig;
  opts: {
    timeoutMs?: number;
    all?: boolean;
    skipProbe?: boolean;
    detailLevel?: "none" | "presence" | "full";
    probeWhenRemoteUrlMissing?: boolean;
    resolveAuthWhenRemoteUrlMissing?: boolean;
    mergeAuthWarningIntoProbeError?: boolean;
  };
}): Promise<GatewayProbeSnapshot> {
  const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({ config: params.cfg });
  const { gatewayMode, remoteUrlMissing } = resolveGatewayProbeTarget(params.cfg);
  const shouldResolveAuth =
    params.opts.skipProbe !== true &&
    (!remoteUrlMissing || params.opts.resolveAuthWhenRemoteUrlMissing === true);
  const shouldProbe =
    params.opts.skipProbe !== true &&
    (!remoteUrlMissing || params.opts.probeWhenRemoteUrlMissing === true);
  const gatewayProbeAuthResolution = shouldResolveAuth
    ? await loadGatewayProbeModule().then(({ resolveGatewayProbeAuthResolution }) =>
        resolveGatewayProbeAuthResolution(params.cfg),
      )
    : { auth: {}, warning: undefined };
  let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
  const defaultProbeTimeoutMs = Math.max(
    params.opts.all ? 5000 : 2500,
    params.cfg.gateway?.handshakeTimeoutMs ?? 0,
  );
  const timeoutMsExplicit = params.opts.timeoutMs !== undefined;
  const probeTimeoutMs = params.opts.timeoutMs ?? defaultProbeTimeoutMs;
  const initialGatewayProbe = shouldProbe
    ? await loadProbeGatewayModule()
        .then(({ probeGateway }) =>
          probeGateway({
            url: gatewayConnection.url,
            auth: gatewayProbeAuthResolution.auth,
            preauthHandshakeTimeoutMs: params.cfg.gateway?.handshakeTimeoutMs,
            timeoutMs: probeTimeoutMs,
            detailLevel: params.opts.detailLevel ?? "presence",
          }),
        )
        .catch(() => null)
    : null;
  const gatewayProbe = await applyLocalStatusRpcFallback({
    cfg: params.cfg,
    gatewayMode,
    gatewayUrl: gatewayConnection.url,
    gatewayProbe: initialGatewayProbe,
    gatewayProbeAuth: gatewayProbeAuthResolution.auth,
    timeoutMs: probeTimeoutMs,
    timeoutMsExplicit,
  });
  if (
    (params.opts.mergeAuthWarningIntoProbeError ?? true) &&
    gatewayProbeAuthWarning &&
    gatewayProbe?.ok === false
  ) {
    gatewayProbe.error = gatewayProbe.error
      ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}`
      : gatewayProbeAuthWarning;
    gatewayProbeAuthWarning = undefined;
  }
  const gatewayReachable = gatewayProbe ? isProbeReachable(gatewayProbe) : false;
  const gatewaySelf = gatewayProbe?.presence
    ? pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  return {
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth: gatewayProbeAuthResolution.auth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    ...(remoteUrlMissing
      ? {
          gatewayCallOverrides: {
            url: gatewayConnection.url,
            token: gatewayProbeAuthResolution.auth.token,
            password: gatewayProbeAuthResolution.auth.password,
          },
        }
      : {}),
  };
}

export function buildTailscaleHttpsUrl(params: {
  tailscaleMode: string;
  tailscaleDns: string | null;
  controlUiBasePath?: string;
}): string | null {
  return params.tailscaleMode !== "off" && params.tailscaleDns
    ? `https://${params.tailscaleDns}${normalizeControlUiBasePath(params.controlUiBasePath)}`
    : null;
}

export async function resolveSharedMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: { defaultId?: string | null };
  memoryPlugin: MemoryPluginStatus;
  resolveMemoryConfig: (cfg: OpenClawConfig, agentId: string) => { store: { path: string } } | null;
  getMemorySearchManager: StatusMemorySearchManagerResolver;
  requireDefaultStore?: (agentId: string) => string | null;
}): Promise<MemoryStatusSnapshot | null> {
  const { cfg, agentStatus, memoryPlugin } = params;
  if (!memoryPlugin.enabled || !memoryPlugin.slot) {
    return null;
  }
  const agentId = agentStatus.defaultId ?? "main";

  if (memoryPlugin.slot !== defaultSlotIdForKey("memory")) {
    return await resolveMemoryManagerStatusSnapshot(params, agentId);
  }

  const defaultStorePath = params.requireDefaultStore?.(agentId);
  if (
    defaultStorePath &&
    !hasExplicitMemorySearchConfig(cfg, agentId) &&
    !existsSync(defaultStorePath)
  ) {
    return null;
  }
  const resolvedMemory = params.resolveMemoryConfig(cfg, agentId);
  if (!resolvedMemory) {
    return null;
  }
  const shouldInspectStore =
    hasExplicitMemorySearchConfig(cfg, agentId) || existsSync(resolvedMemory.store.path);
  if (!shouldInspectStore) {
    return null;
  }
  return await resolveMemoryManagerStatusSnapshot(params, agentId);
}

async function resolveMemoryManagerStatusSnapshot(
  params: {
    cfg: OpenClawConfig;
    getMemorySearchManager: StatusMemorySearchManagerResolver;
  },
  agentId: string,
): Promise<MemoryStatusSnapshot | null> {
  const { manager } = await params.getMemorySearchManager({
    cfg: params.cfg,
    agentId,
    purpose: "status",
  });
  if (!manager) {
    return null;
  }
  try {
    try {
      const currentStatus = manager.status();
      if (currentStatus.backend === "builtin" && manager.probeVectorStoreAvailability) {
        await manager.probeVectorStoreAvailability();
      } else {
        await manager.probeVectorAvailability();
      }
    } catch {}
    const status = manager.status();
    return { agentId, ...status };
  } finally {
    await manager.close?.().catch(() => {});
  }
}
