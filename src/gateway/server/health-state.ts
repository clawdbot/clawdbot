// Gateway health state builds snapshots, caches health probes, and broadcasts health/presence version changes.
import type { Snapshot } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { buildRuntimeConfigHealth } from "../../commands/health-runtime-config.js";
import { createConfigIO, getRuntimeConfig } from "../../config/io.js";
import { STATE_DIR } from "../../config/paths.js";
import {
  getRuntimeConfigAppliedHash,
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshotMetadata,
} from "../../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable, getUpdateSchedule } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAgentSelectionState } from "../agent-list.js";
import { resolveGatewayAuth } from "../auth.js";
import {
  getConfigReloadObservation,
  type ConfigReloadObservation,
} from "../config-reload-observed.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import { projectUpdateAvailable } from "../events.js";
import { collectGatewayHealthSnapshot } from "../health/collector.js";
import type { HealthSummary } from "../health/types.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthCacheConfigKey: string | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

type RuntimeConfigHealthContext = {
  key: string;
  observation: ConfigReloadObservation;
  liveSourceConfig: ReturnType<typeof getRuntimeConfigSourceSnapshot>;
  hasLiveSnapshot: boolean;
};

type HealthAudience = "public" | "admin";
type HealthRefreshStrength = "passive" | "probe";
type HealthRefreshOperation = {
  generation: number;
  promise: Promise<HealthSummary>;
};
type HealthRefreshState = {
  nextGeneration: number;
  committedGeneration: number;
  inFlight: Record<HealthRefreshStrength, HealthRefreshOperation | null>;
};

const healthRefreshStates: Record<HealthAudience, HealthRefreshState> = {
  public: {
    nextGeneration: 0,
    committedGeneration: 0,
    inFlight: { passive: null, probe: null },
  },
  admin: {
    nextGeneration: 0,
    committedGeneration: 0,
    inFlight: { passive: null, probe: null },
  },
};

export function buildGatewaySnapshot(opts: {
  includeSensitive?: boolean;
  includeUpdateDetails?: boolean;
  revisionProjector: GatewayConfigRevisionProjector;
}): Snapshot {
  const cfg = getRuntimeConfig();
  const selection = resolveGatewayAgentSelectionState(cfg);
  const defaultAgentId = selection.defaultId;
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: defaultAgentId });
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const includeUpdateDetails = opts?.includeUpdateDetails === true;
  const updateAvailable =
    projectUpdateAvailable(getUpdateAvailable(), includeUpdateDetails) ?? undefined;
  const updateSchedule = includeUpdateDetails ? (getUpdateSchedule() ?? undefined) : undefined;
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  // Health is async; the caller replaces this with the collected snapshot.
  const emptyHealth: Snapshot["health"] = {};
  const snapshot: Snapshot = {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    appliedConfigHash: appliedConfigHash
      ? opts.revisionProjector.projectResolvedHash(appliedConfigHash)
      : null,
    sessionDefaults: {
      defaultAgentId,
      modelConfigured: Boolean(resolveAgentEffectiveModelPrimary(cfg, defaultAgentId)),
      ownership: selection.ownership,
      selectionRequired: selection.selectionRequired,
      mainKey,
      mainSessionKey,
      scope,
    },
    updateAvailable,
    updateSchedule,
  };
  if (opts?.includeSensitive === true) {
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
    // Surface resolved paths only to admin callers that already have broader gateway access.
    snapshot.configPath = createConfigIO().configPath;
    snapshot.stateDir = STATE_DIR;
    snapshot.authMode = auth.mode;
  }
  return snapshot;
}

export function getHealthCache(): HealthSummary | null {
  // Disk observations and live runtime publication invalidate the whole cache;
  // RPC callers refresh rather than mixing non-config health across revisions.
  if (healthCache && healthCacheConfigKey !== readRuntimeConfigHealthContext().key) {
    return null;
  }
  return healthCache;
}

function readRuntimeConfigHealthContext(): RuntimeConfigHealthContext {
  const observation = getConfigReloadObservation();
  const metadata = getRuntimeConfigSnapshotMetadata();
  return {
    key: `${observation.generation}:${metadata?.revision ?? -1}`,
    observation,
    liveSourceConfig: getRuntimeConfigSourceSnapshot(),
    hasLiveSnapshot: metadata !== null,
  };
}

export function getHealthVersion(): number {
  return healthVersion;
}

export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

export function getPresenceVersion(): number {
  return presenceVersion;
}

export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

function preparePublishedHealthSnapshot(
  snapshot: HealthSummary,
  context: RuntimeConfigHealthContext,
): {
  configKey: string;
  snapshot: HealthSummary;
} {
  // Snapshot-wide health is observable by read-scoped clients, hello, and
  // broadcasts, so it receives only source configs and emits redacted facts.
  const summary = projectRuntimeConfigHealth(context);
  delete snapshot.runtimeConfig;
  if (summary) {
    snapshot.runtimeConfig = summary;
  }
  return { configKey: context.key, snapshot };
}

function projectRuntimeConfigHealth(context: RuntimeConfigHealthContext) {
  return buildRuntimeConfigHealth({
    liveSourceConfig: context.liveSourceConfig,
    hasLiveSnapshot: context.hasLiveSnapshot,
    observedSourceConfig: context.observation.sourceConfig,
  });
}

export function readCurrentRuntimeConfigHealth(): HealthSummary["runtimeConfig"] {
  while (true) {
    const context = readRuntimeConfigHealthContext();
    const summary = projectRuntimeConfigHealth(context);
    // Hello cannot await channel collection, but it can project the exact current
    // in-memory config facts and let the normal passive refresh publish the full snapshot.
    if (context.key === readRuntimeConfigHealthContext().key) {
      return summary;
    }
  }
}

function publishPublicHealthSnapshot(snapshot: HealthSummary, configKey: string): HealthSummary {
  healthCache = snapshot;
  healthCacheConfigKey = configKey;
  healthVersion += 1;
  if (broadcastHealthUpdate) {
    broadcastHealthUpdate(snapshot);
  }
  return snapshot;
}

export async function refreshGatewayHealthSnapshot(opts?: {
  probe?: boolean;
  includeSensitive?: boolean;
  getRuntimeSnapshot?: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  getConfigReloaderHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
}) {
  const includeSensitive = opts?.includeSensitive === true;
  const audience: HealthAudience = includeSensitive ? "admin" : "public";
  const state = healthRefreshStates[audience];
  const strength: HealthRefreshStrength = opts?.probe === false ? "passive" : "probe";
  // Passive callers can reuse a stronger probe, but an explicit probe must not
  // inherit a passive refresh that deliberately skipped live channel checks.
  const existing =
    strength === "passive"
      ? (state.inFlight.probe ?? state.inFlight.passive)
      : state.inFlight.probe;
  if (existing) {
    return existing.promise;
  }

  const generation = state.nextGeneration + 1;
  state.nextGeneration = generation;
  const promise = (async () => {
    const collectPublishedSnapshot = async () => {
      while (true) {
        const contextBeforeCollection = readRuntimeConfigHealthContext();
        let runtimeSnapshot: ChannelRuntimeSnapshot | undefined;
        try {
          runtimeSnapshot = opts?.getRuntimeSnapshot?.();
        } catch {
          runtimeSnapshot = undefined;
        }
        const eventLoop = opts?.getEventLoopHealth?.();
        const configReloadHotReloadStatus = opts?.getConfigReloaderHotReloadStatus?.();
        const collected = await collectGatewayHealthSnapshot({
          audience,
          probe: strength === "probe",
          runtimeSnapshot,
          ...(eventLoop ? { eventLoop } : {}),
          ...(configReloadHotReloadStatus ? { configReloadHotReloadStatus } : {}),
        });
        const contextAfterCollection = readRuntimeConfigHealthContext();
        if (contextBeforeCollection.key !== contextAfterCollection.key) {
          continue;
        }
        const prepared = preparePublishedHealthSnapshot(collected, contextAfterCollection);
        if (
          prepared.configKey === contextBeforeCollection.key &&
          contextBeforeCollection.key === readRuntimeConfigHealthContext().key
        ) {
          return prepared;
        }
      }
    };
    const prepared = await collectPublishedSnapshot();
    const { configKey, snapshot: snap } = prepared;
    if (
      strength === "probe" &&
      state.inFlight.passive &&
      state.inFlight.passive.generation < generation
    ) {
      // Existing passive waiters may finish, but new callers must not join
      // weaker work after this newer live probe has succeeded.
      state.inFlight.passive = null;
    }
    // Concurrent passive/probe refreshes can finish out of order. Only a
    // generation newer than the published cache may advance version/broadcast.
    if (!includeSensitive && generation > state.committedGeneration) {
      state.committedGeneration = generation;
      publishPublicHealthSnapshot(snap, configKey);
    }
    return snap;
  })().finally(() => {
    if (state.inFlight[strength]?.generation === generation) {
      state.inFlight[strength] = null;
    }
  });
  state.inFlight[strength] = { generation, promise };
  return promise;
}
