// Models list e2e tests cover model listing command output with local auth/config fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

let modelsListCommand: typeof import("./models/list.list-command.js").modelsListCommand;
let loadModelRegistry: typeof import("./models/list.registry.js").loadModelRegistry;
let toModelRow: typeof import("./models/list.model-row.js").toModelRow;

const getRuntimeConfig = vi.fn();
const readConfigFileSnapshotForWrite = vi.fn().mockResolvedValue({
  snapshot: { valid: false, resolved: {} },
  writeOptions: {},
});
const setRuntimeConfigSnapshot = vi.fn();
const ensureAuthProfileStore = vi.fn().mockReturnValue({ version: 1, profiles: {} });
const listProfilesForProvider = vi.fn().mockReturnValue([]);
const resolveEnvApiKey = vi.fn().mockReturnValue(undefined);
const resolveAwsSdkEnvVarName = vi.fn().mockReturnValue(undefined);
const hasUsableCustomProviderApiKey = vi.fn().mockReturnValue(false);
const hasSyntheticLocalProviderAuthConfig = vi.fn().mockReturnValue(false);
const loadModelCatalog = vi.fn<(_params?: unknown) => Promise<Array<Record<string, unknown>>>>(
  async () => [],
);
const shouldSuppressBuiltInModelCore = vi.fn().mockReturnValue(false);
const normalizeProviderResolvedModelWithPlugin = vi.hoisted(() =>
  vi.fn(({ context }) => {
    if (context?.provider === "anthropic" && context?.modelId === "claude-sonnet-5") {
      return {
        ...context.model,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
      };
    }
    if (
      context?.provider === "anthropic" &&
      context?.modelId === "claude-sonnet-4-5" &&
      Array.isArray(context?.model?.input) &&
      !context.model.input.includes("image")
    ) {
      return { ...context.model, input: ["text", "image"] };
    }
    return undefined;
  }),
);
const modelRegistryState = {
  models: [] as Array<Record<string, unknown>>,
  available: [] as Array<Record<string, unknown>>,
  getAllError: undefined as unknown,
  getAvailableError: undefined as unknown,
  availableOverride: undefined as { value: unknown } | undefined,
  findError: undefined as unknown,
};

function createMockModelRegistry() {
  return new (class {
    fork() {
      return createMockModelRegistry();
    }

    find(provider: string, id: string) {
      if (modelRegistryState.findError !== undefined) {
        throw toLintErrorObject(modelRegistryState.findError, "Non-Error thrown");
      }
      return (
        modelRegistryState.models.find((model) => model.provider === provider && model.id === id) ??
        null
      );
    }

    getAll() {
      if (modelRegistryState.getAllError !== undefined) {
        throw toLintErrorObject(modelRegistryState.getAllError, "Non-Error thrown");
      }
      return modelRegistryState.models;
    }

    getAvailable() {
      if (modelRegistryState.getAvailableError !== undefined) {
        throw toLintErrorObject(modelRegistryState.getAvailableError, "Non-Error thrown");
      }
      return modelRegistryState.availableOverride
        ? modelRegistryState.availableOverride.value
        : modelRegistryState.available;
    }

    getProviderMetadataOwners() {
      return undefined;
    }

    hasConfiguredAuth(model: { provider: string; id: string }) {
      return modelRegistryState.available.some(
        (available) => available.provider === model.provider && available.id === model.id,
      );
    }
  })();
}

let previousOpenAiApiKey: string | undefined;

vi.mock("./models/load-config.js", () => ({
  loadModelsConfigWithSource: vi.fn(async () => {
    const resolvedConfig = getRuntimeConfig();
    const sourceConfig = await loadSourceConfigSnapshotForTest(resolvedConfig);
    setRuntimeConfigSnapshot(resolvedConfig, sourceConfig);
    return {
      sourceConfig,
      resolvedConfig,
      diagnostics: [],
    };
  }),
}));

vi.mock("../agents/auth-profiles/profile-list.js", () => ({
  listProfilesForProvider,
}));

vi.mock("../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStore,
  getRuntimeAuthProfileStoreSnapshot: vi.fn(() => undefined),
  loadAuthProfileStoreWithoutExternalProfiles: ensureAuthProfileStore,
  updateAuthProfileStoreWithLock: vi.fn(async () => ensureAuthProfileStore()),
}));

vi.mock("../agents/model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-auth.js")>();
  return {
    ...actual,
    hasUsableCustomProviderApiKey,
    hasSyntheticLocalProviderAuthConfig,
    resolveAwsSdkEnvVarName,
    resolveEnvApiKey,
  };
});

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: loadModelCatalog,
  loadPreparedModelCatalogOwnerSnapshot: async (params: { agentDir?: string; config?: object }) => {
    const entries = await loadModelCatalog(params);
    return {
      agentDir: params.agentDir ?? "/tmp/openclaw-agent",
      config: params.config ?? {},
      metadataSnapshot: { manifestRegistry: { plugins: [] } },
      modelCatalog: { entries, routeVariants: entries, staticEntries: entries },
    };
  },
  loadPreparedModelCatalogSnapshot: async (...args: Parameters<typeof loadModelCatalog>) => {
    const entries = await loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
}));

vi.mock("./models/list.scoped-catalog.js", () => ({
  // The scoped-catalog owner covers live discovery; this command fixture supplies
  // deterministic rows without materializing provider runtime in the shared E2E worker.
  loadScopedListModelCatalogSnapshot: async () => {
    const entries = await loadModelCatalog();
    return { entries, routeVariants: entries, staticEntries: [] };
  },
}));

vi.mock("../agents/prepared-model-registry.js", () => ({
  loadPreparedAgentModelRegistry: async (config: object, options?: { agentDir?: string }) => ({
    agentDir: options?.agentDir ?? "/tmp/openclaw-agent",
    config,
    registry: createMockModelRegistry(),
  }),
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModelWithRegistry: ({
    provider,
    modelId,
    modelRegistry,
  }: {
    provider: string;
    modelId: string;
    modelRegistry: { find: (provider: string, id: string) => unknown };
  }) => modelRegistry.find(provider, modelId),
}));

vi.mock("../agents/agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({ getAll: () => ({}) }),
  discoverModels: () => createMockModelRegistry(),
  normalizeDiscoveredAgentModel: (model: unknown) => model,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: vi.fn(() => undefined),
  normalizeProviderConfigWithPlugin: vi.fn(() => undefined),
  normalizeProviderResolvedModelWithPlugin,
  resolveProviderConfigApiKeyWithPlugin: vi.fn(() => undefined),
  resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
  shouldDeferProviderSyntheticProfileAuthWithPlugin: vi.fn(() => false),
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("../agents/model-suppression.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-suppression.js")>()),
  shouldSuppressBuiltInModelCore,
}));

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function firstMockArg(mockFn: ReturnType<typeof vi.fn>, label: string): unknown {
  const call = mockFn.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} call`);
  }
  return call.at(0);
}

function runtimeLogText(runtime: ReturnType<typeof makeRuntime>): string {
  const value = firstMockArg(runtime.log, "runtime.log");
  if (typeof value !== "string") {
    throw new Error("Expected runtime.log text");
  }
  return value;
}

async function loadSourceConfigSnapshotForTest(fallback: unknown): Promise<unknown> {
  try {
    const { snapshot } = await readConfigFileSnapshotForWrite();
    if (snapshot.valid) {
      return snapshot.sourceConfig;
    }
  } catch {
    // Match load-config: source snapshot is a best-effort write-preservation input.
  }
  return fallback;
}

beforeEach(() => {
  previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  modelRegistryState.models = [];
  modelRegistryState.available = [];
  modelRegistryState.getAllError = undefined;
  modelRegistryState.getAvailableError = undefined;
  modelRegistryState.availableOverride = undefined;
  modelRegistryState.findError = undefined;
  getRuntimeConfig.mockReset();
  getRuntimeConfig.mockReturnValue({});
  listProfilesForProvider.mockReturnValue([]);
  loadModelCatalog.mockReset();
  loadModelCatalog.mockResolvedValue([]);
  shouldSuppressBuiltInModelCore.mockReset();
  shouldSuppressBuiltInModelCore.mockReturnValue(false);
  normalizeProviderResolvedModelWithPlugin.mockClear();
  readConfigFileSnapshotForWrite.mockClear();
  readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} },
    writeOptions: {},
  });
  setRuntimeConfigSnapshot.mockClear();
});

afterEach(() => {
  if (previousOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAiApiKey;
  }
});

describe("models list/status", () => {
  const ZAI_MODEL = {
    provider: "zai",
    id: "glm-4.7",
    name: "GLM-4.7",
    input: ["text"],
    baseUrl: "https://api.z.ai/v1",
    contextWindow: 128000,
  };
  const OPENAI_MODEL = {
    provider: "openai",
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    input: ["text"],
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  };
  const OPENAI_SPARK_MODEL = {
    provider: "openai",
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    input: ["text", "image"],
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  };
  const MOONSHOT_MODEL = {
    provider: "moonshot",
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    input: ["text", "image"],
    baseUrl: "https://api.moonshot.ai/v1",
    contextWindow: 262144,
  };
  const AZURE_OPENAI_SPARK_MODEL = {
    provider: "azure-openai-responses",
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    input: ["text", "image"],
    baseUrl: "https://example.openai.azure.com/openai/v1",
    contextWindow: 128000,
  };
  const GOOGLE_ANTIGRAVITY_TEMPLATE_BASE = {
    provider: "google-antigravity",
    api: "google-gemini-cli",
    input: ["text", "image"],
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  };

  function setDefaultModel(model: string) {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model } },
    });
  }

  function configureModelAsConfigured(model: string) {
    getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: {
          model,
          models: {
            [model]: {},
          },
        },
      },
    });
  }

  function configureGoogleAntigravityModel(modelId: string) {
    configureModelAsConfigured(`google-antigravity/${modelId}`);
  }

  function makeGoogleAntigravityTemplate(id: string, name: string) {
    return {
      ...GOOGLE_ANTIGRAVITY_TEMPLATE_BASE,
      id,
      name,
    };
  }

  function enableGoogleAntigravityAuthProfile() {
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
  }

  function parseJsonLog(runtime: ReturnType<typeof makeRuntime>) {
    expect(runtime.log).toHaveBeenCalledTimes(1);
    return JSON.parse(runtimeLogText(runtime));
  }

  async function expectZaiProviderFilter(provider: string) {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.count).toBe(payload.models.length);
    expect(payload.models.length).toBeGreaterThan(0);
    expect(payload.models.map((model: { key: string }) => model.key)).toContain("zai/glm-4.7");
    expect(payload.models.every((model: { key: string }) => model.key.startsWith("zai/"))).toBe(
      true,
    );
  }

  function setDefaultZaiRegistry(params: { available?: boolean } = {}) {
    const available = params.available ?? true;
    setDefaultModel("z.ai/glm-4.7");
    modelRegistryState.models = [ZAI_MODEL, OPENAI_MODEL];
    modelRegistryState.available = available ? [ZAI_MODEL, OPENAI_MODEL] : [];
  }

  async function writeWorkspaceAuthEvidencePlugin(workspaceDir: string) {
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-cloud");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "index.ts"), "export default {}\n", "utf8");
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "workspace-cloud",
        configSchema: { type: "object" },
        setup: {
          providers: [
            {
              id: "workspace-cloud",
              authEvidence: [
                {
                  type: "local-file-with-env",
                  fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
                  credentialMarker: "workspace-cloud-local-credentials",
                  source: "workspace cloud credentials",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
  }

  beforeAll(async () => {
    ({ modelsListCommand } = await import("./models/list.list-command.js"));
    const registryModule = await import("./models/list.registry.js");
    loadModelRegistry = registryModule.loadModelRegistry;
    ({ toModelRow } = await import("./models/list.model-row.js"));
  });

  it("models list runs model discovery without auth.json sync", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("models list outputs canonical zai key for configured z.ai model", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list plain outputs canonical zai key", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [ZAI_MODEL];
    modelRegistryState.available = [ZAI_MODEL];
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtimeLogText(runtime)).toBe("zai/glm-4.7");
  });

  it("models list plain keeps canonical OpenRouter native ids", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model: "openrouter/hunter-alpha" } },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "openrouter",
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        input: ["text"],
        baseUrl: "https://openrouter.ai/api/v1",
        contextWindow: 1048576,
      },
    ];
    modelRegistryState.available = modelRegistryState.models;
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtimeLogText(runtime)).toBe("openrouter/hunter-alpha");
  });

  it("models list --agent projects that agent's configured aliases and tags", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: {
          model: {
            primary: "gpt-5.6-luna",
          },
          models: {
            "openai/gpt-5.6-luna": { alias: "global-luna" },
            "anthropic/claude-sonnet-4-6": { alias: "global-sonnet" },
            "minimax/claude-sonnet-4-6": { alias: "global-minimax-sonnet" },
          },
        },
        entries: {
          main: {},
          worker: {
            model: { fallbacks: ["claude-sonnet-4-6"] },
            models: {
              "openai/gpt-5.6-luna": { alias: "worker-luna" },
              "anthropic/claude-sonnet-4-6": { alias: "worker-sonnet" },
              "google/gemini-3-flash-preview": { alias: "worker-flash" },
            },
          },
        },
      },
    });
    const runtime = makeRuntime();

    await modelsListCommand({ agent: "worker", json: true }, runtime);

    const payload = parseJsonLog(runtime);
    const tagsByKey = Object.fromEntries(
      payload.models.map((model: { key: string; tags: string[] }) => [model.key, model.tags]),
    );
    expect(tagsByKey["openai/gpt-5.6-luna"]).toEqual([
      "default",
      "configured",
      "alias:worker-luna",
    ]);
    expect(tagsByKey["anthropic/claude-sonnet-4-6"]).toEqual([
      "fallback#1",
      "configured",
      "alias:worker-sonnet",
    ]);
    expect(tagsByKey["google/gemini-3-flash-preview"]).toEqual([
      "configured",
      "alias:worker-flash",
    ]);
    expect(tagsByKey["openai/gpt-5.6-luna"]).not.toContain("alias:global-luna");
    expect(tagsByKey["anthropic/claude-sonnet-4-6"]).not.toContain("alias:global-sonnet");
  });

  it("models list configured fallback marks stale Anthropic Claude 4 refs image-capable", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } },
    });
    const runtime = makeRuntime();

    await modelsListCommand({ json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models[0]).toMatchObject({
      key: "anthropic/claude-sonnet-4-5",
      input: "text+image",
    });
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        context: expect.objectContaining({
          modelId: "claude-sonnet-4-5",
        }),
      }),
    );
  });

  it("models list renders a configured Sonnet 5 table row through provider normalization", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model: "anthropic/claude-sonnet-5" } },
    });
    const runtime = makeRuntime();

    await modelsListCommand({}, runtime);

    expect(runtime.error).not.toHaveBeenCalled();
    const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("anthropic/claude-sonnet-5");
    expect(output).toContain("text+image");
    const normalizationContext =
      normalizeProviderResolvedModelWithPlugin.mock.calls.at(-1)?.[0]?.context;
    expect(normalizationContext?.model).not.toHaveProperty("cost");
  });

  it.each(["z.ai", "Z.AI", "z-ai"] as const)(
    "models list provider filter normalizes %s alias",
    async (provider) => {
      await expectZaiProviderFilter(provider);
    },
  );

  it("models list marks auth as unavailable when ZAI key is missing", async () => {
    setDefaultZaiRegistry({ available: false });
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(
      payload.models.find((model: { key?: string }) => model.key === "zai/glm-4.7")?.available,
    ).toBe(false);
  });

  it("models list uses trusted workspace plugin auth evidence for configured rows", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-list-auth-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const bundledDir = path.join(tempRoot, "bundled");
    const stateDir = path.join(tempRoot, "state");
    const credentialsPath = path.join(tempRoot, "credentials.json");
    await fs.mkdir(bundledDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(credentialsPath, "{}", "utf8");
    await writeWorkspaceAuthEvidencePlugin(workspaceDir);
    getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: "workspace-cloud/model-a",
        },
      },
      plugins: { allow: ["workspace-cloud"] },
      models: {
        providers: {
          "workspace-cloud": {
            baseUrl: "https://workspace-cloud.example/v1",
            api: "openai-responses",
            models: [
              {
                id: "model-a",
                name: "Workspace Cloud Model A",
                input: ["text"],
                contextWindow: 8192,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    });
    const runtime = makeRuntime();
    try {
      await withEnvAsync(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_STATE_DIR: stateDir,
          WORKSPACE_CLOUD_CREDENTIALS: credentialsPath,
        },
        () => modelsListCommand({ all: true, provider: "workspace-cloud", json: true }, runtime),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    const payload = parseJsonLog(runtime);
    expect(payload.models).toHaveLength(1);
    const model = payload.models[0];
    expect(model.key).toBe("workspace-cloud/model-a");
    expect(model.available).toBe(true);
  });

  it("models list all includes catalog rows with unknown auth availability", async () => {
    setDefaultZaiRegistry({ available: false });
    loadModelCatalog.mockResolvedValueOnce([{ ...MOONSHOT_MODEL, id: "kimi-k3", name: "Kimi K3" }]);
    const runtime = makeRuntime();

    await withEnvAsync(
      { KIMI_API_KEY: undefined, KIMICODE_API_KEY: undefined, MOONSHOT_API_KEY: undefined },
      () => modelsListCommand({ all: true, provider: "moonshot", json: true }, runtime),
    );

    const payload = parseJsonLog(runtime);
    expect(loadModelCatalog).toHaveBeenCalledOnce();
    expect(payload.models.length).toBeGreaterThan(0);
    const model = payload.models.find(
      (candidate: { key: string }) => candidate.key === "moonshot/kimi-k3",
    );
    expect(model).toBeDefined();
    expect(model.key).toBe("moonshot/kimi-k3");
    expect(model.name).toBe("Kimi K3");
    expect(model.available).toBeNull();
    expect(model.missing).toBe(false);
  });

  it("models list rejects provider display labels", async () => {
    setDefaultZaiRegistry({ available: false });
    const runtime = makeRuntime();
    const message =
      'Invalid provider filter "Moonshot AI". Use a provider id such as "moonshot", not a display label.';

    await expect(
      modelsListCommand({ all: true, provider: "Moonshot AI", json: true }, runtime),
    ).rejects.toMatchObject({
      name: "ExpectedCliError",
      message,
      humanOutput: message,
      machineOutput: message,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("models list all local skips unauthenticated provider catalog rows", async () => {
    setDefaultZaiRegistry({ available: false });
    loadModelCatalog.mockResolvedValueOnce([MOONSHOT_MODEL]);
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, local: true, json: true }, runtime);

    expect(loadModelCatalog).toHaveBeenCalledOnce();
    expect(parseJsonLog(runtime).models).toEqual([]);
  });

  it("models list default does not enumerate all registry models", async () => {
    configureGoogleAntigravityModel("claude-opus-4-6-thinking");
    modelRegistryState.models = [
      makeGoogleAntigravityTemplate("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking"),
    ];
    modelRegistryState.available = modelRegistryState.models;
    modelRegistryState.getAllError = Object.assign(new Error("model discovery failed"), {
      code: "MODEL_AVAILABILITY_UNAVAILABLE",
    });
    const runtime = makeRuntime();
    await withEnvAsync({ OPENAI_API_KEY: undefined }, () =>
      modelsListCommand({ json: true }, runtime),
    );

    expect(runtime.error).not.toHaveBeenCalled();
    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
  });

  it("models list fails fast when configured registry lookup is unavailable", async () => {
    configureGoogleAntigravityModel("claude-opus-4-6-thinking");
    enableGoogleAntigravityAuthProfile();
    modelRegistryState.findError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [];
    modelRegistryState.available = [];
    await expect(modelsListCommand({ local: true, json: true }, runtime)).rejects.toMatchObject({
      name: "ExpectedCliError",
      message: "Model registry unavailable: model discovery unavailable",
      humanOutput: expect.stringContaining(
        "Model registry unavailable:\nError: model discovery unavailable",
      ),
      machineOutput: "Model registry unavailable: model discovery unavailable",
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("loadModelRegistry throws when model discovery is unavailable", async () => {
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    modelRegistryState.available = [
      makeGoogleAntigravityTemplate("claude-opus-4-6-thinking", "Claude Opus 4.5 Thinking"),
    ];

    await expect(loadModelRegistry({})).rejects.toThrow("model discovery unavailable");
  });

  it.each([
    {
      name: "a thrown lookup",
      error: new Error("availability backend unavailable"),
      result: [],
      warning:
        "Model availability unavailable: getAvailable() failed.\nError: availability backend unavailable",
    },
    {
      name: "a non-array result",
      error: undefined,
      result: null,
      warning: "getAvailable() returned a non-array value.",
    },
    {
      name: "an invalid model entry",
      error: undefined,
      result: [{ provider: "zai" }],
      warning: "getAvailable() returned invalid model entries.",
    },
    {
      name: "an authoritative empty result",
      error: undefined,
      result: [],
      warning: undefined,
    },
  ])(
    "models list handles $name without losing discovered rows",
    async ({ error, result, warning }) => {
      getRuntimeConfig.mockReturnValue({
        agents: { defaults: { model: "zai/glm-4.7" } },
        models: { providers: { zai: { apiKey: "test-key" } } },
      });
      modelRegistryState.models = [ZAI_MODEL];
      modelRegistryState.getAvailableError = error;
      modelRegistryState.availableOverride = { value: result };
      const runtime = makeRuntime();

      await modelsListCommand({ all: true, json: true }, runtime);

      const payload = parseJsonLog(runtime);
      expect(payload.models).toEqual([
        expect.objectContaining({
          key: "zai/glm-4.7",
          name: "GLM-4.7",
          available: warning !== undefined,
          missing: false,
        }),
      ]);
      if (warning) {
        expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(
            "Model availability lookup failed; falling back to auth heuristics for discovered models:",
          ),
        );
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(warning));
      } else {
        expect(runtime.error).not.toHaveBeenCalled();
      }
    },
  );

  it("loadModelRegistry does not persist models.json as a side effect", async () => {
    modelRegistryState.models = [OPENAI_MODEL];
    modelRegistryState.available = [OPENAI_MODEL];
    const resolvedConfig = {
      models: { providers: { openai: { apiKey: "sk-resolved-runtime-value" } } }, // pragma: allowlist secret
    };

    const loaded = await loadModelRegistry(resolvedConfig as never);

    expect(loaded.models).toEqual([OPENAI_MODEL]);
  });

  it("filters stale spark rows from models list and registry views", async () => {
    const suppressSpark = ({ provider, id }: { provider?: string | null; id?: string | null }) =>
      id === "gpt-5.3-codex-spark" &&
      (provider === "openai" || provider === "azure-openai-responses");
    shouldSuppressBuiltInModelCore.mockImplementation(suppressSpark);
    setDefaultModel("openai/gpt-5.5");
    modelRegistryState.models = [OPENAI_MODEL, OPENAI_SPARK_MODEL, AZURE_OPENAI_SPARK_MODEL];
    modelRegistryState.available = [OPENAI_MODEL, OPENAI_SPARK_MODEL, AZURE_OPENAI_SPARK_MODEL];
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models.map((model: { key: string }) => model.key)).toEqual([
      "openai/gpt-4.1-mini",
    ]);

    const loaded = await loadModelRegistry({} as never);
    expect(loaded.models.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai/gpt-4.1-mini",
    ]);
    expect(Array.from(loaded.availableKeys ?? [])).toEqual(["openai/gpt-4.1-mini"]);
  });

  it("modelsListCommand lists source snapshot provider models without persisting models.json", async () => {
    modelRegistryState.models = [];
    modelRegistryState.available = [];
    const sourceConfig = {
      models: {
        providers: {
          "custom-proxy": {
            api: "openai-responses",
            baseUrl: "https://custom.example/v1",
            apiKey: "$CUSTOM_PROXY_API_KEY",
            models: [
              {
                id: "custom-model",
                name: "Custom Model",
                input: ["text"],
                contextWindow: 128000,
              },
            ],
          },
        },
      },
    };
    const resolvedConfig = {
      models: {
        providers: {
          "custom-proxy": {
            api: "openai-responses",
            baseUrl: "https://custom.example/v1",
            apiKey: "sk-resolved-runtime-value", // pragma: allowlist secret
            models: [
              {
                id: "custom-model",
                name: "Custom Model",
                input: ["text"],
                contextWindow: 128000,
              },
            ],
          },
        },
      },
    };
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { valid: true, resolved: resolvedConfig, sourceConfig },
      writeOptions: {},
    });
    getRuntimeConfig.mockReturnValue(resolvedConfig);
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models).toHaveLength(1);
    const model = payload.models[0];
    expect(model.key).toBe("custom-proxy/custom-model");
    expect(model.name).toBe("Custom Model");
    expect(model.missing).toBe(false);
  });

  it("toModelRow keeps auth availability unknown when no evidence exists", () => {
    const row = toModelRow({
      model: makeGoogleAntigravityTemplate(
        "claude-opus-4-6-thinking",
        "Claude Opus 4.6 Thinking",
      ) as never,
      key: "google-antigravity/claude-opus-4-6-thinking",
      tags: [],
      availableKeys: undefined,
      authAvailability: undefined,
    });

    expect(row.missing).toBe(false);
    expect(row.available).toBeNull();
  });
});
