import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
// Gateway catalog reads use the atomic prepared runtime generation.
import { getRuntimeConfig } from "../config/io.js";
import type {
  GatewayModelCatalogOwnerSnapshot,
  GatewayModelCatalogSnapshot,
} from "./server-model-catalog.types.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;
export type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadPublishedPreparedModelCatalogOwnerSnapshot = (params: {
  agentId?: string;
  agentDir?: string;
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
  workspaceDir?: string;
}) => Promise<PublishedModelCatalogOwnerCandidate>;
type LoadGatewayModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  getConfig?: () => GatewayModelCatalogConfig;
  loadPublishedPreparedModelCatalogOwnerSnapshot?: LoadPublishedPreparedModelCatalogOwnerSnapshot;
  readOnly?: boolean;
  workspaceDir?: string;
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
export async function resetPreparedModelCatalogForTest(): Promise<void> {
  const [{ resetPreparedModelRuntimeSnapshotsForTest }, { resetModelCatalogBuilderCacheForTest }] =
    await Promise.all([
      import("../agents/prepared-model-runtime.test-support.js"),
      import("../agents/model-catalog.js"),
    ]);
  resetPreparedModelRuntimeSnapshotsForTest();
  resetModelCatalogBuilderCacheForTest();
}

async function loadGatewayModelCatalogOwnerSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogOwnerSnapshot> {
  const loadOwner = await resolveLoader(params);
  return resolvePublishedModelCatalogOwner(
    await loadOwner({
      ...(params?.agentId ? { agentId: params.agentId } : {}),
      ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
      config: (params?.getConfig ?? getRuntimeConfig)(),
      readOnly: params?.readOnly !== false,
      ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    }),
  );
}

function flattenGatewayModelCatalogOwner(
  owner: GatewayModelCatalogOwnerSnapshot,
): GatewayModelCatalogSnapshot {
  return {
    ...owner.modelCatalog,
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    config: owner.config,
  };
}

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot> {
  return flattenGatewayModelCatalogOwner(await loadGatewayModelCatalogOwnerSnapshot(params));
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}

/** Reads the already-published startup catalog snapshot without starting provider discovery. */
export async function readPreparedGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot | undefined> {
  const { getPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  const prepared = getPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config: (params?.getConfig ?? getRuntimeConfig)(),
    readOnly: true,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!prepared) {
    return undefined;
  }
  try {
    return flattenGatewayModelCatalogOwner(resolvePublishedModelCatalogOwner(prepared));
  } catch {
    // A published generation whose owner no longer resolves to one configured agent
    // is not usable metadata. Callers treat it as "not prepared yet" rather than
    // failing the request they decorate.
    return undefined;
  }
}
