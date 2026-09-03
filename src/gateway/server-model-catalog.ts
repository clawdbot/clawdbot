import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
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
import { isPreparedModelCatalogFull } from "../agents/prepared-model-runtime.full-catalog.js";
// Gateway catalog reads use the atomic prepared runtime generation.
import { getRuntimeConfig } from "../config/io.js";
import type { PreparedGatewayModelCatalogSnapshot } from "./server-model-catalog-auth.js";
import type {
  GatewayModelCatalogSnapshot,
  PreparedGatewayModelCatalog,
} from "./server-model-catalog.types.js";

export type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadGatewayModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  getConfig?: () => GatewayModelCatalogConfig;
  readOnly?: boolean;
  refreshFullCatalog?: boolean;
  workspaceDir?: string;
};
type LoadPreparedGatewayModelCatalogParams = LoadGatewayModelCatalogParams & {
  authScope?: PreparedModelRuntimeAuthScope;
  refreshAuth?: boolean;
};

// Isolated gateway tests share process module state with lifecycle-owner tests.
export async function resetPreparedModelCatalogStateForTest(): Promise<void> {
  const [{ resetPreparedModelRuntimeSnapshotsForTest }, { resetModelCatalogBuilderStateForTest }] =
    await Promise.all([
      import("../agents/prepared-model-runtime.test-support.js"),
      import("../agents/model-catalog.js"),
    ]);
  resetPreparedModelRuntimeSnapshotsForTest();
  resetModelCatalogBuilderStateForTest();
}

async function loadGatewayModelCatalogOwnerSnapshot(
  params?: LoadPreparedGatewayModelCatalogParams,
): Promise<{
  candidate: PublishedModelCatalogOwnerCandidate;
  owner: ResolvedPublishedModelCatalogOwner & {
    authMaterializations: PreparedGatewayModelCatalogSnapshot["authMaterializations"];
  };
}> {
  const { loadPublishedPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  const candidate = await loadPublishedPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config: (params?.getConfig ?? getRuntimeConfig)(),
    readOnly: params?.readOnly !== false,
    ...(params?.refreshFullCatalog !== undefined
      ? { refreshFullCatalog: params.refreshFullCatalog }
      : {}),
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
      providerAuth: refreshedAuth?.providerAuth ?? owner.providerAuth,
      authStore: refreshedAuth?.authStore ?? owner.authStore,
      metadataSnapshot: owner.metadataSnapshot,
      authMaterializations: owner.authMaterializations,
      oauthRefreshProviderIds: owner.oauthRefreshProviderIds,
    };
  }
}

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot> {
  const {
    providerAuth: _providerAuth,
    authStore: _authStore,
    metadataSnapshot: _metadataSnapshot,
    authMaterializations: _authMaterializations,
    oauthRefreshProviderIds: _oauthRefreshProviderIds,
    ...snapshot
  } = await loadPreparedGatewayModelCatalogSnapshot(params);
  return snapshot;
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<ModelCatalogEntry[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}

/** Reads the newest completed published catalog without starting provider discovery. */
export async function readPreparedGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalog | undefined> {
  const { getPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const owner = getPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    readOnly: true,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!owner) {
    return undefined;
  }
  return {
    entries: (owner.readFullModelCatalog?.() ?? owner.modelCatalog).entries,
    pluginRegistry: owner.pluginRegistry,
  };
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
  // The published owner is the fact: its completed full catalog when discovery has landed,
  // otherwise its configured projection. Ordinary reads never wait for discovery.
  const modelCatalog = candidate.readFullModelCatalog?.() ?? candidate.modelCatalog;
  const owner = resolvePublishedModelCatalogOwner(candidate);
  return {
    ...projectGatewayModelCatalogSnapshot({ ...owner, modelCatalog }),
    providerAuth: owner.providerAuth,
    authStore: owner.authStore,
    metadataSnapshot: owner.metadataSnapshot,
    authMaterializations: getPreparedModelRuntimeAuthMaterializations(candidate),
    oauthRefreshProviderIds: owner.oauthRefreshProviderIds,
  };
}
