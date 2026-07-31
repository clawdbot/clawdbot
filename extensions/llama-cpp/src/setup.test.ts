import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_REF,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
  meetsLlamaCppDefaultModelRamFloor,
} from "./defaults.js";

const nodeLlamaMocks = vi.hoisted(() => ({
  download: vi.fn(async () => "/models/default.gguf"),
  createModelDownloader: vi.fn(),
  resolveModelFile: vi.fn(),
}));

vi.mock("node-llama-cpp", () => ({
  createModelDownloader: nodeLlamaMocks.createModelDownloader,
  getLlama: vi.fn(),
  resolveModelFile: nodeLlamaMocks.resolveModelFile,
  LlamaChat: vi.fn(),
}));

import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

const { formatLlamaCppDownloadProgress } = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.llamaCppSetupTestApi")
] as {
  formatLlamaCppDownloadProgress: (params: {
    downloadedSize: number;
    totalSize: number;
    bytesPerSecond: number;
  }) => string;
};

const GIB = 1024 ** 3;

let tempRoot: string;
let cacheDir: string;

beforeEach(async () => {
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GIB);
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-cpp-setup-")));
  cacheDir = path.join(tempRoot, "models");
  await fs.mkdir(cacheDir);
  nodeLlamaMocks.download.mockReset().mockResolvedValue("/models/default.gguf");
  nodeLlamaMocks.createModelDownloader.mockReset().mockResolvedValue({
    download: nodeLlamaMocks.download,
  });
  nodeLlamaMocks.resolveModelFile.mockReset().mockImplementation(async (_source, options) => {
    const candidate = path.join(options.directory, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE);
    await fs.access(candidate);
    return candidate;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function configWithCache(): ProviderAppGuidedSetupContext["config"] {
  return {
    models: {
      providers: {
        [LLAMA_CPP_PROVIDER_ID]: {
          baseUrl: "local://llama-cpp",
          api: "openai-completions" as const,
          params: { modelCacheDir: cacheDir },
          models: [],
        },
      },
    },
  };
}

function createAuthContext(confirm: boolean): ProviderAuthContext {
  return {
    config: configWithCache(),
    prompter: {
      confirm: vi.fn(async () => confirm),
      note: vi.fn(async () => {}),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    },
    runtime: {},
  } as unknown as ProviderAuthContext;
}

describe("llama.cpp setup", () => {
  it("uses the verified Gemma 4 default artifact", () => {
    expect(DEFAULT_LLAMA_CPP_MODEL_URI).toBe(
      "hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf",
    );
    expect(DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES).toBe(4_977_169_568);
  });

  it("requires 16 GiB for the bundled default offer", () => {
    expect(meetsLlamaCppDefaultModelRamFloor(16 * GIB - 1)).toBe(false);
    expect(meetsLlamaCppDefaultModelRamFloor(16 * GIB)).toBe(true);
  });

  it("formats percent, decimal GB, and transfer rate", () => {
    expect(
      formatLlamaCppDownloadProgress({
        downloadedSize: 2_100_000_000,
        totalSize: 5_000_000_000,
        bytesPerSecond: 38_000_000,
      }),
    ).toBe("Downloading Gemma 4 E4B… 42% (2.1/5.0 GB, 38 MB/s)");
  });

  it("returns null when the configured model is not cached", async () => {
    await expect(detectLlamaCppSetup({ config: configWithCache(), env: {} })).resolves.toBeNull();
  });

  it("detects the cached default model without downloading", async () => {
    await fs.writeFile(path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE), "fixture");

    await expect(detectLlamaCppSetup({ config: configWithCache(), env: {} })).resolves.toEqual({
      modelRef: DEFAULT_LLAMA_CPP_MODEL_REF,
      detail: "gemma-4-e4b-it-q4_k_m (downloaded)",
    });
    expect(nodeLlamaMocks.createModelDownloader).not.toHaveBeenCalled();
    expect(nodeLlamaMocks.resolveModelFile).toHaveBeenCalledWith(
      expect.stringMatching(/^hf:/),
      expect.objectContaining({ directory: cacheDir, download: false, cli: false }),
    );
  });

  it("uses node-llama-cpp cache resolution for a configured HF branch", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const cachedPath = path.join(cacheDir, "hf_org_repo_release_model.gguf");
    await fs.writeFile(cachedPath, "fixture");
    nodeLlamaMocks.resolveModelFile.mockResolvedValueOnce(cachedPath);
    const config = configWithCache();
    const provider = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("expected llama.cpp provider config");
    }
    provider.models.push({
      id: "custom",
      name: "Custom",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
      params: { modelPath: "hf:org/repo/model.gguf#release" },
    });

    await expect(detectLlamaCppSetup({ config, env: {} })).resolves.toEqual({
      modelRef: "llama-cpp/custom",
      detail: "custom (downloaded)",
    });
    expect(nodeLlamaMocks.resolveModelFile).toHaveBeenCalledWith(
      "hf:org/repo/model.gguf#release",
      expect.objectContaining({ download: false, cli: false }),
    );
  });

  it("prepares config only for a currently cached detected model", async () => {
    await expect(
      prepareLlamaCppSetup({
        config: configWithCache(),
        env: {},
        modelRef: DEFAULT_LLAMA_CPP_MODEL_REF,
      }),
    ).resolves.toBeNull();

    await fs.writeFile(path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE), "fixture");
    await expect(
      prepareLlamaCppSetup({
        config: configWithCache(),
        env: {},
        modelRef: DEFAULT_LLAMA_CPP_MODEL_REF,
      }),
    ).resolves.toMatchObject({
      profiles: [],
      defaultModel: DEFAULT_LLAMA_CPP_MODEL_REF,
      configPatch: {
        models: {
          mode: "merge",
          providers: {
            [LLAMA_CPP_PROVIDER_ID]: {
              baseUrl: "local://llama-cpp",
              models: [
                expect.objectContaining({
                  id: "gemma-4-e4b-it-q4_k_m",
                  name: "Gemma 4 E4B (Q4_K_M)",
                  contextWindow: 8192,
                  contextTokens: 8192,
                  maxTokens: 2048,
                  compat: expect.objectContaining({ supportsTools: true }),
                }),
              ],
            },
          },
        },
      },
    });
  });

  it("skips the bundled offer below the RAM floor", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    const ctx = createAuthContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

    expect(ctx.prompter.confirm).not.toHaveBeenCalled();
    expect(ctx.prompter.note).toHaveBeenCalledWith(
      "This machine has 8 GB RAM; the bundled local model needs 16 GB+. Use Ollama/LM Studio with a smaller model, or a cloud provider.",
      "Setup skipped",
    );
    expect(nodeLlamaMocks.createModelDownloader).not.toHaveBeenCalled();
  });

  it("honors a cached default below the RAM floor", async () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * GIB);
    await fs.writeFile(path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE), "fixture");
    const ctx = createAuthContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toMatchObject({
      defaultModel: DEFAULT_LLAMA_CPP_MODEL_REF,
    });

    expect(ctx.prompter.confirm).not.toHaveBeenCalled();
    expect(ctx.prompter.note).not.toHaveBeenCalled();
  });

  it("keeps the consent path at the RAM floor", async () => {
    const ctx = createAuthContext(false);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("about 5.0 GB") }),
    );
    expect(nodeLlamaMocks.createModelDownloader).not.toHaveBeenCalled();
  });

  it("downloads after consent and returns the provider patch", async () => {
    const ctx = createAuthContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toMatchObject({
      profiles: [],
      defaultModel: DEFAULT_LLAMA_CPP_MODEL_REF,
      configPatch: {
        models: {
          providers: {
            [LLAMA_CPP_PROVIDER_ID]: expect.objectContaining({
              baseUrl: "local://llama-cpp",
            }),
          },
        },
      },
    });

    expect(nodeLlamaMocks.createModelDownloader).toHaveBeenCalledWith(
      expect.objectContaining({
        dirPath: cacheDir,
        fileName: DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
        showCliProgress: false,
      }),
    );
    expect(nodeLlamaMocks.download).toHaveBeenCalledTimes(1);
  });

  it("calculates rolling rate from download deltas without counting resumed bytes", async () => {
    const update = vi.fn();
    const ctx = createAuthContext(true);
    vi.mocked(ctx.prompter.progress).mockReturnValue({ update, stop: vi.fn() });
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    nodeLlamaMocks.createModelDownloader.mockImplementationOnce(
      async (options: {
        onProgress?: (status: { downloadedSize: number; totalSize: number }) => void;
      }) => ({
        download: vi.fn(async () => {
          options.onProgress?.({ downloadedSize: 2_000_000_000, totalSize: 5_000_000_000 });
          options.onProgress?.({ downloadedSize: 2_100_000_000, totalSize: 5_000_000_000 });
        }),
      }),
    );

    await runLlamaCppSetup(ctx);

    expect(update).toHaveBeenNthCalledWith(1, "Downloading Gemma 4 E4B… 40% (2.0/5.0 GB, 0 MB/s)");
    expect(update).toHaveBeenNthCalledWith(
      2,
      "Downloading Gemma 4 E4B… 42% (2.1/5.0 GB, 100 MB/s)",
    );
  });
});
