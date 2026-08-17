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
  selectAsset: vi.fn(() => ({ backend: "metal" })),
  resolvePaths: vi.fn(() => ({ presetPath: "/runtime/models.ini" })),
}));

vi.mock("./managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepareServer,
}));

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  selectLlamaServerAsset: mocks.selectAsset,
  resolveManagedLlamaServerPaths: mocks.resolvePaths,
}));

import {
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
  meetsLlamaCppDefaultModelRamFloor,
} from "./defaults.js";
import { detectLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

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
    presetPath: path.join(tempRoot, "models.ini"),
    baseUrl: "http://127.0.0.1:19432/v1",
    healthUrl: "http://127.0.0.1:19432/health",
    args: ["--host", "127.0.0.1", "--port", "19432"],
    backend: "metal",
  });
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

  it("does not offer the default download below the RAM floor", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const ctx = authContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expect(ctx.prompter.confirm).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
  });

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
        chatModelPath: modelPath,
        embeddingModelPath: path.join(tempRoot, "embedding.gguf"),
      }),
    );
  });

  it("uses the configured local embedding model instead of downloading the default", async () => {
    const ctx = authContext(true);
    ctx.config.memory = {
      search: {
        provider: "local",
        local: { modelPath: "/models/custom-embedding.gguf" },
      },
    };

    await expect(runLlamaCppSetup(ctx)).resolves.toMatchObject({ profiles: [] });

    expect(mocks.ensureModel).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "/models/custom-embedding.gguf",
        download: true,
      }),
    );
  });

  it("sets up an embedding-only server without adding a chat model", async () => {
    const ctx = authContext(true);
    ctx.config.memory = { search: { provider: "local" } };

    await expect(runLlamaCppSetup(ctx)).resolves.toMatchObject({
      profiles: [],
      configPatch: {
        models: {
          providers: {
            [LLAMA_CPP_PROVIDER_ID]: { models: [] },
          },
        },
      },
    });
    expect(mocks.ensureModel).toHaveBeenCalledTimes(1);
    expect(mocks.ensureModel).toHaveBeenCalledWith(
      expect.objectContaining({ download: true, source: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL }),
    );
    expect(mocks.prepareServer).toHaveBeenCalledWith(
      expect.objectContaining({ chatModelPath: undefined }),
    );
  });

  it("does not replace an unavailable configured chat model with default Gemma", async () => {
    const ctx = authContext(true);
    const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("missing fixture provider");
    }
    provider.models = [
      {
        id: "small-chat",
        name: "Small chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        params: { modelPath: "/models/small-chat.gguf" },
      },
    ];

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expect(ctx.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("without downloading the default Gemma model"),
      "Setup skipped",
    );
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
  });
});
