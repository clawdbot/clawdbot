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
}) => Promise<GatewayModelCatalogOwnerSnapshot>;
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
  return await loadOwner({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config: (params?.getConfig ?? getRuntimeConfig)(),
    readOnly: params?.readOnly !== false,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot> {
  const owner = await loadGatewayModelCatalogOwnerSnapshot(params);
  return {
    ...owner.modelCatalog,
    ...(owner.agentId ? { agentId: owner.agentId } : {}),
    agentDir: owner.agentDir,
    ...(owner.workspaceDir ? { workspaceDir: owner.workspaceDir } : {}),
    config: owner.config,
  };
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}
