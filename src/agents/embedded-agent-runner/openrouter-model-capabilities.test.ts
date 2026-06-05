// Coverage for OpenRouter model capability loading and cache invalidation.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

async function withOpenRouterStateDir(run: (stateDir: string) => Promise<void>) {
  // Each case gets an isolated state dir because the module persists capability
  // rows through the plugin state store across imports.
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-openrouter-capabilities-"));
  resetPluginStateStoreForTests();
  try {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        ALL_PROXY: "",
        all_proxy: "",
        HTTP_PROXY: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        https_proxy: "",
      },
      async () => {
        try {
          await run(stateDir);
        } finally {
          resetPluginStateStoreForTests();
        }
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function importOpenRouterModelCapabilities(scope: string) {
  // Import fresh per scope so module-level caches cannot mask persistence bugs.
  return await importFreshModule<typeof import("./openrouter-model-capabilities.js")>(
    import.meta.url,
    `./openrouter-model-capabilities.js?scope=${scope}`,
  );
}

describe("openrouter-model-capabilities", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.unstubAllGlobals();
  });

  it("uses top-level OpenRouter max token fields when top_provider is absent", async () => {
    await withOpenRouterStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "acme/top-level-max-completion",
                    name: "Top Level Max Completion",
                    architecture: { modality: "text+image->text" },
                    supported_parameters: ["reasoning", "tools"],
                    context_length: 65432,
                    max_completion_tokens: 12345,
                    pricing: { prompt: "0.000001", completion: "0.000002" },
                  },
                  {
                    id: "acme/top-level-max-output",
                    name: "Top Level Max Output",
                    modality: "text+image->text",
                    context_length: 54321,
                    max_output_tokens: 23456,
                    pricing: { prompt: "0.000003", completion: "0.000004" },
                  },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );

      const module = await importOpenRouterModelCapabilities("top-level-max-tokens");
      await module.loadOpenRouterModelCapabilities("acme/top-level-max-completion");

      const maxCompletion = module.getOpenRouterModelCapabilities("acme/top-level-max-completion");
      expect(maxCompletion?.input).toEqual(["text", "image"]);
      expect(maxCompletion?.reasoning).toBe(true);
      expect(maxCompletion?.supportsTools).toBe(true);
      expect(maxCompletion?.contextWindow).toBe(65432);
      expect(maxCompletion?.maxTokens).toBe(12345);

      const maxOutput = module.getOpenRouterModelCapabilities("acme/top-level-max-output");
      expect(maxOutput?.input).toEqual(["text", "image"]);
      expect(maxOutput?.reasoning).toBe(false);
      expect(maxOutput?.supportsTools).toBeUndefined();
      expect(maxOutput?.contextWindow).toBe(54321);
      expect(maxOutput?.maxTokens).toBe(23456);
    });
  });

  it("uses endpoint-specific OpenRouter context length when top_provider reports one", async () => {
    await withOpenRouterStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "nvidia/nemotron-3-super-120b-a12b:free",
                    name: "Nemotron 3 Super 120B Free",
                    architecture: { modality: "text->text" },
                    context_length: 1_000_000,
                    top_provider: {
                      context_length: 262_144,
                      max_completion_tokens: 262_144,
                    },
                    pricing: { prompt: "0", completion: "0" },
                  },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );

      const module = await importOpenRouterModelCapabilities("top-provider-context-length");
      await module.loadOpenRouterModelCapabilities("nvidia/nemotron-3-super-120b-a12b:free");

      expect(
        module.getOpenRouterModelCapabilities("nvidia/nemotron-3-super-120b-a12b:free"),
      ).toMatchObject({
        contextWindow: 262_144,
        maxTokens: 262_144,
      });
    });
  });

  it("does not reuse retired JSON caches with precomputed OpenRouter context windows", async () => {
    // Old JSON caches stored unnormalized provider context windows; force a live
    // refresh so endpoint-specific caps are used instead.
    await withOpenRouterStateDir(async (stateDir) => {
      const modelId = "nvidia/nemotron-3-super-120b-a12b:free";
      const cacheDir = join(stateDir, "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "openrouter-models.json"),
        JSON.stringify({
          version: 2,
          models: {
            [modelId]: {
              name: "Nemotron 3 Super 120B Free",
              input: ["text"],
              reasoning: false,
              contextWindow: 1_000_000,
              maxTokens: 262_144,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          },
        }),
      );

      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: modelId,
                  name: "Nemotron 3 Super 120B Free",
                  architecture: { modality: "text->text" },
                  context_length: 1_000_000,
                  top_provider: {
                    context_length: 262_144,
                    max_completion_tokens: 262_144,
                  },
                  pricing: { prompt: "0", completion: "0" },
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const module = await importOpenRouterModelCapabilities("old-context-window-cache");
      await module.loadOpenRouterModelCapabilities(modelId);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(module.getOpenRouterModelCapabilities(modelId)).toMatchObject({
        contextWindow: 262_144,
        maxTokens: 262_144,
      });
    });
  });

  it("loads cached OpenRouter capabilities from SQLite on the next import", async () => {
    await withOpenRouterStateDir(async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "acme/sqlite-cached-model",
                  name: "SQLite Cached Model",
                  architecture: { modality: "text+image->text" },
                  supported_parameters: ["tools"],
                  context_length: 8765,
                  max_completion_tokens: 4321,
                  pricing: { prompt: "0.000005", completion: "0.000006" },
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const firstModule = await importOpenRouterModelCapabilities("sqlite-cache-writer");
      await firstModule.loadOpenRouterModelCapabilities("acme/sqlite-cached-model");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const secondModule = await importOpenRouterModelCapabilities("sqlite-cache-reader");
      expect(secondModule.getOpenRouterModelCapabilities("acme/sqlite-cached-model")).toMatchObject(
        {
          input: ["text", "image"],
          supportsTools: true,
          contextWindow: 8765,
          maxTokens: 4321,
        },
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves explicit OpenRouter tool support metadata", async () => {
    await withOpenRouterStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "perplexity/sonar-deep-research",
                    name: "Sonar Deep Research",
                    supported_parameters: ["reasoning", "web_search_options"],
                  },
                  {
                    id: "google/gemini-2.5-pro",
                    name: "Gemini 2.5 Pro",
                    supported_parameters: ["reasoning", "tools"],
                  },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );

      const module = await importOpenRouterModelCapabilities("tool-support");
      await module.loadOpenRouterModelCapabilities("perplexity/sonar-deep-research");

      expect(
        module.getOpenRouterModelCapabilities("perplexity/sonar-deep-research")?.supportsTools,
      ).toBe(false);
      expect(module.getOpenRouterModelCapabilities("google/gemini-2.5-pro")?.supportsTools).toBe(
        true,
      );
    });
  });

  it("does not refetch immediately after an awaited miss for the same model id", async () => {
    await withOpenRouterStateDir(async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "acme/known-model",
                  name: "Known Model",
                  architecture: { modality: "text->text" },
                  context_length: 1234,
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const module = await importOpenRouterModelCapabilities("awaited-miss");
      await module.loadOpenRouterModelCapabilities("acme/missing-model");
      expect(module.getOpenRouterModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      expect(module.getOpenRouterModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
