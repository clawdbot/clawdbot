import { describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const ensureMoltbotModelsJson = vi.fn().mockResolvedValue(undefined);
const resolveMoltbotAgentDir = vi.fn().mockReturnValue("/tmp/moltbot-agent");
const ensureAuthProfileStore = vi.fn().mockReturnValue({ version: 1, profiles: {} });
const listProfilesForProvider = vi.fn().mockReturnValue([]);
const resolveAuthProfileDisplayLabel = vi.fn(({ profileId }: { profileId: string }) => profileId);
const resolveAuthStorePathForDisplay = vi
  .fn()
  .mockReturnValue("/tmp/moltbot-agent/auth-profiles.json");
const resolveProfileUnusableUntilForDisplay = vi.fn().mockReturnValue(null);
const resolveEnvApiKey = vi.fn().mockReturnValue(undefined);
const resolveAwsSdkEnvVarName = vi.fn().mockReturnValue(undefined);
const getCustomProviderApiKey = vi.fn().mockReturnValue(undefined);
const discoverAuthStorage = vi.fn().mockReturnValue({});
const discoverModels = vi.fn();

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/moltbot.json",
  STATE_DIR: "/tmp/moltbot-state",
  loadConfig,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureMoltbotModelsJson,
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveMoltbotAgentDir,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  resolveAwsSdkEnvVarName,
  getCustomProviderApiKey,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  discoverAuthStorage,
  discoverModels,
}));

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

describe("models list/status", () => {
  it("models status resolves z.ai alias to canonical zai", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const { modelsStatusCommand } = await import("./models/list.js");
    await modelsStatusCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.resolvedDefault).toBe("zai/glm-4.7");
  });

  it("models status plain outputs canonical zai model", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const { modelsStatusCommand } = await import("./models/list.js");
    await modelsStatusCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toBe("zai/glm-4.7");
  });

  it("models list outputs canonical zai key for configured z.ai model", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const model = {
      provider: "zai",
      id: "glm-4.7",
      name: "GLM-4.7",
      input: ["text"],
      baseUrl: "https://api.z.ai/v1",
      contextWindow: 128000,
    };

    discoverModels.mockReturnValue({
      getAll: () => [model],
      getAvailable: () => [model],
    });

    const { modelsListCommand } = await import("./models/list.js");
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list plain outputs canonical zai key", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const model = {
      provider: "zai",
      id: "glm-4.7",
      name: "GLM-4.7",
      input: ["text"],
      baseUrl: "https://api.z.ai/v1",
      contextWindow: 128000,
    };

    discoverModels.mockReturnValue({
      getAll: () => [model],
      getAvailable: () => [model],
    });

    const { modelsListCommand } = await import("./models/list.js");
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toBe("zai/glm-4.7");
  });

  it("models list provider filter normalizes z.ai alias", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const models = [
      {
        provider: "zai",
        id: "glm-4.7",
        name: "GLM-4.7",
        input: ["text"],
        baseUrl: "https://api.z.ai/v1",
        contextWindow: 128000,
      },
      {
        provider: "openai",
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        input: ["text"],
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128000,
      },
    ];

    discoverModels.mockReturnValue({
      getAll: () => models,
      getAvailable: () => models,
    });

    const { modelsListCommand } = await import("./models/list.js");
    await modelsListCommand({ all: true, provider: "z.ai", json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.count).toBe(1);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list provider filter normalizes Z.AI alias casing", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const models = [
      {
        provider: "zai",
        id: "glm-4.7",
        name: "GLM-4.7",
        input: ["text"],
        baseUrl: "https://api.z.ai/v1",
        contextWindow: 128000,
      },
      {
        provider: "openai",
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        input: ["text"],
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128000,
      },
    ];

    discoverModels.mockReturnValue({
      getAll: () => models,
      getAvailable: () => models,
    });

    const { modelsListCommand } = await import("./models/list.js");
    await modelsListCommand({ all: true, provider: "Z.AI", json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.count).toBe(1);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list provider filter normalizes z-ai alias", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const models = [
      {
        provider: "zai",
        id: "glm-4.7",
        name: "GLM-4.7",
        input: ["text"],
        baseUrl: "https://api.z.ai/v1",
        contextWindow: 128000,
      },
      {
        provider: "openai",
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        input: ["text"],
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128000,
      },
    ];

    discoverModels.mockReturnValue({
      getAll: () => models,
      getAvailable: () => models,
    });

    const { modelsListCommand } = await import("./models/list.js");
    await modelsListCommand({ all: true, provider: "z-ai", json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.count).toBe(1);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list marks auth as unavailable when ZAI key is missing", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const model = {
      provider: "zai",
      id: "glm-4.7",
      name: "GLM-4.7",
      input: ["text"],
      baseUrl: "https://api.z.ai/v1",
      contextWindow: 128000,
    };

    discoverModels.mockReturnValue({
      getAll: () => [model],
      getAvailable: () => [],
    });

    const { modelsListCommand } = await import("./models/list.js");
    await modelsListCommand({ all: true, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.available).toBe(false);
  });
});
