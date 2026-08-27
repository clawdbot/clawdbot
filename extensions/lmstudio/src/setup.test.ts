import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
// Lmstudio tests cover setup plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
} from "./defaults.js";
import type { LmstudioModelWire } from "./models.js";
import {
  configureLmstudioNonInteractive,
  discoverLmstudioProvider,
  prepareAppGuidedLmstudioSetup,
  promptAndConfigureLmstudioInteractive,
} from "./setup.js";

const fetchLmstudioModelsMock = vi.hoisted(() => vi.fn());
const discoverLmstudioModelsMock = vi.hoisted(() => vi.fn());
const configureSelfHostedNonInteractiveMock = vi.hoisted(() => vi.fn());
const removeProviderAuthProfilesWithLockMock = vi.hoisted(() => vi.fn());

vi.mock("./models.fetch.js", () => ({
  fetchLmstudioModels: (...args: unknown[]) => fetchLmstudioModelsMock(...args),
  discoverLmstudioModels: (...args: unknown[]) => discoverLmstudioModelsMock(...args),
  ensureLmstudioModelLoaded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    removeProviderAuthProfilesWithLock: (...args: unknown[]) =>
      removeProviderAuthProfilesWithLockMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>();
  return {
    ...actual,
    configureOpenAICompatibleSelfHostedProviderNonInteractive: (...args: unknown[]) =>
      configureSelfHostedNonInteractiveMock(...args),
  };
});

afterAll(() => {
  vi.doUnmock("./models.fetch.js");
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/provider-setup");
  vi.resetModules();
});

function createModel(): ModelDefinitionConfig {
  return {
    id: "qwen3-8b-instruct",
    name: "Qwen3 8B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 8192,
  };
}

function buildConfig(
  provider: Partial<ModelProviderConfig> = {
    apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    api: "openai-completions",
  },
  config: Omit<OpenClawConfig, "models"> = {},
): OpenClawConfig {
  return {
    ...config,
    models: {
      providers: {
        lmstudio: {
          baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
          models: [],
          ...provider,
        },
      },
    },
  };
}

function createWireModel(
  key: string,
  overrides: Omit<LmstudioModelWire, "key"> = {},
): LmstudioModelWire {
  return {
    type: "llm",
    key,
    loaded_instances: [{ id: `${key}-loaded`, config: { context_length: 32_768 } }],
    ...overrides,
  };
}

function mockFetchedModels(models: LmstudioModelWire[]): void {
  fetchLmstudioModelsMock.mockResolvedValue({ reachable: true, status: 200, models });
}

function mockFetchedModelsOnce(models: LmstudioModelWire[]): void {
  fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: true, status: 200, models });
}

function buildDiscoveryContext(params?: {
  config?: OpenClawConfig;
  apiKey?: string;
  discoveryApiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderCatalogContext {
  return {
    config: params?.config ?? ({} as OpenClawConfig),
    env: params?.env ?? {},
    resolveProviderApiKey: () => ({
      apiKey: params?.apiKey,
      discoveryApiKey: params?.discoveryApiKey,
    }),
    resolveProviderAuth: () => ({
      apiKey: params?.apiKey,
      discoveryApiKey: params?.discoveryApiKey,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

function buildNonInteractiveContext(params?: {
  config?: OpenClawConfig;
  customBaseUrl?: string;
  customApiKey?: string;
  lmstudioApiKey?: string;
  customModelId?: string;
  resolvedApiKey?: string | null;
  resolvedApiKeySource?: "flag" | "env" | "profile";
}) {
  return {
    authChoice: "lmstudio",
    config: params?.config ?? buildConfig(),
    baseConfig: params?.config ?? buildConfig(),
    opts: {
      customBaseUrl: params?.customBaseUrl,
      customApiKey: params?.customApiKey ?? "lmstudio-test-key",
      lmstudioApiKey: params?.lmstudioApiKey,
      customModelId: params?.customModelId,
    } as ProviderAuthMethodNonInteractiveContext["opts"],
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(
      async (_options: Parameters<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>[0]) =>
        params?.resolvedApiKey === null
          ? null
          : {
              key: params?.resolvedApiKey ?? "lmstudio-test-key",
              source: params?.resolvedApiKeySource ?? "flag",
            },
    ),
    toApiKeyCredential: vi.fn(),
  } satisfies ProviderAuthMethodNonInteractiveContext;
}

async function runNonInteractive(params?: Parameters<typeof buildNonInteractiveContext>[0]) {
  const ctx = buildNonInteractiveContext({
    customBaseUrl: "http://localhost:1234/api/v1/",
    customModelId: "qwen3-8b-instruct",
    ...params,
  });
  return { ctx, result: await configureLmstudioNonInteractive(ctx) };
}

function createPromptText(apiKey = "lmstudio-test-key", baseUrl = "http://localhost:1234/api/v1/") {
  return vi.fn().mockResolvedValueOnce(baseUrl).mockResolvedValueOnce(apiKey);
}

function runInteractive(
  params: Omit<Parameters<typeof promptAndConfigureLmstudioInteractive>[0], "config"> & {
    config?: OpenClawConfig;
  } = {},
) {
  const { config = buildConfig(), ...options } = params;
  return promptAndConfigureLmstudioInteractive({
    config,
    ...(options.prompter || options.promptText
      ? options
      : { ...options, promptText: createPromptText() }),
  });
}

function runDiscovery(
  provider: Partial<ModelProviderConfig>,
  context: Omit<NonNullable<Parameters<typeof buildDiscoveryContext>[0]>, "config"> = {},
) {
  return discoverLmstudioProvider(
    buildDiscoveryContext({ config: buildConfig(provider), ...context }),
  );
}

type WizardPromptValues = {
  baseUrl?: string;
  apiKey?: string;
  context?: string;
};

function createQueuedWizardPrompterHarness(
  values: WizardPromptValues = {},
  confirmValues: boolean[] = [],
) {
  return createQueuedWizardPrompter({
    textValues: [
      values.baseUrl ?? "http://localhost:1234/api/v1/",
      values.apiKey ?? "lmstudio-test-key",
      ...(values.context === undefined ? [] : [values.context]),
    ],
    confirmValues,
  });
}

function createMethodBoundWizardPrompterHarness(values: WizardPromptValues = {}): {
  prompter: WizardPrompter;
  note: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const { prompter, note, text } = createQueuedWizardPrompterHarness(values);

  class MethodBoundWizardPrompter implements WizardPrompter {
    intro = prompter.intro;
    outro = prompter.outro;
    select = prompter.select;
    multiselect = prompter.multiselect;
    confirm = prompter.confirm;
    progress = prompter.progress;

    async note(message: string, title?: string) {
      await this.recordNote(message, title);
    }
    async text() {
      return await this.readText();
    }
    private async readText(): Promise<string> {
      return (await text()) as string;
    }
    private async recordNote(message: string, title?: string) {
      await note(message, title);
    }
  }

  return { prompter: new MethodBoundWizardPrompter(), note, text };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label = "LM Studio provider",
) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function expectApiKeyProvider(provider: unknown) {
  expectRecordFields(provider, {
    auth: "api-key",
    apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  });
}

function requireNonInteractiveLmstudioProvider(
  result: Awaited<ReturnType<typeof configureLmstudioNonInteractive>>,
): Record<string, unknown> {
  return requireRecord(result?.models?.providers?.lmstudio, "LM Studio provider config");
}

function requireConfigPatchLmstudioProvider(
  result: Awaited<ReturnType<typeof promptAndConfigureLmstudioInteractive>>,
): Record<string, unknown> {
  return requireRecord(
    result.configPatch?.models?.providers?.lmstudio,
    "LM Studio config patch provider",
  );
}

function requireProviderModels(provider: unknown): unknown[] {
  const models = requireRecord(provider, "LM Studio provider").models;
  if (!Array.isArray(models)) {
    throw new Error("expected LM Studio models to be an array");
  }
  return models;
}

function expectModelFields(
  model: unknown,
  expected: Record<string, unknown> = { id: "qwen3-8b-instruct" },
) {
  expectRecordFields(model, expected, "LM Studio model");
}

function expectProfileFields(profile: unknown, key: string) {
  const expectedCredential = { type: "api_key", provider: "lmstudio", key };
  const profileRecord = requireRecord(profile, "LM Studio profile");
  expect(profileRecord.profileId).toBe("lmstudio:default");
  expect(profileRecord.credential).toEqual(expectedCredential);
}

describe("lmstudio setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    fetchLmstudioModelsMock.mockReset();
    discoverLmstudioModelsMock.mockReset();
    configureSelfHostedNonInteractiveMock.mockReset();
    removeProviderAuthProfilesWithLockMock.mockReset();

    mockFetchedModels([createWireModel("qwen3-8b-instruct")]);
    discoverLmstudioModelsMock.mockResolvedValue([createModel()]);
    configureSelfHostedNonInteractiveMock.mockImplementation(
      async ({
        providerId,
        ctx,
      }: {
        providerId: string;
        ctx: ProviderAuthMethodNonInteractiveContext;
      }) => {
        const modelId =
          (typeof ctx.opts.customModelId === "string" ? ctx.opts.customModelId.trim() : "") ||
          "qwen3-8b-instruct";
        return {
          agents: { defaults: { model: { primary: `${providerId}/${modelId}` } } },
          models: {
            providers: {
              [providerId]: { api: "openai-completions", auth: "api-key", apiKey: "LM_API_TOKEN" },
            },
          },
        };
      },
    );
  });

  it("prepares an existing tool-capable LLM without a credential profile", async () => {
    mockFetchedModels([
      createWireModel("nomic-embed", { type: "embedding" }),
      createWireModel("chat-only", { display_name: "Chat only" }),
      createWireModel("qwen3-8b-instruct", {
        display_name: "Qwen3 8B",
        max_context_length: 65536,
        capabilities: { trained_for_tool_use: true },
      }),
    ]);

    const result = await prepareAppGuidedLmstudioSetup({ config: {}, env: {} });

    expect(result).toMatchObject({
      profiles: [],
      defaultModel: "lmstudio/qwen3-8b-instruct",
      configPatch: {
        models: {
          mode: "merge",
          providers: {
            lmstudio: {
              baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
              api: "openai-completions",
              models: [
                expect.objectContaining({ id: "chat-only" }),
                expect.objectContaining({ id: "qwen3-8b-instruct" }),
              ],
            },
          },
        },
      },
    });
    expect(result?.configPatch?.models?.providers?.lmstudio?.apiKey).toBe(
      LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    );
    await expect(
      prepareAppGuidedLmstudioSetup({
        config: {},
        env: {},
        modelRef: "lmstudio/chat-only",
      }),
    ).resolves.toBeNull();
    await expect(
      prepareAppGuidedLmstudioSetup({
        config: {},
        env: {},
        modelRef: "lmstudio/not-installed",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      name: "prefers the strongest tool-calling family among loaded models",
      models: [
        {
          key: "llama3.3-70b-instruct",
          max_context_length: 65_536,
          loaded_instances: [{ id: "llama", config: { context_length: 32_768 } }],
        },
        {
          key: "qwen3.5-4b-instruct",
          max_context_length: 65_536,
          loaded_instances: [{ id: "qwen", config: { context_length: 32_768 } }],
        },
        {
          key: "nomic-embed-text",
          max_context_length: 65_536,
          loaded_instances: [{ id: "nomic", config: { context_length: 32_768 } }],
        },
      ],
      expectedModel: "lmstudio/qwen3.5-4b-instruct",
    },
    {
      name: "ignores a preferred downloaded model when another model is loaded",
      models: [
        {
          key: "qwen3.5-4b-instruct",
          max_context_length: 65_536,
          loaded_instances: [],
        },
        {
          key: "llama3.3-70b-instruct",
          max_context_length: 65_536,
          loaded_instances: [{ id: "llama", config: { context_length: 32_768 } }],
        },
      ],
      expectedModel: "lmstudio/llama3.3-70b-instruct",
    },
    {
      name: "skips a preferred model loaded with less than 16k context",
      models: [
        {
          key: "llama3.3-70b-instruct",
          max_context_length: 65_536,
          loaded_instances: [{ id: "llama", config: { context_length: 32_768 } }],
        },
        {
          key: "qwen3.5-4b-instruct",
          max_context_length: 65_536,
          loaded_instances: [{ id: "qwen", config: { context_length: 8_192 } }],
        },
      ],
      expectedModel: "lmstudio/llama3.3-70b-instruct",
    },
    {
      name: "does not auto-detect a model without measured or advertised context",
      models: [{ key: "qwen3.5-4b-instruct" }],
      expectedModel: undefined,
    },
  ])("$name", async ({ models, expectedModel }) => {
    mockFetchedModels(
      models.map((model) => ({
        type: "llm",
        capabilities: { trained_for_tool_use: true },
        ...model,
      })),
    );

    const result = await prepareAppGuidedLmstudioSetup({ config: {}, env: {} });
    if (expectedModel) {
      expect(result?.defaultModel).toBe(expectedModel);
    } else {
      expect(result).toBeNull();
    }
  });

  it("non-interactive setup discovers catalog and writes LM Studio provider config", async () => {
    mockFetchedModelsOnce([
      createWireModel("qwen3-8b-instruct", {
        display_name: "Qwen3 8B",
        loaded_instances: [{ id: "inst-1", config: { context_length: 64000 } }],
      }),
      createWireModel("text-embedding-nomic-embed-text-v1.5", { type: "embedding" }),
    ]);
    const { result } = await runNonInteractive();

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "lmstudio-test-key",
      timeoutMs: 5000,
    });
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      auth: "api-key",
      apiKey: "LM_API_TOKEN",
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: 64000,
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
  });

  it("non-interactive setup preserves existing custom headers when CLI auth is provided", async () => {
    const { result } = await runNonInteractive({
      config: buildConfig({
        api: "openai-completions",
        apiKey: "LM_API_TOKEN",
        headers: {
          Authorization: "Bearer stale-token",
          "X-Proxy-Auth": "proxy-token",
        },
      }),
    });

    expectRecordFields(requireNonInteractiveLmstudioProvider(result), {
      auth: "api-key",
      apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      headers: {
        Authorization: "Bearer stale-token",
        "X-Proxy-Auth": "proxy-token",
      },
    });
  });

  it("non-interactive setup selects the preferred discovered model when none is provided", async () => {
    mockFetchedModelsOnce([
      createWireModel("phi-4", { max_context_length: 65536 }),
      createWireModel("qwen3-8b-instruct", { display_name: "Qwen3 8B" }),
    ]);
    const { result } = await runNonInteractive({ customModelId: undefined });

    const setupCall = requireRecord(
      configureSelfHostedNonInteractiveMock.mock.calls[0]?.[0],
      "self-hosted setup call",
    );
    const setupCtx = requireRecord(setupCall.ctx, "self-hosted setup context");
    expectRecordFields(
      setupCtx.opts,
      { customModelId: "qwen3-8b-instruct" },
      "self-hosted setup opts",
    );
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const models = requireProviderModels(requireNonInteractiveLmstudioProvider(result));
    expect(models).toHaveLength(2);
    expectModelFields(models[0], {
      id: "phi-4",
      contextWindow: 65536,
    });
    expectModelFields(models[1]);
  });

  it("non-interactive setup synthesizes lmstudio-local when API key is missing", async () => {
    const { result } = await runNonInteractive({
      resolvedApiKey: null,
    });

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0]);
  });

  it.each([
    {
      name: "non-interactive setup keeps Authorization header auth without writing a synthetic key",
      resolvedApiKey: null,
      withProfile: true,
    },
    {
      name: "non-interactive setup clears stale profile auth before switching to Authorization header auth",
      resolvedApiKey: "stale-profile-key",
      resolvedApiKeySource: "profile" as const,
      withProfile: true,
    },
    {
      name: "non-interactive setup clears env fallback auth before switching to Authorization header auth",
      resolvedApiKey: "env-fallback-key",
      resolvedApiKeySource: "env" as const,
      withProfile: false,
    },
  ])("$name", async ({ resolvedApiKey, resolvedApiKeySource, withProfile }) => {
    const headers = { Authorization: "Bearer proxy-token" };
    const { result } = await runNonInteractive({
      config: buildConfig(
        {
          ...(withProfile ? { apiKey: "stale-config-key" } : {}),
          auth: "api-key",
          api: "openai-completions",
          headers,
        },
        withProfile
          ? {
              auth: {
                profiles: { "lmstudio:default": { provider: "lmstudio", mode: "api_key" } },
                order: { lmstudio: ["lmstudio:default"] },
              },
            }
          : {},
      ),
      customApiKey: "",
      resolvedApiKey,
      resolvedApiKeySource,
    });

    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: undefined,
      headers: { Authorization: "Bearer proxy-token" },
      timeoutMs: 5000,
    });
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: { Authorization: "Bearer proxy-token" },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0]);
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
    expect(result?.auth).toBeUndefined();
  });

  it("non-interactive setup prefers --lmstudio-api-key over --custom-api-key", async () => {
    const { ctx } = await runNonInteractive({
      customApiKey: "old-custom-key",
      lmstudioApiKey: "new-lmstudio-key",
    });

    expectRecordFields(
      ctx.resolveApiKey.mock.calls[0]?.[0],
      { flagValue: "new-lmstudio-key", flagName: "--lmstudio-api-key" },
      "resolveApiKey options",
    );
  });

  it("non-interactive setup overwrites existing config apiKey during re-auth", async () => {
    const { result } = await runNonInteractive({
      config: buildConfig({
        auth: "api-key",
        apiKey: "stale-config-key",
        api: "openai-completions",
      }),
      lmstudioApiKey: "fresh-cli-key",
      resolvedApiKey: "fresh-cli-key",
    });

    const provider = requireNonInteractiveLmstudioProvider(result);
    expectApiKeyProvider(provider);
    expect(provider.apiKey).not.toBe("stale-config-key");
  });

  it("non-interactive setup fails when requested model is missing", async () => {
    const ctx = buildNonInteractiveContext({
      customModelId: "missing-model",
    });
    const dockerSetup = ["1", "true", "yes", "on"].includes(
      process.env.OPENCLAW_DOCKER_SETUP?.trim().toLowerCase() ?? "",
    );
    const expectedBaseUrl = dockerSetup
      ? LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL
      : LMSTUDIO_DEFAULT_INFERENCE_BASE_URL;

    await expect(configureLmstudioNonInteractive(ctx)).resolves.toBeNull();

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      `LM Studio model missing-model was not found at ${expectedBaseUrl}.\nAvailable models: qwen3-8b-instruct`,
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
  });

  it("non-interactive setup rejects an installed model that is not loaded", async () => {
    mockFetchedModelsOnce([
      createWireModel("qwen3-8b-instruct", { loaded_instances: [] }),
      createWireModel("phi-4"),
    ]);
    const ctx = buildNonInteractiveContext({
      customModelId: "qwen3-8b-instruct",
    });

    await expect(configureLmstudioNonInteractive(ctx)).resolves.toBeNull();

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "LM Studio model qwen3-8b-instruct is installed but not loaded at http://localhost:1234/v1.\nLoad that model in LM Studio, then re-run setup.",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
  });

  it("interactive setup canonicalizes base URL and persists provider/default model", async () => {
    const result = await runInteractive();

    expect(result.configPatch?.models?.mode).toBe("merge");
    expectRecordFields(requireConfigPatchLmstudioProvider(result), {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      auth: "api-key",
      apiKey: "LM_API_TOKEN",
    });
    expect(result.defaultModel).toBe("lmstudio/qwen3-8b-instruct");
    expectProfileFields(result.profiles[0], "lmstudio-test-key");
  });

  it("interactive setup applies an optional preferred context length to all discovered LM Studio models", async () => {
    mockFetchedModelsOnce([
      createWireModel("phi-4", { display_name: "Phi 4", max_context_length: 65536 }),
      createWireModel("qwen3-8b-instruct", {
        display_name: "Qwen3 8B",
        max_context_length: 32768,
      }),
    ]);
    const { prompter, text } = createQueuedWizardPrompterHarness({ context: "4096" });

    const result = await runInteractive({ prompter });

    expect(text).toHaveBeenCalledTimes(3);
    const models = requireProviderModels(requireConfigPatchLmstudioProvider(result));
    expect(models).toHaveLength(2);
    expectModelFields(models[0], {
      id: "phi-4",
      contextWindow: 65536,
      contextTokens: 4096,
      maxTokens: 4096,
    });
    expectModelFields(models[1], {
      id: "qwen3-8b-instruct",
      contextWindow: 32768,
      contextTokens: 4096,
      maxTokens: 4096,
    });
  });

  it("interactive setup preserves gateway wizard prompter method binding", async () => {
    const { prompter, text } = createMethodBoundWizardPrompterHarness({ context: "4096" });

    const result = await runInteractive({ prompter });

    expect(text).toHaveBeenCalledTimes(3);
    expect(result.defaultModel).toBe("lmstudio/qwen3-8b-instruct");
  });

  it("interactive setup preserves gateway wizard note binding on discovery failure", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: false, models: [] });
    const { prompter, note, text } = createMethodBoundWizardPrompterHarness();

    await expect(
      promptAndConfigureLmstudioInteractive({
        config: buildConfig(),
        prompter,
      }),
    ).rejects.toThrow("LM Studio not reachable");

    expect(text).toHaveBeenCalledTimes(2);
    expect(note).toHaveBeenCalledWith(
      "LM Studio could not be reached at http://localhost:1234/v1.\nStart LM Studio (or run lms server start) and re-run setup.",
      "LM Studio",
    );
  });

  it("remote interactive setup retries discovery without asking for context tuning", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: false, models: [] });
    mockFetchedModelsOnce([
      createWireModel("text-embedding-nomic-embed-text-v1.5", { type: "embedding" }),
    ]);
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: true, status: 503, models: [] });
    mockFetchedModelsOnce([createWireModel("qwen3-8b-instruct")]);
    const { prompter, note, text, confirm } = createQueuedWizardPrompterHarness({}, [
      true,
      true,
      true,
    ]);

    const result = await runInteractive({ prompter, isRemote: true });

    expect(note).toHaveBeenCalledWith(
      "LM Studio could not be reached at http://localhost:1234/v1.\nStart LM Studio (or run lms server start), then continue to retry.",
      "LM Studio",
    );
    expect(confirm).toHaveBeenCalledWith({
      message: "Retry this LM Studio connection now?",
      initialValue: true,
    });
    expect(note).toHaveBeenCalledWith(
      "LM Studio returned HTTP 503 while listing models at http://localhost:1234/v1.\nWait for LM Studio to recover, then continue to retry.",
      "LM Studio",
    );
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(text).toHaveBeenCalledTimes(2);
    expect(result.defaultModel).toBe("lmstudio/qwen3-8b-instruct");
  });

  it("remote interactive setup does not retry immutable HTTP failures", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: true, status: 401, models: [] });
    const { prompter, note, confirm } = createQueuedWizardPrompterHarness();

    await expect(
      promptAndConfigureLmstudioInteractive({
        config: buildConfig(),
        prompter,
        isRemote: true,
      }),
    ).rejects.toThrow("LM Studio discovery failed (401)");

    expect(note).toHaveBeenCalledWith(
      "LM Studio returned HTTP 401 while listing models at http://localhost:1234/v1.\nCheck the base URL and API key, then re-run setup.",
      "LM Studio",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("remote interactive setup stops when cancelled during retry discovery", async () => {
    const controller = new AbortController();
    const retry = createDeferred<{ reachable: true; status: 200; models: never[] }>();
    fetchLmstudioModelsMock
      .mockResolvedValueOnce({ reachable: false, models: [] })
      .mockImplementationOnce(() => retry.promise);
    const { prompter } = createQueuedWizardPrompterHarness({}, [true]);

    const setup = runInteractive({ prompter, isRemote: true, signal: controller.signal });
    await vi.waitFor(() => expect(fetchLmstudioModelsMock).toHaveBeenCalledTimes(2));
    controller.abort();
    retry.resolve({ reachable: true, status: 200, models: [] });

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
    expect(removeProviderAuthProfilesWithLockMock).not.toHaveBeenCalled();
  });

  it("interactive setup accepts a blank API key for unauthenticated local LM Studio", async () => {
    const { prompter, text } = createQueuedWizardPrompterHarness({ apiKey: "", context: "" });

    const result = await runInteractive({ prompter });

    expect(text).toHaveBeenCalledTimes(3);
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(result.profiles).toStrictEqual([]);
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0]);
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive Docker setup defaults to the host LM Studio endpoint", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const { prompter, text } = createQueuedWizardPrompterHarness({
      baseUrl: "http://host.docker.internal:1234",
      apiKey: "",
      context: "",
    });

    const result = await runInteractive({ prompter });

    const firstTextCall = requireRecord(text.mock.calls[0]?.[0], "first text prompt");
    expectRecordFields(
      firstTextCall,
      {
        initialValue: "http://host.docker.internal:1234",
        placeholder: "http://host.docker.internal:1234",
      },
      "first text prompt",
    );
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    expectRecordFields(requireConfigPatchLmstudioProvider(result), {
      baseUrl: "http://host.docker.internal:1234/v1",
    });
  });

  it("interactive setup uses existing Authorization headers when the API key is blank", async () => {
    const config = buildConfig({
      api: "openai-completions",
      apiKey: "stale-config-key",
      auth: "api-key",
      headers: { Authorization: "Bearer proxy-token" },
    });
    const { prompter } = createQueuedWizardPrompterHarness({ apiKey: "", context: "" });

    const result = await runInteractive({ config, prompter });

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: undefined,
      headers: {
        Authorization: "Bearer proxy-token",
      },
      timeoutMs: 5000,
    });
    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(result.profiles).toStrictEqual([]);
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer proxy-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0]);
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup without a wizard accepts a blank API key for local LM Studio", async () => {
    const result = await runInteractive({ promptText: createPromptText("") });

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(result.profiles).toStrictEqual([]);
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, {
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup overwrites existing config apiKey during re-auth", async () => {
    const result = await runInteractive({
      config: buildConfig({
        auth: "api-key",
        apiKey: "stale-config-key",
        api: "openai-completions",
      }),
      promptText: createPromptText("fresh-prompt-key"),
    });
    const provider = requireConfigPatchLmstudioProvider(result);
    expectApiKeyProvider(provider);
    expect(provider.apiKey).not.toBe("stale-config-key");
    expectProfileFields(result.profiles[0], "fresh-prompt-key");
  });

  it("interactive setup preserves existing custom headers when switching to api-key auth", async () => {
    const result = await runInteractive({
      config: buildConfig({
        api: "openai-completions",
        apiKey: "LM_API_TOKEN",
        headers: {
          Authorization: "Bearer stale-token",
          "X-Proxy-Auth": "proxy-token",
        },
      }),
    });
    expectRecordFields(requireConfigPatchLmstudioProvider(result), {
      auth: "api-key",
      apiKey: "LM_API_TOKEN",
      headers: {
        Authorization: "Bearer stale-token",
        "X-Proxy-Auth": "proxy-token",
      },
    });
  });

  it("interactive setup preserves existing agent model allowlist entries", async () => {
    const existingModels = { "anthropic/claude-sonnet-4-6": { alias: "Sonnet" } };
    const result = await runInteractive({
      config: buildConfig(
        { api: "openai-completions", apiKey: "LM_API_TOKEN" },
        { agents: { defaults: { models: existingModels } } },
      ),
    });
    expect(result.configPatch?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": {
        alias: "Sonnet",
      },
      "lmstudio/qwen3-8b-instruct": {},
    });
  });

  it("interactive setup returns clear errors for unreachable/http-empty results", async () => {
    const cases = [
      {
        name: "unreachable",
        discovery: { reachable: false, models: [] },
        expectedError: "LM Studio not reachable",
      },
      {
        name: "http error",
        discovery: { reachable: true, status: 401, models: [] },
        expectedError: "LM Studio discovery failed (401)",
      },
      {
        name: "no llm models",
        discovery: {
          reachable: true,
          status: 200,
          models: [{ type: "embedding", key: "text-embedding-nomic-embed-text-v1.5" }],
        },
        expectedError: "No loaded LM Studio models found",
      },
      {
        name: "only unloaded llm models",
        discovery: {
          reachable: true,
          status: 200,
          models: [createWireModel("qwen3-8b-instruct", { loaded_instances: [] })],
        },
        expectedError: "No loaded LM Studio models found",
      },
    ];

    for (const testCase of cases) {
      const promptText = createPromptText("lmstudio-test-key", "http://localhost:1234/v1");
      fetchLmstudioModelsMock.mockResolvedValueOnce(testCase.discovery);
      await expect(
        promptAndConfigureLmstudioInteractive({
          config: buildConfig(),
          promptText,
        }),
        testCase.name,
      ).rejects.toThrow(testCase.expectedError);
    }
  });

  it.each<{
    name: string;
    providerPatch: Partial<ModelProviderConfig>;
    expectedProviderPatch: Partial<ModelProviderConfig>;
  }>([
    {
      name: "injects lmstudio-local for explicit models by default",
      providerPatch: {},
      expectedProviderPatch: {
        apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      },
    },
    {
      name: "keeps api-key auth backed by default env marker",
      providerPatch: {
        auth: "api-key",
      },
      expectedProviderPatch: {
        auth: "api-key",
        apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      },
    },
    {
      name: "does not inject api-key marker when Authorization header is configured",
      providerPatch: {
        apiKey: "stale-legacy-key",
        headers: {
          Authorization: "Bearer custom-token",
        },
      },
      expectedProviderPatch: {
        headers: {
          Authorization: "Bearer custom-token",
        },
      },
    },
    {
      name: "ignores unresolved apiKey template when Authorization header is configured",
      providerPatch: {
        apiKey: "${LMSTUDIO_API_KEY}",
        headers: {
          Authorization: "Bearer custom-token",
        },
      },
      expectedProviderPatch: {
        headers: {
          Authorization: "Bearer custom-token",
        },
      },
    },
    {
      name: "still injects lmstudio-local when only non-auth headers are configured",
      providerPatch: {
        headers: {
          "X-Proxy-Auth": "proxy-token",
        },
      },
      expectedProviderPatch: {
        apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
        headers: {
          "X-Proxy-Auth": "proxy-token",
        },
      },
    },
  ])(
    "discoverLmstudioProvider short-circuits explicit models and $name",
    async ({ providerPatch, expectedProviderPatch }) => {
      const explicitModels = [createModel()];
      const result = await runDiscovery({
        baseUrl: "http://localhost:1234/api/v1/",
        models: explicitModels,
        ...providerPatch,
      });

      expect(discoverLmstudioModelsMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        provider: {
          baseUrl: "http://localhost:1234/v1",
          api: "openai-completions",
          ...expectedProviderPatch,
          models: explicitModels,
        },
      });
    },
  );

  it("discoverLmstudioProvider uses resolved key/headers and non-quiet discovery", async () => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([createModel()]);

    const result = await runDiscovery(
      {
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: "LMSTUDIO_DISCOVERY_TOKEN" },
        headers: {
          "X-Proxy-Auth": { source: "env", provider: "default", id: "LMSTUDIO_PROXY_TOKEN" },
        },
      },
      {
        env: {
          LMSTUDIO_DISCOVERY_TOKEN: "secretref-lmstudio-key",
          LMSTUDIO_PROXY_TOKEN: "proxy-token-from-env",
        },
      },
    );

    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secretref-lmstudio-key",
      headers: {
        "X-Proxy-Auth": "proxy-token-from-env",
      },
      quiet: false,
    });
    expect(result?.provider.models?.map((model) => model.id)).toEqual(["qwen3-8b-instruct"]);
  });

  it.each<{ name: string; providerPatch: Partial<ModelProviderConfig> }>([
    {
      name: "discoverLmstudioProvider returns null for unresolved header refs",
      providerPatch: {
        headers: {
          "X-Proxy-Auth": { source: "env", provider: "default", id: "LMSTUDIO_PROXY_TOKEN" },
        },
      },
    },
    {
      name: "discoverLmstudioProvider returns null for an unresolved apiKey ref",
      providerPatch: {
        apiKey: { source: "env", provider: "default", id: "LMSTUDIO_DISCOVERY_TOKEN" },
      },
    },
  ])("$name", async ({ providerPatch }) => {
    const result = await runDiscovery({ api: "openai-completions", ...providerPatch }, { env: {} });

    expect(result).toBeNull();
    expect(discoverLmstudioModelsMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "discoverLmstudioProvider uses configured direct apiKey for discovery",
      configuredApiKey: "configured-direct-key",
      expectedApiKey: "configured-direct-key",
    },
    {
      name: "discoverLmstudioProvider prefers resolved discoveryApiKey over configured apiKey",
      configuredApiKey: "configured-direct-key",
      discoveryApiKey: "resolved-discovery-key",
      expectedApiKey: "resolved-discovery-key",
    },
    {
      name: "discoverLmstudioProvider ignores an unresolved apiKey template when discoveryApiKey is resolved",
      configuredApiKey: "${LMSTUDIO_API_KEY}",
      discoveryApiKey: "resolved-discovery-key",
      expectedApiKey: "resolved-discovery-key",
    },
    {
      name: "discoverLmstudioProvider suppresses stale discovery apiKey when Authorization header auth is configured",
      configuredApiKey: "configured-direct-key",
      discoveryApiKey: "resolved-stale-key",
      headers: { Authorization: "Bearer custom-token" },
      expectedApiKey: "",
    },
  ])("$name", async ({ configuredApiKey, discoveryApiKey, headers, expectedApiKey }) => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([createModel()]);

    await runDiscovery(
      {
        api: "openai-completions",
        apiKey: configuredApiKey,
        ...(headers ? { headers } : {}),
      },
      { discoveryApiKey, env: {} },
    );

    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: expectedApiKey,
      headers,
      quiet: false,
    });
  });

  it("discoverLmstudioProvider rewrites stale api-key auth without a persisted key", async () => {
    const result = await runDiscovery({ auth: "api-key" });

    const provider = requireRecord(result?.provider, "discovered LM Studio provider");
    expectApiKeyProvider(provider);
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0]);
  });

  it("discoverLmstudioProvider drops stale apiKey when Authorization header auth is configured", async () => {
    const result = await runDiscovery({
      api: "openai-completions",
      apiKey: "stale-legacy-key",
      headers: { Authorization: "Bearer custom-token" },
    });

    const provider = requireRecord(result?.provider, "discovered LM Studio provider");
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer custom-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0]);
    expect(provider.apiKey).toBeUndefined();
    expect(provider.auth).toBeUndefined();
  });

  it("discoverLmstudioProvider uses quiet mode and returns null when unconfigured", async () => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([]);

    const result = await discoverLmstudioProvider(buildDiscoveryContext());

    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
      quiet: true,
      headers: undefined,
    });
    expect(result).toBeNull();
  });

  it("non-interactive setup replaces local auth markers when enabling api-key auth", async () => {
    const { result } = await runNonInteractive({
      config: buildConfig({ apiKey: CUSTOM_LOCAL_AUTH_MARKER, api: "openai-completions" }),
    });

    expectApiKeyProvider(requireNonInteractiveLmstudioProvider(result));
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
