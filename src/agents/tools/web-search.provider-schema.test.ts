import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../plugins/test-helpers/fs-fixtures.js";
import { projectProviderModelSchema } from "../../web-search/provider-schema.js";
import { createWebSearchTool } from "./web-search.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function resolveSearchContextSizeSchema(tool: ReturnType<typeof createWebSearchTool>): unknown {
  const parameters = tool?.parameters as
    | { properties?: { search_context_size?: unknown } }
    | undefined;
  return parameters?.properties?.search_context_size;
}

function resolveResultDepthSchema(tool: ReturnType<typeof createWebSearchTool>): unknown {
  const parameters = tool?.parameters as { properties?: { result_depth?: unknown } } | undefined;
  return parameters?.properties?.result_depth;
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

  it("loads model schema from an enabled installed plugin without loading its runtime", () => {
    const pluginRoot = makeTrackedTempDir("openclaw-web-search-model-schema", tempDirs);
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@openclaw/fixture-search",
        type: "commonjs",
        openclaw: { extensions: ["./index.js"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "fixture-search",
        activation: { onStartup: false },
        contracts: { webSearchProviders: ["fixture-search"] },
        configSchema: { type: "object" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      'throw new Error("runtime entry must remain unloaded");\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "web-search-contract-api.js"),
      `module.exports.createFixtureWebSearchProvider = () => ({
  id: "fixture-search",
  label: "Fixture Search",
  hint: "fixture",
  envVars: [],
  placeholder: "fixture",
  signupUrl: "https://example.com",
  credentialPath: "plugins.entries.fixture-search.config.apiKey",
  modelSchema: {
    parameters: {
      type: "object",
      properties: { result_depth: { type: "string", enum: ["brief", "deep"] } },
    },
    providerParameters: ["result_depth"],
  },
  getCredentialValue() {},
  setCredentialValue() {},
  createTool() { return null; },
});\n`,
      "utf8",
    );

    const tool = createWebSearchTool({
      config: {
        plugins: {
          load: { paths: [pluginRoot] },
          entries: { "fixture-search": { enabled: true } },
        },
        tools: { web: { search: { provider: "fixture-search" } } },
      },
      runtimeWebSearch: {
        selectedProvider: "fixture-search",
        providerSource: "configured",
        diagnostics: [],
      },
    });

    expect(resolveResultDepthSchema(tool)).toEqual({
      type: "string",
      enum: ["brief", "deep"],
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
