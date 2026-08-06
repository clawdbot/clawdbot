/** Lifecycle-owned model catalog access. */
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import type { ResolvedPublishedModelCatalogOwner } from "./prepared-model-catalog.types.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.facts.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError,
  preparedModelRuntimeConfigsMatch,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { prepareScopedReadOnlyModelCatalog } from "./prepared-model-runtime.scoped-catalog.js";

export type LoadPreparedModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  readOnly?: boolean;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerDiscoveryProviderIds?: readonly string[];
  allowGatewaySubagentBinding?: boolean;
};

export type GetPublishedPreparedModelCatalogOwnerParams = Omit<
  LoadPreparedModelCatalogParams,
  "readOnly"
>;

type PreparedModelCatalogConfigPolicy = "exact" | "published";

async function materializeRequestedModelCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  readOnly: boolean | undefined,
): Promise<PreparedModelRuntimeSnapshot> {
  if (readOnly === true || !snapshot.loadFullModelCatalog) {
    return snapshot;
  }
  const modelCatalog = await snapshot.loadFullModelCatalog();
  return modelCatalog === snapshot.modelCatalog
    ? snapshot
    : Object.freeze({ ...snapshot, modelCatalog });
}

function acceptsPreparedSnapshotConfig(
  snapshot: PreparedModelRuntimeSnapshot,
  input: PreparedModelRuntimeInput,
  policy: PreparedModelCatalogConfigPolicy,
): boolean {
  return policy === "published" || preparedModelRuntimeConfigsMatch(snapshot.config, input.config);
}

function resolveInputs(params: LoadPreparedModelCatalogParams = {}): {
  exact: PreparedModelRuntimeInput;
  full: PreparedModelRuntimeInput;
  activationExact: PreparedModelRuntimeInput;
  activationFull: PreparedModelRuntimeInput;
} {
  const config = params.config ?? getRuntimeConfig();
  const explicitOrDefaultAgentId =
    params.agentId ?? (params.agentDir === undefined ? resolveDefaultAgentId(config) : undefined);
  const agentDir =
    params.agentDir ??
    (explicitOrDefaultAgentId
      ? resolveAgentDir(config, explicitOrDefaultAgentId)
      : resolveDefaultAgentDir(config, params.env));
  const matchingAgentIds =
    params.agentDir === undefined
      ? []
      : listAgentIds(config).filter(
          (candidateAgentId) => resolveAgentDir(config, candidateAgentId) === agentDir,
        );
  const agentId =
    explicitOrDefaultAgentId ??
    (params.agentDir === undefined
      ? resolveDefaultAgentId(config)
      : matchingAgentIds.length === 1
        ? matchingAgentIds[0]
        : undefined);
  const explicitWorkspaceDir = params.workspaceDir === undefined ? undefined : params.workspaceDir;
  const activationWorkspaceDir =
    explicitWorkspaceDir ?? (agentId ? resolveAgentWorkspaceDir(config, agentId) : undefined);
  const full: PreparedModelRuntimeInput = {
    ...(agentId ? { agentId } : {}),
    agentDir,
    config,
    ...(params.env ? { env: params.env } : {}),
    inheritedAuthDir: resolveDefaultAgentDir(config, params.env),
    ...(explicitWorkspaceDir ? { workspaceDir: explicitWorkspaceDir } : {}),
    ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
  const exact = params.readOnly ? { ...full, readOnly: true } : full;
  const activationFull = activationWorkspaceDir
    ? { ...full, workspaceDir: activationWorkspaceDir }
    : full;
  return {
    exact,
    full,
    activationFull,
    activationExact: params.readOnly ? { ...activationFull, readOnly: true } : activationFull,
  };
}

/** Returns the configured lifecycle owner for the current generation without starting discovery. */
export function getPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): PreparedModelRuntimeSnapshot | undefined {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  const publishedFull = getPreparedModelRuntimeSnapshot(full);
  if (publishedFull && preparedModelRuntimeConfigsMatch(publishedFull.config, full.config)) {
    return publishedFull;
  }
  if (activationFull && activationFull.workspaceDir !== full.workspaceDir) {
    const activatedFull = getPreparedModelRuntimeSnapshot(activationFull);
    if (activatedFull && preparedModelRuntimeConfigsMatch(activatedFull.config, full.config)) {
      return activatedFull;
    }
  }
  if (exact === full) {
    return undefined;
  }
  const publishedExact = getPreparedModelRuntimeSnapshot(exact);
  if (publishedExact && preparedModelRuntimeConfigsMatch(publishedExact.config, exact.config)) {
    return publishedExact;
  }
  if (!activationExact || activationExact.workspaceDir === exact.workspaceDir) {
    return undefined;
  }
  const activatedExact = getPreparedModelRuntimeSnapshot(activationExact);
  return activatedExact && preparedModelRuntimeConfigsMatch(activatedExact.config, exact.config)
    ? activatedExact
    : undefined;
}

/**
 * Returns the currently published lifecycle owner and its configured/static turn facts without
 * config hashing, fallback construction, or full control-plane catalog materialization.
 */
export function getPublishedPreparedModelCatalogOwnerSnapshot(
  params: GetPublishedPreparedModelCatalogOwnerParams = {},
): PreparedModelRuntimeSnapshot | undefined {
  const { activationFull, full } = resolveInputs(params);
  const published = getPreparedModelRuntimeSnapshot(full);
  if (published) {
    return published;
  }
  if (activationFull.workspaceDir === full.workspaceDir) {
    return undefined;
  }
  return getPreparedModelRuntimeSnapshot(activationFull);
}

/** Returns the configured catalog for the current generation without starting discovery. */
export function getPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): ModelCatalogSnapshot | undefined {
  return getPreparedModelCatalogOwnerSnapshot(params)?.modelCatalog;
}

async function resolvePreparedModelCatalogOwnerSnapshotWithPolicy(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
): Promise<PreparedModelRuntimeSnapshot> {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  if (params.readOnly) {
    const fullCandidates =
      activationFull.workspaceDir === full.workspaceDir ? [full] : [full, activationFull];
    for (const candidate of fullCandidates) {
      try {
        // Full lifecycle owners include provider augmentation omitted by read-only fallback builds.
        const prepared = await prepareModelRuntimeSnapshot(candidate);
        if (!acceptsPreparedSnapshotConfig(prepared, candidate, configPolicy)) {
          throw new PreparedModelCatalogConfigReplacedError(candidate.agentDir);
        }
        return prepared;
      } catch (error) {
        if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
          throw error;
        }
      }
    }
    const lease = await acquireReadOnlyPreparedModelRuntime(activationExact);
    try {
      if (!acceptsPreparedSnapshotConfig(lease.snapshot, activationExact, configPolicy)) {
        throw new PreparedModelCatalogConfigReplacedError(activationExact.agentDir);
      }
      return lease.snapshot;
    } finally {
      lease.release();
    }
  }
  if (exact !== full) {
    const fullCandidates =
      activationFull.workspaceDir === full.workspaceDir ? [full] : [full, activationFull];
    for (const candidate of fullCandidates) {
      try {
        const preparedFull = await prepareModelRuntimeSnapshot(candidate);
        if (acceptsPreparedSnapshotConfig(preparedFull, full, configPolicy)) {
          return preparedFull;
        }
      } catch (error) {
        if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
          throw error;
        }
      }
    }
  }
  try {
    const preparedExact = await prepareModelRuntimeSnapshot(exact);
    if (acceptsPreparedSnapshotConfig(preparedExact, exact, configPolicy)) {
      return preparedExact;
    }
  } catch (error) {
    if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
      throw error;
    }
  }
  // Direct commands own a persistent standalone generation. During gateway lifetime, writable
  // publication belongs exclusively to startup/reload or agent-run admission.
  const activated = await activateStandalonePreparedModelRuntime(activationExact);
  if (activated && acceptsPreparedSnapshotConfig(activated, activationExact, configPolicy)) {
    return activated;
  }
  if (activated) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model catalog owner was not published for the requested config (${activationExact.agentDir})`,
    );
  }
  // Gateway pre-run selection can name a spawned workspace before embedded-run admission.
  // Lease a complete exact generation so provider catalog hooks remain visible for this read.
  const lease = await acquireAgentRunPreparedModelRuntime(activationFull);
  try {
    if (!acceptsPreparedSnapshotConfig(lease.snapshot, activationFull, configPolicy)) {
      throw new PreparedModelRuntimeOwnerNotPublishedError(
        `prepared model catalog owner was not published for the requested config (${activationFull.agentDir})`,
      );
    }
    return lease.snapshot;
  } finally {
    lease.release();
  }
}

async function loadPreparedModelCatalogOwnerSnapshotWithPolicy(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
): Promise<PreparedModelRuntimeSnapshot> {
  return await materializeRequestedModelCatalog(
    await resolvePreparedModelCatalogOwnerSnapshotWithPolicy(params, configPolicy),
    params.readOnly,
  );
}

async function loadScopedReadOnlyModelCatalog(
  params: LoadPreparedModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const { activationExact, activationFull, full } = resolveInputs(params);
  const fullCandidates =
    activationFull.workspaceDir === full.workspaceDir ? [full] : [full, activationFull];
  for (const candidate of fullCandidates) {
    try {
      const prepared = await prepareModelRuntimeSnapshot(candidate);
      if (!preparedModelRuntimeConfigsMatch(prepared.config, candidate.config)) {
        throw new PreparedModelCatalogConfigReplacedError(candidate.agentDir);
      }
      if (isPreparedModelCatalogFull(prepared.modelCatalog)) {
        return prepared.modelCatalog;
      }
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
  }
  return prepareScopedReadOnlyModelCatalog(
    activationExact,
    params.providerDiscoveryProviderIds ?? [],
  );
}

/** Resolves the lifecycle owner for an exact caller-supplied config. */
export async function loadPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<PreparedModelRuntimeSnapshot> {
  return await loadPreparedModelCatalogOwnerSnapshotWithPolicy(params, "exact");
}

/** Resolves the currently published owner when Gateway config changes during the read. */
export async function loadPublishedPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<PreparedModelRuntimeSnapshot> {
  return await loadPreparedModelCatalogOwnerSnapshotWithPolicy(params, "published");
}

/** Resolves a complete published owner for long-lived runtime consumers. */
export async function loadResolvedPublishedModelCatalogOwner(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ResolvedPublishedModelCatalogOwner> {
  return resolvePublishedModelCatalogOwner(
    await loadPublishedPreparedModelCatalogOwnerSnapshot(params),
  );
}

/** Reads one atomic catalog generation, activating a lifecycle owner when needed. */
export async function loadPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogSnapshot> {
  if (params.readOnly && params.providerDiscoveryProviderIds) {
    return loadScopedReadOnlyModelCatalog(params);
  }
  return (await loadPreparedModelCatalogOwnerSnapshot(params)).modelCatalog;
}

export async function loadPreparedModelCatalog(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogEntry[]> {
  return (await loadPreparedModelCatalogSnapshot(params)).entries;
}

/** Reads the committed owner generation for long-lived runtime work. */
export async function loadPublishedPreparedModelCatalog(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogEntry[]> {
  return (await loadPublishedPreparedModelCatalogOwnerSnapshot(params)).modelCatalog.entries;
}
