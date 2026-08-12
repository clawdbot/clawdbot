import { describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.facts.js";

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  resolveInstalledManifestRegistryIndexFingerprint: () => "test-plugin-index",
}));

describe("prepared model catalog worker input", () => {
  it("preserves the complete materialized auth generation without transferring SecretRefs", () => {
    const authStore = {
      version: 1,
      profiles: {
        "shared:named": {
          type: "oauth" as const,
          provider: "shared",
          access: "access-token",
          refresh: "refresh-token",
          expires: 4_102_444_800_000,
          projectId: "project-id",
        },
        "unrelated:default": {
          type: "api_key" as const,
          provider: "unrelated",
          key: "materialized-key",
          keyRef: { source: "env" as const, provider: "default", id: "UNRELATED_KEY" },
        },
      },
      order: { shared: ["shared:named"] },
      lastGood: { shared: "shared:named" },
    };
    const workerInput = createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: { agentDir: "/tmp/agent", config: {}, workspaceDir: "/tmp/workspace" },
        env: {},
        authStore,
        credentials: { shared: { type: "oauth", ...authStore.profiles["shared:named"] } },
        providerIds: ["configured"],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        configuredGeneratedCatalogPluginIds: [],
        templateAuthStorage: {} as never,
      } satisfies PreparedModelRuntimeAgentFacts,
      pluginMetadataSnapshot: {
        policyHash: "test-policy",
        configFingerprint: "test-config",
        index: {} as never,
        plugins: [],
      } as unknown as PluginMetadataSnapshot,
    });

    const cloned = structuredClone(workerInput);
    expect(cloned.authStore.profiles).toEqual({
      "shared:named": authStore.profiles["shared:named"],
      "unrelated:default": {
        type: "api_key",
        provider: "unrelated",
        key: "materialized-key",
      },
    });
    expect(cloned.authStore.order).toEqual(authStore.order);
    expect(cloned.authStore.lastGood).toEqual(authStore.lastGood);
  });
});
