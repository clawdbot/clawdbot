import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
} from "./defaults.js";
import {
  configureLmstudioNonInteractive,
  discoverLmstudioProvider,
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

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
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

function createModel(id: string, name = id): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 8192,
  };
}

function buildConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          apiKey: "LM_API_TOKEN",
          api: "openai-completions",
          models: [],
        },
      },
    },
  };
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
}): ProviderAuthMethodNonInteractiveContext & {
  runtime: {
    error: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
  resolveApiKey: ReturnType<typeof vi.fn>;
  toApiKeyCredential: ReturnType<typeof vi.fn>;
} {
  const error = vi.fn<(...args: unknown[]) => void>();
  const exit = vi.fn<(code: number) => void>();
  const log = vi.fn<(...args: unknown[]) => void>();
  const resolveApiKey = vi.fn(async () =>
    params?.resolvedApiKey === null
      ? null
      : {
          key: params?.resolvedApiKey ?? "lmstudio-test-key",
          source: params?.resolvedApiKeySource ?? "flag",
        },
  );
  const toApiKeyCredential = vi.fn();
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
    runtime: { error, exit, log },
    resolveApiKey,
    toApiKeyCredential,
  };
}

function createQueuedWizardPrompterHarness(textValues: string[]): {
  prompter: WizardPrompter;
  note: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const queue = [...textValues];
  const note = vi.fn(async (_message: string, _title?: string) => {});
  const text = vi.fn(async () => queue.shift() ?? "");
  const prompter: WizardPrompter = {
    intro: async () => {},
    outro: async () => {},
    note,
    select: async <T>(params: { options: Array<{ value: T }> }) => {
      const firstOption = params.options[0];
      if (!firstOption) {
        throw new Error("select called without options");
      }
      return firstOption.value;
    },
    multiselect: async () => [],
    text,
    confirm: async () => false,
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
  return { prompter, note, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requirePathRecord(value: unknown, label: string, path: string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    current = requireRecord(current, label)[key];
  }
  return requireRecord(current, label);
}

function requireNonInteractiveLmstudioProvider(result: unknown): Record<string, unknown> {
  return requirePathRecord(result, "LM Studio provider config", [
    "models",
    "providers",
    "lmstudio",
  ]);
}

function requireConfigPatchLmstudioProvider(result: unknown): Record<string, unknown> {
  return requirePathRecord(result, "LM Studio config patch provider", [
    "configPatch",
    "models",
    "providers",
    "lmstudio",
  ]);
}

function requireProviderModels(provider: unknown): unknown[] {
  return requireArray(requireRecord(provider, "LM Studio provider").models, "LM Studio models");
}

function expectModelFields(model: unknown, expected: Record<string, unknown>) {
  expectRecordFields(model, "LM Studio model", expected);
}

function expectProfileFields(profile: unknown, expectedCredential: Record<string, unknown>) {
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

    fetchLmstudioModelsMock.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [
        {
          type: "llm",
          key: "qwen3-8b-instruct",
        },
      ],
    });
    discoverLmstudioModelsMock.mockResolvedValue([createModel("qwen3-8b-instruct", "Qwen3 8B")]);
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

  it("non-interactive setup discovers catalog and writes LM Studio provider config", async () => {
    const ctx = buildNonInteractiveContext({
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: "qwen3-8b-instruct",
    });
    fetchLmstudioModelsMock.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      models: [
        {
          type: "llm",
          key: "qwen3-8b-instruct",
          display_name: "Qwen3 8B",
          loaded_instances: [{ id: "inst-1", config: { context_length: 64000 } }],
        },
        {
          type: "embedding",
          key: "text-embedding-nomic-embed-text-v1.5",
        },
      ],
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "lmstudio-test-key",
      timeoutMs: 5000,
    });
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio provider config", {
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
    const ctx = buildNonInteractiveContext({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              api: "openai-completions",
              apiKey: "LM_API_TOKEN",
              headers: {
                Authorization: "Bearer stale-token",
                "X-Proxy-Auth": "proxy-token",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: "qwen3-8b-instruct",
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expectRecordFields(requireNonInteractiveLmstudioProvider(result), "LM Studio provider config", {
      auth: "api-key",
      apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      headers: {
        Authorization: "Bearer stale-token",
        "X-Proxy-Auth": "proxy-token",
      },
    });
  });

  it("non-interactive setup auto-selects a discovered LM Studio model when none is provided", async () => {
    const ctx = buildNonInteractiveContext({
      customBaseUrl: "http://localhost:1234/api/v1/",
    });
    fetchLmstudioModelsMock.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      models: [
        {
          type: "llm",
          key: "phi-4",
          max_context_length: 65536,
        },
        {
          type: "llm",
          key: "qwen3-8b-instruct",
          display_name: "Qwen3 8B",
        },
      ],
    });

    const result = await configureLmstudioNonInteractive(ctx);

    const setupCall = requireRecord(
      configureSelfHostedNonInteractiveMock.mock.calls[0]?.[0],
      "self-hosted setup call",
    );
    const setupCtx = requireRecord(setupCall.ctx, "self-hosted setup context");
    expectRecordFields(setupCtx.opts, "self-hosted setup opts", {
      customModelId: "phi-4",
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe("lmstudio/phi-4");
    const models = requireProviderModels(requireNonInteractiveLmstudioProvider(result));
    expect(models).toHaveLength(2);
    expectModelFields(models[0], {
      id: "phi-4",
      contextWindow: 65536,
    });
    expectModelFields(models[1], {
      id: "qwen3-8b-instruct",
    });
  });

  it("non-interactive setup synthesizes lmstudio-local when API key is missing", async () => {
    const ctx = buildNonInteractiveContext({
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: "qwen3-8b-instruct",
      resolvedApiKey: null,
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio provider config", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
  });

  it("non-interactive setup keeps Authorization header auth without writing a synthetic key", async () => {
    const ctx = buildNonInteractiveContext({
      config: {
        auth: {
          profiles: {
            "lmstudio:default": {
              provider: "lmstudio",
              mode: "api_key",
            },
          },
          order: {
            lmstudio: ["lmstudio:default"],
          },
        },
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              apiKey: "stale-config-key",
              auth: "api-key",
              api: "openai-completions",
              headers: {
                Authorization: "Bearer proxy-token",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      customBaseUrl: "http://localhost:1234/api/v1/",
      customApiKey: "",
      customModelId: "qwen3-8b-instruct",
      resolvedApiKey: null,
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: undefined,
      headers: {
        Authorization: "Bearer proxy-token",
      },
      timeoutMs: 5000,
    });
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio provider config", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer proxy-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
    expect(result?.auth).toBeUndefined();
  });

  it("non-interactive setup clears stale profile auth before switching to Authorization header auth", async () => {
    const ctx = buildNonInteractiveContext({
      config: {
        auth: {
          profiles: {
            "lmstudio:default": {
              provider: "lmstudio",
              mode: "api_key",
            },
          },
          order: {
            lmstudio: ["lmstudio:default"],
          },
        },
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              apiKey: "stale-config-key",
              auth: "api-key",
              api: "openai-completions",
              headers: {
                Authorization: "Bearer proxy-token",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      customBaseUrl: "http://localhost:1234/api/v1/",
      customApiKey: "",
      customModelId: "qwen3-8b-instruct",
      resolvedApiKey: "stale-profile-key",
      resolvedApiKeySource: "profile",
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: undefined,
      headers: {
        Authorization: "Bearer proxy-token",
      },
      timeoutMs: 5000,
    });
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio provider config", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer proxy-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
    expect(result?.auth).toBeUndefined();
  });

  it("non-interactive setup clears env fallback auth before switching to Authorization header auth", async () => {
    const ctx = buildNonInteractiveContext({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              auth: "api-key",
              api: "openai-completions",
              headers: {
                Authorization: "Bearer proxy-token",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      customBaseUrl: "http://localhost:1234/api/v1/",
      customApiKey: "",
      customModelId: "qwen3-8b-instruct",
      resolvedApiKey: "env-fallback-key",
      resolvedApiKeySource: "env",
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      provider: "lmstudio",
      agentDir: undefined,
    });
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: undefined,
      headers: {
        Authorization: "Bearer proxy-token",
      },
      timeoutMs: 5000,
    });
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio provider config", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer proxy-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
    expect(result?.auth).toBeUndefined();
  });

  it("non-interactive setup prefers --lmstudio-api-key over --custom-api-key", async () => {
    const ctx = buildNonInteractiveContext({
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: "qwen3-8b-instruct",
      customApiKey: "old-custom-key",
      lmstudioApiKey: "new-lmstudio-key",
    });

    await configureLmstudioNonInteractive(ctx);

    expectRecordFields(ctx.resolveApiKey.mock.calls[0]?.[0], "resolveApiKey options", {
      flagValue: "new-lmstudio-key",
      flagName: "--lmstudio-api-key",
    });
  });

  it("non-interactive setup overwrites existing config apiKey during re-auth", async () => {
    const ctx = buildNonInteractiveContext({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              auth: "api-key",
              apiKey: "stale-config-key",
              api: "openai-completions",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: "qwen3-8b-instruct",
      lmstudioApiKey: "fresh-cli-key",
      resolvedApiKey: "fresh-cli-key",
    });

    const result = await configureLmstudioNonInteractive(ctx);

    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio provider config", {
      auth: "api-key",
      apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    });
    expect(provider.apiKey).not.toBe("stale-config-key");
  });

  it("non-interactive setup fails when requested model is missing", async () => {
    const ctx = buildNonInteractiveContext({
      customModelId: "missing-model",
    });

    await expect(configureLmstudioNonInteractive(ctx)).resolves.toBeNull();

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "LM Studio model missing-model was not found at http://localhost:1234/v1.\nAvailable models: qwen3-8b-instruct",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
  });

  it("interactive setup canonicalizes base URL and persists provider/default model", async () => {
    const promptText = vi
      .fn()
      .mockResolvedValueOnce("http://localhost:1234/api/v1/")
      .mockResolvedValueOnce("lmstudio-test-key");

    const result = await promptAndConfigureLmstudioInteractive({
      config: buildConfig(),
      promptText,
    });

    expect(result.configPatch?.models?.mode).toBe("merge");
    expectRecordFields(
      requireConfigPatchLmstudioProvider(result),
      "LM Studio config patch provider",
      {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKey: "LM_API_TOKEN",
      },
    );
    expect(result.defaultModel).toBe("lmstudio/qwen3-8b-instruct");
    expectProfileFields(result.profiles[0], {
      type: "api_key",
      provider: "lmstudio",
      key: "lmstudio-test-key",
    });
  });

  it("interactive setup applies an optional preferred context length to all discovered LM Studio models", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      models: [
        {
          type: "llm",
          key: "phi-4",
          display_name: "Phi 4",
          max_context_length: 65536,
        },
        {
          type: "llm",
          key: "qwen3-8b-instruct",
          display_name: "Qwen3 8B",
          max_context_length: 32768,
        },
      ],
    });
    const { prompter, text } = createQueuedWizardPrompterHarness([
      "http://localhost:1234/api/v1/",
      "lmstudio-test-key",
      "4096",
    ]);

    const result = await promptAndConfigureLmstudioInteractive({
      config: buildConfig(),
      prompter,
    });

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

  it("interactive setup accepts a blank API key for unauthenticated local LM Studio", async () => {
    const { prompter, text } = createQueuedWizardPrompterHarness([
      "http://localhost:1234/api/v1/",
      "",
      "",
    ]);

    const result = await promptAndConfigureLmstudioInteractive({
      config: buildConfig(),
      prompter,
    });

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
    expectRecordFields(provider, "LM Studio config patch provider", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive Docker setup defaults to the host LM Studio endpoint", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const { prompter, text } = createQueuedWizardPrompterHarness([
      "http://host.docker.internal:1234",
      "",
      "",
    ]);

    const result = await promptAndConfigureLmstudioInteractive({
      config: buildConfig(),
      prompter,
    });

    const firstTextCall = requireRecord(text.mock.calls[0]?.[0], "first text prompt");
    expectRecordFields(firstTextCall, "first text prompt", {
      initialValue: "http://host.docker.internal:1234",
      placeholder: "http://host.docker.internal:1234",
    });
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    expectRecordFields(
      requireConfigPatchLmstudioProvider(result),
      "LM Studio config patch provider",
      {
        baseUrl: "http://host.docker.internal:1234/v1",
      },
    );
  });

  it("interactive setup uses existing Authorization headers when the API key is blank", async () => {
    const config = {
      models: {
        providers: {
          lmstudio: {
            baseUrl: "http://localhost:1234/v1",
            api: "openai-completions",
            apiKey: "stale-config-key",
            auth: "api-key",
            headers: {
              Authorization: "Bearer proxy-token",
            },
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const { prompter } = createQueuedWizardPrompterHarness([
      "http://localhost:1234/api/v1/",
      "",
      "",
    ]);

    const result = await promptAndConfigureLmstudioInteractive({
      config,
      prompter,
    });

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
    expectRecordFields(provider, "LM Studio config patch provider", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer proxy-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup without a wizard accepts a blank API key for local LM Studio", async () => {
    const promptText = vi
      .fn()
      .mockResolvedValueOnce("http://localhost:1234/api/v1/")
      .mockResolvedValueOnce("");

    const result = await promptAndConfigureLmstudioInteractive({
      config: buildConfig(),
      promptText,
    });

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
    expectRecordFields(provider, "LM Studio config patch provider", {
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup overwrites existing config apiKey during re-auth", async () => {
    const config = {
      models: {
        providers: {
          lmstudio: {
            baseUrl: "http://localhost:1234/v1",
            auth: "api-key",
            apiKey: "stale-config-key",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const promptText = vi
      .fn()
      .mockResolvedValueOnce("http://localhost:1234/api/v1/")
      .mockResolvedValueOnce("fresh-prompt-key");

    const result = await promptAndConfigureLmstudioInteractive({
      config,
      promptText,
    });
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, "LM Studio config patch provider", {
      auth: "api-key",
      apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    });
    expect(provider.apiKey).not.toBe("stale-config-key");
    expectProfileFields(result.profiles[0], {
      type: "api_key",
      provider: "lmstudio",
      key: "fresh-prompt-key",
    });
  });

  it("interactive setup preserves existing custom headers when switching to api-key auth", async () => {
    const config = {
      models: {
        providers: {
          lmstudio: {
            baseUrl: "http://localhost:1234/v1",
            api: "openai-completions",
            apiKey: "LM_API_TOKEN",
            headers: {
              Authorization: "Bearer stale-token",
              "X-Proxy-Auth": "proxy-token",
            },
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const promptText = vi
      .fn()
      .mockResolvedValueOnce("http://localhost:1234/api/v1/")
      .mockResolvedValueOnce("lmstudio-test-key");

    const result = await promptAndConfigureLmstudioInteractive({
      config,
      promptText,
    });
    expectRecordFields(
      requireConfigPatchLmstudioProvider(result),
      "LM Studio config patch provider",
      {
        auth: "api-key",
        apiKey: "LM_API_TOKEN",
        headers: {
          Authorization: "Bearer stale-token",
          "X-Proxy-Auth": "proxy-token",
        },
      },
    );
  });

  it("interactive setup preserves existing agent model allowlist entries", async () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              alias: "Sonnet",
            },
          },
        },
      },
      models: {
        providers: {
          lmstudio: {
            baseUrl: "http://localhost:1234/v1",
            api: "openai-completions",
            apiKey: "LM_API_TOKEN",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const promptText = vi
      .fn()
      .mockResolvedValueOnce("http://localhost:1234/api/v1/")
      .mockResolvedValueOnce("lmstudio-test-key");

    const result = await promptAndConfigureLmstudioInteractive({
      config,
      promptText,
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
        expectedError: "No LM Studio models found",
      },
    ];

    for (const testCase of cases) {
      const promptText = vi
        .fn()
        .mockResolvedValueOnce("http://localhost:1234/v1")
        .mockResolvedValueOnce("lmstudio-test-key");
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

  it.each([
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
      const explicitModels = [createModel("qwen3-8b-instruct", "Qwen3 8B")];
      const result = await discoverLmstudioProvider(
        buildDiscoveryContext({
          config: {
            models: {
              providers: {
                lmstudio: {
                  baseUrl: "http://localhost:1234/api/v1/",
                  models: explicitModels,
                  ...providerPatch,
                },
              },
            },
          } as OpenClawConfig,
        }),
      );

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
    discoverLmstudioModelsMock.mockResolvedValueOnce([
      createModel("qwen3-8b-instruct", "Qwen3 8B"),
    ]);

    const result = await discoverLmstudioProvider(
      buildDiscoveryContext({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "LMSTUDIO_DISCOVERY_TOKEN",
                },
                headers: {
                  "X-Proxy-Auth": {
                    source: "env",
                    provider: "default",
                    id: "LMSTUDIO_PROXY_TOKEN",
                  },
                },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {
          LMSTUDIO_DISCOVERY_TOKEN: "secretref-lmstudio-key",
          LMSTUDIO_PROXY_TOKEN: "proxy-token-from-env",
        },
      }),
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

  it("discoverLmstudioProvider returns null for unresolved header refs", async () => {
    const result = await discoverLmstudioProvider(
      buildDiscoveryContext({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                headers: {
                  "X-Proxy-Auth": {
                    source: "env",
                    provider: "default",
                    id: "LMSTUDIO_PROXY_TOKEN",
                  },
                },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {},
      }),
    );

    expect(result).toBeNull();
    expect(discoverLmstudioModelsMock).not.toHaveBeenCalled();
  });

  it("discoverLmstudioProvider returns null for an unresolved apiKey ref", async () => {
    const result = await discoverLmstudioProvider(
      buildDiscoveryContext({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "LMSTUDIO_DISCOVERY_TOKEN",
                },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {},
      }),
    );

    expect(result).toBeNull();
    expect(discoverLmstudioModelsMock).not.toHaveBeenCalled();
  });

  it("discoverLmstudioProvider uses configured direct apiKey for discovery", async () => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([
      createModel("qwen3-8b-instruct", "Qwen3 8B"),
    ]);

    await discoverLmstudioProvider(
      buildDiscoveryContext({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                apiKey: "configured-direct-key",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
      }),
    );

    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "configured-direct-key",
      headers: undefined,
      quiet: false,
    });
  });

  it("discoverLmstudioProvider prefers resolved discoveryApiKey over configured apiKey", async () => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([
      createModel("qwen3-8b-instruct", "Qwen3 8B"),
    ]);

    await discoverLmstudioProvider(
      buildDiscoveryContext({
        discoveryApiKey: "resolved-discovery-key",
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                apiKey: "configured-direct-key",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
      }),
    );

    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "resolved-discovery-key",
      headers: undefined,
      quiet: false,
    });
  });

  it("discoverLmstudioProvider suppresses stale discovery apiKey when Authorization header auth is configured", async () => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([
      createModel("qwen3-8b-instruct", "Qwen3 8B"),
    ]);

    await discoverLmstudioProvider(
      buildDiscoveryContext({
        discoveryApiKey: "resolved-stale-key",
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                apiKey: "configured-direct-key",
                headers: {
                  Authorization: "Bearer custom-token",
                },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
      }),
    );

    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
      headers: {
        Authorization: "Bearer custom-token",
      },
      quiet: false,
    });
  });

  it("discoverLmstudioProvider rewrites stale api-key auth without a persisted key", async () => {
    const result = await discoverLmstudioProvider(
      buildDiscoveryContext({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                auth: "api-key",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
      }),
    );

    const provider = requireRecord(result?.provider, "discovered LM Studio provider");
    expectRecordFields(provider, "discovered LM Studio provider", {
      auth: "api-key",
      apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
  });

  it("discoverLmstudioProvider drops stale apiKey when Authorization header auth is configured", async () => {
    const result = await discoverLmstudioProvider(
      buildDiscoveryContext({
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                api: "openai-completions",
                apiKey: "stale-legacy-key",
                headers: {
                  Authorization: "Bearer custom-token",
                },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
      }),
    );

    const provider = requireRecord(result?.provider, "discovered LM Studio provider");
    expectRecordFields(provider, "discovered LM Studio provider", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer custom-token",
      },
    });
    const models = requireProviderModels(provider);
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "qwen3-8b-instruct",
    });
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
    const ctx = buildNonInteractiveContext({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              apiKey: CUSTOM_LOCAL_AUTH_MARKER,
              api: "openai-completions",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: "qwen3-8b-instruct",
    });

    const result = await configureLmstudioNonInteractive(ctx);

    expectRecordFields(requireNonInteractiveLmstudioProvider(result), "LM Studio provider config", {
      auth: "api-key",
      apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    });
  });
});
