import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { removeProviderAuthProfilesWithLock } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildLlamaCppAuthProfileRemovalPatch,
  LLAMA_CPP_DEFAULT_PROFILE_ID,
} from "./auth-config.js";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_REF,
  LLAMA_CPP_PROVIDER_ID,
  buildLlamaCppProviderConfig,
  meetsLlamaCppDefaultModelRamFloor,
  resolveCachedLlamaCppModelPath,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import { resolveManagedLlamaServerPaths, selectLlamaServerAsset } from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  prepareManagedLlamaServer,
  type ManagedLlamaServer,
} from "./managed-server.js";

const BYTES_PER_GB = 1_000_000_000;
const BYTES_PER_MB = 1_000_000;

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

function formatRamGb(totalmemBytes: number): string {
  return (totalmemBytes / 1024 ** 3).toFixed(1).replace(/\.0$/u, "");
}

function readPrimaryModel(config: ProviderAppGuidedSetupContext["config"]): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

function configuredCandidates(
  config: ProviderAppGuidedSetupContext["config"],
): Array<{ model: ModelDefinitionConfig; provider: ModelProviderConfig }> {
  const existing = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const provider = buildLlamaCppProviderConfig(existing?.localService ? existing : undefined);
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

async function resolveCachedCandidate(candidate: {
  model: ModelDefinitionConfig;
  provider: ModelProviderConfig;
}): Promise<string | undefined> {
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
    return await ensureLlamaCppModel({
      source,
      cacheDir: resolveLlamaCppModelCacheDir(candidate.provider),
      download: false,
    }).catch(() => undefined);
  }
  return undefined;
}

function readConfiguredPort(provider: ModelProviderConfig | undefined): number | undefined {
  try {
    const url = new URL(provider?.baseUrl ?? "");
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
      return undefined;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function buildSetupResult(params: {
  config: ProviderAppGuidedSetupContext["config"];
  managed: ManagedLlamaServer;
  defaultModel?: string;
}): ProviderAuthResult {
  const existing = params.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const switchingFromExternal = Boolean(existing && !existing.localService);
  return {
    profiles: [],
    defaultModel: params.defaultModel ?? DEFAULT_LLAMA_CPP_MODEL_REF,
    configPatch: {
      ...buildLlamaCppAuthProfileRemovalPatch(params.config),
      models: {
        mode: params.config.models?.mode ?? "merge",
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: buildLlamaCppProviderConfig(
            switchingFromExternal ? undefined : existing,
            params.managed,
          ),
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
  for (const candidate of configuredCandidates(ctx.config)) {
    if (await resolveCachedCandidate(candidate)) {
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
    defaultModel: ctx.modelRef,
    managed: {
      command: existing.localService.command,
      presetPath:
        existing.localService.args?.find(
          (_, index, args) => args[index - 1] === "--models-preset",
        ) ?? resolveManagedLlamaServerPaths(selectLlamaServerAsset()).presetPath,
      baseUrl,
      healthUrl: existing.localService.healthUrl ?? `${rootUrl}/health`,
      args: existing.localService.args ?? [],
      backend: selectLlamaServerAsset().backend,
    },
  });
}

export async function runLlamaCppSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const managedExisting = existing?.localService ? existing : undefined;
  const candidates = configuredCandidates(ctx.config);
  let selected = candidates[0];
  let chatModelPath = selected ? await resolveCachedCandidate(selected) : undefined;
  if (!chatModelPath) {
    selected = candidates.find((candidate) => candidate.model.id === DEFAULT_LLAMA_CPP_MODEL_ID);
    const totalmemBytes = os.totalmem();
    if (!selected || !meetsLlamaCppDefaultModelRamFloor(totalmemBytes)) {
      await ctx.prompter.note(
        `This Gateway has ${formatRamGb(totalmemBytes)} GB RAM; the recommended model needs 16 GB+. Configure an existing smaller GGUF, use Ollama or LM Studio, or choose a cloud provider.`,
        "Setup skipped",
      );
      return { profiles: [] };
    }
    const consent = await ctx.prompter.confirm({
      message:
        "OpenClaw will install a verified llama.cpp server and download Gemma 4 E4B IT Q4_K_M (about 5.0 GB) plus the local embedding model (about 0.3 GB). Continue?",
      initialValue: false,
    });
    if (!consent) {
      await ctx.prompter.note("Local model setup skipped.", "Setup skipped");
      return { profiles: [] };
    }
  }

  if (!selected) {
    throw new Error("llama.cpp setup could not resolve a chat model");
  }

  const progress = ctx.prompter.progress("Preparing managed llama.cpp server…");
  try {
    const cacheDir = resolveLlamaCppModelCacheDir(managedExisting);
    chatModelPath ??= await ensureLlamaCppModel({
      source: resolveLlamaCppModelSource(selected.model),
      cacheDir,
      download: true,
      signal: ctx.signal,
      onProgress: (status) => progress.update(formatDownloadProgress("Gemma 4 E4B", status)),
    });
    const embeddingModelPath = await ensureLlamaCppModel({
      source: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      cacheDir,
      download: true,
      signal: ctx.signal,
      onProgress: (status) => progress.update(formatDownloadProgress("EmbeddingGemma", status)),
    });
    const configuredContext = selected.model.params?.contextSize;
    const contextSize =
      typeof configuredContext === "number" && configuredContext > 0
        ? Math.floor(configuredContext)
        : selected.model.contextTokens;
    const managed = await prepareManagedLlamaServer({
      chatModelId: selected.model.id,
      chatModelPath,
      contextSize,
      maxTokens: selected.model.maxTokens,
      embeddingModelPath,
      port: readConfiguredPort(managedExisting),
    });
    const updated = await removeProviderAuthProfilesWithLock({
      provider: LLAMA_CPP_PROVIDER_ID,
      profileIds: [LLAMA_CPP_DEFAULT_PROFILE_ID],
      agentDir: ctx.agentDir,
    });
    if (!updated) {
      throw new Error("Failed to remove the previous llama.cpp endpoint auth profile");
    }
    progress.stop("Managed llama.cpp server prepared");
    return buildSetupResult({
      config: ctx.config,
      managed,
      defaultModel: `${LLAMA_CPP_PROVIDER_ID}/${selected.model.id}`,
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
