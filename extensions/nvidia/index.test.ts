// Nvidia tests cover index plugin behavior.
import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { clearNvidiaFeaturedModelCacheForTests } from "./provider-catalog.js";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

type NvidiaManifest = {
  providerAuthChoices?: Array<Record<string, unknown>>;
};
type RegisteredModelCatalogProvider = Parameters<
  ReturnType<typeof createTestPluginApi>["registerModelCatalogProvider"]
>[0];

function readManifest(): NvidiaManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as NvidiaManifest;
}

async function registerNvidiaProvider() {
  return registerSingleProviderPlugin(plugin);
}

afterEach(() => {
  clearNvidiaFeaturedModelCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
});

function mockFeaturedCatalogResponse(payload: unknown, status = 200) {
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: Response.json(payload, { status }),
    release: vi.fn(),
  });
}

function registerNvidiaPluginApi() {
  const registeredProviders: string[] = [];
  const registeredModelCatalogProviders: RegisteredModelCatalogProvider[] = [];

  plugin.register(
    createTestPluginApi({
      registerProvider(provider: { id: string }) {
        registeredProviders.push(provider.id);
      },
      registerModelCatalogProvider(provider) {
        registeredModelCatalogProviders.push(provider);
      },
    }),
  );

  return { registeredProviders, registeredModelCatalogProviders };
}

function buildCatalogContext(apiKey?: string) {
  return {
    config: {},
    env: process.env,
    resolveProviderApiKey: () => ({ apiKey }),
    resolveProviderAuth: () => ({
      apiKey,
      mode: apiKey ? ("api_key" as const) : ("none" as const),
      source: apiKey ? ("env" as const) : ("none" as const),
    }),
  };
}

function buildAugmentCatalogContext(apiKey?: string) {
  const env = { ...process.env };
  if (!apiKey) {
    delete env.NVIDIA_API_KEY;
  }
  return {
    ...buildCatalogContext(apiKey),
    env,
    entries: [],
  };
}

describe("nvidia provider hooks", () => {
  it("registers the nvidia provider with correct metadata", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.id).toBe("nvidia");
    expect(provider.label).toBe("NVIDIA");
    expect(provider.docsPath).toBe("/providers/nvidia");
    expect(provider.envVars).toEqual(["NVIDIA_API_KEY"]);
  });

  it("registers API-key auth choice metadata", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "nvidia-api-key",
    });
    expect(choice?.provider.id).toBe("nvidia");
    expect(choice?.method.id).toBe("api-key");
    expect(readManifest().providerAuthChoices).toStrictEqual([
      {
        provider: "nvidia",
        method: "api-key",
        choiceId: "nvidia-api-key",
        choiceLabel: "NVIDIA API key",
        groupId: "nvidia",
        groupLabel: "NVIDIA",
        groupHint: "Direct API key",
        optionKey: "nvidiaApiKey",
        cliFlag: "--nvidia-api-key",
        cliOption: "--nvidia-api-key <key>",
        cliDescription: "NVIDIA API key",
      },
    ]);
  });

  it("keeps nvidia auth setup metadata aligned", async () => {
    const provider = await registerNvidiaProvider();

    expect(
      provider.auth.map((method) => ({
        id: method.id,
        label: method.label,
        hint: method.hint,
        choiceId: method.wizard?.choiceId,
        groupId: method.wizard?.groupId,
        groupLabel: method.wizard?.groupLabel,
        groupHint: method.wizard?.groupHint,
      })),
    ).toEqual([
      {
        id: "api-key",
        label: "NVIDIA API key",
        hint: "Direct API key",
        choiceId: "nvidia-api-key",
        groupId: "nvidia",
        groupLabel: "NVIDIA",
        groupHint: "Direct API key",
      },
    ]);
  });

  it("keeps nvidia wizard setup metadata aligned", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.wizard?.setup).toStrictEqual({
      choiceId: "nvidia-api-key",
      choiceLabel: "NVIDIA API key",
      groupId: "nvidia",
      groupLabel: "NVIDIA",
      groupHint: "Direct API key",
      methodId: "api-key",
      modelSelection: {
        promptWhenAuthChoiceProvided: true,
        allowKeepCurrent: false,
      },
    });
  });

  it("keeps nvidia model picker metadata aligned", async () => {
    const provider = await registerNvidiaProvider();

    expect(provider.wizard?.modelPicker).toStrictEqual({
      label: "NVIDIA (custom)",
      hint: "Use NVIDIA-hosted open models",
      methodId: "api-key",
    });
  });

  it("does not override replay policy for standard openai-compatible transport", async () => {
    const provider = await registerNvidiaProvider();

    // NVIDIA uses standard OpenAI-compatible API without custom replay logic
    expect(provider.buildReplayPolicy).toBeUndefined();
  });

  it("does not override stream wrapper for standard models", async () => {
    const provider = await registerNvidiaProvider();

    // NVIDIA uses standard streaming without custom wrappers
    expect(provider.wrapStreamFn).toBeUndefined();
  });

  it("surfaces the bundled NVIDIA models without fetching when no NVIDIA API token is available", async () => {
    const provider = await registerNvidiaProvider();

    const entries = await provider.augmentModelCatalog?.(buildAugmentCatalogContext());

    expect(entries?.map((entry) => entry.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(entries?.every((entry) => entry.provider === "nvidia")).toBe(true);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("surfaces the bundled NVIDIA models when authenticated featured catalog fetch fails", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);
    const provider = await registerNvidiaProvider();

    const entries = await provider.augmentModelCatalog?.(buildAugmentCatalogContext("nvapi-test"));

    expect(entries?.map((entry) => entry.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(entries?.every((entry) => entry.provider === "nvidia")).toBe(true);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("surfaces live featured NVIDIA models via augmentModelCatalog", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });
    const provider = await registerNvidiaProvider();

    const entries = await provider.augmentModelCatalog?.(buildAugmentCatalogContext("nvapi-test"));

    expect(entries?.map((entry) => entry.id)).toEqual(["minimaxai/minimax-m2.7"]);
  });

  it("opts into literal provider-prefix preservation", async () => {
    const provider = await registerNvidiaProvider();

    // NVIDIA's ids like nvidia/nemotron-... sit alongside moonshotai/...,
    // minimaxai/..., z-ai/... in the same catalog, so the leading nvidia/
    // is a vendor namespace rather than a redundant provider prefix. The
    // flag keeps the canonical ref as nvidia/nvidia/nemotron-... instead
    // of letting the default string-based dedupe collapse it.
    expect(provider.preserveLiteralProviderPrefix).toBe(true);
  });

  it("registers nvidia provider through the plugin api", () => {
    const { registeredProviders, registeredModelCatalogProviders } = registerNvidiaPluginApi();

    expect(registeredProviders).toStrictEqual(["nvidia"]);
    expect(registeredModelCatalogProviders.map((provider) => provider.provider)).toStrictEqual([
      "nvidia",
    ]);
  });

  it("registers static and live nvidia model catalog rows", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });
    const { registeredModelCatalogProviders } = registerNvidiaPluginApi();
    const catalogProvider = registeredModelCatalogProviders[0];

    expect(catalogProvider?.provider).toBe("nvidia");
    expect(catalogProvider?.kinds).toStrictEqual(["text"]);

    const staticRows = await catalogProvider?.staticCatalog?.(buildCatalogContext());
    expect(staticRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
      "static:nvidia/nvidia/nemotron-3-ultra-550b-a55b",
      "static:nvidia/nvidia/nemotron-3-super-120b-a12b",
      "static:nvidia/moonshotai/kimi-k2.5",
      "static:nvidia/minimaxai/minimax-m2.7",
      "static:nvidia/z-ai/glm-5.1",
      "static:nvidia/minimaxai/minimax-m2.5",
      "static:nvidia/z-ai/glm5",
    ]);

    await expect(catalogProvider?.liveCatalog?.(buildCatalogContext())).resolves.toEqual([]);

    const liveRows = await catalogProvider?.liveCatalog?.(buildCatalogContext("nvapi-test"));
    expect(liveRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
      "live:nvidia/minimaxai/minimax-m2.7",
    ]);
  });

  it("keeps static rows out of the live catalog when the featured catalog is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);
    const { registeredModelCatalogProviders } = registerNvidiaPluginApi();
    const catalogProvider = registeredModelCatalogProviders[0];

    await expect(
      catalogProvider?.liveCatalog?.(buildCatalogContext("nvapi-test")),
    ).resolves.toEqual([]);
  });
});
