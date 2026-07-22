// Shared status scan helpers for gateway probing, Tailscale URL formatting, and memory status.
// This file owns the cross-command contracts reused by normal, JSON, and status-all scans.

import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { resolveGatewayProbeTarget } from "../gateway/probe-target.js";
import type { GatewayProbeResult, probeGateway as probeGatewayFn } from "../gateway/probe.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  type MemoryProviderStatus,
} from "../memory-host-sdk/engine-storage.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
import { isProbeReachable } from "./gateway-status/helpers.js";

const gatewayProbeModuleLoader = createLazyImportLoader(() => import("./status.gateway-probe.js"));
const probeGatewayModuleLoader = createLazyImportLoader(() => import("../gateway/probe.js"));
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));
const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

function loadGatewayProbeModule() {
  return gatewayProbeModuleLoader.load();
}

function loadProbeGatewayModule() {
  return probeGatewayModuleLoader.load();
}

function loadGatewayCallModule() {
  return gatewayCallModuleLoader.load();
}

function hasBuiltInMemoryState(databasePath: string): boolean {
  if (!existsSync(databasePath)) {
    return false;
  }
  const { DatabaseSync } = requireNodeSqlite();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const builtInMemoryTableSets = [
      {
        meta: MEMORY_INDEX_META_TABLE,
        sources: MEMORY_INDEX_SOURCES_TABLE,
        chunks: MEMORY_INDEX_CHUNKS_TABLE,
      },
      {
        meta: "meta",
        sources: "files",
        chunks: "chunks",
      },
    ] as const;
    const builtInMemoryTables = builtInMemoryTableSets.flatMap(({ meta, sources, chunks }) => [
      meta,
      sources,
      chunks,
    ]);
    const tableNames = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${builtInMemoryTables.map(() => "?").join(", ")})`,
          )
          .all(...builtInMemoryTables) as Array<{ name?: unknown }>
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const tables of builtInMemoryTableSets) {
      if (
        tableNames.has(tables.meta) &&
        db
          .prepare(`SELECT 1 AS ok FROM ${tables.meta} WHERE key = ? LIMIT 1`)
          .get(MEMORY_INDEX_META_KEY)
      ) {
        return true;
      }
      for (const tableName of [tables.sources, tables.chunks]) {
        if (
          tableNames.has(tableName) &&
          db.prepare(`SELECT 1 AS ok FROM ${tableName} LIMIT 1`).get()
        ) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
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
  // Only retry local loopback probes; remote endpoints should not receive an extra status RPC.
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
  enabled?: boolean;
}): Promise<GatewayProbeResult | null> {
  if (params.enabled === false) {
    return params.gatewayProbe;
  }
  if (!shouldTryLocalStatusRpcFallback(params)) {
    return params.gatewayProbe;
  }
  const boundedFallbackTimeoutMs = Math.min(2000, Math.max(1000, params.timeoutMs));
  // The fallback uses the gateway status RPC because it can succeed after probe handshake ambiguity.
  const status = await loadGatewayCallModule()
    .then(({ callGateway }) =>
      callGateway({
        config: params.cfg,
        method: "status",
        token: params.gatewayProbeAuth.token,
        password: params.gatewayProbeAuth.password,
        timeoutMs: boundedFallbackTimeoutMs,
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
    ...(auth
      ? {
          auth:
            auth.capability === "unknown"
              ? {
                  ...auth,
                  capability: "read_only",
                }
              : auth,
        }
      : {}),
  };
}

function hasExplicitMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  if (cfg.memory && Object.hasOwn(cfg.memory, "search")) {
    return true;
  }
  return listAgentEntries(cfg).some(
    (agent) =>
      normalizeAgentId(agent.id) === normalizeAgentId(agentId) &&
      agent.memory != null &&
      Object.hasOwn(agent.memory, "search"),
  );
}

/** Resolves whether memory status should be shown and which slot owns it. */
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

/** Resolves gateway connection details, probe result, auth warnings, and call overrides. */
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
    localStatusRpcFallback?: boolean;
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
  const defaultProbeTimeoutMs = params.opts.all ? 5000 : 2500;
  const timeoutMsExplicit = params.opts.timeoutMs !== undefined;
  const probeTimeoutMs = params.opts.timeoutMs ?? defaultProbeTimeoutMs;
  const initialGatewayProbe = shouldProbe
    ? await loadProbeGatewayModule()
        .then(({ probeGateway }) =>
          probeGateway({
            url: gatewayConnection.url,
            auth: gatewayProbeAuthResolution.auth,
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
    enabled: params.opts.localStatusRpcFallback !== false,
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
          // Remote-url-missing reports use local fallback URL for follow-up diagnostic calls.
          gatewayCallOverrides: {
            url: gatewayConnection.url,
            token: gatewayProbeAuthResolution.auth.token,
            password: gatewayProbeAuthResolution.auth.password,
          },
        }
      : {}),
  };
}

/** Builds the published Tailscale HTTPS Control UI URL when exposure is enabled. */
export function buildTailscaleHttpsUrl(params: {
  tailscaleMode: string;
  tailscaleDns: string | null;
  serviceName?: string | null;
  controlUiBasePath?: string;
}): string | null {
  const host = resolveTailscalePublishedHost({
    tailscaleMode: params.tailscaleMode,
    tailnetHost: params.tailscaleDns,
    serviceName: params.serviceName,
  });
  return params.tailscaleMode !== "off" && host
    ? `https://${host}${normalizeControlUiBasePath(params.controlUiBasePath)}`
    : null;
}

/** Resolves memory provider status without creating default stores just for status output. */
export async function resolveSharedMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: { defaultId?: string | null };
  memoryPlugin: MemoryPluginStatus;
  resolveMemoryConfig: (
    cfg: OpenClawConfig,
    agentId: string,
  ) => { store: { databasePath: string } } | null;
  getMemorySearchManager: StatusMemorySearchManagerResolver;
  requireDefaultDatabasePath?: (agentId: string) => string | null;
}): Promise<MemoryStatusSnapshot | null> {
  const { cfg, agentStatus, memoryPlugin } = params;
  if (!memoryPlugin.enabled || !memoryPlugin.slot) {
    return null;
  }
  const agentId = agentStatus.defaultId ?? "main";

  if (memoryPlugin.slot !== defaultSlotIdForKey("memory")) {
    // Non-default memory slots are plugin-owned; ask the manager directly instead of checking built-in files.
    return await resolveMemoryManagerStatusSnapshot(params, agentId);
  }

  const hasExplicitConfig = hasExplicitMemorySearchConfig(cfg, agentId);
  const defaultDatabasePath = params.requireDefaultDatabasePath?.(agentId);
  if (defaultDatabasePath && !hasExplicitConfig && !hasBuiltInMemoryState(defaultDatabasePath)) {
    // Avoid instantiating built-in memory for users who never created the default store.
    return null;
  }
  const resolvedMemory = params.resolveMemoryConfig(cfg, agentId);
  if (!resolvedMemory) {
    return null;
  }
  const shouldInspectStore =
    hasExplicitConfig || hasBuiltInMemoryState(resolvedMemory.store.databasePath);
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
        // Built-in vector store has a store-level probe that avoids conflating index absence with plugin failure.
        await manager.probeVectorStoreAvailability();
      } else {
        await manager.probeVectorAvailability();
      }
    } catch {}
    const status = manager.status();
    return { agentId, ...status };
  } finally {
    // Status probes must not leak plugin resources such as SQLite handles.
    await manager.close?.().catch(() => {});
  }
}
