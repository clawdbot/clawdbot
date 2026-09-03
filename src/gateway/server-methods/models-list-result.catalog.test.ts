import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../server-model-catalog-auth.js";
import { registerGatewayModelCatalogPrivateAccess } from "../server-model-catalog-auth.js";
import { buildModelsListResult } from "./models-list-result.js";

describe("models.list completed catalog facts", () => {
  it("has a credential provider's curated rows in the configured catalog before discovery runs", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "test/curated" } },
    };
    const curated = {
      provider: "test",
      id: "curated",
      name: "Curated",
      api: "openai-completions" as const,
      baseUrl: "https://test.invalid",
    };
    const owner: PreparedGatewayModelCatalogSnapshot = {
      agentId: "main",
      agentDir: "/tmp/models-list-agent",
      workspaceDir: "/tmp/models-list-workspace",
      config,
      providerAuth: { test: { mode: "api_key" } },
      authStore: {
        version: 1,
        profiles: {
          "test:default": { type: "api_key", provider: "test", key: "synthetic-key" },
        },
      },
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      authMaterializations: [],
      entries: [curated],
      routeVariants: [curated],
      catalogComplete: false,
    };
    const loadGatewayModelCatalogSnapshot = vi.fn();
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: () => new Promise<never>(() => {}),
      readPrepared: async () => owner,
    });
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    } as never;

    const result = await buildModelsListResult({
      context,
      agentId: "main",
      params: { view: "configured" },
    });

    expect(result.models).toEqual([
      expect.objectContaining({ provider: "test", id: "curated", available: true }),
    ]);
    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("uses a refreshed generation for the next ordinary read without rediscovery", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "test/discovered" } },
    };
    const discovered = { id: "discovered", name: "Discovered", provider: "test" };
    const catalog: ModelCatalogSnapshot = {
      entries: [discovered],
      routeVariants: [discovered],
    };
    const owner: PreparedGatewayModelCatalogSnapshot = {
      agentId: "main",
      agentDir: "/tmp/models-list-agent",
      workspaceDir: "/tmp/models-list-workspace",
      config,
      providerAuth: {},
      authStore: { version: 1, profiles: {} },
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      authMaterializations: [],
      ...catalog,
      catalogComplete: true,
    };
    const loadDeferred = vi.fn(async () => owner);
    const readPrepared = vi.fn(async () => owner);
    const loadGatewayModelCatalogSnapshot = vi.fn();
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred,
      readPrepared,
    });
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    } as never;

    await buildModelsListResult({
      context,
      agentId: "main",
      params: { view: "configured", refresh: true },
    });
    const ordinary = await buildModelsListResult({
      context,
      agentId: "main",
      params: { view: "configured" },
    });

    expect(ordinary.models).toEqual([expect.objectContaining({ id: "discovered" })]);
    expect(loadDeferred).toHaveBeenCalledOnce();
    expect(readPrepared).toHaveBeenCalledOnce();
  });

  it("uses an inherited auth profile from the prepared owner", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "models-list-inherited-auth-", agentEnv: "main" },
      async (state) => {
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              "test:inherited": { type: "api_key", provider: "test", key: "synthetic-key" },
            },
          },
          "main",
        );
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              authInheritance: { agentId: "main" },
              model: "test/inherited",
            },
            entries: { worker: { model: "test/inherited" } },
          },
          models: {
            providers: {
              test: {
                baseUrl: "http://127.0.0.1:1",
                models: [
                  {
                    id: "inherited",
                    name: "Inherited",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32_000,
                    maxTokens: 4_096,
                  },
                ],
              },
            },
          },
        };
        const loadGatewayModelCatalogSnapshot = vi.fn();
        const owner = {
          agentId: "worker",
          agentDir: state.agentDir("worker"),
          workspaceDir: "/tmp",
          config,
          providerAuth: {},
          authStore: {
            version: 1,
            profiles: {
              "test:inherited": { type: "api_key", provider: "test", key: "synthetic-key" },
            },
          },
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          authMaterializations: [],
          entries: [
            {
              id: "inherited",
              name: "Inherited",
              provider: "test",
              api: "openai-completions" as const,
              baseUrl: "http://127.0.0.1:1",
              contextWindow: 32_000,
              input: ["text" as const],
            },
          ],
          routeVariants: [],
        } satisfies PreparedGatewayModelCatalogSnapshot;
        const context = {
          getRuntimeConfig: () => config,
          loadGatewayModelCatalogSnapshot,
          logGateway: { debug: vi.fn(), warn: vi.fn() },
        } as never;
        registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
          loadDeferred: async () => {
            throw new Error("unexpected discovery");
          },
          readPrepared: async () => owner,
        });

        const result = await buildModelsListResult({
          context,
          agentId: "worker",
          params: { view: "configured" },
        });

        expect(result.models).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "inherited", provider: "test", available: true }),
          ]),
        );
      },
    );
  });

  it("rejects when an explicit catalog load fails", async () => {
    const config: OpenClawConfig = {};
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    } as never;
    const error = new Error("catalog unavailable");
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: async () => {
        throw error;
      },
      readPrepared: async () => undefined,
    });

    await expect(
      buildModelsListResult({
        context,
        agentId: "main",
        params: { view: "configured", refresh: true },
      }),
    ).rejects.toBe(error);
  });
});
