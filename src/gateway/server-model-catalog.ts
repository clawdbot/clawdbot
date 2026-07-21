// Gateway catalog reads use the atomic prepared runtime generation.
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { PreparedModelCatalogConfigReplacedError } from "../agents/prepared-model-catalog.errors.js";
import { getRuntimeConfig } from "../config/io.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";

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
  const loadSnapshot = await resolveLoader(params);
  const getConfig = params?.getConfig ?? getRuntimeConfig;
  let config = getConfig();
  let configFingerprint = hashRuntimeConfigValue(config);
  for (;;) {
    try {
      return await loadSnapshot({
        ...(params?.agentId ? { agentId: params.agentId } : {}),
        ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
        config,
        readOnly: params?.readOnly !== false,
        ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      });
    } catch (error) {
      if (!(error instanceof PreparedModelCatalogConfigReplacedError)) {
        throw error;
      }
      // Config publication may replace the prepared owner while this request is waiting. Follow
      // that committed generation; explicit read-only draft callers retain strict isolation.
      const replacementConfig = getConfig();
      const replacementFingerprint = hashRuntimeConfigValue(replacementConfig);
      if (replacementFingerprint === configFingerprint) {
        throw error;
      }
      config = replacementConfig;
      configFingerprint = replacementFingerprint;
    }
  }
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}
