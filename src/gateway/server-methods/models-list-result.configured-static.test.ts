import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  catalogEntry,
  listModels,
  providerCatalogEntry,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

describe("models.list configured static entries", () => {
  it("projects a configured runtime model from prepared static facts", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        list: [
          {
            id: "main",
            default: true,
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } as OpenClawConfig;

    await expect(
      listModels({
        catalog: [],
        staticEntries: [
          catalogEntry("gpt-5.6-sol", "openai-responses"),
          catalogEntry("gpt-unconfigured", "openai-responses"),
        ],
        cfg: config,
        view: "configured",
      }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-5.6-sol",
          provider: "openai",
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: false,
            devicePlacementSupported: false,
            source: "model",
          },
        }),
      ],
    });
  });

  it("projects agent aliases onto inherited default and fallback catalog rows", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.6-luna",
              fallbacks: ["claude-sonnet-4-6"],
            },
            models: {
              "openai/gpt-5.6-luna": { alias: "global-luna" },
              "anthropic/claude-sonnet-4-6": { alias: "global-sonnet" },
            },
          },
          entries: {
            main: {},
            worker: {
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
                "anthropic/claude-sonnet-4-6": { alias: "worker-sonnet" },
              },
            },
          },
        },
      } as OpenClawConfig;

      const result = await listModels({
        agentId: "worker",
        cfg,
        view: "configured",
        catalog: [
          catalogEntry("gpt-5.6-luna", "openai-responses"),
          providerCatalogEntry("anthropic", "claude-sonnet-4-6"),
        ],
      });

      const projected = Object.fromEntries(
        result.models.map((model) => [model.id, { alias: model.alias, tags: model.tags }]),
      );
      expect(projected).toMatchObject({
        "gpt-5.6-luna": {
          alias: "global-luna",
          tags: ["default", "configured"],
        },
        "claude-sonnet-4-6": {
          alias: "worker-sonnet",
          tags: ["fallback#1", "configured"],
        },
      });
    });
  });
});
