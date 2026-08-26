import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaModelsConfig,
  discoverOllamaModelsForSetup,
  findAvailableOllamaModelName,
  mergeUniqueModelNames,
  normalizeOllamaModelName,
  selectAppGuidedOllamaModelFromDiscovery,
} from "./setup-model-selection.js";
import { promptAndConfigureOllama } from "./setup.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pendingAbortableResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

describe("Ollama onboarding model selection", () => {
  it("preserves catalog order while preferring an explicit latest tag", () => {
    expect(mergeUniqueModelNames(["gemma4", "qwen3:0.6b"], ["GEMMA4:latest"])).toEqual([
      "GEMMA4:latest",
      "qwen3:0.6b",
    ]);
  });

  it("resolves normalized custom model names to the installed latest tag", () => {
    expect(normalizeOllamaModelName("  OLLAMA/Gemma4  ")).toBe("Gemma4");
    expect(findAvailableOllamaModelName("Gemma4", ["qwen3:0.6b", "gemma4:latest"])).toBe(
      "gemma4:latest",
    );
  });

  it("keeps failed model inspections distinct from uninspected models", () => {
    const models = buildOllamaModelsConfig(
      ["deepseek-r1:14b", "uninspected"],
      new Map([["deepseek-r1:14b", { name: "deepseek-r1:14b", showInspectionFailed: true }]]),
    );

    expect(models[0]?.compat?.supportsTools).toBe(false);
    expect(models[0]?.reasoning).toBe(true);
    expect(models[1]?.compat?.supportsTools).toBe(true);
  });

  it("preserves discovered Gemma vision, reasoning, context, and tool capabilities", () => {
    const [model] = buildOllamaModelsConfig(
      ["gemma4:e2b"],
      new Map([
        [
          "gemma4:e2b",
          {
            name: "gemma4:e2b",
            contextWindow: 131_072,
            capabilities: ["completion", "tools", "vision", "thinking"],
          },
        ],
      ]),
    );

    expect(model).toMatchObject({
      id: "gemma4:e2b",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      compat: { supportsTools: true },
    });
  });

  it("selects a deterministic tools-capable model with enough context", () => {
    expect(
      selectAppGuidedOllamaModelFromDiscovery([
        { name: "llama3:8b", contextWindow: 32_768, capabilities: ["tools"] },
        { name: "qwen3:0.6b", contextWindow: 40_960, capabilities: ["tools"] },
        { name: "gemma4:e4b", contextWindow: 8_192, capabilities: ["tools"] },
      ]),
    ).toBe("qwen3:0.6b");
  });

  it.each([
    {
      description: "skips a smaller model with an explicit thinking capability",
      capabilities: ["tools", "thinking"],
      expected: "llama3.2:latest",
    },
    {
      description: "trusts explicit non-thinking capabilities over a reasoning-like model name",
      capabilities: ["tools"],
      expected: "deepseek-r1:8b",
    },
  ])("$description", ({ capabilities, expected }) => {
    expect(
      selectAppGuidedOllamaModelFromDiscovery([
        {
          name: "deepseek-r1:8b",
          contextWindow: 131_072,
          capabilities,
          size: 1_000,
        },
        {
          name: "orieg/gemma3-tools:12b-ft",
          contextWindow: 131_072,
          capabilities: ["tools"],
          size: 8_000,
        },
        {
          name: "llama3.2:latest",
          contextWindow: 131_072,
          capabilities: ["tools"],
          size: 2_000,
        },
      ]),
    ).toBe(expected);
  });

  it("selects the smallest explicitly non-thinking model during interactive setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return Response.json({
            models: [
              { name: "deepseek-r1:1b", size: 100 },
              { name: "llama3:70b", size: 70_000 },
            ],
          });
        }
        if (url.endsWith("/api/show")) {
          return Response.json({
            model_info: { "test.context_length": 32_768 },
            capabilities: ["completion", "tools"],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const prompter = {
      select: vi.fn().mockResolvedValueOnce("local-only"),
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;
    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const selected = result.config.models?.providers?.ollama?.models?.find(
      (model) => model.id === "deepseek-r1:1b",
    );

    expect(selected?.reasoning).toBe(false);
    expect(result.defaultModel).toBe("ollama/deepseek-r1:1b");
  });

  it("aborts pending model discovery with the setup signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        pendingAbortableResponse(init?.signal),
      ),
    );

    const discovery = discoverOllamaModelsForSetup({
      baseUrl: "http://127.0.0.1:11434",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts pending context enrichment with the setup signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "gemma4" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return pendingAbortableResponse(init?.signal);
      }),
    );

    const discovery = discoverOllamaModelsForSetup({
      baseUrl: "http://127.0.0.1:11434",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });
});
