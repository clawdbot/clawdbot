import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function withOpenRouterStateDir(run: (stateDir: string) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-openrouter-capabilities-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  for (const key of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  try {
    await run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function importOpenRouterModelCapabilities(scope: string) {
  return await importFreshModule<typeof import("./openrouter-model-capabilities.js")>(
    import.meta.url,
    `./openrouter-model-capabilities.js?scope=${scope}`,
  );
}

describe("openrouter-model-capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_STATE_DIR;
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
                    supported_parameters: ["reasoning"],
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

      expect(module.getOpenRouterModelCapabilities("acme/top-level-max-completion")).toMatchObject({
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 65432,
        maxTokens: 12345,
      });
      expect(module.getOpenRouterModelCapabilities("acme/top-level-max-output")).toMatchObject({
        input: ["text", "image"],
        reasoning: false,
        contextWindow: 54321,
        maxTokens: 23456,
      });
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
