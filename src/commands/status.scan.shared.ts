import { existsSync } from "node:fs";
import type { OpenClawConfig } from "../config/types.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { resolveGatewayProbeTarget } from "../gateway/probe-target.js";
import type { probeGateway as probeGatewayFn } from "../gateway/probe.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";

let gatewayProbeModulePromise: Promise<typeof import("./status.gateway-probe.js")> | undefined;
let probeGatewayModulePromise: Promise<typeof import("../gateway/probe.js")> | undefined;

function loadGatewayProbeModule() {
  gatewayProbeModulePromise ??= import("./status.gateway-probe.js");
  return gatewayProbeModulePromise;
}

function loadProbeGatewayModule() {
  probeGatewayModulePromise ??= import("../gateway/probe.js");
  return probeGatewayModulePromise;
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

export function hasExplicitMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
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
  const gatewayProbe = shouldProbe
    ? await loadProbeGatewayModule()
        .then(({ probeGateway }) =>
          probeGateway({
            url: gatewayConnection.url,
            auth: gatewayProbeAuthResolution.auth,
            timeoutMs: Math.min(params.opts.all ? 5000 : 2500, params.opts.timeoutMs ?? 10_000),
            detailLevel: params.opts.detailLevel ?? "presence",
          }),
        )
        .catch(() => null)
    : null;
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
  const gatewayReachable = gatewayProbe?.ok === true;
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
  getMemorySearchManager: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose: "status";
  }) => Promise<{
    manager: {
      probeVectorAvailability(): Promise<boolean>;
      status(): MemoryProviderStatus;
      close?(): Promise<void>;
    } | null;
  }>;
  requireDefaultStore?: (agentId: string) => string | null;
}): Promise<MemoryStatusSnapshot | null> {
  const { cfg, agentStatus, memoryPlugin } = params;
  if (!memoryPlugin.enabled || !memoryPlugin.slot) {
    return null;
  }
  const agentId = agentStatus.defaultId ?? "main";
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
  const { manager } = await params.getMemorySearchManager({ cfg, agentId, purpose: "status" });
  if (!manager) {
    return null;
  }
  try {
    await manager.probeVectorAvailability();
  } catch {}
  const status = manager.status();
  await manager.close?.().catch(() => {});
  return { agentId, ...status };
}
