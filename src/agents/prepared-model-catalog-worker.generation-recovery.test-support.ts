import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
} from "../gateway/server-model-catalog.js";
import {
  PLUGIN_ID,
  PROVIDER_ID,
  writeFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  registerPreparedModelRuntimePublicationListener,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";

type GenerationRecoveryFixture = {
  root: string;
  agentDir: string;
  workspaceDir: string;
  marker: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export async function expectPublishedOwnerRecoveryAfterGenerationMismatch(
  fixture: GenerationRecoveryFixture,
): Promise<void> {
  vi.stubEnv("OPENCLAW_WORKER_CATALOG_MARKER", fixture.marker);
  const config = {
    ...fixture.config,
    agents: {
      ...fixture.config.agents,
      list: [
        {
          id: "main",
          default: true,
          agentDir: fixture.agentDir,
          workspace: fixture.workspaceDir,
        },
      ],
    },
  } satisfies OpenClawConfig;
  const input = {
    agentId: "main",
    agentDir: fixture.agentDir,
    inheritedAuthDir: fixture.agentDir,
    workspaceDir: fixture.workspaceDir,
    config,
    env: fixture.env,
  } satisfies PreparedModelRuntimeInput;
  await publishPreparedModelRuntimeSnapshot(input, {
    provenance: "configured",
    catalogMode: "static",
  });
  writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
  fixture.config.plugins!.entries![PLUGIN_ID] = { enabled: true, config: {} };

  const loadRecoveredCatalog = async () =>
    await loadGatewayModelCatalogSnapshot({
      agentId: "main",
      agentDir: fixture.agentDir,
      workspaceDir: fixture.workspaceDir,
      getConfig: () => config,
      readOnly: false,
    });
  registerGatewayModelCatalogPrivateAccess(loadRecoveredCatalog, {
    loadDeferred: async () =>
      await loadPreparedGatewayModelCatalogSnapshot({
        agentId: "main",
        agentDir: fixture.agentDir,
        workspaceDir: fixture.workspaceDir,
        getConfig: () => config,
        readOnly: false,
      }),
    readPrepared: async () => undefined,
  });
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: loadRecoveredCatalog,
    logGateway: { debug: () => undefined },
  } as unknown as GatewayRequestContext;
  let concurrentRead: ReturnType<typeof loadRecoveredCatalog> | undefined;
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "invalidated" && !concurrentRead) {
      concurrentRead = prepareModelRuntimeSnapshot(input).then(loadRecoveredCatalog);
    }
  });
  const recovered = await buildModelsListResult({ context, params: { view: "all" } }).finally(
    unregister,
  );
  const concurrentRecovered = await concurrentRead;

  expect(recovered.models).toContainEqual(
    expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v2" }),
  );
  expect(concurrentRecovered?.entries).toContainEqual(
    expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v2" }),
  );
}
