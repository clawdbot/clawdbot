import { describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  resolveInstalledManifestRegistryIndexFingerprint: () => "test-plugin-index",
}));

describe("prepared model catalog worker input", () => {
  it("preserves SecretRef identity beside materialized literals", () => {
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
        "ref-api:default": {
          type: "api_key" as const,
          provider: "ref-api",
          keyRef: { source: "env" as const, provider: "default", id: "REF_API_KEY" },
        },
        "ref-token:default": {
          type: "token" as const,
          provider: "ref-token",
          tokenRef: { source: "env" as const, provider: "default", id: "REF_TOKEN" },
        },
      },
      order: { shared: ["shared:named"] },
      lastGood: { shared: "shared:named" },
    };
    const workerInput = createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: {
          agentDir: "/tmp/agent",
          config: {},
          workspaceDir: "/tmp/workspace",
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
        },
        env: {},
        authStore,
        credentials: { shared: { ...authStore.profiles["shared:named"] } },
        providerIds: ["configured"],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        runtimeCapabilityModels: [],
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
        keyRef: { source: "env", provider: "default", id: "UNRELATED_KEY" },
      },
      "ref-api:default": authStore.profiles["ref-api:default"],
      "ref-token:default": authStore.profiles["ref-token:default"],
    });
    expect(cloned.authStore.order).toEqual(authStore.order);
    expect(cloned.authStore.lastGood).toEqual(authStore.lastGood);
    expect(cloned.input.runtimePluginSelections).toEqual([
      { provider: "selected", modelId: "model" },
    ]);
    expect(cloned.input).not.toHaveProperty("loadRuntimePlugins");
  });
});
