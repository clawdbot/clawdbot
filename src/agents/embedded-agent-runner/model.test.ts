// Broad coverage for embedded runner model resolution behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { discoverAuthStorage, discoverModels } from "../agent-model-discovery.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../auth-profiles.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "../plugin-model-catalog.js";
import { resetModelDiscoveryCacheForTest } from "./model-discovery-cache.test-support.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

const resolveBundledStaticCatalogModelMock = vi.hoisted(() => vi.fn());
const resolveBundledProviderStaticCatalogModelMock = vi.hoisted(() => vi.fn());
const resolveManifestModelCatalogProviderAliasMetadataMock = vi.hoisted(() =>
  vi.fn<
    (params: {
      provider: string;
      cfg?: { models?: { providers?: Record<string, { baseUrl?: string }> } };
    }) => {
      ambiguous?: true;
      provider: string;
      transport?: { api?: "azure-openai-responses"; baseUrl?: string };
    }
  >(),
);
const resolveRuntimeSyntheticAuthProviderRefsMock = vi.hoisted(() => vi.fn((): string[] => []));
const resolveRuntimeExternalAuthProviderRefsMock = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock("../model-suppression.js", () => {
  // Mirrors the canonical manifest-driven suppression in
  // extensions/qwen/openclaw.plugin.json and src/plugins/manifest-model-suppression.ts.
  function isQwenCodingPlanBaseUrl(value: string | undefined): boolean {
    const trimmed = value?.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
      return (
        hostname === "coding.dashscope.aliyuncs.com" ||
        hostname === "coding-intl.dashscope.aliyuncs.com"
      );
    } catch {
      return false;
    }
  }

  function resolveConfiguredQwenBaseUrl(config: unknown): string | undefined {
    const providers = (config as { models?: { providers?: Record<string, { baseUrl?: string }> } })
      ?.models?.providers;
    if (!providers) {
      return undefined;
    }
    for (const [provider, entry] of Object.entries(providers)) {
      const normalizedProvider = provider.trim().toLowerCase();
      if (normalizedProvider !== "qwen" && normalizedProvider !== "modelstudio") {
        continue;
      }
      const baseUrl = entry?.baseUrl?.trim();
      if (baseUrl) {
        return baseUrl;
      }
    }
    return undefined;
  }

  function isUnsupportedXaiMultiAgentModel(provider?: string, id?: string): boolean {
    return provider === "xai" && id?.trim().toLowerCase() === "grok-4.20-multi-agent-0309";
  }

  return {
    shouldSuppressBuiltInModel: ({
      provider,
      id,
      baseUrl,
      config,
    }: {
      provider?: string;
      id?: string;
      baseUrl?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      if (isUnsupportedXaiMultiAgentModel(provider, id)) {
        return true;
      }
      return (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(baseUrl ?? resolveConfiguredQwenBaseUrl(config))
      );
    },
    shouldUnconditionallySuppress: ({ provider, id }: { provider?: string; id?: string }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      return isUnsupportedXaiMultiAgentModel(provider, id);
    },
    buildSuppressedBuiltInModelError: ({
      provider,
      id,
      config,
    }: {
      provider?: string;
      id?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(resolveConfiguredQwenBaseUrl(config))
      ) {
        return "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.";
      }
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run \`openclaw models auth login --provider openai\` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.`;
      }
      if (isUnsupportedXaiMultiAgentModel(provider, id)) {
        return "Unknown model: xai/grok-4.20-multi-agent-0309. OpenClaw does not currently support xAI multi-agent models; choose another xAI model. See https://docs.openclaw.ai/providers/xai.";
      }
      return undefined;
    },
  };
});

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: resolveRuntimeSyntheticAuthProviderRefsMock,
  resolveRuntimeExternalAuthProviderRefs: resolveRuntimeExternalAuthProviderRefsMock,
}));

vi.mock("./model.static-catalog.js", () => ({
  canonicalizeManifestModelCatalogProviderAlias: (params: { provider: string }) =>
    resolveManifestModelCatalogProviderAliasMetadataMock(params).provider,
  resolveBundledProviderStaticCatalogModel: resolveBundledProviderStaticCatalogModelMock,
  resolveBundledStaticCatalogModel: resolveBundledStaticCatalogModelMock,
  resolveManifestModelCatalogProviderAliasMetadata:
    resolveManifestModelCatalogProviderAliasMetadataMock,
  resolveManifestModelCatalogProviderTransport: (params: { provider: string }) =>
    resolveManifestModelCatalogProviderAliasMetadataMock(params).transport,
}));

type OpenRouterModelCapabilities = NonNullable<
  ReturnType<typeof import("./openrouter-model-capabilities.js").getOpenRouterModelCapabilities>
>;

const mockGetOpenRouterModelCapabilities = vi.fn<
  (modelId: string) => OpenRouterModelCapabilities | undefined
>(() => undefined);
const mockLoadOpenRouterModelCapabilities = vi.fn<(modelId: string) => Promise<void>>(
  async () => {},
);
vi.mock("./openrouter-model-capabilities.js", () => ({
  getOpenRouterModelCapabilities: (modelId: string) => mockGetOpenRouterModelCapabilities(modelId),
  loadOpenRouterModelCapabilities: (modelId: string) =>
    mockLoadOpenRouterModelCapabilities(modelId),
}));

import type { OpenClawConfig, OpenClawConfigInput } from "../../config/config.js";
import { COPILOT_INTEGRATION_ID, buildCopilotIdeHeaders } from "../copilot-dynamic-headers.js";
import { getModelProviderLocalService } from "../provider-local-service.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { buildForwardCompatTemplate } from "./model.forward-compat.test-support.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { resolveModel, resolveModelAsync, resolveModelWithRegistry } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  OPENAI_CODEX_TEMPLATE_MODEL,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  resetModelDiscoveryCacheForTest();
  resetMockDiscoverModels(discoverModels);
  vi.mocked(discoverModels).mockClear();
  vi.mocked(discoverAuthStorage).mockClear();
  resolveRuntimeSyntheticAuthProviderRefsMock.mockReset();
  resolveRuntimeSyntheticAuthProviderRefsMock.mockReturnValue([]);
  resolveRuntimeExternalAuthProviderRefsMock.mockReset();
  resolveRuntimeExternalAuthProviderRefsMock.mockReturnValue([]);
  mockGetOpenRouterModelCapabilities.mockReset();
  mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);
  mockLoadOpenRouterModelCapabilities.mockReset();
  mockLoadOpenRouterModelCapabilities.mockResolvedValue();
  resolveBundledStaticCatalogModelMock.mockReset();
  resolveBundledProviderStaticCatalogModelMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockImplementation(({ provider, cfg }) => {
    const normalized = provider.trim().toLowerCase();
    const canonicalProvider =
      normalized === "moonshotai" || normalized === "moonshot-ai" ? "moonshot" : provider;
    const transport =
      provider === "azure-openai-responses" && cfg?.models?.providers?.[provider]?.baseUrl
        ? { api: "azure-openai-responses" as const }
        : undefined;
    return {
      provider: canonicalProvider,
      ...(transport ? { transport } : {}),
    };
  });
});

function createRuntimeHooks() {
  // Runtime hooks emulate provider plugin model discovery, transport
  // normalization, and OpenRouter capability loading without plugin imports.
  return createProviderRuntimeTestMock({
    handledDynamicProviders: [
      "openrouter",
      "github-copilot",
      "openai",
      "openai",
      "anthropic",
      "zai",
    ],
    getOpenRouterModelCapabilities: (modelId: string) =>
      mockGetOpenRouterModelCapabilities(modelId),
    loadOpenRouterModelCapabilities: async (modelId: string) => {
      await mockLoadOpenRouterModelCapabilities(modelId);
    },
  });
}

function resolveModelForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
) {
  // Most tests use fixed auth storage to keep assertions focused on model
  // resolution rather than auth discovery.
  const resolvedAgentDir = agentDir ?? "/tmp/agent";
  return resolveModel(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    runtimeHooks: createRuntimeHooks(),
  });
}

function resolveModelAsyncForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    allowBundledStaticCatalogFallback?: boolean;
    preferBundledStaticCatalogTransport?: boolean;
    retryTransientProviderRuntimeMiss?: boolean;
    runtimeHooks?: ReturnType<typeof createRuntimeHooks>;
    skipAgentDiscovery?: boolean;
  },
) {
  const resolvedAgentDir = agentDir ?? "/tmp/agent";
  return resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    ...options,
    runtimeHooks: options?.runtimeHooks ?? createRuntimeHooks(),
  });
}

type ResolveModelForTestResult =
  | ReturnType<typeof resolveModelForTest>
  | Awaited<ReturnType<typeof resolveModelAsyncForTest>>;

function expectResolvedModel(result: ResolveModelForTestResult) {
  if (result.error !== undefined) {
    throw new Error(`expected model resolution to succeed, got error: ${result.error}`);
  }
  if (!result.model) {
    throw new Error("expected model resolution to return a model");
  }
  return result.model;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

describe("resolveModel", () => {
  it("reuses agent discovery stores while the agent model files are unchanged", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        provider: "openai",
        ...makeModel("gpt-5.5"),
      },
    });

    const first = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("invalidates agent discovery stores when provider route config changes", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        provider: "openai",
        ...makeModel("gpt-5.5"),
      },
    });
    const providerConfig = (api: "openai-responses" | "openai-completions") =>
      ({
        models: {
          providers: {
            openai: {
              api,
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      }) as OpenClawConfig;

    const first = await resolveModelAsync(
      "openai",
      "gpt-5.5",
      "/tmp/agent",
      providerConfig("openai-responses"),
      { runtimeHooks: createRuntimeHooks() },
    );
    const second = await resolveModelAsync(
      "openai",
      "gpt-5.5",
      "/tmp/agent",
      providerConfig("openai-completions"),
      { runtimeHooks: createRuntimeHooks() },
    );

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(discoverModels).toHaveBeenCalledTimes(2);
  });

  it("invalidates agent discovery stores when generated plugin catalogs change", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cache-plugin-"));
    const agentDir = path.join(rootDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    mockDiscoveredModel(discoverModels, {
      provider: "zai",
      modelId: "glm-5.1",
      templateModel: {
        provider: "zai",
        ...makeModel("glm-5.1"),
      },
    });

    const first = await resolveModelAsync("zai", "glm-5.1", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const catalogPath = path.join(agentDir, "plugins", "zai", PLUGIN_MODEL_CATALOG_FILE);
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {},
      }),
    );
    const second = await resolveModelAsync("zai", "glm-5.1", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverModels).toHaveBeenCalledTimes(2);
  });

  it("invalidates agent discovery stores when inherited default auth changes", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cache-"));
    const agentDir = path.join(rootDir, "agent");
    const defaultAgentDir = path.join(rootDir, "default-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(defaultAgentDir, { recursive: true });
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, agentDir: defaultAgentDir },
          { id: "worker", agentDir },
        ],
      },
    } as unknown as OpenClawConfig;
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        provider: "openai",
        ...makeModel("gpt-5.5"),
      },
    });

    const first = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "one" } },
      },
      defaultAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const second = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(discoverModels).toHaveBeenCalledTimes(2);
  });

  it("uses the resolved default agent workspace for cached model discovery", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-workspace-"));
    const agentDir = path.join(rootDir, "agent");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(agentDir, { recursive: true });
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        provider: "openai",
        ...makeModel("gpt-5.5"),
      },
    });
    const cfg = {
      agents: {
        list: [{ id: "workspace-agent", default: true, agentDir, workspace: workspaceDir }],
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(result);
    expect(discoverModels).toHaveBeenCalledWith(
      expect.anything(),
      agentDir,
      expect.objectContaining({ workspaceDir }),
    );
  });

  it.each(["sync", "async"] as const)(
    "passes config into %s model discovery when auth storage is prebuilt",
    async (mode) => {
      const agentDir = `/tmp/agent-configured-${mode}`;
      const workspaceDir = `/tmp/workspace-configured-${mode}`;
      const authStorage = { mocked: true } as never;
      const cfg = {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      mockDiscoveredModel(discoverModels, {
        provider: "openai",
        modelId: "gpt-5.5",
        templateModel: {
          provider: "openai",
          ...makeModel("gpt-5.5"),
        },
      });

      const options = {
        authStorage,
        workspaceDir,
        runtimeHooks: createRuntimeHooks(),
      };
      const result =
        mode === "sync"
          ? resolveModel("openai", "gpt-5.5", agentDir, cfg, options)
          : await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, options);

      expectResolvedModel(result);
      expect(discoverModels).toHaveBeenCalledWith(authStorage, agentDir, {
        config: cfg,
        workspaceDir,
      });
    },
  );

  it("invalidates agent discovery stores when implicit main auth changes without config", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cache-state-"));
    const agentDir = path.join(rootDir, "agents", "worker", "agent");
    const mainAgentDir = path.join(rootDir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(mainAgentDir, { recursive: true });
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: rootDir }, async () => {
        mockDiscoveredModel(discoverModels, {
          provider: "openai",
          modelId: "gpt-5.5",
          templateModel: {
            provider: "openai",
            ...makeModel("gpt-5.5"),
          },
        });

        const first = await resolveModelAsync("openai", "gpt-5.5", agentDir, undefined, {
          runtimeHooks: createRuntimeHooks(),
        });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: { "openai:default": { type: "api_key", provider: "openai", key: "one" } },
          },
          mainAgentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        const second = await resolveModelAsync("openai", "gpt-5.5", agentDir, undefined, {
          runtimeHooks: createRuntimeHooks(),
        });

        expectResolvedModel(first);
        expectResolvedModel(second);
        expect(discoverAuthStorage).toHaveBeenCalledTimes(2);
        expect(discoverModels).toHaveBeenCalledTimes(2);
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not cache agent discovery stores while runtime auth snapshots are active", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            openai: { type: "api_key", key: "one" },
          },
        } as never,
      },
    ]);
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        provider: "openai",
        ...makeModel("gpt-5.5"),
      },
    });

    const first = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(discoverModels).toHaveBeenCalledTimes(2);
  });

  it("does not cache agent discovery stores while plugin auth overlays are active", async () => {
    resolveRuntimeSyntheticAuthProviderRefsMock.mockReturnValue(["runtime-provider"]);
    resolveRuntimeExternalAuthProviderRefsMock.mockReturnValue(["external-provider"]);
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        provider: "openai",
        ...makeModel("gpt-5.5"),
      },
    });

    const first = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(discoverModels).toHaveBeenCalledTimes(2);
  });

  it("skips OpenClaw auth and model discovery during dynamic model resolution", async () => {
    const result = await resolveModelAsync(
      "openrouter",
      "openrouter/auto",
      "/tmp/agent",
      undefined,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "openrouter",
      id: "openrouter/auto",
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("resolves opt-in bundled static catalog rows while skipping agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "mistral",
      id: "mistral-medium-3-5",
      name: "Mistral Medium 3.5",
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 8192,
    });

    const result = await resolveModelAsync(
      "mistral",
      "mistral-medium-3-5",
      "/tmp/agent",
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "mistral",
      id: "mistral-medium-3-5",
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 8192,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: undefined,
      workspaceDir: undefined,
    });
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("resolves opt-in provider static catalog rows while skipping agent discovery", async () => {
    resolveBundledProviderStaticCatalogModelMock.mockResolvedValueOnce({
      provider: "google",
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });

    const result = await resolveModelAsync(
      "google",
      "gemini-3.1-pro-preview",
      "/tmp/agent",
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "google",
      id: "gemini-3.1-pro-preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg: undefined,
      workspaceDir: undefined,
    });
    expect(resolveBundledProviderStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg: undefined,
      workspaceDir: undefined,
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("falls back to bundled static catalog rows without agent discovery", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn(() => undefined);

    const result = await resolveModelAsync("openai", "gpt-5.3-codex", "/tmp/agent", cfg, {
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      runtimeHooks: {
        ...baseRuntimeHooks,
        prepareProviderDynamicModel,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.3-codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledTimes(1);
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.3-codex",
        cfg,
      }),
    );
    expect(prepareProviderDynamicModel).toHaveBeenCalled();
    expect(runProviderDynamicModel).toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("resolves a deferred Fireworks manifest id from the bundled static catalog", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p6",
      name: "Kimi K2.6",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0.95, output: 4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 262144,
    });

    const result = await resolveModelAsync(
      "fireworks",
      "accounts/fireworks/models/kimi-k2p6",
      "/tmp/agent",
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p6",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      contextWindow: 262144,
      maxTokens: 262144,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p6",
      }),
    );
  });

  it("prefers user openclaw.json config over the Fireworks manifest for the same id", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValue({
      ...makeModel("accounts/fireworks/models/kimi-k2p6"),
      provider: "fireworks",
      name: "Kimi K2.6",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 262_144,
    });
    const cfg = {
      models: {
        providers: {
          fireworks: {
            api: "openai-completions",
            baseUrl: "https://api.fireworks.ai/inference/v1",
            models: [
              {
                ...makeModel("accounts/fireworks/models/kimi-k2p6"),
                name: "Kimi K2.6 (user override)",
                contextWindow: 300_000,
                maxTokens: 300_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest(
      "fireworks",
      "accounts/fireworks/models/kimi-k2p6",
      "/tmp/agent",
      cfg,
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p6",
      contextWindow: 300_000,
      maxTokens: 300_000,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p6",
        cfg,
      }),
    );
  });

  it("keeps provider dynamic metadata for runtime-preferred models", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123_456,
      maxTokens: 64_000,
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn(() => ({
      provider: "openai",
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    }));
    const shouldPreferProviderRuntimeResolvedModel = vi.fn(() => true);

    const result = await resolveModelAsync("openai", "gpt-5.5-pro", "/tmp/agent", undefined, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: {
        ...baseRuntimeHooks,
        prepareProviderDynamicModel,
        runProviderDynamicModel,
        shouldPreferProviderRuntimeResolvedModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.5-pro",
      api: "openai-chatgpt-responses",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(prepareProviderDynamicModel).toHaveBeenCalled();
    expect(runProviderDynamicModel).toHaveBeenCalled();
    expect(shouldPreferProviderRuntimeResolvedModel).toHaveBeenCalled();
  });

  it("keeps the prepared auth mode through async provider model resolution", async () => {
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn((params: { context: { authProfileMode?: string } }) => ({
      provider: "openai",
      ...makeModel("gpt-5.5"),
      api:
        params.context.authProfileMode === "api_key"
          ? ("openai-responses" as const)
          : ("openai-chatgpt-responses" as const),
      baseUrl:
        params.context.authProfileMode === "api_key"
          ? "https://api.openai.com/v1"
          : "https://chatgpt.com/backend-api",
    }));

    const result = await resolveModelAsync("openai", "gpt-5.5", "/tmp/agent", undefined, {
      authProfileMode: "api_key",
      runtimeHooks: {
        ...baseRuntimeHooks,
        prepareProviderDynamicModel,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expectRecordFields(mockCallArg(prepareProviderDynamicModel).context, {
      authProfileMode: "api_key",
    });
    expectRecordFields(mockCallArg(runProviderDynamicModel).context, {
      authProfileMode: "api_key",
    });
  });

  it("looks up each static fallback candidate with its own normalized model id", async () => {
    resolveBundledStaticCatalogModelMock.mockImplementation(({ provider, modelId }) => ({
      provider,
      id: modelId,
      name: modelId,
      api: "openai-responses",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));

    const anthropicResult = await resolveModelAsync(
      "anthropic",
      "anthropic/claude-haiku-4-5",
      "/tmp/agent",
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
        skipProviderRuntimeHooks: true,
      },
    );
    const openaiResult = await resolveModelAsync("openai", "gpt-4o", "/tmp/agent", undefined, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
      skipProviderRuntimeHooks: true,
    });

    expectRecordFields(expectResolvedModel(anthropicResult), {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
    expectRecordFields(expectResolvedModel(openaiResult), {
      provider: "openai",
      id: "gpt-4o",
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      cfg: undefined,
      workspaceDir: undefined,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-4o",
      cfg: undefined,
      workspaceDir: undefined,
    });
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "claude-haiku-4-5",
      }),
    );
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "anthropic/claude-haiku-4-5",
      }),
    );
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("applies provider overrides to bundled static catalog rows while skipping agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "mistral",
      id: "mistral-medium-3-5",
      name: "Mistral Medium 3.5",
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 8192,
      mediaInput: {
        image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
      },
    });
    const cfg = {
      models: {
        providers: {
          mistral: {
            baseUrl: "https://mistral-proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Proxy": "static-fast-path" },
            request: { proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" } },
            localService: {
              command: "/opt/mistral/start",
              args: ["--port", "18080"],
              healthUrl: "http://127.0.0.1:18080/health",
            },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync("mistral", "mistral-medium-3-5", "/tmp/agent", cfg, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expect(model.baseUrl).toBe("https://mistral-proxy.example.com/v1");
    expect(model.headers).toEqual({ "X-Proxy": "static-fast-path" });
    expect(getModelProviderRequestTransport(model)).toEqual({
      proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" },
    });
    expect(getModelProviderLocalService(model)).toEqual({
      command: "/opt/mistral/start",
      args: ["--port", "18080"],
      healthUrl: "http://127.0.0.1:18080/health",
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("merges bundled static media input into resolved models when opted in", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5-pro",
      templateModel: {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      },
    });
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
      mediaInput: {
        image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
      },
    });

    const result = await resolveModelAsync("openai", "gpt-5.5-pro", "/tmp/agent", undefined, {
      allowBundledStaticCatalogFallback: true,
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent"),
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect((expectResolvedModel(result) as { mediaInput?: unknown }).mediaInput).toEqual({
      image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      cfg: undefined,
      workspaceDir: undefined,
    });
  });

  it("merges configured media input with discovered model metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "vision-model",
      templateModel: {
        id: "vision-model",
        name: "Vision Model",
        provider: "custom",
        api: "openai-responses",
        baseUrl: "https://models.example.com/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        mediaInput: {
          image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
        },
      },
    });

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", {
      models: {
        providers: {
          custom: {
            baseUrl: "https://models.example.com/v1",
            models: [
              {
                id: "vision-model",
                name: "Vision Model",
                mediaInput: { image: { maxBytes: 1 } },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect((expectResolvedModel(result) as { mediaInput?: unknown }).mediaInput).toEqual({
      image: { maxBytes: 1, maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
    });
  });

  it("does not use bundled static catalog rows unless the caller opts in", async () => {
    const result = await resolveModelAsync(
      "mistral",
      "mistral-medium-3-5",
      "/tmp/agent",
      undefined,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: mistral/mistral-medium-3-5");
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("defaults model input to text when discovery omits input", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "missing-input",
      templateModel: {
        id: "missing-input",
        name: "missing-input",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://localhost:9999",
        reasoning: false,
        // NOTE: deliberately omit input to simulate buggy/custom catalogs.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    });

    const result = resolveModelForTest("custom", "missing-input", "/tmp/agent", {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9999",
            api: "openai-completions",
            // Intentionally keep this minimal — the discovered model provides the rest.
            models: [{ id: "missing-input", name: "missing-input" }],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(expectResolvedModel(result).input).toEqual(["text"]);
  });

  it("defaults missing model cost before handing models to OpenClaw", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 400_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    };

    const result = resolveModelForTest("openai", "gpt-5.5", "/tmp/agent", cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.5",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("includes provider baseUrl in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.baseUrl).toBe("http://localhost:9000");
    expect(model.provider).toBe("custom");
    expect(model.id).toBe("missing-model");
    expect(model.api).toBe("openai-completions");
  });

  it("defaults baseUrl-only Google fallback models to native Gemini transport", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google", "gemini-2.5-flash-lite", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.provider).toBe("google");
    expect(model.id).toBe("gemini-2.5-flash-lite");
    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("defaults baseUrl-only Google Vertex fallback models to native Vertex transport", () => {
    const cfg = {
      models: {
        providers: {
          "google-vertex": {
            baseUrl: "https://aiplatform.googleapis.com",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google-vertex", "gemini-2.5-flash", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.provider).toBe("google-vertex");
    expect(model.id).toBe("gemini-2.5-flash");
    expect(model.api).toBe("google-vertex");
    expect(model.baseUrl).toBe("https://aiplatform.googleapis.com");
  });

  it("uses bundled static metadata for configured provider fallback token limits", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "xiaomi-token-plan",
      id: "mimo-v2.5-pro",
      name: "Xiaomi MiMo V2.5 Pro",
      api: "openai-completions",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 32_000,
    });
    const cfg = {
      models: {
        providers: {
          "xiaomi-token-plan": {
            baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("xiaomi-token-plan", "mimo-v2.5-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.name).toBe("Xiaomi MiMo V2.5 Pro");
    expect(model.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxTokens).toBe(32_000);
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "xiaomi-token-plan",
      modelId: "mimo-v2.5-pro",
      cfg,
      workspaceDir: expect.any(String),
      includeRuntimeDiscovery: true,
    });
  });

  it("leaves maxTokens undefined when no configured or catalog value is available (regression: #98295)", () => {
    // Regression for https://github.com/openclaw/openclaw/issues/98295.
    // A custom provider entry without maxTokens (and no matching bundled
    // static catalog row) must not synthesize an oversized output cap from
    // DEFAULT_CONTEXT_TOKENS. Leaving maxTokens undefined lets the transport
    // omit `max_completion_tokens` so the provider applies its own default,
    // avoiding HTTP 400 (Param Incorrect) from strict OpenAI-compatible
    // servers whose completion-token ceiling is below the synthesized value.
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(undefined);
    const cfg = {
      models: {
        providers: {
          xiaomi: {
            baseUrl: "https://api.xiaomimimo.com/v1",
            models: [
              {
                id: "mimo-v2.5-pro",
                name: "mimo-v2.5-pro",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("xiaomi", "mimo-v2.5-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.id).toBe("mimo-v2.5-pro");
    expect(model.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(model.maxTokens).toBeUndefined();
  });

  it("inherits bundled static transport for configured provider fallback models", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    });
    const cfg = {
      models: {
        providers: {
          deepseek: {
            baseUrl: "",
            models: [
              {
                id: "deepseek-v4-pro",
                name: "Custom DeepSeek V4 Pro",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4_096,
                compat: {
                  supportsReasoningEffort: false,
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("deepseek", "deepseek-v4-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      name: "Custom DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
      }),
    );
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      cfg,
      workspaceDir: expect.any(String),
      includeRuntimeDiscovery: true,
    });
  });

  it("fills missing configured provider runtime transport from bundled static metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    });
    const cfg = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-pro",
                name: "Custom DeepSeek V4 Pro",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4_096,
                thinkingLevelMap: { off: null },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const baseRuntimeHooks = createRuntimeHooks();
    const runProviderDynamicModel = vi.fn(() => ({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "Custom DeepSeek V4 Pro",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4_096,
    }));

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", "/tmp/agent", cfg, {
      runtimeHooks: {
        ...baseRuntimeHooks,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect(runProviderDynamicModel).toHaveBeenCalled();
  });

  it("resolves configured DeepSeek probe models through bundled static transport without agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    });
    const cfg = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-pro",
                name: "Custom DeepSeek V4 Pro",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4_096,
                thinkingLevelMap: { off: null },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", "/tmp/agent", cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      name: "Custom DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect((model as { thinkingLevelMap?: unknown }).thinkingLevelMap).toEqual({ off: null });
  });

  it("keeps provider runtime transport ahead of bundled static fallback metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
    const cfg = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-pro",
                name: "Custom DeepSeek V4 Pro",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const baseRuntimeHooks = createRuntimeHooks();
    const runProviderDynamicModel = vi.fn(() => ({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "Runtime DeepSeek V4 Pro",
      api: "openai-responses" as const,
      baseUrl: "https://runtime.deepseek.example/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4_096,
    }));

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", "/tmp/agent", cfg, {
      runtimeHooks: {
        ...baseRuntimeHooks,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-responses",
      baseUrl: "https://runtime.deepseek.example/v1",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(runProviderDynamicModel).toHaveBeenCalled();
  });

  it("keeps configured transport overrides ahead of bundled static fallback metadata", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
    const cfg = {
      models: {
        providers: {
          deepseek: {
            baseUrl: "https://deepseek-proxy.example.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "deepseek-v4-pro",
                name: "Custom DeepSeek V4 Pro",
                baseUrl: "https://deepseek-model-proxy.example.com/v1",
                api: "openai-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("deepseek", "deepseek-v4-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-responses",
      baseUrl: "https://deepseek-model-proxy.example.com/v1",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
  });

  it("keeps bundled static baseUrl when provider api is configured without a baseUrl", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-responses",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
    const cfg = {
      models: {
        providers: {
          deepseek: {
            api: "openai-completions",
            models: [
              {
                id: "deepseek-v4-pro",
                name: "Custom DeepSeek V4 Pro",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4_096,
                thinkingLevelMap: { off: null },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("deepseek", "deepseek-v4-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.thinkingLevelMap).toEqual({ off: null });
  });

  it("keeps provider token overrides ahead of bundled static fallback metadata", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "xiaomi-token-plan",
      id: "mimo-v2.5-pro",
      name: "Xiaomi MiMo V2.5 Pro",
      api: "openai-completions",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
      contextWindow: 1_048_576,
      contextTokens: 500_000,
      maxTokens: 32_000,
    });
    const cfg = {
      models: {
        providers: {
          "xiaomi-token-plan": {
            baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
            api: "openai-completions",
            contextWindow: 100_000,
            contextTokens: 90_000,
            maxTokens: 512,
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("xiaomi-token-plan", "mimo-v2.5-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      contextWindow: 100_000,
      contextTokens: 90_000,
      maxTokens: 512,
    });
  });

  it("does not synthesize unknown models from timeout-only provider overlays", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            timeoutSeconds: 300,
            baseUrl: "",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "typo-model", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai/typo-model");
  });

  it("does not create fallback models from provider overlays alone", () => {
    const cfg = {
      models: {
        providers: {
          typoProvider: {
            timeoutSeconds: 600,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = resolveModelForTest(
      "typoProvider",
      "typoed-model",
      "/tmp/agent",
      cfg as unknown as OpenClawConfig,
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: typoProvider/typoed-model");
  });

  it("does not create fallback models from built-in provider api overlays", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = resolveModelForTest(
      "openai",
      "typoed-model",
      "/tmp/agent",
      cfg as unknown as OpenClawConfig,
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai/typoed-model");
  });

  it("resolves per-model api and baseUrl override in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          "my-router": {
            baseUrl: "http://localhost:8080",
            api: "ollama",
            models: [
              {
                id: "my-router/claude",
                name: "Claude via Router",
                api: "anthropic-messages",
                input: ["text", "image"],
                contextWindow: 200_000,
              },
              {
                id: "my-router/gpt",
                name: "GPT via Router",
                api: "openai-completions",
                baseUrl: "http://localhost:8080/v1",
                input: ["text"],
                contextWindow: 400_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const claude = resolveModelForTest("my-router", "my-router/claude", "/tmp/agent", cfg);
    const claudeModel = expectResolvedModel(claude);
    expect(claudeModel.api).toBe("anthropic-messages");
    expect(claudeModel.baseUrl).toBe("http://localhost:8080");
    expect(claudeModel.maxTokens).toBeUndefined();

    const gpt = resolveModelForTest("my-router", "my-router/gpt", "/tmp/agent", cfg);
    const gptModel = expectResolvedModel(gpt);
    expect(gptModel.api).toBe("openai-completions");
    expect(gptModel.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("preserves normalized inline provider transport when static metadata is merged", () => {
    const cfg = {
      models: {
        providers: {
          "my-gemini": {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [
              {
                id: "gemini-pro",
                name: "Gemini Pro",
                input: ["text"],
                contextWindow: 32_768,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("my-gemini", "gemini-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("defaults baseUrl-only local custom fallback models to chat completions", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "local-agent-proxy/gpt-5.2" },
        },
      },
      models: {
        providers: {
          "local-agent-proxy": {
            baseUrl: "http://127.0.0.1:3000/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("local-agent-proxy", "gpt-5.2", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      provider: "local-agent-proxy",
      id: "gpt-5.2",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:3000/v1",
    });
    expect(getModelProviderRequestTransport(model)).toBeUndefined();
  });

  it("attaches provider localService metadata to configured fallback models", () => {
    const cfg = {
      models: {
        providers: {
          ds4: {
            baseUrl: "http://127.0.0.1:18000/v1",
            api: "openai-completions",
            localService: {
              command: "/opt/ds4/ds4-server",
              args: ["--port", "18000"],
              healthUrl: "http://127.0.0.1:18000/v1/models",
              readyTimeoutMs: 180_000,
              idleStopMs: 0,
            },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ds4", "deepseek-v4-flash", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(getModelProviderLocalService(model)).toEqual({
      command: "/opt/ds4/ds4-server",
      args: ["--port", "18000"],
      healthUrl: "http://127.0.0.1:18000/v1/models",
      readyTimeoutMs: 180_000,
      idleStopMs: 0,
    });
  });

  it("resolves explicitly configured qwen3.6-plus before Coding Plan built-in suppression", () => {
    const cfg = {
      models: {
        providers: {
          qwen: {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen3.6-plus",
                name: "qwen3.6-plus",
                input: ["text", "image"],
                reasoning: false,
                contextWindow: 1_000_000,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("qwen", "qwen3.6-plus", "/tmp/agent", cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "qwen",
      id: "qwen3.6-plus",
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
  });

  it("keeps unconfigured qwen3.6-plus suppressed on Coding Plan endpoints", () => {
    const cfg = {
      models: {
        providers: {
          qwen: {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("qwen", "qwen3.6-plus", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.",
    );
  });

  it("#74451: resolves explicitly configured openai/gpt-5.4-mini inline entries", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            models: [
              {
                id: "gpt-5.4-mini",
                name: "GPT-5.4 mini",
                api: "openai-chatgpt-responses",
                contextWindow: 400_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4-mini", "/tmp/agent", cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-chatgpt-responses",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes Google fallback baseUrls for custom providers", () => {
    const cfg = {
      models: {
        providers: {
          "google-paid": {
            baseUrl: "https://generativelanguage.googleapis.com",
            api: "google-generative-ai",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google-paid", "missing-model", "/tmp/agent", cfg);

    expect(expectResolvedModel(result).baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("normalizes configured Google override baseUrls when provider api is omitted", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "google",
      modelId: "gemini-2.5-pro",
      templateModel: {
        ...makeModel("gemini-2.5-pro"),
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    });

    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google", "gemini-2.5-pro", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("normalizes custom api.openai.com providers to responses transport", () => {
    const cfg = {
      models: {
        providers: {
          "custom-openai": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("gpt-5.4"),
                provider: "custom-openai",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom-openai", "gpt-5.4", "/tmp/agent", cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("normalizes custom api.x.ai providers to responses transport", () => {
    const cfg = {
      models: {
        providers: {
          "custom-xai": {
            baseUrl: "https://api.x.ai/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("grok-4.1-fast"),
                provider: "custom-xai",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom-xai", "grok-4.1-fast", "/tmp/agent", cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "custom-xai",
      id: "grok-4.1-fast",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("adds GitHub Copilot IDE headers to dynamic resolved model headers for native compaction", () => {
    const result = resolveModelForTest("github-copilot", "gpt-5.5", "/tmp/agent");
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      ...buildCopilotIdeHeaders(),
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
      "Openai-Organization": "github-copilot",
    });
  });

  it("adds GitHub Copilot IDE headers to configured resolved model headers for native compaction", () => {
    const cfg = {
      models: {
        providers: {
          "github-copilot": {
            baseUrl: "https://api.githubcopilot.com",
            api: "openai-responses",
            models: [makeModel("gpt-5.5")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("github-copilot", "gpt-5.5", "/tmp/agent", cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      ...buildCopilotIdeHeaders(),
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
      "Openai-Organization": "github-copilot",
    });
  });

  it("includes provider headers in provider fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: { "X-Custom-Auth": "token-123" },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    // Requesting a non-listed model forces the providerCfg fallback branch.
    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops SecretRef marker provider headers in fallback models", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: {
              Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
              "X-Managed": "secretref-managed",
              "X-Custom-Auth": "token-123",
            },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops marker headers from discovered models.json entries", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "listed-model",
      templateModel: {
        ...makeModel("listed-model"),
        provider: "custom",
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
      },
    });

    const result = resolveModelForTest("custom", "listed-model", "/tmp/agent");
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Static": "tenant-a",
    });
  });

  it("prefers matching configured model metadata for fallback token limits", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                contextWindow: 4096,
                maxTokens: 1024,
              },
              {
                ...makeModel("model-b"),
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);
    const model = expectResolvedModel(result);

    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(32768);
  });

  it("merges configured model params with agent defaults for resolved models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3:32b",
      templateModel: {
        ...makeModel("qwen3:32b"),
        provider: "ollama",
        params: { num_ctx: 4096, keep_alive: "1m" },
      },
    });
    const cfg = {
      agents: {
        defaults: {
          models: {
            "OLLAMA/qwen3:32B": {
              params: { num_ctx: 8192, thinking: "low" },
            },
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            models: [
              {
                ...makeModel("qwen3:32b"),
                params: { num_ctx: 16384 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3:32b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 16384,
      keep_alive: "1m",
      thinking: "low",
    });
  });

  it("applies configured provider params to resolved models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3:32b",
      templateModel: {
        ...makeModel("qwen3:32b"),
        provider: "ollama",
        params: { keep_alive: "1m" },
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            params: { num_ctx: 65536, top_p: 0.9 },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3:32b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      keep_alive: "1m",
      num_ctx: 65536,
      top_p: 0.9,
    });
  });

  it("resolves provider request timeout metadata for configured provider models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3:32b",
      templateModel: {
        ...makeModel("qwen3:32b"),
        provider: "ollama",
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            timeoutSeconds: 300,
            models: [makeModel("qwen3:32b")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3:32b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      300_000,
    );
  });

  it("resolves provider request timeout metadata from built-in provider overlays", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        ...makeModel("gpt-5.5"),
        provider: "openai",
      },
    });
    const cfg = {
      models: {
        providers: {
          openai: {
            timeoutSeconds: 600,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = resolveModelForTest(
      "openai",
      "gpt-5.5",
      "/tmp/agent",
      cfg as unknown as OpenClawConfig,
    );

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      600_000,
    );
  });

  it("caps oversized provider request timeout metadata at the timer-safe ceiling", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        ...makeModel("gpt-5.5"),
        provider: "openai",
      },
    });
    const cfg = {
      models: {
        providers: {
          openai: {
            timeoutSeconds: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = resolveModelForTest(
      "openai",
      "gpt-5.5",
      "/tmp/agent",
      cfg as unknown as OpenClawConfig,
    );

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("uses provider-level context defaults over discovered metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      templateModel: {
        ...makeModel("qwen3.5:9b"),
        provider: "ollama",
        contextWindow: 216_000,
        contextTokens: 216_000,
        maxTokens: 65_536,
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            contextWindow: 8_192,
            contextTokens: 8_000,
            models: [{ id: "qwen3.5:9b", name: "qwen3.5:9b" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3.5:9b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(8_192);
    expect((result.model as { contextTokens?: number } | undefined)?.contextTokens).toBe(8_000);
    expect(result.model?.maxTokens).toBe(8_192);
  });

  it("keeps per-model context values above provider-level defaults", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      templateModel: {
        ...makeModel("qwen3.5:9b"),
        provider: "ollama",
        contextWindow: 216_000,
        maxTokens: 65_536,
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            contextWindow: 8_192,
            maxTokens: 4_096,
            models: [
              {
                id: "qwen3.5:9b",
                name: "qwen3.5:9b",
                contextWindow: 16_384,
                maxTokens: 12_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3.5:9b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(16_384);
    expect(result.model?.maxTokens).toBe(12_000);
  });

  it("applies agent default model params without explicit provider config", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "llama3.2",
      templateModel: {
        ...makeModel("llama3.2"),
        provider: "ollama",
      },
    });
    const cfg = {
      agents: {
        defaults: {
          models: {
            "ollama/llama3.2": {
              params: { num_ctx: 32768 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "llama3.2", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 32768,
    });
  });

  it("propagates reasoning from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                reasoning: false,
              },
              {
                ...makeModel("model-b"),
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.reasoning).toBe(true);
  });

  it("propagates compat from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("Qwen/Qwen3-8B"),
                compat: { thinkingFormat: "qwen-chat-template" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("vllm", "Qwen/Qwen3-8B", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.compat).toEqual(
      expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
    );
    expect(result.model?.reasoning).toBe(false);
  });

  it("lets configured vLLM Qwen compat override stale discovered reasoning", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "vllm",
      modelId: "Qwen/Qwen3-8B",
      templateModel: {
        ...makeModel("Qwen/Qwen3-8B"),
        provider: "vllm",
        api: "openai-completions",
        baseUrl: "http://localhost:9000",
        reasoning: false,
        compat: { supportsStrictMode: false },
      },
    });
    const cfg = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                id: "Qwen/Qwen3-8B",
                name: "Qwen/Qwen3-8B",
                compat: { thinkingFormat: "qwen-chat-template" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("vllm", "Qwen/Qwen3-8B", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(true);
    expect(result.model?.compat).toEqual(
      expect.objectContaining({
        supportsStrictMode: false,
        thinkingFormat: "qwen-chat-template",
      }),
    );
  });

  it("infers reasoning for matching vLLM Qwen compat fallback models", () => {
    const cfg = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                id: "Qwen/Qwen3-8B",
                name: "Qwen/Qwen3-8B",
                compat: { thinkingFormat: "qwen-chat-template" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("vllm", "Qwen/Qwen3-8B", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(true);
  });

  it("propagates image input capability from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text"],
              },
              {
                ...makeModel("model-b"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("propagates image input when configured model ids include the provider prefix", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("custom/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "custom",
      id: "custom/vision-model",
      input: ["text", "image"],
    });
  });

  it("does not match provider-prefixed configured model ids through core provider aliases", () => {
    const cfg = {
      models: {
        providers: {
          volcengine: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("volcengine/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("bytedance", "vision-model", "/tmp/agent", cfg);

    expect(result.error).toBe("Unknown model: bytedance/vision-model");
  });

  it("resolves direct moonshotai refs through manifest-owned provider aliases", () => {
    const cfg = {
      models: {
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("kimi-k2.6"),
                name: "Kimi K2.6",
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("moonshotai", "kimi-k2.6", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "moonshot",
      id: "kimi-k2.6",
    });
  });

  it("resolves direct moonshot-ai refs through manifest-owned provider aliases", () => {
    const cfg = {
      models: {
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            api: "openai-completions",
            models: [makeModel("kimi-k2.6")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("moonshot-ai", "kimi-k2.6", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "moonshot",
      id: "kimi-k2.6",
    });
  });

  it("keeps transport-overriding manifest aliases on the requested provider", () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "azure-openai-responses",
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveModelForTest("azure-openai-responses", "gpt-5.5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it("infers provider-level Azure transport aliases from the configured endpoint", async () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            models: [],
          },
        },
      },
    };
    resolveBundledStaticCatalogModelMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      "/tmp/agent",
      cfg,
      {
        allowBundledStaticCatalogFallback: true,
        preferBundledStaticCatalogTransport: true,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it("uses manifest alias base URLs before discovered target endpoints", async () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "",
            models: [],
            params: { temperature: 0.2 },
          },
        },
      },
    };
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      transport: {
        api: "azure-openai-responses",
        baseUrl: "https://manifest-alias.example.com/openai/v1",
      },
    });
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel: vi.fn(({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? {
              provider: "openai",
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            }
          : undefined,
      ),
    };

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      "/tmp/agent",
      cfg,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://manifest-alias.example.com/openai/v1",
    });
  });

  it("keeps retained manifest alias ownership without provider config", async () => {
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      transport: {
        api: "azure-openai-responses",
        baseUrl: "https://manifest-alias.example.com/openai/v1",
      },
    });
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel: vi.fn(({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? {
              provider: "openai",
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            }
          : undefined,
      ),
    };

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      "/tmp/agent",
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://manifest-alias.example.com/openai/v1",
    });
  });

  it("resolves manifest alias metadata once per async model lookup", async () => {
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      transport: { api: "azure-openai-responses" },
    });
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel: vi.fn(({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? {
              provider: "openai",
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            }
          : undefined,
      ),
    };

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      "/tmp/agent",
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(resolveManifestModelCatalogProviderAliasMetadataMock).toHaveBeenCalledTimes(1);
  });

  it.each(["sync", "async"] as const)(
    "rejects configured fallbacks for ambiguous manifest aliases in the $resolver resolver",
    async (resolver) => {
      resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
        provider: "azure-openai-responses",
        ambiguous: true,
      });
      const cfg = {
        models: {
          providers: {
            "azure-openai-responses": {
              baseUrl: "https://example.openai.azure.com/openai/v1",
              api: "azure-openai-responses" as const,
              models: [makeModel("gpt-5.5")],
            },
          },
        },
      };

      const result =
        resolver === "sync"
          ? resolveModelForTest("azure-openai-responses", "gpt-5.5", "/tmp/agent", cfg)
          : await resolveModelAsyncForTest("azure-openai-responses", "gpt-5.5", "/tmp/agent", cfg);

      expect(result.model).toBeUndefined();
      expect(result.error).toBe("Unknown model: azure-openai-responses/gpt-5.5");
    },
  );

  it("does not treat arbitrary namespaced model ids as provider prefixes", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("meta/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", cfg);

    expect(result.model?.id).toBe("vision-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("resolves custom MLX-style Hugging Face ids without adding the provider prefix", () => {
    const modelId = "mlx-community/Qwen3-30B-A3B-6bit";
    const cfg = {
      agents: {
        defaults: {
          model: { primary: `mlx/${modelId}` },
        },
      },
      models: {
        providers: {
          mlx: {
            baseUrl: "http://127.0.0.1:8080/v1",
            apiKey: "mlx-local",
            api: "openai-completions",
            models: [
              {
                ...makeModel(modelId),
                contextWindow: 131072,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("mlx", modelId, "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "mlx",
      id: modelId,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
  });

  it("prefers provider-prefixed configured metadata over discovered text-only models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "vision-model",
      templateModel: {
        ...makeModel("vision-model"),
        provider: "custom",
        input: ["text"],
      },
    });
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("custom/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "custom",
      id: "custom/vision-model",
      input: ["text", "image"],
    });
  });

  it("keeps unknown fallback models text-only instead of borrowing image input from another configured model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "typoed-model", "/tmp/agent", cfg);

    expect(result.model?.id).toBe("typoed-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("explains when an agent model entry is missing provider model registration", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "microsoft-foundry/Kimi-K2.6-1": {
              contextWindow: 262144,
              maxOutputTokens: 16384,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync("microsoft-foundry", "Kimi-K2.6-1", "/tmp/agent", cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect(result.error).toBe(
      'Unknown model: microsoft-foundry/Kimi-K2.6-1. Found agents.defaults.models["microsoft-foundry/Kimi-K2.6-1"], but no matching models.providers["microsoft-foundry"].models[] entry. Add { "id": "Kimi-K2.6-1", "name": "Kimi-K2.6-1" } to models.providers["microsoft-foundry"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it.each([
    {
      name: "agent model entry",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {},
            },
          },
        },
      },
    },
    {
      name: "legacy provider config",
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" }],
            },
          },
        },
      },
    },
  ])("suggests running doctor for openai-codex from $name", async ({ cfg }) => {
    const result = await resolveModelAsync(
      "openai-codex",
      "gpt-5.4",
      "/tmp/agent",
      cfg as unknown as OpenClawConfig,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBe(
      'Unknown model: openai-codex/gpt-5.4. "openai-codex" is a legacy provider ID. Run `openclaw doctor --fix` to migrate legacy model and provider config to the current OpenAI format. If the provider has no authenticated profile, run `openclaw models status` to check provider auth and re-authenticate if needed. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("suggests adding config entry when a non-bundled provider model is missing", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "custom-provider/some-model": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync("custom-provider", "some-model", "/tmp/agent", cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect(result.error).toBe(
      'Unknown model: custom-provider/some-model. Found agents.defaults.models["custom-provider/some-model"], but no matching models.providers["custom-provider"].models[] entry. Add { "id": "some-model", "name": "some-model" } to models.providers["custom-provider"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("points runtime-bound model entries at the runtime catalog instead of provider registration", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.3-codex": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync("openai", "gpt-5.3-codex", "/tmp/agent", cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect(result.error).toBe(
      'Unknown model: openai/gpt-5.3-codex. Found agents.defaults.models["openai/gpt-5.3-codex"] bound to the "codex" agent runtime. Models served by an agent runtime come from that runtime and its linked account, not from models.providers["openai"].models[] — registering it there will not make it usable. Confirm "gpt-5.3-codex" is still offered by the "codex" runtime and switch agents.defaults.model.primary to a currently available model (run `openclaw models list --provider openai` to list them). See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("repairs stale text-only Foundry fallback rows for GPT-family models", () => {
    const cfg = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                name: "gpt-5.4",
                api: "azure-openai-responses",
                input: ["text"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Anthropic fallback rows for Claude vision models", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            api: "anthropic-messages",
            models: [
              {
                ...makeModel("claude-sonnet-4-5"),
                name: "claude-sonnet-4-5",
                api: "anthropic-messages",
                input: ["text"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("anthropic", "claude-sonnet-4-5", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows for GPT-family models", () => {
    const cfg = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                name: "gpt-5.4",
                api: "azure-openai-responses",
                input: ["text"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    mockDiscoveredModel(discoverModels, {
      provider: "microsoft-foundry",
      modelId: "gpt-5.4",
      templateModel: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "azure-openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    });

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows without config overrides", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "microsoft-foundry",
      modelId: "gpt-5.4",
      templateModel: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "azure-openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    });

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent");

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("matches prefixed OpenRouter native ids in configured fallback models", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("openrouter/healer-alpha"),
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const models = buildInlineProviderModels(cfg.models?.providers ?? {});
    const model = models.find((entry) => entry.id === "openrouter/healer-alpha");
    expectRecordFields(model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("uses OpenRouter API capabilities for unknown models when cache is populated", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue({
      name: "Healer Alpha",
      input: ["text", "image"],
      reasoning: true,
      supportsTools: false,
      contextWindow: 262144,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    const result = resolveModelForTest("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    const resolvedModel = expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      name: "Healer Alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
    expect((resolvedModel.compat as { supportsTools?: boolean } | undefined)?.supportsTools).toBe(
      false,
    );
  });

  it("falls back to text-only when OpenRouter API cache is empty", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);

    const result = resolveModelForTest("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: false,
      input: ["text"],
    });
  });

  it("uses provider-normalized model ids for OpenRouter transport", () => {
    const modelId = "openrouter/anthropic/claude-sonnet-4.6";
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId,
      templateModel: {
        ...makeModel(modelId),
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const normalizeProviderResolvedModelWithPlugin = vi.fn(
      (params: { context: { model: { id: string } } }) => ({
        ...params.context.model,
        id: params.context.model.id.slice("openrouter/".length),
      }),
    );

    const result = resolveModel("openrouter", modelId, "/tmp/agent", undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent"),
      runtimeHooks: {
        ...baseRuntimeHooks,
        normalizeProviderResolvedModelWithPlugin,
      },
    });

    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        context: expect.objectContaining({
          modelId,
          model: expect.objectContaining({ id: modelId }),
        }),
      }),
    );
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("matches prefixed Hugging Face ids against discovered registry models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "huggingface",
      modelId: "deepseek-ai/DeepSeek-R1",
      templateModel: {
        ...makeModel("deepseek-ai/DeepSeek-R1"),
        provider: "huggingface",
        baseUrl: "https://router.huggingface.co/v1",
        reasoning: true,
        input: ["text"],
      },
    });

    const result = resolveModelForTest(
      "huggingface",
      "huggingface/deepseek-ai/DeepSeek-R1",
      "/tmp/agent",
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "huggingface",
      id: "deepseek-ai/DeepSeek-R1",
      reasoning: true,
      input: ["text"],
    });
  });

  it("preloads OpenRouter capabilities before first async resolve of an unknown model", async () => {
    mockLoadOpenRouterModelCapabilities.mockImplementation(async (modelId) => {
      if (modelId === "google/gemini-3.1-flash-image-preview") {
        mockGetOpenRouterModelCapabilities.mockReturnValue({
          name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 65536,
          maxTokens: 65536,
          cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
        });
      }
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "google/gemini-3.1-flash-image-preview",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).toHaveBeenCalledWith(
      "google/gemini-3.1-flash-image-preview",
    );
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "google/gemini-3.1-flash-image-preview",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 65536,
      maxTokens: 65536,
    });
  });

  it("skips OpenRouter preload for models already present in the registry", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId: "openrouter/healer-alpha",
      templateModel: {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
      },
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "openrouter/healer-alpha",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
    });
  });

  it("threads the model id through inline configured transport normalization", () => {
    const normalizeProviderTransportWithPlugin = vi.fn(() => undefined);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "openai-completions",
                baseUrl: "https://api.openai.com/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModel("openai", "gpt-5.5", "/tmp/agent", cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent"),
      runtimeHooks: {
        ...createRuntimeHooks(),
        normalizeProviderTransportWithPlugin,
      },
    });

    expectResolvedModel(result);
    expect(normalizeProviderTransportWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5.5",
        context: expect.objectContaining({ modelId: "gpt-5.5" }),
      }),
    );
  });

  it("prefers configured provider api metadata over discovered registry model", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "onehub",
      modelId: "glm-5",
      templateModel: {
        id: "glm-5",
        name: "GLM-5 (cached)",
        provider: "onehub",
        api: "anthropic-messages",
        baseUrl: "https://old-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = {
      models: {
        providers: {
          onehub: {
            baseUrl: "http://new-provider.example.com/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("glm-5"),
                api: "openai-completions",
                reasoning: true,
                contextWindow: 198000,
                maxTokens: 16000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("onehub", "glm-5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "onehub",
      id: "glm-5",
      api: "openai-completions",
      baseUrl: "http://new-provider.example.com/v1",
      reasoning: true,
      contextWindow: 198000,
      maxTokens: 16000,
    });
  });

  it("prefers exact provider config over normalized alias match when both keys exist", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "bedrock",
      modelId: "bedrock-alias-exact-test",
      templateModel: {
        id: "bedrock-alias-exact-test",
        name: "Bedrock alias test",
        provider: "bedrock",
        api: "openai-completions",
        baseUrl: "https://default-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://canonical-bedrock.example.com/v1",
            api: "openai-completions",
            headers: { "X-Provider": "canonical" },
            models: [{ ...makeModel("bedrock-alias-exact-test"), reasoning: false }],
          },
          bedrock: {
            baseUrl: "https://alias-bedrock.example.com/v1",
            api: "anthropic-messages",
            headers: { "X-Provider": "alias" },
            models: [
              {
                ...makeModel("bedrock-alias-exact-test"),
                api: "anthropic-messages",
                reasoning: true,
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("bedrock", "bedrock-alias-exact-test", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "bedrock",
      id: "bedrock-alias-exact-test",
      api: "anthropic-messages",
      baseUrl: "https://alias-bedrock.example.com",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 32768,
      headers: { "X-Provider": "alias" },
    });
  });

  it("builds an openai fallback for gpt-5.4", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("upgrades stale exact openai gpt-5.4 registry metadata via forward-compat", () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider !== "openai") {
          return null;
        }
        if (modelId === "gpt-5.4") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.4",
            name: "GPT-5.4",
            contextWindow: 272000,
          };
        }
        if (modelId === "gpt-5.3-codex") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
          };
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128000,
    });
  });

  it("accepts available exact openai gpt-5.3-codex registry metadata", () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider !== "openai") {
          return null;
        }
        if (modelId === "gpt-5.3-codex") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
            contextWindow: 272000,
          };
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModelForTest("openai", "gpt-5.3-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.3-codex",
      contextWindow: 272000,
    });
  });

  it("canonicalizes the legacy openai gpt-5.4-codex alias at runtime", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai", "gpt-5.4-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.name).toBe("gpt-5.4");
  });

  it("applies canonical openai overrides when resolving the gpt-5.4-codex alias", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/backend-api",
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                contextWindow: 123456,
                contextTokens: 65432,
                maxTokens: 7777,
                reasoning: false,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4-codex", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/backend-api",
      contextWindow: 123456,
      contextTokens: 65432,
      maxTokens: 7777,
      reasoning: false,
    });
  });

  it("prefers alias-specific overrides over canonical ones for gpt-5.4-codex", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                contextWindow: 222222,
                maxTokens: 22222,
              },
              {
                ...makeModel("gpt-5.4-codex"),
                contextWindow: 111111,
                maxTokens: 11111,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4-codex", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 111111,
      maxTokens: 11111,
    });
  });

  it("builds an openai fallback for gpt-5.4-mini", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
      contextWindow: 400_000,
      contextTokens: 272_000,
    });
  });

  it("does not build an openai fallback for removed gpt-5.3-codex-spark", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("does not build a configured fallback for unsupported xAI multi-agent models", () => {
    const cfg = {
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("xai", "grok-4.20-multi-agent-0309", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: xai/grok-4.20-multi-agent-0309. OpenClaw does not currently support xAI multi-agent models; choose another xAI model. See https://docs.openclaw.ai/providers/xai.",
    );
  });

  it("rejects stale openai gpt-5.3-codex-spark discovery rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
        name: "GPT-5.3 Codex Spark",
        input: ["text"],
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("prefers runtime-resolved openai gpt-5.4 metadata when it has a larger context window", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        contextWindow: 128_000,
        contextTokens: 32_000,
        input: ["text"],
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("lets official openai metadata override stale configured model rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
      },
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.5-pro"),
                api: "openai-chatgpt-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 400_000,
                contextTokens: 64_000,
                maxTokens: 32_000,
                metadataSource: "models-add",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.5-pro", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5-pro",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("resolves openai gpt-5.5 through the direct API fallback when discovery omits OAuth metadata", () => {
    const result = resolveModelForTest("openai", "gpt-5.5");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("preserves unmarked manual openai metadata overrides", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.5"),
        name: "GPT-5.5",
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 400_000,
      },
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "openai-chatgpt-responses",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
                contextWindow: 555_555,
                contextTokens: 111_111,
                maxTokens: 22_222,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5",
      cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
      contextWindow: 555_555,
      contextTokens: 111_111,
      maxTokens: 22_222,
    });
  });

  it("prefers runtime-resolved openai gpt-5.4 metadata during async resolution too", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        contextWindow: 128_000,
        contextTokens: 32_000,
      },
    });

    const result = await resolveModelAsyncForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("normalizes stale discovered openai /backend-api/v1 metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        baseUrl: "https://chatgpt.com/backend-api/v1",
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("normalizes stale discovered openrouter /v1 metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      templateModel: {
        provider: "openrouter",
        id: "openai/gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    });

    const result = resolveModelForTest("openrouter", "openai/gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openai/gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("normalizes discovered openai metadata when api is missing", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        api: undefined,
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("passes configured workspaceDir to runtime preference hooks", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        contextWindow: 128_000,
        contextTokens: 32_000,
      },
    });

    const shouldPreferRuntimeResolvedModel = vi.fn(
      (params: { workspaceDir?: string; context: { agentDir?: string } }) =>
        params.workspaceDir === "/tmp/workspace" && params.context.agentDir === "/tmp/agent-state",
    );
    const runProviderDynamicModel = vi.fn(
      (params: { workspaceDir?: string; context: { provider: string; modelId: string } }) =>
        params.workspaceDir === "/tmp/workspace" &&
        params.context.provider === "openai" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      shouldPreferProviderRuntimeResolvedModel: shouldPreferRuntimeResolvedModel,
      runProviderDynamicModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("openai", "gpt-5.4", "/tmp/agent-state", cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent-state"),
      runtimeHooks,
    });

    const preferInput = mockCallArg(shouldPreferRuntimeResolvedModel);
    expectRecordFields(preferInput, {
      provider: "openai",
      workspaceDir: "/tmp/workspace",
    });
    expectRecordFields(preferInput.context, {
      agentDir: "/tmp/agent-state",
      workspaceDir: "/tmp/workspace",
    });
    const dynamicInput = mockCallArg(runProviderDynamicModel);
    expectRecordFields(dynamicInput, {
      provider: "openai",
      workspaceDir: "/tmp/workspace",
    });
    expectRecordFields(dynamicInput.context, {
      agentDir: "/tmp/agent-state",
      modelId: "gpt-5.4",
      provider: "openai",
    });
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("passes configured workspaceDir through direct registry dynamic hooks", () => {
    const runProviderDynamicModel = vi.fn(
      (params: {
        workspaceDir?: string;
        context: { workspaceDir?: string; provider: string; modelId: string };
      }) =>
        params.workspaceDir === "/tmp/workspace" &&
        params.context.workspaceDir === "/tmp/workspace" &&
        params.context.provider === "openai" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
        },
      },
    } as OpenClawConfig;

    const result = resolveModelWithRegistry({
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent-state",
      cfg,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent-state"),
      runtimeHooks,
    });

    const dynamicInput = mockCallArg(runProviderDynamicModel);
    expectRecordFields(dynamicInput, {
      workspaceDir: "/tmp/workspace",
    });
    expectRecordFields(dynamicInput.context, {
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent-state",
      modelId: "gpt-5.4",
      provider: "openai",
    });
    expectRecordFields(result, {
      provider: "openai",
      id: "gpt-5.4",
    });
  });

  it("resolves discovered openai gpt-5.4-mini rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
        name: "GPT-5.4 Mini",
        contextWindow: 64_000,
        input: ["text"],
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      contextWindow: 64_000,
      input: ["text"],
    });
  });

  it("rejects stale direct openai gpt-5.3-codex-spark discovery rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("applies provider overrides to openai gpt-5.4 forward-compat models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/v1",
            headers: { "X-Proxy-Auth": "token-123" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    expectRecordFields(result.model?.headers, {
      "X-Proxy-Auth": "token-123",
    });
  });

  it("applies configured overrides to github-copilot dynamic models", () => {
    const cfg = {
      models: {
        providers: {
          "github-copilot": {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Proxy-Auth": "token-123" },
            models: [
              {
                ...makeModel("gpt-5.4-mini"),
                reasoning: true,
                input: ["text"],
                contextWindow: 256000,
                maxTokens: 32000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("github-copilot", "gpt-5.4-mini", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "github-copilot",
      id: "gpt-5.4-mini",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 256000,
      maxTokens: 32000,
    });
    expectRecordFields((result.model as unknown as { headers?: Record<string, string> }).headers, {
      "X-Proxy-Auth": "token-123",
    });
  });

  it("resolves github-copilot Claude dynamic models to anthropic-messages by default", () => {
    const result = resolveModelForTest("github-copilot", "claude-sonnet-4.6", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
      api: "anthropic-messages",
    });
  });

  it.each([
    { modelId: "claude-sonnet-4.6", expectedApi: "anthropic-messages" },
    { modelId: "gemini-3.1-pro-preview", expectedApi: "openai-completions" },
    { modelId: "gpt-5.4-mini", expectedApi: "openai-responses" },
  ] as const)(
    "preserves discovered $expectedApi transport for params-only github-copilot $modelId",
    ({ modelId, expectedApi }) => {
      mockDiscoveredModel(discoverModels, {
        provider: "github-copilot",
        modelId,
        templateModel: {
          ...makeModel(modelId),
          provider: "github-copilot",
          api: expectedApi,
          baseUrl: "https://api.githubcopilot.com",
        },
      });
      const cfg = {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "",
              models: [],
              params: { temperature: 0.2 },
            },
          },
        },
      };

      const result = resolveModelForTest("github-copilot", modelId, "/tmp/agent", cfg);

      expect(result.error).toBeUndefined();
      expectRecordFields(result.model, {
        provider: "github-copilot",
        id: modelId,
        api: expectedApi,
        params: { temperature: 0.2 },
      });
    },
  );

  it("builds an openai fallback for gpt-5.5 when the live catalog cache is cold", () => {
    const result = resolveModelForTest("openai", "gpt-5.5", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      mediaInput: {
        image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
      },
    });
  });

  it("builds an openai fallback for gpt-5.4 mini from the gpt-5.4-mini template", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4-mini",
        name: "GPT-5 mini",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("builds an openai fallback for gpt-5.4 nano from the gpt-5.4-nano template", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-nano",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4-nano",
        name: "GPT-5 nano",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4-nano", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes stale native openai gpt-5.4 completions transport to responses", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps proxied openai completions transport untouched", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
    });
  });

  it("normalizes stale native xai completions transport to responses", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.20-0309-reasoning",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20 0309 (Reasoning)",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = resolveModelForTest("xai", "grok-4.20-0309-reasoning", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "xai",
      id: "grok-4.20-0309-reasoning",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("normalizes stale native xai completions transport after plugin model normalization", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.3",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.3",
        name: "Grok 4.3",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = resolveModel("xai", "grok-4.3-latest", "/tmp/agent", undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent"),
      runtimeHooks: {
        buildProviderUnknownModelHintWithPlugin: () => undefined,
        prepareProviderDynamicModel: async () => {},
        runProviderDynamicModel: () => undefined,
        applyProviderResolvedTransportWithPlugin: ({ provider, context }) =>
          provider === "xai" &&
          context.model.api === "openai-completions" &&
          context.model.baseUrl === "https://api.x.ai/v1"
            ? {
                ...context.model,
                api: "openai-responses",
              }
            : undefined,
        normalizeProviderResolvedModelWithPlugin: ({ provider, context }) =>
          provider === "xai" ? (context.model as never) : undefined,
        normalizeProviderTransportWithPlugin: () => undefined,
      },
    });

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "xai",
      id: "grok-4.3",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
