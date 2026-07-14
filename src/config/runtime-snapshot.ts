// Produces redacted runtime config snapshots for diagnostics and UI surfaces.
import { sha256Base64Url } from "../infra/crypto-digest.js";
import {
  resetPublishedConfigRuntimeEnv,
  type PreparedConfigRuntimeEnv,
} from "./config-env-vars.js";
import type { OpenClawConfig } from "./types.js";

export type RuntimeConfigSnapshotRefreshOptions = {
  includeAuthStoreRefs?: boolean;
};

export type RuntimeConfigSnapshotRefreshParams = RuntimeConfigSnapshotRefreshOptions & {
  sourceConfig: OpenClawConfig;
  preflightResult?: unknown;
};
type MaybePromise<T> = T | Promise<T>;

export type ConfigWriteAfterWrite =
  | { mode: "auto" }
  | { mode: "restart"; reason: string }
  | { mode: "none"; reason: string };

export type ConfigWriteFollowUp =
  | {
      mode: "auto";
      requiresRestart: false;
    }
  | {
      mode: "none";
      reason: string;
      requiresRestart: false;
    }
  | {
      mode: "restart";
      reason: string;
      requiresRestart: true;
    };

export function resolveConfigWriteAfterWrite(
  afterWrite?: ConfigWriteAfterWrite,
): ConfigWriteAfterWrite {
  return afterWrite ?? { mode: "auto" };
}

export function resolveConfigWriteFollowUp(
  afterWrite?: ConfigWriteAfterWrite,
): ConfigWriteFollowUp {
  const resolved = resolveConfigWriteAfterWrite(afterWrite);
  if (resolved.mode === "restart") {
    return {
      mode: "restart",
      reason: resolved.reason,
      requiresRestart: true,
    };
  }
  if (resolved.mode === "none") {
    return {
      mode: "none",
      reason: resolved.reason,
      requiresRestart: false,
    };
  }
  return {
    mode: "auto",
    requiresRestart: false,
  };
}

export type RuntimeConfigSnapshotRefreshHandler = {
  preflight?: (params: RuntimeConfigSnapshotRefreshParams) => MaybePromise<unknown>;
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

export type RuntimeConfigWriteNotification = {
  configPath: string;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  writtenAtMs: number;
  afterWrite?: ConfigWriteAfterWrite;
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  preparedCandidate?: RuntimeConfigWritePreparedCandidate;
  preparedCandidatesByOwner?: ReadonlyMap<symbol, RuntimeConfigWritePreparedCandidate>;
};

export type RuntimeConfigWritePreparedCandidate = {
  runtimeConfig: OpenClawConfig;
  compareConfig: OpenClawConfig;
  runtimeEnv?: PreparedConfigRuntimeEnv;
  reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
};

export type RuntimeConfigSnapshotMetadata = {
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  updatedAtMs: number;
};

let runtimeConfigSnapshot: OpenClawConfig | null = null;
let runtimeConfigSourceSnapshot: OpenClawConfig | null = null;
let runtimeConfigSnapshotMetadata: RuntimeConfigSnapshotMetadata | null = null;
let runtimeConfigSnapshotRevision = 0;
let runtimeConfigSnapshotRefreshHandler: RuntimeConfigSnapshotRefreshHandler | null = null;
type ManagedRuntimeConfigWritePreflight = (
  sourceConfig: OpenClawConfig,
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
) => MaybePromise<RuntimeConfigWritePreparedCandidate>;
const managedRuntimeConfigWriteOwners = new Map<
  string,
  Set<{ id: symbol; preflight?: ManagedRuntimeConfigWritePreflight }>
>();
const runtimeConfigWriteListeners = new Set<(event: RuntimeConfigWriteNotification) => void>();

function stableConfigStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableConfigStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableConfigStringify(record[key])}`)
    .join(",")}}`;
}

function configSnapshotsMatch(left: OpenClawConfig, right: OpenClawConfig): boolean {
  if (left === right) {
    return true;
  }
  try {
    return stableConfigStringify(left) === stableConfigStringify(right);
  } catch {
    return false;
  }
}

export function hashRuntimeConfigValue(value: OpenClawConfig): string {
  return sha256Base64Url(stableConfigStringify(value));
}

function createRuntimeConfigSnapshotMetadata(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): RuntimeConfigSnapshotMetadata {
  runtimeConfigSnapshotRevision += 1;
  return {
    revision: runtimeConfigSnapshotRevision,
    fingerprint: hashRuntimeConfigValue(config),
    sourceFingerprint: sourceConfig ? hashRuntimeConfigValue(sourceConfig) : null,
    updatedAtMs: Date.now(),
  };
}

export function setRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): void {
  runtimeConfigSnapshot = config;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
  runtimeConfigSnapshotMetadata = createRuntimeConfigSnapshotMetadata(config, sourceConfig);
}

/** Publish a newer canonical source without changing the active runtime object. */
export function setRuntimeConfigSourceSnapshotIfCurrent(params: {
  expectedRevision: number;
  sourceConfig: OpenClawConfig;
}): boolean {
  if (
    !runtimeConfigSnapshot ||
    !runtimeConfigSnapshotMetadata ||
    runtimeConfigSnapshotMetadata.revision !== params.expectedRevision
  ) {
    return false;
  }
  setRuntimeConfigSnapshot(runtimeConfigSnapshot, params.sourceConfig);
  return true;
}

export function resetConfigRuntimeState(): void {
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
  runtimeConfigSnapshotMetadata = null;
  runtimeConfigSnapshotRevision = 0;
  resetPublishedConfigRuntimeEnv();
}

export function clearRuntimeConfigSnapshot(): void {
  resetConfigRuntimeState();
}

export function getRuntimeConfigSnapshot(): OpenClawConfig | null {
  return runtimeConfigSnapshot;
}

export function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null {
  return runtimeConfigSourceSnapshot;
}

export function getRuntimeConfigSnapshotMetadata(): RuntimeConfigSnapshotMetadata | null {
  return runtimeConfigSnapshotMetadata;
}

export function resolveRuntimeConfigCacheKey(config: OpenClawConfig): string {
  const metadata = runtimeConfigSnapshotMetadata;
  if (metadata && config === runtimeConfigSnapshot) {
    return `runtime:${metadata.revision}:${metadata.fingerprint}`;
  }
  return `config:${hashRuntimeConfigValue(config)}`;
}

export function createRuntimeConfigWriteNotification(params: {
  configPath: string;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  writtenAtMs?: number;
  afterWrite?: ConfigWriteAfterWrite;
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  preparedCandidate?: RuntimeConfigWritePreparedCandidate;
  preparedCandidatesByOwner?: ReadonlyMap<symbol, RuntimeConfigWritePreparedCandidate>;
}): RuntimeConfigWriteNotification {
  const metadata =
    params.runtimeConfig === runtimeConfigSnapshot && runtimeConfigSnapshotMetadata
      ? runtimeConfigSnapshotMetadata
      : {
          revision: runtimeConfigSnapshotRevision,
          fingerprint: hashRuntimeConfigValue(params.runtimeConfig),
          sourceFingerprint: hashRuntimeConfigValue(params.sourceConfig),
          updatedAtMs: Date.now(),
        };
  return {
    configPath: params.configPath,
    sourceConfig: params.sourceConfig,
    runtimeConfig: params.runtimeConfig,
    persistedHash: params.persistedHash,
    revision: metadata.revision,
    fingerprint: metadata.fingerprint,
    sourceFingerprint: metadata.sourceFingerprint,
    writtenAtMs: params.writtenAtMs ?? Date.now(),
    afterWrite: params.afterWrite,
    ...(params.runtimeRefresh ? { runtimeRefresh: params.runtimeRefresh } : {}),
    ...(params.preparedCandidate ? { preparedCandidate: params.preparedCandidate } : {}),
    ...(params.preparedCandidatesByOwner
      ? { preparedCandidatesByOwner: params.preparedCandidatesByOwner }
      : {}),
  };
}

export function selectApplicableRuntimeConfig(params: {
  inputConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig | null;
  runtimeSourceConfig?: OpenClawConfig | null;
}): OpenClawConfig | undefined {
  const runtimeConfig = params.runtimeConfig ?? null;
  if (!runtimeConfig) {
    return params.inputConfig;
  }
  const inputConfig = params.inputConfig;
  if (!inputConfig) {
    return runtimeConfig;
  }
  if (inputConfig === runtimeConfig) {
    return inputConfig;
  }
  const runtimeSourceConfig = params.runtimeSourceConfig ?? null;
  if (!runtimeSourceConfig) {
    return runtimeConfig;
  }
  if (configSnapshotsMatch(inputConfig, runtimeSourceConfig)) {
    return runtimeConfig;
  }
  return inputConfig;
}

export function setRuntimeConfigSnapshotRefreshHandler(
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null,
): void {
  runtimeConfigSnapshotRefreshHandler = refreshHandler;
}

export function getRuntimeConfigSnapshotRefreshHandler(): RuntimeConfigSnapshotRefreshHandler | null {
  return runtimeConfigSnapshotRefreshHandler;
}

export function registerRuntimeConfigWriteListener(
  listener: (event: RuntimeConfigWriteNotification) => void,
): () => void {
  runtimeConfigWriteListeners.add(listener);
  return () => {
    runtimeConfigWriteListeners.delete(listener);
  };
}

export function registerManagedRuntimeConfigWriteOwner(
  configPath: string,
  preflight?: ManagedRuntimeConfigWritePreflight,
): (() => void) & { ownerId: symbol } {
  const owner = preflight
    ? { id: Symbol("managed-runtime-config-write-owner"), preflight }
    : { id: Symbol("managed-runtime-config-write-owner") };
  const owners = managedRuntimeConfigWriteOwners.get(configPath) ?? new Set();
  owners.add(owner);
  managedRuntimeConfigWriteOwners.set(configPath, owners);
  let released = false;
  const unregister = () => {
    if (released) {
      return;
    }
    released = true;
    const currentOwners = managedRuntimeConfigWriteOwners.get(configPath);
    currentOwners?.delete(owner);
    if (!currentOwners || currentOwners.size === 0) {
      managedRuntimeConfigWriteOwners.delete(configPath);
    }
  };
  return Object.assign(unregister, { ownerId: owner.id });
}

export async function preflightManagedRuntimeConfigWrite(
  configPath: string,
  sourceConfig: OpenClawConfig,
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
): Promise<Map<symbol, RuntimeConfigWritePreparedCandidate>> {
  const owners = managedRuntimeConfigWriteOwners.get(configPath);
  if (!owners) {
    return new Map();
  }
  const preparedCandidates = new Map<symbol, RuntimeConfigWritePreparedCandidate>();
  for (const owner of owners) {
    if (owner.preflight) {
      preparedCandidates.set(owner.id, await owner.preflight(sourceConfig, refreshOptions));
    }
  }
  return preparedCandidates;
}

export function hasManagedRuntimeConfigWriteOwner(configPath: string): boolean {
  return managedRuntimeConfigWriteOwners.has(configPath);
}

export function notifyRuntimeConfigWriteListeners(event: RuntimeConfigWriteNotification): void {
  for (const listener of runtimeConfigWriteListeners) {
    try {
      listener(event);
    } catch {
      // Best-effort observer path only; successful writes must still complete.
    }
  }
}

export function loadPinnedRuntimeConfig(loadFresh: () => OpenClawConfig): OpenClawConfig {
  if (runtimeConfigSnapshot) {
    return runtimeConfigSnapshot;
  }
  const config = loadFresh();
  setRuntimeConfigSnapshot(config);
  return getRuntimeConfigSnapshot() ?? config;
}

export async function preflightRuntimeSnapshotWrite(params: {
  nextSourceConfig: OpenClawConfig;
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions;
  createRefreshError: (detail: string, cause: unknown) => Error;
  formatRefreshError: (error: unknown) => string;
}): Promise<unknown> {
  const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
  if (!refreshHandler?.preflight) {
    return undefined;
  }
  try {
    return await refreshHandler.preflight({
      sourceConfig: params.nextSourceConfig,
      ...params.refreshOptions,
    });
  } catch (error) {
    throw params.createRefreshError(params.formatRefreshError(error), error);
  }
}

export async function finalizeRuntimeSnapshotWrite(params: {
  nextSourceConfig: OpenClawConfig;
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions;
  hadRuntimeSnapshot: boolean;
  hadBothSnapshots: boolean;
  loadFreshConfig: () => OpenClawConfig;
  notifyCommittedWrite: () => void;
  createRefreshError: (detail: string, cause: unknown) => Error;
  formatRefreshError: (error: unknown) => string;
  preflightResult?: unknown;
  deferRuntimeActivation?: boolean;
}): Promise<void> {
  if (params.deferRuntimeActivation) {
    params.notifyCommittedWrite();
    return;
  }
  const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
  if (refreshHandler) {
    try {
      const refreshed = await refreshHandler.refresh({
        sourceConfig: params.nextSourceConfig,
        ...params.refreshOptions,
        preflightResult: params.preflightResult,
      });
      if (refreshed) {
        params.notifyCommittedWrite();
        return;
      }
    } catch (error) {
      try {
        refreshHandler.clearOnRefreshFailure?.();
      } catch {
        // Keep the original refresh failure as the surfaced error.
      }
      throw params.createRefreshError(params.formatRefreshError(error), error);
    }
  }

  if (params.hadBothSnapshots) {
    const fresh = params.loadFreshConfig();
    setRuntimeConfigSnapshot(fresh, params.nextSourceConfig);
    params.notifyCommittedWrite();
    return;
  }

  if (params.hadRuntimeSnapshot) {
    const fresh = params.loadFreshConfig();
    setRuntimeConfigSnapshot(fresh);
    params.notifyCommittedWrite();
    return;
  }

  setRuntimeConfigSnapshot(params.loadFreshConfig());
  params.notifyCommittedWrite();
}
