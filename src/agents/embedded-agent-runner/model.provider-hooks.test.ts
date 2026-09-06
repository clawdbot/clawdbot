import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { resolveAgentToolSurfacePlan } from "../tool-surface-plan.js";
import { DEFAULT_PROVIDER_RUNTIME_HOOKS, normalizeResolvedModel } from "./model.provider-hooks.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => ({
    manifestRegistry: { plugins: [] },
    owners: { providerEndpoints: [], providerRequests: new Map() },
  }),
}));

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "small-model",
    name: "Small model",
    provider: "custom-host",
    api: "ollama",
    baseUrl: "http://model-host.example:11434",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
    ...overrides,
  };
}

function toolSearchEnabled(resolvedModel: Model, config: OpenClawConfig = {}): boolean {
  return resolveAgentToolSurfacePlan({
    config,
    model: resolvedModel,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.id,
    forceDirectMessageTool: false,
    toolsEnabled: true,
    isRawModelRun: false,
  }).toolSearchControlsEnabled;
}

describe("resolved model Tool Search policy", () => {
  beforeAll(() => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  });
  afterAll(() => vi.unstubAllEnvs());

  it.each([
    { provider: "ollama", api: "ollama", id: "qwen3.5:4b", expected: true },
    { provider: "custom-host", api: "ollama", id: "qwen3.5:4b", expected: true },
    { provider: "custom-host", api: "ollama", id: "server-alias", expected: true },
    { provider: "lmstudio", api: "openai-completions", id: "small-model", expected: true },
    { provider: "ollama-cloud", api: "ollama", id: "cloud-model", expected: false },
    { provider: "custom-host", api: "ollama", id: "model:cloud", expected: false },
    { provider: "custom-host", api: "openai-responses", id: "hosted-model", expected: false },
  ] as const)("prepares $provider/$id using its $api policy", ({ expected, ...route }) => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: false } } },
    };
    const resolved = normalizeResolvedModel({
      provider: route.provider,
      model: model(route),
      cfg: config,
    });
    expect(toolSearchEnabled(resolved, config)).toBe(expected);
    expect(config.tools).toBeUndefined();
  });

  it("uses the final transport and clears a previous attempt's preference", () => {
    const original = model();
    const local = normalizeResolvedModel({ provider: original.provider, model: original });
    expect(toolSearchEnabled(local)).toBe(true);

    const hosted = normalizeResolvedModel({
      provider: original.provider,
      model: local,
      runtimeHooks: {
        ...DEFAULT_PROVIDER_RUNTIME_HOOKS,
        normalizeProviderTransportWithPlugin: () => ({
          api: "openai-responses",
          baseUrl: "https://hosted.example/v1",
        }),
      },
    });
    expect(hosted.baseUrl).toBe("https://hosted.example/v1");
    expect(toolSearchEnabled(hosted)).toBe(false);
    expect(toolSearchEnabled(local)).toBe(true);
  });

  it.each([
    { finalBaseUrl: "http://managed.example:8080/v1/", api: "openai-completions", expected: true },
    { finalBaseUrl: "https://hosted.example/v1", api: "openai-completions", expected: false },
    { finalBaseUrl: "https://ollama.com/v1", api: "ollama", expected: false },
  ] as const)(
    "limits managed inference defaults to $finalBaseUrl",
    ({ finalBaseUrl, api, expected }) => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            " CUSTOM-HOST ": {
              baseUrl: api === "ollama" ? finalBaseUrl : "http://managed.example:8080/v1",
              api,
              models: [],
              localService: { command: "/fixture/server" },
            },
          },
        },
      };
      const resolved = normalizeResolvedModel({
        provider: "custom-host",
        model: model({ api, baseUrl: finalBaseUrl }),
        cfg,
      });
      expect(toolSearchEnabled(resolved, cfg)).toBe(expected);
      expect(cfg.tools).toBeUndefined();
    },
  );
});
