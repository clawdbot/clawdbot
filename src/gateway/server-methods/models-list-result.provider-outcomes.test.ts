import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

describe("models.list provider catalog outcomes", () => {
  it("preserves an auth rejection when no usable models are visible", async () => {
    const config = {} as OpenClawConfig;
    const snapshot = {
      agentId: "main",
      agentDir: "/tmp/models-list-provider-outcomes-agent",
      config,
      entries: [],
      routeVariants: [],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" as const }],
    };
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(() => Promise.resolve(snapshot)),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(buildModelsListResult({ context, params: { view: "all" } })).resolves.toEqual({
      models: [],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
    });
  });

  it("marks configured rows unavailable when stored credentials were rejected", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": {} },
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
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" as const }],
    };
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: config,
      agentId: "main",
      snapshot,
      preparedAuthStore: {
        version: 1,
        profiles: {
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "rejected-access-token",
            refresh: "rejected-refresh-token",
            expires: Date.now() + 30 * 60_000,
          },
        },
      },
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
      models: [expect.objectContaining({ id: "gpt-5.6-sol", available: false })],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
    });
  });
});
