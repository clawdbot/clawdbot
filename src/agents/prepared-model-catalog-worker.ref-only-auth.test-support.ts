import { expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import {
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_API_PROVIDER_ID,
  REF_ONLY_TOKEN_ENV,
  REF_ONLY_TOKEN_PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { AuthStorage } from "./sessions/auth-storage.js";

type RefOnlyAuthFixture = {
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  isCurrent: () => boolean;
};

export async function expectRefOnlyAuthProfilesThroughWorker(
  fixture: RefOnlyAuthFixture,
): Promise<void> {
  const authStore = {
    version: 1,
    profiles: {
      [`${REF_ONLY_API_PROVIDER_ID}:default`]: {
        type: "api_key" as const,
        provider: REF_ONLY_API_PROVIDER_ID,
        keyRef: { source: "env" as const, provider: "default", id: REF_ONLY_API_ENV },
      },
      [`${REF_ONLY_TOKEN_PROVIDER_ID}:default`]: {
        type: "token" as const,
        provider: REF_ONLY_TOKEN_PROVIDER_ID,
        tokenRef: { source: "env" as const, provider: "default", id: REF_ONLY_TOKEN_ENV },
      },
    },
  };
  const input = createPreparedModelCatalogWorkerInput({
    agentFacts: {
      input: {
        agentId: "main",
        agentDir: fixture.agentDir,
        workspaceDir: fixture.workspaceDir,
        config: fixture.config,
        env: fixture.env,
      },
      env: fixture.env,
      authStore,
      credentials: {},
      providerIds: [PROVIDER_ID],
      configuredModelRefs: [],
      configuredRuntimeModels: [],
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
      templateAuthStorage: AuthStorage.inMemory({}),
    } satisfies PreparedModelRuntimeAgentFacts,
    pluginMetadataSnapshot: fixture.pluginMetadataSnapshot,
  });

  const catalog = await createPreparedModelCatalogWorker({
    input,
    isCurrent: fixture.isCurrent,
  }).loadCatalog();

  expect(catalog.entries).toContainEqual(
    expect.objectContaining({
      provider: PROVIDER_ID,
      id: "ref-proof-api-true-token-true",
    }),
  );
}
