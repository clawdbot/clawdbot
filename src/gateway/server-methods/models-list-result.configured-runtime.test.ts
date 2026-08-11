import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

const WITHOUT_OPENAI_ENV_AUTH = {
  CODEX_API_KEY: undefined,
  CODEX_HOME: "/__openclaw_models_list_configured_runtime_test__/codex",
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_OAUTH_TOKEN: undefined,
  CHATGPT_OAUTH_TOKEN: undefined,
} as const;
const IMPLICIT_OPENCLAW_RUNTIME = { id: "openclaw", source: "implicit" } as const;

function catalogEntry(id: string, api: ModelCatalogEntry["api"]): ModelCatalogEntry {
  return { id, name: id, provider: "openai", api };
}

async function listConfiguredModels(params: { catalog: ModelCatalogEntry[]; cfg: OpenClawConfig }) {
  const context = {
    getRuntimeConfig: () => params.cfg,
    loadGatewayModelCatalog: vi.fn(() => Promise.resolve(params.catalog)),
    loadGatewayModelCatalogSnapshot: vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        agentDir: "/tmp/models-list-configured-runtime-agent",
        config: params.cfg,
        entries: params.catalog,
        routeVariants: params.catalog,
      }),
    ),
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  return await buildModelsListResult({
    context,
    params: { view: "configured" },
  });
}

describe("models.list configured runtimes", () => {
  it("keeps configured provider rows visible when unavailable", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expect(
        listConfiguredModels({
          cfg,
          catalog: [catalogEntry("gpt-5.6", "openai-chatgpt-responses")],
        }),
      ).resolves.toEqual({
        models: [
          {
            id: "gpt-5.6",
            name: "GPT-5.6",
            provider: "openai",
            agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
            available: false,
          },
        ],
      });
    });
  });

  it("projects a configured Codex default missing from the prepared catalog", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-configured-codex-default-",
          agentEnv: "main",
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "openai:chatgpt": {
                type: "oauth",
                provider: "openai",
                access: "chatgpt-access",
                refresh: "chatgpt-refresh",
                expires: Date.now() + 30 * 60_000,
              },
            },
          });
          const cfg = {
            agents: {
              defaults: { model: { primary: "openai/gpt-5.6-sol" } },
              list: [
                {
                  id: "main",
                  default: true,
                  models: {
                    "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
                  },
                },
              ],
            },
          } as OpenClawConfig;

          await expect(listConfiguredModels({ cfg, catalog: [] })).resolves.toEqual({
            models: [
              {
                id: "gpt-5.6-sol",
                name: "gpt-5.6-sol",
                provider: "openai",
                agentRuntime: { id: "codex", source: "model" },
                available: true,
              },
            ],
          });
        },
      );
    });
  });
});
