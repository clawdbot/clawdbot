import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import type {
  PublishedModelCatalogOwnerCandidate,
  ResolvedPublishedModelCatalogOwner,
} from "../agents/prepared-model-catalog.types.js";
import {
  getPreparedModelRuntimeAuthMaterializations,
  loadPreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
} from "../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "../agents/prepared-model-runtime.facts.js";
// Gateway catalog reads use the atomic prepared runtime generation.
import { getRuntimeConfig } from "../config/io.js";
import type { PreparedGatewayModelCatalogSnapshot } from "./server-model-catalog-auth.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;
export type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadPublishedPreparedModelCatalogOwnerSnapshot = (params: {
  agentId?: string;
  agentDir?: string;
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
  refreshFullCatalog?: boolean;
  workspaceDir?: string;
}) => Promise<PublishedModelCatalogOwnerCandidate>;
type LoadGatewayModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  getConfig?: () => GatewayModelCatalogConfig;
  loadPublishedPreparedModelCatalogOwnerSnapshot?: LoadPublishedPreparedModelCatalogOwnerSnapshot;
  readOnly?: boolean;
  refreshFullCatalog?: boolean;
  workspaceDir?: string;
};
type LoadPreparedGatewayModelCatalogParams = LoadGatewayModelCatalogParams & {
  authScope?: PreparedModelRuntimeAuthScope;
  refreshAuth?: boolean;
};

async function resolveLoader(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadPublishedPreparedModelCatalogOwnerSnapshot> {
  if (params?.loadPublishedPreparedModelCatalogOwnerSnapshot) {
    return params.loadPublishedPreparedModelCatalogOwnerSnapshot;
  }
  const { loadPublishedPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  return loadPublishedPreparedModelCatalogOwnerSnapshot;
}

// Isolated gateway tests share process module state with lifecycle-owner tests.
export async function resetPreparedModelCatalogStateForTest(): Promise<void> {
  const [{ resetPreparedModelRuntimeSnapshotsForTest }, { resetModelCatalogBuilderCacheForTest }] =
    await Promise.all([
      import("../agents/prepared-model-runtime.test-support.js"),
      import("../agents/model-catalog.js"),
    ]);
  resetPreparedModelRuntimeSnapshotsForTest();
  resetModelCatalogBuilderCacheForTest();
}

async function loadGatewayModelCatalogOwnerSnapshot(
  params?: LoadPreparedGatewayModelCatalogParams,
): Promise<{
  candidate: PublishedModelCatalogOwnerCandidate;
  owner: ResolvedPublishedModelCatalogOwner & {
    authMaterializations: PreparedGatewayModelCatalogSnapshot["authMaterializations"];
  };
}> {
  const loadOwner = await resolveLoader(params);
  const candidate = await loadOwner({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config: (params?.getConfig ?? getRuntimeConfig)(),
    readOnly: params?.readOnly !== false,
    ...(params?.refreshFullCatalog ? { refreshFullCatalog: true } : {}),
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const owner = resolvePublishedModelCatalogOwner(candidate);
  return {
    candidate,
    owner: {
      ...owner,
      authMaterializations: getPreparedModelRuntimeAuthMaterializations(candidate),
    },
  };
}

function projectGatewayModelCatalogSnapshot(
  owner: Pick<
    ResolvedPublishedModelCatalogOwner,
    "agentId" | "agentDir" | "workspaceDir" | "config" | "modelCatalog"
  >,
): GatewayModelCatalogSnapshot {
  return {
    ...owner.modelCatalog,
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    catalogComplete: isPreparedModelCatalogFull(owner.modelCatalog),
    workspaceDir: owner.workspaceDir,
    config: owner.config,
  };
}

export async function loadPreparedGatewayModelCatalogSnapshot(
  params?: LoadPreparedGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalogSnapshot> {
  for (;;) {
    let loaded: Awaited<ReturnType<typeof loadGatewayModelCatalogOwnerSnapshot>>;
    try {
      loaded = await loadGatewayModelCatalogOwnerSnapshot(params);
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        continue;
      }
      throw error;
    }
    const { candidate, owner } = loaded;
    let refreshedAuth: Awaited<ReturnType<typeof loadPreparedModelRuntimeAuth>>;
    try {
      refreshedAuth = params?.refreshAuth
        ? await loadPreparedModelRuntimeAuth(
            candidate,
            params.authScope ?? {
              providerIds: owner.modelCatalog.entries.map((entry) => entry.provider),
            },
          )
        : undefined;
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        // Supersession invalidates every captured owner fact. Reacquire the whole owner so
        // replacement auth cannot be combined with stale catalog or metadata.
        continue;
      }
      refreshedAuth = undefined;
    }
    return {
      ...projectGatewayModelCatalogSnapshot(owner),
      authModes: refreshedAuth?.authModes ?? owner.authModes,
      authStore: refreshedAuth?.authStore ?? owner.authStore,
      metadataSnapshot: owner.metadataSnapshot,
      authMaterializations: owner.authMaterializations,
    };
  }
}

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot> {
  const {
    authModes: _authModes,
    authStore: _authStore,
    metadataSnapshot: _metadataSnapshot,
    authMaterializations: _authMaterializations,
    ...snapshot
  } = await loadPreparedGatewayModelCatalogSnapshot(params);
  return snapshot;
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}

/** Reads the already-published startup catalog without starting provider discovery. */
export async function readPreparedGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[] | undefined> {
  const { getPreparedModelCatalogSnapshot } = await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  return getPreparedModelCatalogSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    readOnly: true,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  })?.entries;
}

/** Reads the published owner generation without activating full catalog discovery. */
export async function readPreparedGatewayModelCatalogOwnerSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalogSnapshot | undefined> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const candidate = getPublishedPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!candidate) {
    return undefined;
  }
  const owner = resolvePublishedModelCatalogOwner(candidate);
  return {
    ...projectGatewayModelCatalogSnapshot(owner),
    authModes: owner.authModes,
    authStore: owner.authStore,
    metadataSnapshot: owner.metadataSnapshot,
    authMaterializations: getPreparedModelRuntimeAuthMaterializations(candidate),
  };
}
