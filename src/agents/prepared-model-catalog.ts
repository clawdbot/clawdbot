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
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
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

export type LoadPreparedModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  readOnly?: boolean;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

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

/** Returns the current published catalog without waiting or starting discovery. */
export function getPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): ModelCatalogSnapshot | undefined {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  const publishedFull = getPreparedModelRuntimeSnapshot(full);
  if (publishedFull && preparedModelRuntimeConfigsMatch(publishedFull.config, full.config)) {
    return publishedFull.modelCatalog;
  }
  if (activationFull && activationFull.workspaceDir !== full.workspaceDir) {
    const activatedFull = getPreparedModelRuntimeSnapshot(activationFull);
    if (activatedFull && preparedModelRuntimeConfigsMatch(activatedFull.config, full.config)) {
      return activatedFull.modelCatalog;
    }
  }
  if (exact === full) {
    return undefined;
  }
  const publishedExact = getPreparedModelRuntimeSnapshot(exact);
  if (publishedExact && preparedModelRuntimeConfigsMatch(publishedExact.config, exact.config)) {
    return publishedExact.modelCatalog;
  }
  if (!activationExact || activationExact.workspaceDir === exact.workspaceDir) {
    return undefined;
  }
  const activatedExact = getPreparedModelRuntimeSnapshot(activationExact);
  return activatedExact && preparedModelRuntimeConfigsMatch(activatedExact.config, exact.config)
    ? activatedExact.modelCatalog
    : undefined;
}

/** Resolves the lifecycle owner used for a catalog read. */
export async function loadPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<PreparedModelRuntimeSnapshot> {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  if (params.readOnly) {
    const fullCandidates =
      activationFull.workspaceDir === full.workspaceDir ? [full] : [full, activationFull];
    for (const candidate of fullCandidates) {
      try {
        // Full lifecycle owners include provider augmentation omitted by read-only fallback builds.
        const prepared = await prepareModelRuntimeSnapshot(candidate);
        if (!preparedModelRuntimeConfigsMatch(prepared.config, candidate.config)) {
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
      if (!preparedModelRuntimeConfigsMatch(lease.snapshot.config, activationExact.config)) {
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
        if (preparedModelRuntimeConfigsMatch(preparedFull.config, full.config)) {
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
    if (preparedModelRuntimeConfigsMatch(preparedExact.config, exact.config)) {
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
  if (activated && preparedModelRuntimeConfigsMatch(activated.config, activationExact.config)) {
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
    if (!preparedModelRuntimeConfigsMatch(lease.snapshot.config, activationFull.config)) {
      throw new PreparedModelRuntimeOwnerNotPublishedError(
        `prepared model catalog owner was not published for the requested config (${activationFull.agentDir})`,
      );
    }
    return lease.snapshot;
  } finally {
    lease.release();
  }
}

/** Reads one atomic catalog generation, activating a lifecycle owner when needed. */
export async function loadPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogSnapshot> {
  return (await loadPreparedModelCatalogOwnerSnapshot(params)).modelCatalog;
}

export async function loadPreparedModelCatalog(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogEntry[]> {
  return (await loadPreparedModelCatalogSnapshot(params)).entries;
}
