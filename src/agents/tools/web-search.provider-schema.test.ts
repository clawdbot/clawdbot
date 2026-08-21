import { describe, expect, it } from "vitest";
import { projectProviderModelSchema } from "../../web-search/provider-schema.js";
import { createWebSearchTool } from "./web-search.js";

function resolveSearchContextSizeSchema(tool: ReturnType<typeof createWebSearchTool>): unknown {
  const parameters = tool?.parameters as
    | { properties?: { search_context_size?: unknown } }
    | undefined;
  return parameters?.properties?.search_context_size;
}

describe("web_search provider-aware model schema", () => {
  it("omits Perplexity search context size without a prepared provider", () => {
    expect(resolveSearchContextSizeSchema(createWebSearchTool())).toBeUndefined();
  });

  it("omits Perplexity search context size for a selected unsupported provider", () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "duckduckgo" } } } },
      runtimeWebSearch: {
        selectedProvider: "duckduckgo",
        providerSource: "configured",
        diagnostics: [],
      },
    });

    expect(resolveSearchContextSizeSchema(tool)).toBeUndefined();
  });

  it("advertises Perplexity search context size for a selected capable provider", () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      runtimeWebSearch: {
        selectedProvider: "perplexity",
        providerSource: "configured",
        diagnostics: [],
      },
    });

    expect(resolveSearchContextSizeSchema(tool)).toMatchObject({
      type: "string",
      enum: ["low", "medium", "high"],
    });
  });

  it("preserves required provider parameters in the projected schema", () => {
    const projected = projectProviderModelSchema(
      {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      {
        parameters: {
          type: "object",
          properties: { result_depth: { type: "string" } },
          required: ["result_depth"],
        },
        providerParameters: ["result_depth"],
      },
    );

    expect(projected).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        result_depth: { type: "string" },
      },
      required: ["query", "result_depth"],
    });
  });
});
