import fs from "node:fs/promises";
import os from "node:os";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_REF,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
  buildLlamaCppProviderConfig,
  meetsLlamaCppDefaultModelRamFloor,
  resolveCachedLlamaCppModelPath,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  formatLlamaCppSetupError,
  importNodeLlamaCpp,
  type NodeLlamaCppModule,
} from "./node-llama.runtime.js";

const BYTES_PER_GB = 1_000_000_000;
const BYTES_PER_MB = 1_000_000;

function formatLlamaCppDownloadProgress(params: {
  downloadedSize: number;
  totalSize: number;
  bytesPerSecond: number;
}): string {
  const downloadedSize = Math.max(0, params.downloadedSize);
  const totalSize = Math.max(1, params.totalSize);
  const percent = Math.min(100, Math.floor((downloadedSize / totalSize) * 100));
  const downloadedGb = (downloadedSize / BYTES_PER_GB).toFixed(1);
  const totalGb = (totalSize / BYTES_PER_GB).toFixed(1);
  const rateMb = Math.max(0, Math.round(params.bytesPerSecond / BYTES_PER_MB));
  return `Downloading Gemma 4 E4B… ${percent}% (${downloadedGb}/${totalGb} GB, ${rateMb} MB/s)`;
}

function formatRamGb(totalmemBytes: number): string {
  return (totalmemBytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "");
}

function readPrimaryModel(config: ProviderAppGuidedSetupContext["config"]): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

function configuredCandidates(
  config: ProviderAppGuidedSetupContext["config"],
): Array<{ model: ModelDefinitionConfig; provider: ModelProviderConfig }> {
  const existing = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const provider = buildLlamaCppProviderConfig(existing);
  const primary = readPrimaryModel(config);
  const primaryId = primary?.startsWith(`${LLAMA_CPP_PROVIDER_ID}/`)
    ? primary.slice(LLAMA_CPP_PROVIDER_ID.length + 1)
    : undefined;
  return provider.models
    .map((model) => ({ model, provider }))
    .toSorted((a, b) => Number(b.model.id === primaryId) - Number(a.model.id === primaryId));
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function detectLlamaCppSetup(ctx: ProviderAppGuidedSetupContext) {
  let runtime: NodeLlamaCppModule;
  try {
    runtime = await importNodeLlamaCpp();
  } catch {
    return null;
  }
  for (const candidate of configuredCandidates(ctx.config)) {
    try {
      const cachedPath = await runtime.resolveModelFile(
        resolveLlamaCppModelSource(candidate.model),
        {
          directory: resolveLlamaCppModelCacheDir(candidate.provider),
          download: false,
          cli: false,
        },
      );
      if (!(await isFile(cachedPath))) {
        continue;
      }
      return {
        modelRef: `${LLAMA_CPP_PROVIDER_ID}/${candidate.model.id}`,
        detail: `${candidate.model.id} (downloaded)`,
      };
    } catch {
      // Discovery is read-only: a missing model or native module is not a setup error.
    }
  }
  return null;
}

function buildSetupResult(
  config: ProviderAppGuidedSetupContext["config"],
  defaultModel = DEFAULT_LLAMA_CPP_MODEL_REF,
): ProviderAuthResult {
  return {
    profiles: [],
    defaultModel,
    configPatch: {
      models: {
        mode: config.models?.mode ?? "merge",
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: buildLlamaCppProviderConfig(
            config.models?.providers?.[LLAMA_CPP_PROVIDER_ID],
          ),
        },
      },
    },
  };
}

export async function prepareLlamaCppSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const detected = await detectLlamaCppSetup(ctx);
  return detected?.modelRef === ctx.modelRef ? buildSetupResult(ctx.config, ctx.modelRef) : null;
}

export async function runLlamaCppSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const cacheDir = resolveLlamaCppModelCacheDir(existing);
  const cachedPath = resolveCachedLlamaCppModelPath({
    model: {
      id: DEFAULT_LLAMA_CPP_MODEL_ID,
      params: { modelPath: DEFAULT_LLAMA_CPP_MODEL_URI },
    },
    provider: existing,
  });
  if (!cachedPath || !(await isFile(cachedPath))) {
    const totalmemBytes = os.totalmem();
    if (!meetsLlamaCppDefaultModelRamFloor(totalmemBytes)) {
      await ctx.prompter.note(
        `This machine has ${formatRamGb(totalmemBytes)} GB RAM; the bundled local model needs 16 GB+. Use Ollama/LM Studio with a smaller model, or a cloud provider.`,
        "Setup skipped",
      );
      return { profiles: [] };
    }
    const consent = await ctx.prompter.confirm({
      message: "Download Gemma 4 E4B IT Q4_K_M (about 5.0 GB) for local llama.cpp inference?",
      initialValue: false,
    });
    if (!consent) {
      await ctx.prompter.note("Local model download skipped.", "Setup skipped");
      return { profiles: [] };
    }
    const progress = ctx.prompter.progress("Preparing Gemma 4 E4B model download…");
    try {
      const runtime = await importNodeLlamaCpp();
      let previousDownloadedSize: number | undefined;
      let previousProgressAtMs: number | undefined;
      let rollingBytesPerSecond = 0;
      const downloader = await runtime.createModelDownloader({
        modelUri: DEFAULT_LLAMA_CPP_MODEL_URI,
        dirPath: cacheDir,
        fileName: DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
        showCliProgress: false,
        onProgress: ({ downloadedSize, totalSize }) => {
          const now = Date.now();
          if (
            previousDownloadedSize !== undefined &&
            previousProgressAtMs !== undefined &&
            downloadedSize >= previousDownloadedSize &&
            now > previousProgressAtMs
          ) {
            const elapsedSeconds = (now - previousProgressAtMs) / 1000;
            const currentBytesPerSecond =
              (downloadedSize - previousDownloadedSize) / elapsedSeconds;
            // Four-sample EWMA: a small rolling window without per-update allocations.
            rollingBytesPerSecond =
              rollingBytesPerSecond === 0
                ? currentBytesPerSecond
                : rollingBytesPerSecond * 0.75 + currentBytesPerSecond * 0.25;
          }
          previousDownloadedSize = downloadedSize;
          previousProgressAtMs = now;
          const expectedSize = totalSize || DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES;
          progress.update(
            formatLlamaCppDownloadProgress({
              downloadedSize,
              totalSize: expectedSize,
              bytesPerSecond: rollingBytesPerSecond,
            }),
          );
        },
      });
      await downloader.download({ signal: ctx.signal });
      progress.stop("Gemma 4 E4B model downloaded");
    } catch (error) {
      progress.stop("Model download failed");
      throw new Error(formatLlamaCppSetupError(error), { cause: error });
    }
  }
  return buildSetupResult(ctx.config);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.llamaCppSetupTestApi")] = {
    formatLlamaCppDownloadProgress,
  };
}
