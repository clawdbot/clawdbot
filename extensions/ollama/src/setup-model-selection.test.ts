import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaModelsConfig,
  discoverOllamaModelsForSetup,
  findAvailableOllamaModelName,
  mergeUniqueModelNames,
  normalizeOllamaModelName,
  selectAppGuidedOllamaModelId,
} from "./setup-model-selection.js";

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
      selectAppGuidedOllamaModelId([
        { id: "llama3:8b", contextWindow: 32_768, supportsTools: true },
        { id: "qwen3:0.6b", contextWindow: 40_960, supportsTools: true },
        { id: "gemma4:e4b", contextWindow: 8_192, supportsTools: true },
      ]),
    ).toBe("qwen3:0.6b");
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
