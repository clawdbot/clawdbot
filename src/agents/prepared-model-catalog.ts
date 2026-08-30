/** Lifecycle-owned model catalog access. */
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
} from "./agent-scope.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import type { ResolvedPublishedModelCatalogOwner } from "./prepared-model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthMaterializations,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthMaterializations,
  setPreparedModelRuntimeAuthLoader,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
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
import {
  prepareScopedReadOnlyLiveModelCatalog,
  prepareScopedReadOnlyModelCatalog,
} from "./prepared-model-runtime.scoped-catalog.js";
import {
  hasResolvedThinkingCatalogEntry,
  normalizeThinkingCatalogProviders,
} from "./thinking-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

export type LoadPreparedModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  readOnly?: boolean;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerDiscoveryProviderIds?: readonly string[];
  /** Rebuilds a completed full catalog instead of reusing this generation's cache. */
  refreshFullCatalog?: boolean;
  /** Scoped read-only loads may run live discovery for the scoped providers only. */
  scopedLiveProviderDiscovery?: boolean;
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
  refreshFullCatalog: boolean | undefined,
): Promise<PreparedModelRuntimeSnapshot> {
  if (!snapshot.loadFullModelCatalog) {
    return snapshot;
  }
  const modelCatalog =
    readOnly === true
      ? snapshot.readFullModelCatalog?.()
      : await snapshot.loadFullModelCatalog({ refresh: refreshFullCatalog === true });
  if (!modelCatalog) {
    return snapshot;
  }
  const fullAuth = getPreparedModelFullCatalogAuth(modelCatalog);
  if (!fullAuth) {
    throw new Error("prepared full model catalog omitted its auth generation");
  }
  const materialized = Object.freeze({
    ...snapshot,
    authModes: fullAuth.authModes,
    modelCatalog,
  });
  setPreparedModelRuntimeAuthStore(materialized, fullAuth.authStore);
  // Later explicit auth refreshes stay bound to the original owner generation. Ordinary reads
  // consume the full worker's paired auth without invoking this loader.
  setPreparedModelRuntimeAuthLoader(
    materialized,
    async (scope) => (await loadPreparedModelRuntimeAuth(snapshot, scope)) ?? fullAuth,
  );
  setPreparedModelRuntimeAuthMaterializations(
    materialized,
    getPreparedModelRuntimeAuthMaterializations(snapshot),
  );
  return materialized;
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
    params.agentId ??
    (params.agentDir === undefined ? resolveAmbientOwnerAgentId(config) : undefined);
  const agentDir =
    params.agentDir ?? resolveAgentDir(config, explicitOrDefaultAgentId as string, params.env);
  const matchingAgentIds =
    explicitOrDefaultAgentId !== undefined
      ? []
      : listAgentIds(config).filter(
          (candidateAgentId) => resolveAgentDir(config, candidateAgentId, params.env) === agentDir,
        );
  const agentId =
    explicitOrDefaultAgentId ?? (matchingAgentIds.length === 1 ? matchingAgentIds[0] : undefined);
  const explicitWorkspaceDir = params.workspaceDir === undefined ? undefined : params.workspaceDir;
  const activationWorkspaceDir =
    explicitWorkspaceDir ??
    (agentId ? resolveAgentWorkspaceDir(config, agentId, params.env) : undefined);
  const full: PreparedModelRuntimeInput = {
    ...(agentId ? { agentId } : {}),
    agentDir,
    config,
    ...(params.env ? { env: params.env } : {}),
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config, params.env),
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
  if (activationFull.workspaceDir !== full.workspaceDir) {
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
  if (activationExact.workspaceDir === exact.workspaceDir) {
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

/** Returns the newest completed catalog for the current generation without starting discovery. */
export function getAvailablePreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): ModelCatalogSnapshot | undefined {
  const owner = getPreparedModelCatalogOwnerSnapshot(params);
  return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
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
  const publishedReadOnlyOwner = params.readOnly
    ? getPreparedModelCatalogOwnerSnapshot(params)
    : undefined;
  const snapshot = await resolvePreparedModelCatalogOwnerSnapshotWithPolicy(params, configPolicy);
  // A fallback read-only lease retires before this projection. Only a published owner can safely
  // expose its generation cache; the leased snapshot already contains its exact prepared facts.
  if (params.readOnly && !publishedReadOnlyOwner) {
    return snapshot;
  }
  return await materializeRequestedModelCatalog(
    snapshot,
    params.readOnly,
    params.refreshFullCatalog,
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
  const prepareScoped =
    params.scopedLiveProviderDiscovery === true
      ? prepareScopedReadOnlyLiveModelCatalog
      : prepareScopedReadOnlyModelCatalog;
  return prepareScoped(activationExact, params.providerDiscoveryProviderIds ?? []);
}

/**
 * Turn-path capability reads (thinking levels and similar per-model facts) must stay off a new
 * full catalog build: reuse the published generation, then manifest/scoped read-only metadata,
 * then scoped live discovery only for providers whose models exist solely at runtime.
 */
export async function loadProviderScopedThinkingCatalog(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Input preparation must resolve modalities for this route, independently of reasoning. */
  requiredInputRoute?: Pick<ModelCatalogEntry, "api" | "baseUrl">;
}): Promise<ModelCatalogEntry[]> {
  const scopedParams = {
    config: params.config,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    readOnly: true,
    providerDiscoveryProviderIds: [params.provider],
  } satisfies LoadPreparedModelCatalogParams;
  const entryResolved = (catalog: readonly ModelCatalogEntry[]) => {
    if (params.requiredInputRoute === undefined) {
      return hasResolvedThinkingCatalogEntry({
        catalog,
        provider: params.provider,
        model: params.model,
      });
    }
    const entry = findModelInCatalog(catalog, params.provider, params.model);
    return (
      entry?.input !== undefined && modelTransportRoutesMatch(entry, params.requiredInputRoute)
    );
  };
  const augmentHarnessCatalog = async (snapshot: ModelCatalogSnapshot) => {
    const agentId = params.agentId ?? resolveAmbientOwnerAgentId(params.config);
    const { augmentModelCatalogWithAgentHarness } = await import("./harness/model-catalog.js");
    const augmented = await augmentModelCatalogWithAgentHarness({
      cfg: params.config,
      agentId,
      agentDir: params.agentDir ?? resolveAgentDir(params.config, agentId),
      workspaceDir:
        params.workspaceDir ??
        resolveAgentWorkspaceDir(params.config, agentId) ??
        resolveDefaultAgentWorkspaceDir(),
      modelRef: { provider: params.provider, model: params.model },
      snapshot,
    });
    const entries = normalizeThinkingCatalogProviders(augmented.entries);
    return params.requiredInputRoute !== undefined && !entryResolved(entries) ? [] : entries;
  };
  const publishedCatalog = getPreparedModelCatalogSnapshot(scopedParams);
  if (publishedCatalog && entryResolved(publishedCatalog.entries)) {
    return await augmentHarnessCatalog(publishedCatalog);
  }
  const { loadManifestModelCatalog } = await import("./model-catalog.js");
  const manifestCatalog = normalizeThinkingCatalogProviders(
    loadManifestModelCatalog({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    }),
  );
  if (entryResolved(manifestCatalog)) {
    return await augmentHarnessCatalog({
      entries: manifestCatalog,
      routeVariants: manifestCatalog,
      staticEntries: manifestCatalog,
    });
  }
  const scopedStatic = await loadPreparedModelCatalogSnapshot(scopedParams);
  if (entryResolved(scopedStatic.entries)) {
    return await augmentHarnessCatalog(scopedStatic);
  }
  return await augmentHarnessCatalog(
    await loadPreparedModelCatalogSnapshot({
      ...scopedParams,
      scopedLiveProviderDiscovery: true,
    }),
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
