// Gateway catalog reads use the atomic prepared runtime generation.
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { getRuntimeConfig } from "../config/io.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadPreparedModelCatalogSnapshot = (params: {
  agentId?: string;
  agentDir?: string;
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
  workspaceDir?: string;
}) => Promise<ModelCatalogSnapshot>;
type LoadGatewayModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  getConfig?: () => GatewayModelCatalogConfig;
  loadPreparedModelCatalogSnapshot?: LoadPreparedModelCatalogSnapshot;
  readOnly?: boolean;
  workspaceDir?: string;
};

async function resolveLoader(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadPreparedModelCatalogSnapshot> {
  if (params?.loadPreparedModelCatalogSnapshot) {
    return params.loadPreparedModelCatalogSnapshot;
  }
  const { loadPreparedModelCatalogSnapshot } = await import("../agents/prepared-model-catalog.js");
  return loadPreparedModelCatalogSnapshot;
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

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const loadSnapshot = await resolveLoader(params);
  return await loadSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    readOnly: params?.readOnly !== false,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}
