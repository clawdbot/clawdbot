// Model picker tests cover catalog rows, provider metadata, backend defaults, and prompt choices.
import path from "node:path";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { stampConfigWriteMetadata } from "../config/io.meta.js";
import type { WizardMultiSelectParams, WizardPrompter } from "../wizard/prompts.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
const modelCatalogRouteVariants = vi.hoisted(() => ({
  value: undefined as readonly ModelCatalogEntry[] | undefined,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await loadModelCatalog(...args);
    return { entries, routeVariants: modelCatalogRouteVariants.value ?? entries };
  },
}));

const loadStaticManifestCatalogRowsForList = vi.hoisted(() =>
  vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
);
vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList,
}));

const loadPreferredProviderPickerCatalog = vi.hoisted(() =>
  vi.fn<
    (_params: {
      cfg: OpenClawConfig;
      preferredProvider: string;
      agentDir?: string;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
    }) => Promise<ModelCatalogEntry[]>
  >(async () => []),
);
vi.mock("../flows/model-picker.provider-catalog.js", () => ({
  loadPreferredProviderPickerCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: () => ({
    mode: "scoped",
    allowKeychainPrompt: false,
  }),
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
}));

const resolveEnvApiKey = vi.hoisted(() =>
  vi.fn<(_provider: string, _env?: NodeJS.ProcessEnv) => { apiKey: string; source: string } | null>(
    (_provider: string) => ({
      apiKey: "test-key",
      source: "test",
    }),
  ),
);
const hasUsableCustomProviderApiKey = vi.hoisted(() =>
  vi.fn<(_cfg?: OpenClawConfig, _provider?: string, _env?: NodeJS.ProcessEnv) => boolean>(
    () => false,
  ),
);
const hasRuntimeAvailableProviderAuth = vi.hoisted(() =>
  vi.fn(
    ({
      provider,
      cfg,
      env,
    }: {
      provider: string;
      cfg?: OpenClawConfig;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
    }) => {
      if (provider === "amazon-bedrock") {
        const auth = cfg?.models?.providers?.["amazon-bedrock"]?.auth;
        return auth === undefined || auth === "aws-sdk";
      }
      if (resolveEnvApiKey(provider, env)?.apiKey) {
        return true;
      }
      if (hasUsableCustomProviderApiKey(cfg, provider, env)) {
        return true;
      }
      const providerConfig = cfg?.models?.providers?.[provider];
      return Boolean(
        providerConfig?.baseUrl?.startsWith("http://127.0.0.1") &&
        providerConfig.api &&
        providerConfig.models?.length &&
        !providerConfig.apiKey,
      );
    },
  ),
);
const createRuntimeProviderAuthLookup = vi.hoisted(() =>
  vi.fn(() => ({
    envApiKey: {
      aliasMap: {},
      candidateMap: {},
      authEvidenceMap: {},
    },
    syntheticAuthProviderRefs: [],
  })),
);
vi.mock("../agents/model-auth.js", () => ({
  createRuntimeProviderAuthLookup,
  resolveEnvApiKey,
  hasUsableCustomProviderApiKey,
  hasRuntimeAvailableProviderAuth,
}));

const providerAuthRoute = vi.hoisted(() => ({
  value: undefined as
    | {
        api: "openai-responses" | "openai-chatgpt-responses";
        baseUrl: string;
        authRequirement: "api-key" | "subscription";
        requestTransportOverrides: "none" | "present";
      }
    | undefined,
}));
const providerAuthEvaluations = vi.hoisted(
  () =>
    new Map<
      string,
      {
        availability: boolean | undefined;
        routeResolution: null;
        selectedAuthMode?: string;
        evidence?: "aws-sdk" | "provider-config";
      }
    >(),
);
const createProviderAuthChecker = vi.hoisted(() =>
  vi.fn((params: { cfg?: OpenClawConfig; workspaceDir?: string; env?: NodeJS.ProcessEnv }) => {
    const checker = vi.fn(
      async (provider: string, ref?: { api?: string | null; baseUrl?: unknown }) => {
        const prepared = providerAuthEvaluations.get(provider);
        if (prepared) {
          return prepared.availability === true;
        }
        return (
          hasRuntimeAvailableProviderAuth({
            provider,
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            env: params.env,
          }) &&
          !(ref?.api === "openai-chatgpt-responses" && ref.baseUrl === "https://api.openai.com/v1")
        );
      },
    );
    const evaluateModelAuth = vi.fn(
      async (provider: string, ref?: { api?: string | null; baseUrl?: unknown }) => {
        const prepared = providerAuthEvaluations.get(provider);
        if (prepared) {
          return prepared;
        }
        const availability = await checker(provider, ref);
        const selectedRoute = providerAuthRoute.value;
        return {
          availability,
          routeResolution: selectedRoute
            ? { kind: "routes" as const, routes: [selectedRoute] as const }
            : null,
          ...(selectedRoute ? { selectedRoute } : {}),
        };
      },
    );
    return Object.assign(checker, { evaluateModelAuth });
  }),
);
vi.mock("../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() =>
  vi.fn(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  }),
);
vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProviderRef: resolveOwningPluginIdsForProvider,
}));

const providerModelPickerContributionRuntime = vi.hoisted(() => ({
  enabled: false,
  resolve: vi.fn(() => []),
}));
const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
const runProviderPluginAuthMethod = vi.hoisted(() => vi.fn());
vi.mock("../commands/model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    get resolveProviderModelPickerContributions() {
      return providerModelPickerContributionRuntime.enabled
        ? providerModelPickerContributionRuntime.resolve
        : undefined;
    },
    resolveProviderModelPickerEntries,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    resolvePluginProviders,
    runProviderPluginAuthMethod,
  },
}));

const OPENROUTER_CATALOG = [
  {
    provider: "openrouter",
    id: "auto",
    name: "OpenRouter Auto",
  },
  {
    provider: "openrouter",
    id: "meta-llama/llama-3.3-70b:free",
    name: "Llama 3.3 70B",
  },
] as const;

function expectRouterModelFiltering(options: Array<{ value: string }>) {
  const routerValues = options
    .map((option) => option.value)
    .filter((value) => value.startsWith("openrouter/"));
  expect(routerValues).toEqual(["openrouter/meta-llama/llama-3.3-70b:free"]);
}

function createSelectAllMultiselect() {
  return vi.fn(async (params) => params.options.map((option: { value: string }) => option.value));
}

function configuredTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function manifestTextRow(
  provider: string,
  id: string,
  name: string,
  status: NormalizedModelCatalogRow["status"] = "available",
): NormalizedModelCatalogRow {
  return {
    provider,
    id,
    name,
    ref: `${provider}/${id}`,
    mergeKey: `${provider}:${id}`,
    source: "manifest",
    input: ["text"],
    reasoning: false,
    status,
  };
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

type PickerOption = Record<string, unknown> & {
  value: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call[argIndex];
}

function pickerParams(source: MockCallSource, callIndex = 0) {
  return requireRecord(mockArg(source, callIndex, 0, `picker call ${callIndex}`), "picker params");
}

function pickerOptions(source: MockCallSource, callIndex = 0) {
  const options = pickerParams(source, callIndex).options;
  expect(options, "picker options").toBeInstanceOf(Array);
  return options as PickerOption[];
}

function optionValues(options: PickerOption[]) {
  return options.map((option) => option.value);
}

function requireOption(options: PickerOption[], value: string) {
  const option = options.find((candidate) => candidate.value === value);
  if (!option) {
    throw new Error(`expected picker option: ${value}`);
  }
  return option;
}

function providerCallProviders() {
  return resolveOwningPluginIdsForProvider.mock.calls.map(
    ([params]) => requireRecord(params, "provider ownership params").provider,
  );
}

beforeEach(() => {
  delete process.env.OPENCLAW_LOCALE;
  // Route hints exercise source policy even when a prior local build left stale dist artifacts.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  vi.clearAllMocks();
  modelCatalogRouteVariants.value = undefined;
  providerAuthRoute.value = undefined;
  providerAuthEvaluations.clear();
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
      {
        id: "google-gemini-cli",
        modelProvider: "google",
        pluginId: "google",
        config: { command: "gemini" },
      },
    ],
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [
        {
          pluginId: "anthropic",
          backend: {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
          },
        },
        {
          pluginId: "google",
          backend: {
            id: "google-gemini-cli",
            modelProvider: "google",
            config: { command: "gemini" },
          },
        },
      ],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
  loadStaticManifestCatalogRowsForList.mockReturnValue([]);
  loadPreferredProviderPickerCatalog.mockResolvedValue([]);
  listProfilesForProvider.mockReturnValue([]);
  resolveEnvApiKey.mockImplementation((_provider: string) => ({
    apiKey: "test-key",
    source: "test",
  }));
  hasUsableCustomProviderApiKey.mockReturnValue(false);
  providerModelPickerContributionRuntime.enabled = false;
  resolveOwningPluginIdsForProvider.mockImplementation(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

describe("promptDefaultModel", () => {
  it("adds runtime-route hints for canonical OpenAI models", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const options = pickerOptions(select as MockCallSource);
    const canonical = requireOption(options, "openai/gpt-5.5");
    expect(canonical.hint).toContain("Codex runtime route");
    expect(canonical.hint).not.toContain("OpenClaw runtime route");
  });

  it.each([
    ["default request params", { params: { temperature: 0.2 } }],
    [
      "model request params",
      { models: { "openai/gpt-5.5": { params: { text_verbosity: "low" } } } },
    ],
  ] as const)(
    "labels official OpenAI with %s as an OpenClaw runtime route",
    async (_label, defaults) => {
      loadModelCatalog.mockResolvedValue([
        {
          provider: "openai",
          id: "gpt-5.5",
          name: "GPT-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      ]);
      const select = vi.fn(async (params) => params.initialValue as never);

      await promptDefaultModel({
        config: { agents: { defaults } } as OpenClawConfig,
        prompter: makePrompter({ select }),
        allowKeep: false,
        includeManual: false,
        ignoreAllowlist: true,
      });

      const option = requireOption(pickerOptions(select as MockCallSource), "openai/gpt-5.5");
      expect(option.hint).toContain("OpenClaw runtime route");
      expect(option.hint).not.toContain("Codex runtime route");
    },
  );

  it.each([
    ["custom endpoint", "openai-responses", "https://example.test/v1"],
    ["authored Completions", "openai-completions", "https://api.openai.com/v1"],
  ] as const)("labels an OpenAI %s as an OpenClaw runtime route", async (_label, api, baseUrl) => {
    loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", api, baseUrl },
    ]);
    const config = {
      agents: { defaults: {} },
      models: {
        providers: {
          openai: { api, baseUrl, models: [configuredTextModel("gpt-5.5", "GPT-5.5")] },
        },
      },
    } as OpenClawConfig;
    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultModel({
      config,
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const option = requireOption(pickerOptions(select as MockCallSource), "openai/gpt-5.5");
    expect(option.hint).toContain("OpenClaw runtime route");
    expect(option.hint).not.toContain("Codex runtime route");
  });

  it("uses selected ChatGPT capabilities regardless of physical row order", async () => {
    providerAuthRoute.value = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
    };
    const platform: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-5.5",
      name: "Platform GPT-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_000_000,
      reasoning: true,
      input: ["text", "image"],
    };
    const chatGPT: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-5.5",
      name: "ChatGPT GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 400_000,
      reasoning: false,
      input: ["text"],
    };
    loadModelCatalog.mockResolvedValue([platform]);
    modelCatalogRouteVariants.value = [platform, chatGPT];
    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const option = requireOption(pickerOptions(select as MockCallSource), "openai/gpt-5.5");
    expect(option.hint).toContain("ChatGPT GPT-5.5");
    expect(option.hint).toContain("ctx 400k");
    expect(option.hint).not.toContain("reasoning");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual(["openai/gpt-5.5"]);
  });

  it("hides unauthenticated catalog entries from default model choices", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } },
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const values = optionValues(pickerOptions(select as MockCallSource));
    expect(values).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("does not offer an OpenAI row with a conflicting API and endpoint", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);
    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultModel({
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      },
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
    const checker = createProviderAuthChecker.mock.results.at(-1)?.value;
    expect(checker).toHaveBeenCalledWith("openai", {
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps implicit Bedrock AWS SDK models visible without API-key auth", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const values = optionValues(pickerOptions(select as MockCallSource));
    expect(values).toEqual(["amazon-bedrock/us.anthropic.claude-sonnet-4-5"]);
  });

  it("shows AWS SDK models but hides unresolved non-OpenAI SecretRefs", async () => {
    providerAuthEvaluations.set("amazon-bedrock", {
      availability: true,
      routeResolution: null,
      selectedAuthMode: "aws-sdk",
      evidence: "aws-sdk",
    });
    providerAuthEvaluations.set("anthropic", {
      availability: undefined,
      routeResolution: null,
      selectedAuthMode: "api-key",
      evidence: "provider-config",
    });
    loadModelCatalog.mockResolvedValue([
      {
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-sonnet-4-5",
        name: "Bedrock Claude",
        api: "bedrock-converse-stream",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Anthropic Claude",
        api: "anthropic-messages",
      },
    ]);
    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "amazon-bedrock/us.anthropic.claude-sonnet-4-5",
    ]);
    const authChecker = createProviderAuthChecker.mock.results.at(-1)?.value;
    if (!authChecker) {
      throw new Error("expected provider auth checker");
    }
    expect(authChecker.evaluateModelAuth).toHaveBeenCalledWith("amazon-bedrock", {
      modelId: "us.anthropic.claude-sonnet-4-5",
      observedRoutes: [{ api: "bedrock-converse-stream", baseUrl: undefined }],
    });
    expect(authChecker.evaluateModelAuth).toHaveBeenCalledWith("anthropic", {
      modelId: "claude-sonnet-4-6",
      observedRoutes: [{ api: "anthropic-messages", baseUrl: undefined }],
    });
  });

  it("hides legacy runtime providers from default model choices", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "codex-cli", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google-gemini-cli", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const values = optionValues(pickerOptions(select as MockCallSource));
    expect(values).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("normalizes retired Google Gemini catalog rows before saving config", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
    ]);

    const select = vi.fn(async (params) => params.options[0]?.value as never);
    const prompter = makePrompter({ select });

    const result = await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    expect(result.model).toBe("google/gemini-3.1-pro-preview");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
    expect(
      requireRecord(
        mockArg(runProviderModelSelectedHook as MockCallSource, 0, 0, "provider selected hook"),
        "provider selected hook params",
      ).model,
    ).toBe("google/gemini-3.1-pro-preview");
  });

  it("uses configured provider models for default picker without loading the full catalog in replace mode", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
    ]);

    const select = vi.fn(async (params) => params.options[0]?.value as never);
    const prompter = makePrompter({ select });
    const config = {
      models: {
        mode: "replace",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.test/v1",
            models: [configuredTextModel("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed")],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    const minimaxOption = requireOption(
      pickerOptions(select as MockCallSource),
      "minimax/MiniMax-M2.7-highspeed",
    );
    expect(minimaxOption.hint).toContain("MiniMax M2.7 Highspeed");
    expect(result.model).toBe("minimax/MiniMax-M2.7-highspeed");
  });

  it("treats byteplus plan models as preferred-provider matches", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "byteplus-plan",
        id: "ark-code-latest",
        name: "Ark Coding Plan",
      },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "byteplus",
    });

    const options = pickerOptions(select as MockCallSource);
    const values = optionValues(options);
    expect(values).toContain("byteplus-plan/ark-code-latest");
    expect(values[1]).toBe("byteplus-plan/ark-code-latest");
    expect(pickerParams(select as MockCallSource).initialValue).toBe(
      "byteplus-plan/ark-code-latest",
    );
    expect(result.model).toBe("byteplus-plan/ark-code-latest");
    expect(providerCallProviders()).toContain("byteplus");
    expect(providerCallProviders()).toContain("byteplus-plan");
  });

  it("shows literal double-prefix labels for providers that preserve literal prefixes", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron",
      },
    ]);
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      },
    } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const options = pickerOptions(select as MockCallSource);
    expect(requireOption(options, "__keep__").label).toBe(
      "Keep current (nvidia/nvidia/nemotron-3-super-120b-a12b)",
    );
    expect(requireOption(options, "nvidia/nemotron-3-super-120b-a12b").label).toBe(
      "nvidia/nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("does not double-prefix non-literal NVIDIA vendor model labels", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron",
      },
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.7",
        name: "MiniMax M2.7",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
    ]);
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
    });

    const options = pickerOptions(select as MockCallSource);
    expect(requireOption(options, "nvidia/nemotron-3-super-120b-a12b").label).toBe(
      "nvidia/nvidia/nemotron-3-super-120b-a12b",
    );
    expect(requireOption(options, "nvidia/minimaxai/minimax-m2.7").label).toBe(
      "nvidia/minimaxai/minimax-m2.7",
    );
    expect(requireOption(options, "nvidia/z-ai/glm-5.1").label).toBe("nvidia/z-ai/glm-5.1");
  });

  it("shows literal double-prefix keep label before browsing provider catalogs", async () => {
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    expect(result).toStrictEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    const params = pickerParams(select as MockCallSource);
    expect(params.searchable).toBe(false);
    expect(params.initialValue).toBe("__keep__");
    const options = pickerOptions(select as MockCallSource);
    expect(optionValues(options)).toEqual(["__keep__", "__manual__", "__browse__"]);
    expect(requireOption(options, "__keep__").label).toBe(
      "Keep current (nvidia/nvidia/nemotron-3-super-120b-a12b)",
    );
  });

  it("keeps current preferred-provider models cold until browsing is requested", async () => {
    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "openai",
      browseCatalogOnDemand: true,
    });

    expect(result).toStrictEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    const params = pickerParams(select as MockCallSource);
    expect(params.searchable).toBe(false);
    expect(params.initialValue).toBe("__keep__");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "__keep__",
      "__manual__",
      "__browse__",
    ]);
  });

  it("keeps the full catalog cold until browsing when no provider is preferred", async () => {
    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "fleet-router/qwen3.6:latest",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      browseCatalogOnDemand: true,
      loadCatalog: true,
    });

    expect(result).toStrictEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    const params = pickerParams(select as MockCallSource);
    expect(params.searchable).toBe(false);
    expect(params.initialValue).toBe("__keep__");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "__keep__",
      "__manual__",
      "__browse__",
    ]);
  });

  it("loads the full model catalog when browsing without a preferred provider", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
      },
    ]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockImplementationOnce(async (params) => {
        const option = params.options.find(
          (entry: { value: string }) => entry.value === "openai/gpt-5.5-pro",
        );
        return option?.value ?? params.initialValue;
      });
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("openai/gpt-5.5-pro");
    expect(loadModelCatalog).toHaveBeenCalledOnce();
    expect(loadPreferredProviderPickerCatalog).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1]?.[0]?.searchable).toBe(true);
  });

  it("loads the preferred provider catalog when the user chooses to browse", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
      },
    ]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockImplementationOnce(async (params) => {
        const option = params.options.find(
          (entry: { value: string }) => entry.value === "openai/gpt-5.5-pro",
        );
        return option?.value ?? params.initialValue;
      });
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "openai",
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("openai/gpt-5.5-pro");
    expect(loadPreferredProviderPickerCatalog).toHaveBeenCalledWith({
      cfg: config,
      preferredProvider: "openai",
      agentDir: expect.stringContaining("agents/main/agent"),
    });
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1]?.[0]?.searchable).toBe(true);
  });

  it("scopes on-demand preferred-provider loads before the first model prompt", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "NVIDIA Nemotron 3 Super 120B",
      },
      {
        provider: "nvidia",
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
      },
    ]);
    const select = vi.fn(async (params) => params.options[0]?.value as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(loadPreferredProviderPickerCatalog).toHaveBeenCalledWith({
      cfg: config,
      preferredProvider: "nvidia",
      agentDir: expect.stringContaining("agents/main/agent"),
    });
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/moonshotai/kimi-k2.5",
    ]);
  });

  it("preselects the first live provider row when keep-current is disabled", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "NVIDIA Nemotron 3 Super 120B",
      },
    ]);
    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "nvidia/nemotron-3-ultra-550b-a55b",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("nvidia/z-ai/glm-5.1");
    expect(pickerParams(select as MockCallSource).initialValue).toBe("nvidia/z-ai/glm-5.1");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "nvidia/z-ai/glm-5.1",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
    expect(
      requireOption(pickerOptions(select as MockCallSource), "nvidia/nemotron-3-ultra-550b-a55b")
        .hint,
    ).toBe("current (not in catalog)");
  });

  it("keeps on-demand NVIDIA vendor labels single-prefixed after browsing", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "NVIDIA Nemotron 3 Super 120B",
      },
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.7",
        name: "MiniMax M2.7",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
    ]);
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockResolvedValueOnce("nvidia/nemotron-3-super-120b-a12b");
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: {
        agents: {
          defaults: {
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
        },
      } as OpenClawConfig,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    const options = pickerOptions(select as MockCallSource, 1);
    expect(requireOption(options, "nvidia/nemotron-3-super-120b-a12b").label).toBe(
      "nvidia/nvidia/nemotron-3-super-120b-a12b",
    );
    expect(requireOption(options, "nvidia/minimaxai/minimax-m2.7").label).toBe(
      "nvidia/minimaxai/minimax-m2.7",
    );
    expect(requireOption(options, "nvidia/z-ai/glm-5.1").label).toBe("nvidia/z-ai/glm-5.1");
  });

  it("omits local NVIDIA static fallback rows when browsing live provider rows", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "NVIDIA Nemotron 3 Super 120B",
      },
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.7",
        name: "MiniMax M2.7",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
    ]);
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "minimaxai/minimax-m2.5", "MiniMax M2.5", "deprecated"),
      manifestTextRow("nvidia", "z-ai/glm5", "GLM5", "deprecated"),
    ]);
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockResolvedValueOnce("nvidia/nemotron-3-super-120b-a12b");
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: {
        agents: {
          defaults: {
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
        },
      } as OpenClawConfig,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    expect(optionValues(pickerOptions(select as MockCallSource, 1))).toEqual([
      "__keep__",
      "__manual__",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/minimaxai/minimax-m2.7",
      "nvidia/z-ai/glm-5.1",
    ]);
  });

  it("uses the configured default agent dir for provider-scoped catalog auth", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
    ]);
    const select = vi.fn(async (params) => params.options[0]?.value as never);
    const prompter = makePrompter({ select });
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: "/tmp/openclaw-picker-state",
    };
    const config = {
      agents: {
        list: [{ id: "worker", default: true }],
        defaults: {
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      },
    } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
      env,
    });

    expect(loadPreferredProviderPickerCatalog).toHaveBeenCalledWith({
      cfg: config,
      preferredProvider: "nvidia",
      agentDir: "/tmp/openclaw-picker-state/agents/worker/agent",
      env,
    });
  });

  it("supports configuring vLLM during setup", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
    ]);
    resolveProviderModelPickerEntries.mockReturnValue([
      { value: "vllm", label: "vLLM (custom)", hint: "Enter vLLM URL + API key + model" },
    ] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "vllm", label: "vLLM", auth: [] },
      method: { id: "custom", label: "vLLM", kind: "custom" },
    });
    runProviderPluginAuthMethod.mockResolvedValue({
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "VLLM_API_KEY",
              models: [
                {
                  id: "meta-llama/Meta-Llama-3-8B-Instruct",
                  name: "meta-llama/Meta-Llama-3-8B-Instruct",
                },
              ],
            },
          },
        },
      },
      defaultModel: "vllm/meta-llama/Meta-Llama-3-8B-Instruct",
    });

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "vllm");
      return (vllm?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(runProviderPluginAuthMethod).toHaveBeenCalledOnce();
    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config,
      workspaceDir: undefined,
      env: undefined,
      mode: "setup",
    });
    expect(result.model).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
    expect(result.config?.models?.providers?.vllm).toEqual({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY", // pragma: allowlist secret
      models: [
        { id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "meta-llama/Meta-Llama-3-8B-Instruct" },
      ],
    });
  });

  it("prefers provider model-picker contributions when the runtime exposes them", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);
    providerModelPickerContributionRuntime.enabled = true;
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        id: "provider:model-picker:ollama",
        kind: "provider",
        surface: "model-picker",
        option: {
          value: "ollama",
          label: "Ollama",
          hint: "Local/self-hosted setup",
        },
      },
    ] as never);
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        value: "legacy-entry",
        label: "Legacy entry",
        hint: "Should not be used when contributions exist",
      },
    ] as never);

    const select = vi.fn(async (params) => {
      const ollama = params.options.find((opt: { value: string }) => opt.value === "ollama");
      return (ollama?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(providerModelPickerContributionRuntime.resolve).toHaveBeenCalledOnce();
    const options = pickerOptions(select as MockCallSource);
    expect(requireOption(options, "ollama").label).toBe("Ollama");
    expect(optionValues(options)).not.toContain("legacy-entry");
  });

  it("keeps skip-auth model selection cold when catalog loading is disabled", async () => {
    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      includeProviderPluginSetups: true,
      loadCatalog: false,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(result).toStrictEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(resolveProviderModelPickerEntries).not.toHaveBeenCalled();
    expect(providerModelPickerContributionRuntime.resolve).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "__keep__",
      "__manual__",
      "openai/gpt-5.5",
    ]);
  });

  it("surfaces NVIDIA provider model-picker contributions", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
    ]);
    providerModelPickerContributionRuntime.enabled = true;
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        id: "provider:model-picker:provider-plugin:nvidia:api-key",
        kind: "provider",
        surface: "model-picker",
        option: {
          value: "provider-plugin:nvidia:api-key",
          label: "NVIDIA (custom)",
          hint: "Use NVIDIA-hosted open models",
        },
      },
    ] as never);

    const select = vi.fn(async (params) => {
      const nvidia = params.options.find(
        (opt: { value: string }) => opt.value === "provider-plugin:nvidia:api-key",
      );
      return (nvidia?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(
      requireOption(pickerOptions(select as MockCallSource), "provider-plugin:nvidia:api-key")
        .label,
    ).toBe("NVIDIA (custom)");
  });
});

describe("promptModelAllowlist", () => {
  it("filters to allowed keys when provided", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["anthropic/claude-opus-4-6"],
    });

    const options = pickerOptions(multiselect as MockCallSource);
    expect(optionValues(options)).toEqual(["anthropic/claude-opus-4-6"]);
    expect(result.scopeKeys).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("localizes the model allowlist picker", async () => {
    process.env.OPENCLAW_LOCALE = "zh-CN";
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({ config, prompter });

    expect(multiselect.mock.calls[0]?.[0]?.message).toBe("/model 选择器中的模型（多选）");
  });

  it("uses static manifest catalog rows for a preferred provider without loading runtime catalog", async () => {
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      {
        provider: "github-copilot",
        id: "gpt-5.4",
        name: "GPT-5.4",
        ref: "github-copilot/gpt-5.4",
        mergeKey: "github-copilot:gpt-5.4",
        source: "manifest",
        input: ["text"],
        reasoning: true,
        status: "available",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "github-copilot",
    });

    expect(loadStaticManifestCatalogRowsForList).toHaveBeenCalledWith({
      cfg: config,
      providerFilter: "github-copilot",
    });
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "github-copilot/gpt-5.4",
    ]);
  });

  it("preserves static OpenAI route facts for future model auth checks", async () => {
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      {
        provider: "openai",
        id: "gpt-future",
        name: "GPT Future",
        ref: "openai/gpt-future",
        mergeKey: "openai:gpt-future",
        source: "manifest",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        reasoning: true,
        status: "available",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    await promptModelAllowlist({
      config: { agents: { defaults: {} } },
      prompter: makePrompter({ multiselect }),
      preferredProvider: "openai",
    });

    const checker = createProviderAuthChecker.mock.results.at(-1)?.value;
    expect(checker).toHaveBeenCalledWith("openai", {
      modelId: "gpt-future",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "openai/gpt-future",
    ]);
  });

  it("uses the selected route for allowlist capability hints", async () => {
    providerAuthRoute.value = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
    };
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "Platform GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_000_000,
        reasoning: true,
        input: ["text", "image"],
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "ChatGPT GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 400_000,
        reasoning: false,
        input: ["text"],
      },
    ]);
    const multiselect = createSelectAllMultiselect();

    await promptModelAllowlist({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter: makePrompter({ multiselect }),
    });

    const option = requireOption(pickerOptions(multiselect as MockCallSource), "openai/gpt-5.5");
    expect(option.hint).toContain("ChatGPT GPT-5.5");
    expect(option.hint).toContain("ctx 400k");
    expect(option.hint).not.toContain("reasoning");
  });

  it("uses configured provider models for allowlist picker without loading the full catalog in replace mode", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        mode: "replace",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.test/v1",
            models: [configuredTextModel("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed")],
          },
          zhipu: {
            baseUrl: "https://api.zhipu.test/v1",
            models: [configuredTextModel("glm-4.5-air", "GLM 4.5 Air")],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "minimax/MiniMax-M2.7-highspeed",
      "zhipu/glm-4.5-air",
    ]);
    expect(result.models).toEqual(["minimax/MiniMax-M2.7-highspeed", "zhipu/glm-4.5-air"]);
  });

  it("scopes the initial allowlist picker to the preferred provider", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openai",
    });

    const options = pickerOptions(multiselect as MockCallSource);
    expect(optionValues(options)).toEqual(["openai/gpt-5.5", "openai/gpt-5.4-mini"]);
  });

  it("includes stale configured preferred provider models in the scoped cleanup", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b:free",
        name: "Llama 3.3 70B",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const activeModel = "openrouter/meta-llama/llama-3.3-70b:free";
    const staleModel = "openrouter/elephant-alpha";
    const multiselect = vi.fn(async (params: WizardMultiSelectParams) =>
      params.options.map((option) => option.value).filter((value) => value === activeModel),
    );
    const prompter = makePrompter({
      multiselect: multiselect as unknown as WizardPrompter["multiselect"],
    });
    const config = {
      agents: {
        defaults: {
          models: {
            [activeModel]: { alias: "llama" },
            [staleModel]: { alias: "elephant" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openrouter",
    });

    const options = pickerOptions(multiselect as MockCallSource);
    expect(optionValues(options)).toEqual([activeModel, staleModel]);
    expect(requireOption(options, staleModel).hint).toBe("configured (not in catalog)");
    expect(multiselect.mock.calls[0]?.[0]?.initialValues).toEqual([activeModel, staleModel]);
    expect(result).toEqual({
      models: [activeModel],
      scopeKeys: [activeModel, staleModel],
    });

    const next = applyModelAllowlist(config, result.models ?? [], {
      scopeKeys: result.scopeKeys,
    });
    expect(next.agents?.defaults?.models).toEqual({
      [activeModel]: { alias: "llama" },
      [staleModel]: { alias: "elephant" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "anthropic/claude-sonnet-4-6",
      activeModel,
    ]);
  });

  it("shows configured preferred provider models when the catalog has no entries", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const multiselect = createSelectAllMultiselect();
    const text = vi.fn(async () => "");
    const prompter = makePrompter({ multiselect, text });
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "https://ollama.com/v1",
            models: [
              configuredTextModel("kimi-k2.5:cloud", "Kimi K2.5"),
              configuredTextModel("gpt-oss:20b-cloud", "GPT OSS 20B"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "ollama",
      loadCatalog: true,
    });

    expect(text).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "ollama/kimi-k2.5:cloud",
      "ollama/gpt-oss:20b-cloud",
    ]);
    expect(result).toEqual({
      models: ["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:20b-cloud"],
      scopeKeys: ["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:20b-cloud"],
    });
  });

  it("keeps live preferred-provider rows before configured fallback supplements", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.7",
        name: "MiniMax M2.7",
      },
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron 3 Super",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            models: [
              configuredTextModel("nvidia/nemotron-3-super-120b-a12b", "Bundled Nemotron 3 Super"),
              configuredTextModel("moonshotai/kimi-k2.5", "Bundled Kimi K2.5"),
              configuredTextModel("minimaxai/minimax-m2.7", "Bundled MiniMax M2.7"),
              configuredTextModel("z-ai/glm5", "Bundled GLM5"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "nvidia",
      loadCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual([
      "nvidia/minimaxai/minimax-m2.7",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/moonshotai/kimi-k2.5",
      "nvidia/z-ai/glm5",
    ]);
    expect(result.scopeKeys).toEqual(values);
  });

  it("keeps provider-scoped live rows authoritative over configured provider supplements", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron 3 Super",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.7",
        name: "MiniMax M2.7",
      },
      {
        provider: "nvidia",
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
      },
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.5",
        name: "MiniMax M2.5",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm5",
        name: "GLM5",
      },
    ]);
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "nvidia/nemotron-3-super-120b-a12b", "Bundled Nemotron 3 Super"),
      manifestTextRow("nvidia", "moonshotai/kimi-k2.5", "Bundled Kimi K2.5"),
      manifestTextRow("nvidia", "minimaxai/minimax-m2.7", "Bundled MiniMax M2.7"),
      manifestTextRow("nvidia", "z-ai/glm-5.1", "Bundled GLM 5.1"),
      manifestTextRow("nvidia", "minimaxai/minimax-m2.5", "Bundled MiniMax M2.5", "deprecated"),
      manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated"),
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            models: [
              configuredTextModel("nvidia/nemotron-3-super-120b-a12b", "Bundled Nemotron 3 Super"),
              configuredTextModel("moonshotai/kimi-k2.5", "Bundled Kimi K2.5"),
              configuredTextModel("minimaxai/minimax-m2.7", "Bundled MiniMax M2.7"),
              configuredTextModel("z-ai/glm-5.1", "Bundled GLM 5.1"),
              configuredTextModel("minimaxai/minimax-m2.5", "Bundled MiniMax M2.5"),
              configuredTextModel("z-ai/glm5", "Bundled GLM5"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/z-ai/glm-5.1",
      "nvidia/minimaxai/minimax-m2.7",
      "nvidia/moonshotai/kimi-k2.5",
    ]);
    expect(result.scopeKeys).toEqual(values);
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps custom configured rows after provider-scoped live rows", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron 3 Super",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm-5.1",
        name: "GLM 5.1",
      },
    ]);
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "nvidia/nemotron-3-super-120b-a12b", "Bundled Nemotron 3 Super"),
      manifestTextRow("nvidia", "z-ai/glm-5.1", "Bundled GLM 5.1"),
      manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated"),
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            models: [
              configuredTextModel("nvidia/nemotron-3-super-120b-a12b", "Bundled Nemotron 3 Super"),
              configuredTextModel("z-ai/glm5", "Configured GLM5 fallback"),
              configuredTextModel("private/custom-nvidia", "Private NVIDIA model"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/z-ai/glm-5.1",
      "nvidia/private/custom-nvidia",
    ]);
    expect(result.scopeKeys).toEqual(values);
  });

  it("does not re-add configured static rows after filtering deprecated live rows", async () => {
    loadPreferredProviderPickerCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "minimaxai/minimax-m2.5",
        name: "MiniMax M2.5",
      },
      {
        provider: "nvidia",
        id: "z-ai/glm5",
        name: "GLM5",
      },
    ]);
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "minimaxai/minimax-m2.5", "Bundled MiniMax M2.5", "deprecated"),
      manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated"),
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            models: [
              configuredTextModel("minimaxai/minimax-m2.5", "Configured MiniMax M2.5"),
              configuredTextModel("z-ai/glm5", "Configured GLM5"),
              configuredTextModel("private/custom-nvidia", "Private NVIDIA model"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual(["nvidia/private/custom-nvidia"]);
    expect(result.scopeKeys).toEqual(values);
  });

  it("uses configured provider rows when a provider-scoped live catalog is unavailable", async () => {
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated"),
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            models: [
              configuredTextModel("custom-nvidia-model", "Custom NVIDIA model"),
              configuredTextModel("z-ai/glm5", "Configured GLM5 fallback"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual(["nvidia/custom-nvidia-model", "nvidia/z-ai/glm5"]);
    expect(result.scopeKeys).toEqual(values);
    expect(loadStaticManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps local no-key provider models visible in allowlist choices", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      {
        provider: "vllm",
        id: "meta-llama/Meta-Llama-3-8B-Instruct",
        name: "Meta Llama",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          vllm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [configuredTextModel("meta-llama/Meta-Llama-3-8B-Instruct", "Meta Llama")],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "vllm/meta-llama/Meta-Llama-3-8B-Instruct",
    ]);
    expect(result.models).toEqual(["vllm/meta-llama/Meta-Llama-3-8B-Instruct"]);
  });

  it("seeds existing model fallbacks into unscoped allowlist selections", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });
    const call = pickerParams(multiselect as MockCallSource);
    expect(optionValues(call.options as PickerOption[])).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(call.initialValues).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
    expect(result.models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  it("resolves bare fallback seeds against the primary model provider", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "claude-sonnet-4-6",
        name: "Wrong provider",
      },
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });
    const call = pickerParams(multiselect as MockCallSource);

    expect(call.initialValues).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(result.models).toEqual(["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"]);
  });

  it("keeps the no-catalog allowlist prompt blank when no allowlist exists", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const text = vi.fn(async (params) => params.initialValue ?? "");
    const prompter = makePrompter({ text });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(pickerParams(text as MockCallSource).initialValue).toBe("");
    expect(result).toStrictEqual({});
  });

  it("shows existing fallbacks in the no-catalog allowlist prompt when an allowlist exists", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const text = vi.fn(async (params) => params.initialValue ?? "");
    const prompter = makePrompter({ text });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(pickerParams(text as MockCallSource).initialValue).toBe(
      "openai/gpt-5.5, anthropic/claude-sonnet-4-6",
    );
    expect(result.models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  it("keeps provider-scoped fallback supplements within scope", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openai",
    });

    const call = pickerParams(multiselect as MockCallSource);
    expect(optionValues(call.options as PickerOption[])).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ]);
    expect(call.initialValues).toEqual(["openai/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
  });

  it("uses configured provider-scoped seeds without loading the full catalog", async () => {
    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openai",
      loadCatalog: false,
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual(["openai/gpt-5.5"]);
    expect(pickerParams(multiselect as MockCallSource).initialValues).toEqual(["openai/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5"],
    });
  });

  it("uses explicit allowed model keys without loading the full catalog", async () => {
    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
      preferredProvider: "openai",
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ]);
    expect(pickerParams(multiselect as MockCallSource).initialValues).toEqual(["openai/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai/gpt-5.5", "openai/gpt-5.4"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
  });
});

describe("runtime model picker visibility", () => {
  it("hides legacy runtime refs from allowlist choices and configured supplements", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google-gemini-cli", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          models: {
            "codex/gpt-5.5": { alias: "legacy-codex" },
            "claude-cli/claude-sonnet-4-6": { alias: "CLI Claude" },
            "google-gemini-cli/gemini-3-pro-preview": { alias: "CLI Gemini" },
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    await promptModelAllowlist({ config, prompter });

    const call = pickerParams(multiselect as MockCallSource);
    const values = optionValues(call.options as PickerOption[]);
    expect(values).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.6-sol",
    ]);
    expect(call.initialValues).toEqual(["openai/gpt-5.5", "openai/gpt-5.6-sol"]);
  });
});

describe("router model filtering", () => {
  it("filters internal router models in both default and allowlist prompts", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const multiselect = createSelectAllMultiselect();
    const defaultPrompter = makePrompter({ select });
    const allowlistPrompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter: defaultPrompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });
    await promptModelAllowlist({ config, prompter: allowlistPrompter });

    const defaultOptions = pickerOptions(select as MockCallSource);
    expectRouterModelFiltering(defaultOptions);

    const allowlistCall = pickerParams(multiselect as MockCallSource);
    expectRouterModelFiltering(allowlistCall.options as Array<{ value: string }>);
    expect(allowlistCall.searchable).toBe(true);
    expect(runProviderPluginAuthMethod).not.toHaveBeenCalled();
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
  });

  it("normalizes retired Google Gemini refs before writing selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "gemini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, [
      "google/gemini-3-pro-preview",
      "google-gemini-cli/gemini-3-pro-preview",
      "openrouter/google/gemini-3-pro-preview",
    ]);
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "gemini" },
      "google-gemini-cli/gemini-3.1-pro-preview": {},
      "openrouter/google/gemini-3.1-pro-preview": {},
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "google/gemini-3.1-pro-preview",
      "google-gemini-cli/gemini-3.1-pro-preview",
      "openrouter/google/gemini-3.1-pro-preview",
    ]);
  });

  it("keeps non-Google provider Gemini-looking refs unchanged while writing selected models", () => {
    const config = {} as OpenClawConfig;

    const next = applyModelAllowlist(config, ["litellm/gemini-3-flash", "litellm/gemini-3.1-pro"]);
    expect(next.agents?.defaults?.models).toEqual({
      "litellm/gemini-3-flash": {},
      "litellm/gemini-3.1-pro": {},
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "litellm/gemini-3-flash",
      "litellm/gemini-3.1-pro",
    ]);
  });

  it("preserves entries outside scoped allowlist updates", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
          modelPolicy: { allow: ["openai/*", "anthropic/*", "sonnet"] },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["anthropic/claude-sonnet-4-6"], {
      scopeKeys: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/*",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("seeds provider-scoped configure edits from the effective legacy allowlist", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig;

    const applied = applyModelAllowlist(config, ["openai/gpt-5.6-sol"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.6-sol"],
    });
    const next = stampConfigWriteMetadata(applied, undefined, undefined, config);

    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.6-sol",
    ]);
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("clears an effective legacy restriction and preserves model metadata", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const applied = applyModelAllowlist(config, []);
    const next = stampConfigWriteMetadata(applied, undefined, undefined, config);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([]);
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("does not inject a phantom primary when none was configured", () => {
    const config = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.model).not.toHaveProperty("primary");
  });

  it("does not write an empty model object for singleton default selections", () => {
    const config = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next).toBe(config);
  });

  it("clears existing fallbacks when only the primary remains selected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["anthropic/claude-opus-4-6"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
  });

  it("normalizes retired Google Gemini refs in selected fallbacks before writing config", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "openai/gpt-5.5",
      "google/gemini-3-pro-preview",
      "openrouter/google/gemini-3-pro-preview",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["google/gemini-3.1-pro-preview", "openrouter/google/gemini-3.1-pro-preview"],
    });
  });

  it("normalizes a retired Google Gemini primary while writing selected fallbacks", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-pro-preview",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.5",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["openai/gpt-5.5"],
    });
  });

  it("drops malformed fallback refs instead of preserving raw strings", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("preserves hidden fallbacks during unscoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["claude-cli/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["claude-cli/claude-sonnet-4-6"],
    });
  });

  it("preserves out-of-scope fallbacks during scoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("removes scoped fallbacks for empty scoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5", "google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
  });

  it("does not add new scoped fallbacks when the primary is outside scope", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5", "openai/gpt-5.4"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.5"],
    });
  });

  it("removes existing scoped fallback aliases when deselected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["mini"],
          },
          models: {
            "openai/gpt-5.4-mini": { alias: "mini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("canonicalizes existing scoped fallback aliases when kept selected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["mini"],
          },
          models: {
            "openai/gpt-5.4-mini": { alias: "mini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(
      config,
      ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      {
        scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      },
    );
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.5"] },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.5"],
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
