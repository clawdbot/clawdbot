import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAgentIds, resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildLlamaCppAuthProfileRemovalPatch } from "./auth-config.js";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  buildLlamaCppProviderConfig,
  resolveCachedLlamaCppModelPath,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppEmbeddingModel,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import { detectLlamaCppHardware, formatLlamaCppMemory, type LlamaCppHardware } from "./hardware.js";
import {
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  type LlamaServerAsset,
} from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  prepareManagedLlamaServer,
  type ManagedLlamaChatModel,
  type ManagedLlamaServer,
} from "./managed-server.js";
import { recommendLlamaCppModel, resolveLlamaCppModelCandidates } from "./model-catalog.js";

const BYTES_PER_GB = 1_000_000_000;
const BYTES_PER_MB = 1_000_000;

type LlamaCppChatCandidate = {
  model: ModelDefinitionConfig;
  provider: ModelProviderConfig;
};

type LlamaCppSetupPlan =
  | { kind: "chat"; candidate: LlamaCppChatCandidate; cachedPath?: string }
  | { kind: "embedding-only" };

function formatDownloadProgress(
  label: string,
  params: { downloadedSize: number; totalSize: number; bytesPerSecond: number },
): string {
  const downloadedSize = Math.max(0, params.downloadedSize);
  const totalSize = Math.max(1, params.totalSize);
  const percent = Math.min(100, Math.floor((downloadedSize / totalSize) * 100));
  const downloadedGb = (downloadedSize / BYTES_PER_GB).toFixed(1);
  const totalGb = (totalSize / BYTES_PER_GB).toFixed(1);
  const rateMb = Math.max(0, Math.round(params.bytesPerSecond / BYTES_PER_MB));
  return `Downloading ${label}… ${percent}% (${downloadedGb}/${totalGb} GB, ${rateMb} MB/s)`;
}

function describeEmbeddingDownload(isDefault: boolean): string {
  return isDefault
    ? "the local embedding model (about 0.3 GB)"
    : "your configured local embedding model";
}

function readPrimaryModel(config: ProviderAppGuidedSetupContext["config"]): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

function configuredCandidates(
  config: ProviderAppGuidedSetupContext["config"],
  scope: "detection" | "setup",
): LlamaCppChatCandidate[] {
  const existing = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const managedExisting = existing?.localService ? existing : undefined;
  const provider = buildLlamaCppProviderConfig({
    existing: managedExisting,
    // Detection reports persisted inventory; interactive setup may still offer the default.
    ...(managedExisting && scope === "detection" ? { modelInventory: managedExisting.models } : {}),
  });
  const primary = readPrimaryModel(config);
  const primaryId = primary?.startsWith(`${LLAMA_CPP_PROVIDER_ID}/`)
    ? primary.slice(LLAMA_CPP_PROVIDER_ID.length + 1)
    : undefined;
  return provider.models
    .map((model) => ({ model, provider }))
    .toSorted((a, b) => Number(b.model.id === primaryId) - Number(a.model.id === primaryId));
}

async function isFile(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function resolveCachedArtifact(source: string, cacheDir: string, signal?: AbortSignal) {
  return await ensureLlamaCppModel({ source, cacheDir, download: false, signal }).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
}

async function resolveCachedCandidate(
  candidate: { model: ModelDefinitionConfig; provider: ModelProviderConfig },
  signal?: AbortSignal,
): Promise<string | undefined> {
  const source = resolveLlamaCppModelSource(candidate.model);
  const resolved = resolveCachedLlamaCppModelPath(candidate);
  if (resolved && (await isFile(resolved))) {
    return resolved;
  }
  if (candidate.model.id === DEFAULT_LLAMA_CPP_MODEL_ID) {
    const legacy = path.join(
      resolveLegacyLlamaCppModelCacheDir(),
      DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
    );
    if (await isFile(legacy)) {
      return legacy;
    }
  }
  if (/^(?:hf|huggingface|https):/iu.test(source)) {
    return await resolveCachedArtifact(
      source,
      resolveLlamaCppModelCacheDir(candidate.provider),
      signal,
    );
  }
  return undefined;
}

function buildSetupResult(params: {
  config: ProviderAppGuidedSetupContext["config"];
  managed: ManagedLlamaServer;
  plan: LlamaCppSetupPlan["kind"];
  defaultModel?: string;
  model?: ModelDefinitionConfig;
}): ProviderAuthResult {
  const existing = params.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const switchingFromExternal = Boolean(existing && !existing.localService);
  return {
    profiles: [],
    ...(params.defaultModel ? { defaultModel: params.defaultModel } : {}),
    configPatch: {
      ...buildLlamaCppAuthProfileRemovalPatch(params.config),
      models: {
        mode: params.config.models?.mode ?? "merge",
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: buildLlamaCppProviderConfig({
            existing: switchingFromExternal ? undefined : existing,
            managed: params.managed,
            modelInventory:
              params.plan === "embedding-only"
                ? []
                : params.model
                  ? [
                      params.model,
                      ...(existing?.localService
                        ? existing.models.filter((model) => model.id !== params.model?.id)
                        : []),
                    ]
                  : existing?.models,
          }),
        },
      },
    },
  };
}

export async function detectLlamaCppSetup(ctx: ProviderAppGuidedSetupContext) {
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const command = existing?.localService?.command;
  const presetPath = existing?.localService?.args?.find(
    (_, index, args) => args[index - 1] === "--models-preset",
  );
  if (
    !command ||
    !path.isAbsolute(command) ||
    !(await isFile(command)) ||
    !presetPath ||
    !(await isFile(presetPath))
  ) {
    return null;
  }
  for (const candidate of configuredCandidates(ctx.config, "detection")) {
    if (await resolveCachedCandidate(candidate, ctx.signal)) {
      return {
        modelRef: `${LLAMA_CPP_PROVIDER_ID}/${candidate.model.id}`,
        detail: "Managed llama.cpp server ready",
      };
    }
  }
  return null;
}

export async function prepareLlamaCppSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const detected = await detectLlamaCppSetup(ctx);
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (detected?.modelRef !== ctx.modelRef || !existing?.localService?.command) {
    return null;
  }
  const baseUrl = existing.baseUrl?.replace(/\/+$/u, "") ?? "";
  const rootUrl = baseUrl.replace(/\/v1$/u, "");
  return buildSetupResult({
    config: ctx.config,
    plan: "chat",
    defaultModel: ctx.modelRef,
    managed: {
      command: existing.localService.command,
      baseUrl,
      healthUrl: existing.localService.healthUrl ?? `${rootUrl}/health`,
      args: existing.localService.args ?? [],
    },
  });
}

function resolveEmbeddingSetup(config: ProviderAuthContext["config"], cacheDir: string) {
  const defaults = config.memory?.search;
  const models = listAgentIds(config).flatMap((agentId) => {
    const override = resolveAgentConfig(config, agentId)?.memory?.search;
    // Match core memory config: each agent field overrides the top-level default.
    if (
      !(override?.enabled ?? defaults?.enabled ?? true) ||
      (override?.provider ?? defaults?.provider) !== "local"
    ) {
      return [];
    }
    return [
      resolveLlamaCppEmbeddingModel({
        modelPath: override?.local?.modelPath ?? defaults?.local?.modelPath,
        modelCacheDir: cacheDir,
      }),
    ];
  });
  const model = models[0] ?? resolveLlamaCppEmbeddingModel({ modelCacheDir: cacheDir });
  return {
    model,
    localMemoryIntent: models.length > 0,
    conflict: models.some((candidate) => candidate.source !== model.source),
  };
}

async function resolveSetupPlan(
  ctx: ProviderAuthContext,
  candidates: LlamaCppChatCandidate[],
  embeddingModelIsDefault: boolean,
  localMemoryIntent: boolean,
  hardware: LlamaCppHardware,
  asset: LlamaServerAsset,
  runtimeNote?: string,
): Promise<LlamaCppSetupPlan | undefined> {
  let candidate = candidates[0];
  const configuredPath = candidate
    ? await resolveCachedCandidate(candidate, ctx.signal)
    : undefined;
  if (candidate && configuredPath) {
    if (
      runtimeNote &&
      !(await ctx.prompter.confirm({
        message: `${runtimeNote} Use cached ${candidate.model.name} on Gateway host ${os.hostname()} with the verified CPU runtime?`,
        initialValue: false,
      }))
    ) {
      return undefined;
    }
    return { kind: "chat", candidate, cachedPath: configuredPath };
  }

  const provider = candidate?.provider ?? buildLlamaCppProviderConfig();
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const cachedModels = new Map<string, string>();
  // A cancelled activation may leave a complete download without configured inventory.
  // Credit only verified artifacts, before charging disk space for a retry.
  for (const recipe of resolveLlamaCppModelCandidates(hardware, asset.backend).recipes) {
    const cached = await resolveCachedArtifact(
      resolveLlamaCppModelSource(recipe.model),
      cacheDir,
      ctx.signal,
    );
    if (cached) {
      cachedModels.set(recipe.model.id, cached);
      // Lower cached tiers cannot save more download space than this one.
      break;
    }
  }
  const cachedEmbedding =
    embeddingModelIsDefault &&
    Boolean(await resolveCachedArtifact(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, cacheDir, ctx.signal));
  const recommendation = recommendLlamaCppModel(hardware, asset.backend, {
    modelIds: new Set(cachedModels.keys()),
    embedding: cachedEmbedding,
    // An existing pinned command is validated by the installer; it will not be downloaded again.
    runtime: await isFile(resolveManagedLlamaServerPaths(asset).command),
  });
  if (recommendation.kind === "recommended") {
    const { recipe } = recommendation;
    const cachedPath = cachedModels.get(recipe.model.id);
    candidate = { model: recipe.model, provider };
    const recommendationSummary = [
      `Runs on Gateway host ${os.hostname()} (${hardware.platform}/${hardware.arch}), using ${asset.backend === "metal" ? "Apple Metal" : asset.backend === "cuda" ? "NVIDIA CUDA" : "the CPU"}.`,
      `${formatLlamaCppMemory(hardware.totalMemoryBytes)} RAM; ${formatLlamaCppMemory(hardware.availableDiskBytes ?? 0)} free disk.`,
      !hardware.sharedDisk
        ? `${formatLlamaCppMemory(hardware.availableRuntimeDiskBytes ?? 0)} free on the runtime volume.`
        : undefined,
      runtimeNote,
      recommendation.reason,
      !embeddingModelIsDefault
        ? "This estimate includes the default embedding model; your configured embedding model may need more memory and disk space."
        : undefined,
      "OpenClaw will check a real tool call before making this your default model.",
    ]
      .filter(Boolean)
      .join("\n");
    const consent = await ctx.prompter.confirm({
      message: `${recommendationSummary}\n\n${
        cachedPath
          ? `Use cached ${recipe.model.name}, download any missing embedding and ${asset.backend.toUpperCase()} runtime files, then use this model?`
          : `Download ${recipe.model.name} (${(recipe.sizeBytes / BYTES_PER_GB).toFixed(1)} GB), ${describeEmbeddingDownload(embeddingModelIsDefault)}, and the verified ${asset.backend.toUpperCase()} runtime, then use this model?`
      }`,
      initialValue: false,
    });
    if (consent) {
      return { kind: "chat", candidate, cachedPath };
    }
  } else if (!localMemoryIntent) {
    await ctx.prompter.note(recommendation.reason, "Setup skipped");
    return undefined;
  }

  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (localMemoryIntent && existing && (!existing.localService || existing.models.length > 0)) {
    await ctx.prompter.note(
      "Embedding-only setup cannot replace an existing llama.cpp server or configured llama.cpp chat routes. Move those routes to another provider, remove any existing server config, then retry llama.cpp setup.",
      "Setup skipped",
    );
    return undefined;
  }

  if (localMemoryIntent) {
    const consent = await ctx.prompter.confirm({
      message: `${runtimeNote ? `${runtimeNote} ` : ""}Install a verified ${asset.backend.toUpperCase()} llama.cpp server on Gateway host ${os.hostname()} and download only ${describeEmbeddingDownload(embeddingModelIsDefault)}? Your chat model will stay unchanged.`,
      initialValue: false,
    });
    if (consent) {
      return { kind: "embedding-only" };
    }
  }

  await ctx.prompter.note("Local model setup skipped.", "Setup skipped");
  return undefined;
}

export async function runLlamaCppSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const managedExisting = existing?.localService ? existing : undefined;
  const cacheDir = resolveLlamaCppModelCacheDir(managedExisting);
  const embeddingSetup = resolveEmbeddingSetup(ctx.config, cacheDir);
  if (embeddingSetup.conflict) {
    await ctx.prompter.note(
      "Configured agents resolve to different local embedding models. Set memory.search.local.modelPath and any per-agent overrides to the same value, then retry llama.cpp setup.",
      "Setup skipped",
    );
    return { profiles: [] };
  }
  const embeddingModel = embeddingSetup.model;
  const hardware = await detectLlamaCppHardware({ cacheDir, signal: ctx.signal });
  let asset: LlamaServerAsset;
  let runtimeNote: string | undefined;
  try {
    asset = selectLlamaServerAsset(hardware.platform, hardware.arch, hardware.accelerator);
  } catch (error) {
    if (hardware.accelerator.kind !== "cuda") {
      throw error;
    }
    // CUDA cannot silently fall back: the download confirmation names the CPU runtime.
    asset = selectLlamaServerAsset(hardware.platform, hardware.arch, { kind: "cpu" });
    runtimeNote = `${error instanceof Error ? error.message : String(error)} This recommendation uses CPU execution.`;
  }
  const candidates = configuredCandidates(ctx.config, "setup");
  const plan = await resolveSetupPlan(
    ctx,
    candidates,
    embeddingModel.isDefault,
    embeddingSetup.localMemoryIntent,
    hardware,
    asset,
    runtimeNote,
  );
  if (!plan) {
    return { profiles: [] };
  }

  const progress = ctx.prompter.progress("Preparing managed llama.cpp server…");
  try {
    let chatModel: ManagedLlamaChatModel;
    if (plan.kind === "chat") {
      const chatModelPath =
        plan.cachedPath ??
        (await ensureLlamaCppModel({
          source: resolveLlamaCppModelSource(plan.candidate.model),
          cacheDir,
          download: true,
          signal: ctx.signal,
          onProgress: (status) =>
            progress.update(formatDownloadProgress(plan.candidate.model.name, status)),
        }));
      const configuredContext = plan.candidate.model.params?.contextSize;
      chatModel = {
        mode: "configure",
        id: plan.candidate.model.id,
        path: chatModelPath,
        contextSize:
          typeof configuredContext === "number" && configuredContext > 0
            ? Math.floor(configuredContext)
            : plan.candidate.model.contextTokens,
        maxTokens: plan.candidate.model.maxTokens,
      };
    } else {
      chatModel = { mode: "remove" };
    }
    const embeddingModelLabel = embeddingModel.isDefault
      ? "EmbeddingGemma"
      : "configured embedding model";
    const embeddingModelPath = await ensureLlamaCppModel({
      source: embeddingModel.source,
      cacheDir,
      download: true,
      signal: ctx.signal,
      onProgress: (status) => progress.update(formatDownloadProgress(embeddingModelLabel, status)),
    });
    const managed = await prepareManagedLlamaServer({
      chatModel,
      configuredChatModelIds:
        plan.kind === "chat" ? plan.candidate.provider.models.map((model) => model.id) : [],
      embeddingModelIsDefault: embeddingModel.isDefault,
      embeddingModelPath,
      asset,
      isolated: true,
      signal: ctx.signal,
      onProgress: (status) => progress.update(formatDownloadProgress("llama.cpp runtime", status)),
    });
    // The managed provider's synthetic marker takes precedence over implicit profiles.
    // Keep stored credentials intact until the candidate is verified and accepted.
    ctx.signal?.throwIfAborted();
    progress.stop("Managed llama.cpp server prepared");
    return buildSetupResult({
      config: ctx.config,
      managed,
      plan: plan.kind,
      ...(plan.kind === "chat"
        ? {
            defaultModel: `${LLAMA_CPP_PROVIDER_ID}/${plan.candidate.model.id}`,
            model: plan.candidate.model,
          }
        : {}),
    });
  } catch (error) {
    progress.stop("llama.cpp setup failed");
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Managed llama.cpp setup failed. Run openclaw doctor, fix the reported runtime or model issue, then retry. ${detail}`,
      { cause: error },
    );
  }
}
