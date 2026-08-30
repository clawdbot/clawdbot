import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createNamespacedModelConfig } from "../../test-utils/model-namespace-fixture.js";
import {
  catalogEntry,
  listModels,
  providerCatalogEntry,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

describe("models.list configured static entries", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits for the complete configured catalog when explicit refresh exceeds the browse deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const catalog = [
      { ...catalogEntry("gpt-5.6-luna", "openai-responses"), name: "Refreshed Luna" },
      { ...catalogEntry("gpt-5.6-sol", "openai-responses"), name: "Refreshed Sol" },
    ];
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    } as OpenClawConfig;

    const result = listModels({
      catalog,
      catalogLoadDelayMs: 800,
      preparedCatalog: catalog.slice(0, 1),
      publishedCatalog: catalog.slice(0, 1),
      cfg: config,
      refresh: true,
      view: "configured",
    });

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);

    expect((await result).models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gpt-5.6-luna", name: "Refreshed Luna" },
      { id: "gpt-5.6-sol", name: "Refreshed Sol" },
    ]);
  });

  it("keeps the published configured catalog when an implicit load exceeds the browse deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publishedCatalog = [
      { ...catalogEntry("gpt-5.6-luna", "openai-responses"), name: "Published Luna" },
      { ...catalogEntry("gpt-5.6-sol", "openai-responses"), name: "Published Sol" },
    ];
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    } as OpenClawConfig;

    const result = listModels({
      catalog: [],
      catalogLoadDelayMs: 800,
      publishedCatalog,
      cfg: config,
      view: "configured",
    });

    await vi.advanceTimersByTimeAsync(750);

    expect((await result).models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gpt-5.6-luna", name: "Published Luna" },
      { id: "gpt-5.6-sol", name: "Published Sol" },
    ]);
  });

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

  it("keeps exact model namespaces distinct in configured aliases and role tags", async () => {
    const ids = ["model", "custom/model"];
    const namespaceConfig = createNamespacedModelConfig();
    const cfg: OpenClawConfig = {
      ...namespaceConfig,
      agents: {
        defaults: {
          ...namespaceConfig.agents?.defaults,
          model: { primary: "custom/model", fallbacks: ["custom/custom/model"] },
        },
      },
    };
    const result = await listModels({
      cfg,
      view: "configured",
      catalog: ids.map((id) => providerCatalogEntry("custom", id)),
    });

    expect(
      Object.fromEntries(result.models.map(({ id, alias, tags }) => [id, { alias, tags }])),
    ).toEqual({
      model: { alias: "plain", tags: ["default", "configured"] },
      "custom/model": { alias: "nested", tags: ["fallback#1", "configured"] },
    });
  });
});
