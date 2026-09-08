import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listModels } from "./models-list-result.openai-routes.test-support.js";

it.each([
  { configuredId: "arcee-ai/trinity-large-thinking", aliasId: "trinity-large-thinking" },
  { configuredId: "trinity-large-thinking", aliasId: "arcee-ai/trinity-large-thinking" },
])(
  "joins authored metadata and alias across $configuredId / $aliasId",
  async ({ configuredId, aliasId }) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "arcee-public-catalog-" },
      async (state) => {
        const authored: ModelCatalogEntry = {
          provider: "arcee",
          id: "arcee-ai/trinity-large-thinking",
          name: "Authored default",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          contextWindow: 32768,
          reasoning: false,
        };
        const cfg: OpenClawConfig = {
          plugins: { allow: ["arcee"] },
          agents: {
            defaults: {
              model: { primary: "arcee/trinity-large-thinking" },
              models: { [`arcee/${aliasId}`]: { alias: "Work account model" } },
            },
          },
          models: {
            mode: "replace",
            providers: {
              arcee: {
                baseUrl: "https://openrouter.ai/api/v1",
                api: "openai-completions",
                models: [
                  {
                    id: configuredId,
                    name: "Authored default",
                    contextWindow: 32768,
                    reasoning: false,
                    input: ["text"],
                    maxTokens: 2048,
                    cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
                  },
                ],
              },
            },
          },
        };
        await state.writeConfig(cfg);
        const result = await listModels({
          cfg,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          view: "all",
          catalog: [
            authored,
            {
              ...authored,
              id: "trinity-large-thinking",
              name: "Static sibling",
              contextWindow: 262144,
              reasoning: true,
            },
          ],
        });
        expect(result.models).toHaveLength(1);
        expect(result.models[0]).toMatchObject({
          provider: "arcee",
          id: "trinity-large-thinking",
          name: "Authored default",
          contextWindow: 32768,
          reasoning: false,
          alias: "Work account model",
          tags: expect.arrayContaining(["default", "configured"]),
        });
      },
    );
  },
);
