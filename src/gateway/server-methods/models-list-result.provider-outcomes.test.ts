import { describe, expect, it, vi } from "vitest";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
  prepareModelsListResult,
} from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture();
const emptyAuthStore = { version: 1, profiles: {} } as const;

describe("models.list provider catalog outcomes", () => {
  it("preserves an auth rejection when no usable models are visible", async () => {
    const config = {} as OpenClawConfig;
    const snapshot = {
      agentId: "main",
      agentDir: "/tmp/models-list-provider-outcomes-agent",
      catalogComplete: true,
      workspaceDir: "/tmp/models-list-provider-outcomes-workspace",
      config,
      authModes: {},
      authStore: emptyAuthStore,
      metadataSnapshot,
      authMaterializations: [],
      entries: [],
      routeVariants: [],
      providerOutcomes: [
        {
          provider: "openai",
          profileId: "openai:chatgpt",
          status: "auth-rejected" as const,
        },
      ],
    };
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(() => Promise.resolve(snapshot)),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
      loadDeferred: async () => snapshot as PreparedGatewayModelCatalogSnapshot,
      readPrepared: async () => snapshot as PreparedGatewayModelCatalogSnapshot,
    });

    await expect(buildModelsListResult({ context, params: { view: "all" } })).resolves.toEqual({
      models: [],
      providerOutcomes: [
        { provider: "openai", profileId: "openai:chatgpt", status: "auth-rejected" },
      ],
    });
  });

  it.each([
    { name: "provider auth", rejectionScope: undefined, usageStats: undefined },
    {
      name: "model-route auth",
      rejectionScope: "catalog" as const,
      usageStats: {
        "openai:chatgpt": {
          disabledUntil: 2_000_000_000_000,
          disabledReason: "auth_permanent" as const,
        },
      },
    },
  ])("marks configured API-key rows unavailable after $name rejection", async (testCase) => {
    const config = {
      auth: { order: { openai: ["openai:chatgpt"] } },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/*": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    } as OpenClawConfig;
    const model = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const snapshot = markPreparedModelCatalogFull({
      entries: [model],
      routeVariants: [model],
      providerOutcomes: [
        {
          provider: "openai",
          profileId: "openai:chatgpt",
          ...(testCase.rejectionScope ? { rejectionScope: testCase.rejectionScope } : {}),
          status: "auth-rejected" as const,
        },
      ],
    });
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: config,
      agentId: "main",
      snapshot,
      metadataSnapshot,
      preparedAuthStore: {
        version: 1,
        profiles: {
          "openai:chatgpt": {
            type: "api_key",
            provider: "openai",
            key: "rejected-api-key",
          },
          "openai:other": {
            type: "oauth",
            provider: "openai",
            access: "accepted-access-token",
            refresh: "accepted-refresh-token",
            expires: Date.now() + 30 * 60_000,
          },
        },
        ...(testCase.usageStats ? { usageStats: testCase.usageStats } : {}),
      },
      preferredProfileId: "openai:chatgpt",
    });
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        agentId: "main",
        params: { view: "configured" },
        preloadedCatalog: { agentId: "main", config, snapshot },
        preloadedOnly: true,
        catalogProjector: projector,
      }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-5.6-sol",
          available: false,
          unavailableReason: "auth-failed",
        }),
      ],
      providerOutcomes: [
        { provider: "openai", profileId: "openai:chatgpt", status: "auth-rejected" },
      ],
    });
  });

  it("does not apply one profile rejection to a different selected profile", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/*": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    } as OpenClawConfig;
    const model = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const snapshot = {
      entries: [model],
      routeVariants: [model],
      providerOutcomes: [
        {
          provider: "openai",
          profileId: "openai:rejected",
          status: "auth-rejected" as const,
        },
      ],
    };
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: config,
      agentId: "main",
      snapshot,
      metadataSnapshot,
      preferredProfileId: "openai:accepted",
      preparedAuthStore: {
        version: 1,
        profiles: {
          "openai:rejected": {
            type: "oauth",
            provider: "openai",
            access: "rejected-access-token",
            refresh: "rejected-refresh-token",
            expires: Date.now() + 30 * 60_000,
          },
          "openai:accepted": {
            type: "oauth",
            provider: "openai",
            access: "accepted-access-token",
            refresh: "accepted-refresh-token",
            expires: Date.now() + 30 * 60_000,
          },
        },
      },
    });

    await expect(projector.evaluateEntry(model, [model])).resolves.toMatchObject({
      availability: true,
      selectedProfileId: "openai:accepted",
    });
  });

  it.each([
    {
      name: "missing credentials",
      evaluation: { availability: undefined, unavailableReason: "missing-auth" },
      expected: { available: false, unavailableReason: "missing-auth" },
    },
    {
      name: "cooldown with its retry time",
      evaluation: {
        availability: false,
        unavailableReason: "cooldown",
        unavailableUntil: 2_000_000_000_000,
      },
      expected: {
        available: false,
        unavailableReason: "cooldown",
        unavailableUntil: 2_000_000_000_000,
      },
    },
    {
      name: "unknown availability without an auth diagnosis",
      evaluation: { availability: undefined },
      expected: { available: false },
    },
    {
      name: "available models without stale unavailability metadata",
      evaluation: {
        availability: true,
        unavailableReason: "cooldown",
        unavailableUntil: 2_000_000_000_000,
      },
      expected: { available: true },
    },
  ] as const)("projects $name", async ({ evaluation, expected }) => {
    const config = {
      agents: { defaults: { models: { "custom/test-model": {} } } },
    } as OpenClawConfig;
    const model = { id: "test-model", name: "Test Model", provider: "custom" };
    const snapshot = markPreparedModelCatalogFull({ entries: [model], routeVariants: [model] });
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: config,
      agentId: "main",
      snapshot,
      metadataSnapshot,
      preparedAuthStore: emptyAuthStore,
    });
    const evaluateEntry = vi.spyOn(projector, "evaluateEntry").mockResolvedValue({
      ...evaluation,
      routeResolution: null,
    });
    const evaluateNative = vi.spyOn(projector, "evaluateNative");
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    const prepared = await prepareModelsListResult({
      context,
      params: { view: "configured" },
      preloadedCatalog: { agentId: "main", config, snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });

    expect(prepared.read().models).toEqual([{ ...model, tags: ["configured"], ...expected }]);
    const hostEvaluations = evaluateEntry.mock.calls.length;
    evaluateNative.mockReturnValue({ availability: true, routeResolution: null });
    expect(prepared.read().models).toEqual([{ ...model, tags: ["configured"], available: true }]);
    evaluateNative.mockReturnValue({ availability: false, routeResolution: null });
    expect(prepared.read().models).toEqual([{ ...model, tags: ["configured"], available: false }]);
    expect(evaluateEntry).toHaveBeenCalledTimes(hostEvaluations);
  });
});
