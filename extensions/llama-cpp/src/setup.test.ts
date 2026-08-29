import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  prepareServer: vi.fn(),
  removeProfiles: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  removeProviderAuthProfilesWithLock: mocks.removeProfiles,
}));

vi.mock("./managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepareServer,
}));

import {
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
  meetsLlamaCppDefaultModelRamFloor,
} from "./defaults.js";
import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

const GIB = 1024 ** 3;
let tempRoot: string;
let modelPath: string;

beforeEach(async () => {
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GIB);
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-setup-")));
  modelPath = path.join(tempRoot, "model.gguf");
  mocks.ensureModel.mockReset().mockImplementation(async ({ source, download }) => {
    if (!download) {
      throw new Error("not cached");
    }
    return source === DEFAULT_LLAMA_CPP_MODEL_URI
      ? modelPath
      : path.join(tempRoot, "embedding.gguf");
  });
  mocks.prepareServer.mockReset().mockResolvedValue({
    command: path.join(tempRoot, "llama-server"),
    baseUrl: "http://127.0.0.1:19432/v1",
    healthUrl: "http://127.0.0.1:19432/health",
    args: ["--host", "127.0.0.1", "--port", "19432"],
  });
  mocks.removeProfiles.mockReset().mockResolvedValue({ version: 1, profiles: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function config(): ProviderAppGuidedSetupContext["config"] {
  return {
    models: {
      providers: {
        [LLAMA_CPP_PROVIDER_ID]: {
          baseUrl: "http://127.0.0.1:19432/v1",
          api: "openai-completions",
          params: { modelCacheDir: tempRoot },
          models: [],
        },
      },
    },
  };
}

function authContext(confirm: boolean): ProviderAuthContext {
  return {
    config: config(),
    prompter: {
      confirm: vi.fn(async () => confirm),
      note: vi.fn(async () => {}),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    },
    runtime: {},
  } as unknown as ProviderAuthContext;
}

function requestUnconfiguredLocalMemory(ctx: ProviderAuthContext): void {
  ctx.config.memory = { search: { provider: "local" } };
  delete ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
}

const externalChatRoutes: Array<{
  name: string;
  agents: NonNullable<ProviderAppGuidedSetupContext["config"]["agents"]>;
}> = [
  {
    name: "the default primary",
    agents: { defaults: { model: { primary: "llama-cpp/external-chat" } } },
  },
  {
    name: "a default fallback",
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.4",
          fallbacks: ["llama-cpp/external-chat"],
        },
      },
    },
  },
  {
    name: "an agent primary",
    agents: {
      defaults: { model: { primary: "openai/gpt-5.4" } },
      entries: {
        helper: { model: { primary: "llama-cpp/external-chat" } },
      },
    },
  },
  {
    name: "the default subagent model",
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        subagents: { model: "llama-cpp/external-chat" },
      },
    },
  },
  {
    name: "an agent subagent model",
    agents: {
      defaults: { model: { primary: "openai/gpt-5.4" } },
      entries: {
        helper: { subagents: { model: "llama-cpp/external-chat" } },
      },
    },
  },
];

describe("llama.cpp managed setup", () => {
  it("pins the default model identity and integrity", () => {
    expect(DEFAULT_LLAMA_CPP_MODEL_URI).toBe(
      "hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf",
    );
    expect(DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES).toBe(4_977_171_584);
    expect(DEFAULT_LLAMA_CPP_MODEL_SHA256).toMatch(/^[a-f\d]{64}$/u);
  });

  it("keeps the 16 GiB default-model gate", () => {
    expect(meetsLlamaCppDefaultModelRamFloor(16 * GIB - 1)).toBe(false);
    expect(meetsLlamaCppDefaultModelRamFloor(16 * GIB)).toBe(true);
  });

  it("keeps app discovery read-only", async () => {
    await expect(detectLlamaCppSetup({ config: config(), env: {} })).resolves.toBeNull();
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it("detects a fully prepared managed server", async () => {
    const command = path.join(tempRoot, "llama-server");
    const preset = path.join(tempRoot, "models.ini");
    await Promise.all([
      fs.writeFile(command, "binary"),
      fs.writeFile(preset, "version = 1"),
      fs.writeFile(modelPath, "GGUF"),
    ]);
    const cfg = config();
    const provider = cfg.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("missing fixture provider");
    }
    provider.models[0] = {
      id: "custom",
      name: "Custom",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
      params: { modelPath },
    };
    provider.localService = {
      command,
      args: ["--models-preset", preset],
      healthUrl: "http://127.0.0.1:19432/health",
    };

    await expect(detectLlamaCppSetup({ config: cfg, env: {} })).resolves.toEqual({
      modelRef: "llama-cpp/custom",
      detail: "Managed llama.cpp server ready",
    });
  });

  it("does not detect chat from a cached model when the managed inventory is empty", async () => {
    const command = path.join(tempRoot, "llama-server");
    const preset = path.join(tempRoot, "models.ini");
    const cachedDefault = path.join(tempRoot, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE);
    await Promise.all([
      fs.writeFile(command, "binary"),
      fs.writeFile(preset, "version = 1"),
      fs.writeFile(cachedDefault, "GGUF"),
    ]);
    const cfg = config();
    const provider = cfg.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("missing fixture provider");
    }
    provider.localService = {
      command,
      args: ["--models-preset", preset],
      healthUrl: "http://127.0.0.1:19432/health",
    };

    await expect(detectLlamaCppSetup({ config: cfg, env: {} })).resolves.toBeNull();
    await expect(
      prepareLlamaCppSetup({
        config: cfg,
        env: {},
        modelRef: `${LLAMA_CPP_PROVIDER_ID}/${DEFAULT_LLAMA_CPP_MODEL_ID}`,
      }),
    ).resolves.toBeNull();
  });

  it("does not offer the default download below the RAM floor", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const ctx = authContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expect(ctx.prompter.confirm).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
  });

  it("offers embedding-only setup for local memory below the chat RAM floor", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const ctx = authContext(true);
    requestUnconfiguredLocalMemory(ctx);
    ctx.config.agents = { defaults: { model: { primary: "openai/gpt-5.4" } } };

    const result = await runLlamaCppSetup(ctx);

    expect(ctx.prompter.confirm).toHaveBeenCalledWith({
      message:
        "OpenClaw can install a verified llama.cpp server and download only the local embedding model (about 0.3 GB). This will not install or change your chat model. Continue?",
      initialValue: false,
    });
    expect(result.defaultModel).toBeUndefined();
    expect(result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.models).toEqual([]);
    expect(ctx.config.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(
      mocks.ensureModel.mock.calls.filter(([options]) => options.download === true),
    ).toHaveLength(1);
    expect(mocks.prepareServer).toHaveBeenCalledWith({
      chatModel: { mode: "remove" },
      embeddingModelIsDefault: true,
      embeddingModelPath: path.join(tempRoot, "embedding.gguf"),
      port: undefined,
    });
  });

  it("requires consent before embedding-only setup", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const ctx = authContext(false);
    requestUnconfiguredLocalMemory(ctx);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("only the local embedding model"),
      }),
    );
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
  });

  it("offers embedding-only setup after the chat download is declined", async () => {
    const ctx = authContext(false);
    requestUnconfiguredLocalMemory(ctx);
    vi.mocked(ctx.prompter.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await runLlamaCppSetup(ctx);

    expect(ctx.prompter.confirm).toHaveBeenCalledTimes(2);
    expect(result.defaultModel).toBeUndefined();
    expect(result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.models).toEqual([]);
    expect(
      mocks.ensureModel.mock.calls.filter(([options]) => options.download === true),
    ).toHaveLength(1);
  });

  it("offers embedding-only setup for per-agent local memory intent", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const ctx = authContext(true);
    delete ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    ctx.config.agents = {
      defaults: { model: { primary: "openai/gpt-5.4" } },
      entries: {
        helper: { memory: { search: { provider: "local" } } },
      },
    };

    const result = await runLlamaCppSetup(ctx);

    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("only the local embedding model"),
      }),
    );
    expect(result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.models).toEqual([]);
  });

  it.each(externalChatRoutes)(
    "does not replace an external llama.cpp provider used as $name",
    async ({ agents }) => {
      vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
      const ctx = authContext(true);
      ctx.config.memory = { search: { provider: "local" } };
      ctx.config.agents = agents;
      const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
      if (!provider) {
        throw new Error("missing external provider fixture");
      }
      provider.models = [
        {
          id: "external-chat",
          name: "External chat",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
      ];

      await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

      expect(ctx.prompter.confirm).not.toHaveBeenCalled();
      expect(ctx.prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("existing llama.cpp server"),
        "Setup skipped",
      );
      expect(mocks.ensureModel).not.toHaveBeenCalledWith(
        expect.objectContaining({ download: true }),
      );
      expect(ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID]).toBe(provider);
    },
  );

  it.each(externalChatRoutes.filter(({ name }) => name !== "an agent primary"))(
    "does not replace a managed llama.cpp provider used as $name",
    async ({ agents }) => {
      vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
      const ctx = authContext(true);
      ctx.config.memory = { search: { provider: "local" } };
      ctx.config.agents = agents;
      const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
      if (!provider) {
        throw new Error("missing managed provider fixture");
      }
      provider.localService = {
        command: path.join(tempRoot, "llama-server"),
        args: ["--models-preset", path.join(tempRoot, "models.ini")],
        healthUrl: "http://127.0.0.1:19432/health",
      };
      provider.models = [
        {
          id: "external-chat",
          name: "Managed chat",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
      ];

      await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

      expect(ctx.prompter.confirm).not.toHaveBeenCalled();
      expect(ctx.prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("chat routes"),
        "Setup skipped",
      );
      expect(ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID]).toBe(provider);
    },
  );

  it("requires consent before installing and downloading", async () => {
    const ctx = authContext(false);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("verified llama.cpp server") }),
    );
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
  });

  it("writes one durable managed-server provider after preparation", async () => {
    const ctx = authContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toMatchObject({
      profiles: [],
      defaultModel: `${LLAMA_CPP_PROVIDER_ID}/${DEFAULT_LLAMA_CPP_MODEL_ID}`,
      configPatch: {
        models: {
          providers: {
            [LLAMA_CPP_PROVIDER_ID]: {
              baseUrl: "http://127.0.0.1:19432/v1",
              api: "openai-completions",
              localService: {
                command: path.join(tempRoot, "llama-server"),
                healthUrl: "http://127.0.0.1:19432/health",
                readyTimeoutMs: 30_000,
                idleStopMs: 600_000,
              },
            },
          },
        },
      },
    });
    expect(
      mocks.ensureModel.mock.calls.filter(([options]) => options.download === true),
    ).toHaveLength(2);
    expect(mocks.prepareServer).toHaveBeenCalledWith(
      expect.objectContaining({
        chatModel: expect.objectContaining({ mode: "configure", path: modelPath }),
        embeddingModelPath: path.join(tempRoot, "embedding.gguf"),
      }),
    );
  });

  it("preserves custom model config when refreshing an existing managed server", async () => {
    const customModelPath = path.join(tempRoot, "custom.gguf");
    await fs.writeFile(customModelPath, "GGUF");
    const ctx = authContext(true);
    const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("missing managed provider fixture");
    }
    provider.localService = {
      command: path.join(tempRoot, "old-llama-server"),
      args: ["--models-preset", path.join(tempRoot, "old-models.ini")],
      healthUrl: "http://127.0.0.1:19432/health",
    };
    provider.timeoutSeconds = 321;
    provider.models = [
      {
        id: "custom",
        name: "Custom model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 4096,
        params: { modelPath: customModelPath, contextSize: 16_384 },
      },
    ];

    const result = await runLlamaCppSetup(ctx);
    const managed = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];

    expect(managed?.timeoutSeconds).toBe(321);
    expect(managed?.models[0]).toEqual(provider.models[0]);
    expect(mocks.prepareServer).toHaveBeenCalledWith(
      expect.objectContaining({
        chatModel: expect.objectContaining({
          mode: "configure",
          id: "custom",
          path: customModelPath,
        }),
      }),
    );
  });

  it("replaces external endpoint state when switching to managed setup", async () => {
    const ctx = authContext(true);
    ctx.agentDir = path.join(tempRoot, "agent");
    ctx.config.auth = {
      profiles: { "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" } },
      order: { "llama-cpp": ["llama-cpp:default"] },
    };
    const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("missing external provider fixture");
    }
    provider.baseUrl = "http://127.0.0.1:8080/v1";
    provider.apiKey = "external-key";
    provider.auth = "api-key";
    provider.headers = { Authorization: "Bearer external-header" };
    provider.params = { endpointOnly: true };
    provider.models = [
      {
        id: "external-model",
        name: "External model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    ];

    const result = await runLlamaCppSetup(ctx);
    const managed = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];

    expect(managed).toMatchObject({
      baseUrl: "http://127.0.0.1:19432/v1",
      apiKey: "llama-cpp-local",
      localService: { command: path.join(tempRoot, "llama-server") },
    });
    expect(managed).not.toHaveProperty("auth");
    expect(managed).not.toHaveProperty("headers");
    expect(managed).not.toHaveProperty("params");
    expect(managed?.models.some((model) => model.id === "external-model")).toBe(false);
    expect(result.configPatch?.auth).toEqual({
      profiles: { "llama-cpp:default": undefined },
      order: { "llama-cpp": undefined },
    });
    expect(mocks.removeProfiles).toHaveBeenCalledWith({
      provider: "llama-cpp",
      profileIds: ["llama-cpp:default"],
      agentDir: ctx.agentDir,
    });
    expect(mocks.prepareServer).toHaveBeenCalledWith(expect.objectContaining({ port: undefined }));
    expect(mocks.ensureModel).toHaveBeenCalledWith(
      expect.not.objectContaining({ cacheDir: tempRoot }),
    );
  });
});
