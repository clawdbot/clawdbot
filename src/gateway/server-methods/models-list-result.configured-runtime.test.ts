import { describe, expect, it, vi } from "vitest";
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
async function listConfiguredModels(params: { cfg: OpenClawConfig }) {
  const context = {
    getRuntimeConfig: () => params.cfg,
    loadGatewayModelCatalog: vi.fn(() => Promise.resolve([])),
    loadGatewayModelCatalogSnapshot: vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        agentDir: "/tmp/models-list-configured-runtime-agent",
        config: params.cfg,
        entries: [],
        routeVariants: [],
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

          await expect(listConfiguredModels({ cfg })).resolves.toEqual({
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

  it("keeps a configured Codex default visible when route credentials are unavailable", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
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

      await expect(listConfiguredModels({ cfg })).resolves.toEqual({
        models: [
          {
            id: "gpt-5.6-sol",
            name: "gpt-5.6-sol",
            provider: "openai",
            agentRuntime: { id: "codex", source: "model" },
            available: false,
          },
        ],
      });
    });
  });

  it("projects a configured Codex default accepted by a provider wildcard", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            modelPolicy: { allow: ["openai/*"] },
          },
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

      await expect(listConfiguredModels({ cfg })).resolves.toEqual({
        models: [
          {
            id: "gpt-5.6-sol",
            name: "gpt-5.6-sol",
            provider: "openai",
            agentRuntime: { id: "codex", source: "model" },
            available: false,
          },
        ],
      });
    });
  });

  it("preserves an exact alias runtime binding through public projection", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-configured-codex-alias-",
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
              defaults: {
                model: { primary: "openai/gpt-5.4-codex" },
                modelPolicy: {},
                models: {
                  "openai/gpt-5.4": { agentRuntime: { id: "auto" } },
                  "openai/gpt-5.4-codex": { agentRuntime: { id: "codex" } },
                },
              },
            },
          } as OpenClawConfig;

          await expect(listConfiguredModels({ cfg })).resolves.toEqual({
            models: [
              {
                id: "gpt-5.4-codex",
                name: "gpt-5.4-codex",
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

  it("keeps a defaults alias when an agent canonical sibling does not match it", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-configured-codex-cross-scope-alias-",
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
              defaults: {
                model: { primary: "my-alias" },
                modelPolicy: {},
                models: {
                  "openai/gpt-5.4-codex": {
                    alias: "my-alias",
                    agentRuntime: { id: "codex" },
                  },
                },
              },
              list: [
                {
                  id: "main",
                  default: true,
                  models: {
                    "openai/gpt-5.4": {
                      alias: "my-alias",
                      agentRuntime: { id: "auto" },
                    },
                  },
                },
              ],
            },
          } as OpenClawConfig;

          await expect(listConfiguredModels({ cfg })).resolves.toEqual({
            models: [
              {
                id: "gpt-5.4-codex",
                name: "gpt-5.4-codex",
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
