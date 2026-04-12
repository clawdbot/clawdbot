import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { agentCommand } from "../agents/agent-command.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
} from "../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { modelsAuthLoginCommand, modelsStatusCommand } from "../commands/models.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { isLoopbackHost } from "../gateway/net.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { generateImage, listRuntimeImageGenerationProviders } from "../image-generation/runtime.js";
import { buildMediaUnderstandingRegistry } from "../media-understanding/provider-registry.js";
import {
  describeImageFile,
  describeVideoFile,
  transcribeAudioFile,
} from "../media-understanding/runtime.js";
import { getImageMetadata } from "../media/image-ops.js";
import { detectMime, extensionForMime, normalizeMimeType } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import {
  createEmbeddingProvider,
  registerBuiltInMemoryEmbeddingProviders,
} from "../plugin-sdk/memory-core-bundled-runtime.js";
import {
  listMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
import { writeRuntimeJson, defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { canonicalizeSpeechProviderId, listSpeechProviders } from "../tts/provider-registry.js";
import {
  getTtsProvider,
  listSpeechVoices,
  resolveExplicitTtsOverrides,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsEnabled,
  setTtsProvider,
  textToSpeech,
} from "../tts/tts.js";
import { generateVideo, listRuntimeVideoGenerationProviders } from "../video-generation/runtime.js";
import {
  isWebFetchProviderConfigured,
  resolveWebFetchDefinition,
  listWebFetchProviders,
} from "../web-fetch/runtime.js";
import {
  isWebSearchProviderConfigured,
  listWebSearchProviders,
  runWebSearch,
} from "../web-search/runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { createDefaultDeps } from "./deps.js";
import { collectOption } from "./program/helpers.js";

type CapabilityTransport = "local" | "gateway";

type CapabilityMetadata = {
  id: string;
  description: string;
  transports: Array<CapabilityTransport>;
  flags: string[];
  resultShape: string;
};

type CapabilityEnvelope = {
  ok: boolean;
  capability: string;
  transport: CapabilityTransport;
  provider?: string;
  model?: string;
  attempts: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  error?: string;
};

const CAPABILITY_METADATA: CapabilityMetadata[] = [
  {
    id: "model.run",
    description: "Run a one-shot text inference turn through the agent runtime.",
    transports: ["local", "gateway"],
    flags: ["--prompt", "--model", "--local", "--gateway", "--json"],
    resultShape: "normalized payloads plus provider/model attribution",
  },
  {
    id: "model.list",
    description: "List known models from the model catalog.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "catalog entries",
  },
  {
    id: "model.inspect",
    description: "Inspect one model catalog entry.",
    transports: ["local"],
    flags: ["--model", "--json"],
    resultShape: "single catalog entry",
  },
  {
    id: "model.providers",
    description: "List model providers discovered from the catalog.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids with counts and defaults",
  },
  {
    id: "model.auth.login",
    description: "Run the existing provider auth login flow.",
    transports: ["local"],
    flags: ["--provider"],
    resultShape: "interactive auth result",
  },
  {
    id: "model.auth.logout",
    description: "Remove saved auth profiles for one provider.",
    transports: ["local"],
    flags: ["--provider", "--json"],
    resultShape: "removed profile ids",
  },
  {
    id: "model.auth.status",
    description: "Show configured model auth state.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "model status summary",
  },
  {
    id: "image.generate",
    description: "Generate raster images with configured image providers.",
    transports: ["local"],
    flags: [
      "--prompt",
      "--model",
      "--count",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--output",
      "--json",
    ],
    resultShape: "saved image files plus attempts",
  },
  {
    id: "image.edit",
    description: "Generate edited images from one or more input files.",
    transports: ["local"],
    flags: ["--file", "--prompt", "--model", "--output", "--json"],
    resultShape: "saved image files plus attempts",
  },
  {
    id: "image.describe",
    description: "Describe one image file through media-understanding providers.",
    transports: ["local"],
    flags: ["--file", "--prompt", "--model", "--json"],
    resultShape: "normalized text output",
  },
  {
    id: "image.describe-many",
    description: "Describe multiple image files independently.",
    transports: ["local"],
    flags: ["--file", "--prompt", "--model", "--json"],
    resultShape: "one text output per file",
  },
  {
    id: "image.providers",
    description: "List image generation providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and defaults",
  },
  {
    id: "audio.transcribe",
    description: "Transcribe one audio file.",
    transports: ["local"],
    flags: ["--file", "--model", "--json"],
    resultShape: "normalized text output",
  },
  {
    id: "audio.providers",
    description: "List audio transcription providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and capabilities",
  },
  {
    id: "tts.convert",
    description: "Convert text to speech.",
    transports: ["local", "gateway"],
    flags: [
      "--text",
      "--channel",
      "--voice",
      "--model",
      "--output",
      "--local",
      "--gateway",
      "--json",
    ],
    resultShape: "saved audio file plus attempts",
  },
  {
    id: "tts.voices",
    description: "List voices for a speech provider.",
    transports: ["local"],
    flags: ["--provider", "--json"],
    resultShape: "voice entries",
  },
  {
    id: "tts.providers",
    description: "List speech providers.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "provider ids, configured state, models, voices",
  },
  {
    id: "tts.status",
    description: "Show gateway-managed TTS state.",
    transports: ["gateway"],
    flags: ["--gateway", "--json"],
    resultShape: "enabled/provider state",
  },
  {
    id: "tts.enable",
    description: "Enable TTS in prefs.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "enabled state",
  },
  {
    id: "tts.disable",
    description: "Disable TTS in prefs.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "enabled state",
  },
  {
    id: "tts.set-provider",
    description: "Set the active TTS provider.",
    transports: ["local", "gateway"],
    flags: ["--provider", "--local", "--gateway", "--json"],
    resultShape: "selected provider",
  },
  {
    id: "video.generate",
    description: "Generate video files with configured video providers.",
    transports: ["local"],
    flags: ["--prompt", "--model", "--output", "--json"],
    resultShape: "saved video files plus attempts",
  },
  {
    id: "video.describe",
    description: "Describe one video file through media-understanding providers.",
    transports: ["local"],
    flags: ["--file", "--model", "--json"],
    resultShape: "normalized text output",
  },
  {
    id: "video.providers",
    description: "List video generation and description providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and defaults",
  },
  {
    id: "web.search",
    description: "Run provider-backed web search.",
    transports: ["local"],
    flags: ["--query", "--provider", "--limit", "--json"],
    resultShape: "search provider result",
  },
  {
    id: "web.fetch",
    description: "Fetch URL content through configured web fetch providers.",
    transports: ["local"],
    flags: ["--url", "--provider", "--format", "--json"],
    resultShape: "fetch provider result",
  },
  {
    id: "web.providers",
    description: "List web search and fetch providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids grouped by family",
  },
  {
    id: "embedding.create",
    description: "Create embeddings through embedding providers.",
    transports: ["local"],
    flags: ["--text", "--provider", "--model", "--json"],
    resultShape: "vectors with provider/model attribution",
  },
  {
    id: "embedding.providers",
    description: "List embedding providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and default models",
  },
];

function findCapabilityMetadata(id: string): CapabilityMetadata | undefined {
  return CAPABILITY_METADATA.find((entry) => entry.id === id);
}

function resolveTransport(opts: {
  local?: boolean;
  gateway?: boolean;
  supported: Array<CapabilityTransport>;
  defaultTransport: CapabilityTransport;
}): CapabilityTransport {
  if (opts.local && opts.gateway) {
    throw new Error("Pass only one of --local or --gateway.");
  }
  if (opts.local) {
    if (!opts.supported.includes("local")) {
      throw new Error("This command does not support --local.");
    }
    return "local";
  }
  if (opts.gateway) {
    if (!opts.supported.includes("gateway")) {
      throw new Error("This command does not support --gateway.");
    }
    return "gateway";
  }
  return opts.defaultTransport;
}

function emitJsonOrText(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  value: unknown,
  textFormatter: (value: unknown) => string,
) {
  if (json) {
    writeRuntimeJson(runtime, value);
    return;
  }
  runtime.log(textFormatter(value));
}

function formatEnvelopeForText(value: unknown): string {
  const envelope = value as CapabilityEnvelope;
  if (!envelope.ok) {
    return `${envelope.capability} failed: ${envelope.error ?? "unknown error"}`;
  }
  const lines = [
    `${envelope.capability} via ${envelope.transport}`,
    ...(envelope.provider ? [`provider: ${envelope.provider}`] : []),
    ...(envelope.model ? [`model: ${envelope.model}`] : []),
    `outputs: ${String(envelope.outputs.length)}`,
  ];
  for (const output of envelope.outputs) {
    const pathValue = typeof output.path === "string" ? output.path : undefined;
    const textValue = typeof output.text === "string" ? output.text : undefined;
    if (pathValue) {
      lines.push(pathValue);
    } else if (textValue) {
      lines.push(textValue);
    } else {
      lines.push(JSON.stringify(output));
    }
  }
  return lines.join("\n");
}

function providerSummaryText(value: unknown): string {
  const providers = value as Array<Record<string, unknown>>;
  return providers.map((entry) => JSON.stringify(entry)).join("\n");
}

function hasOwnKeys(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0,
  );
}

function resolveSelectedProviderFromModelRef(modelRef: string | undefined): string | undefined {
  return resolveModelRefOverride(modelRef).provider;
}

function getAuthProfileIdsForProvider(cfg: OpenClawConfig, providerId: string): string[] {
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const store = loadAuthProfileStoreForRuntime(agentDir);
  return listProfilesForProvider(store, providerId);
}

function providerHasGenericConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  envVars?: string[];
}): boolean {
  const modelsProviders = (params.cfg.models?.providers ?? {}) as Record<string, unknown>;
  const pluginEntries = (params.cfg.plugins?.entries ?? {}) as Record<string, { config?: unknown }>;
  const ttsProviders = (params.cfg.messages?.tts?.providers ?? {}) as Record<string, unknown>;
  const envConfigured = (params.envVars ?? []).some((envVar) =>
    Boolean(process.env[envVar]?.trim()),
  );
  return (
    getAuthProfileIdsForProvider(params.cfg, params.providerId).length > 0 ||
    hasOwnKeys(modelsProviders[params.providerId]) ||
    hasOwnKeys(pluginEntries[params.providerId]?.config) ||
    hasOwnKeys(ttsProviders[params.providerId]) ||
    envConfigured
  );
}

async function writeOutputAsset(params: {
  buffer: Buffer;
  mimeType?: string;
  originalFilename?: string;
  outputPath?: string;
  outputIndex: number;
  outputCount: number;
  subdir: string;
}) {
  if (!params.outputPath) {
    const saved = await saveMediaBuffer(
      params.buffer,
      params.mimeType,
      params.subdir,
      Number.MAX_SAFE_INTEGER,
      params.originalFilename,
    );
    return { path: saved.path, mimeType: saved.contentType, size: saved.size };
  }

  const resolvedOutput = path.resolve(params.outputPath);
  const parsed = path.parse(resolvedOutput);
  const detectedMime =
    (await detectMime({
      buffer: params.buffer,
      headerMime: params.mimeType,
    })) ?? params.mimeType;
  const requestedMime = normalizeMimeType(await detectMime({ filePath: resolvedOutput }));
  const detectedNormalized = normalizeMimeType(detectedMime);
  const canonicalDetectedExt = extensionForMime(detectedNormalized);
  const fallbackExt = parsed.ext || path.extname(params.originalFilename ?? "") || "";
  const ext =
    parsed.ext && requestedMime === detectedNormalized
      ? parsed.ext
      : (canonicalDetectedExt ?? fallbackExt);
  const filePath =
    params.outputCount <= 1
      ? path.join(parsed.dir, `${parsed.name}${ext}`)
      : path.join(parsed.dir, `${parsed.name}-${String(params.outputIndex + 1)}${ext}`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, params.buffer);
  return {
    path: filePath,
    mimeType: detectedNormalized ?? params.mimeType,
    size: params.buffer.byteLength,
  };
}

async function readInputFiles(files: string[]): Promise<Array<{ path: string; buffer: Buffer }>> {
  return await Promise.all(
    files.map(async (filePath) => ({
      path: path.resolve(filePath),
      buffer: await fs.readFile(path.resolve(filePath)),
    })),
  );
}

function resolveModelRefOverride(raw: string | undefined): { provider?: string; model?: string } {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return {};
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

function requireProviderModelOverride(
  raw: string | undefined,
): { provider: string; model: string } | undefined {
  const resolved = resolveModelRefOverride(raw);
  if (!raw?.trim()) {
    return undefined;
  }
  if (!resolved.provider || !resolved.model) {
    throw new Error("Model overrides must use the form <provider/model>.");
  }
  return {
    provider: resolved.provider,
    model: resolved.model,
  };
}

async function runModelRun(params: {
  prompt: string;
  model?: string;
  transport: CapabilityTransport;
}) {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  if (params.transport === "local") {
    const result = await agentCommand(
      {
        message: params.prompt,
        agentId,
        model: params.model,
        json: false,
      },
      {
        ...defaultRuntime,
        log: () => {},
      },
      createDefaultDeps(),
    );
    return {
      ok: true,
      capability: "model.run",
      transport: "local" as const,
      provider: result?.meta?.agentMeta?.provider,
      model: result?.meta?.agentMeta?.model,
      attempts: [],
      outputs: (result?.payloads ?? []).map((payload) => ({
        text: payload.text,
        mediaUrl: payload.mediaUrl,
        mediaUrls: payload.mediaUrls,
      })),
    } satisfies CapabilityEnvelope;
  }

  const { provider, model } = resolveModelRefOverride(params.model);
  const response: {
    result?: {
      payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
      meta?: { agentMeta?: { provider?: string; model?: string } };
    };
  } = await callGateway({
    method: "agent",
    params: {
      agentId,
      message: params.prompt,
      provider,
      model,
      idempotencyKey: randomIdempotencyKey(),
    },
    expectFinal: true,
    timeoutMs: 120_000,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
  return {
    ok: true,
    capability: "model.run",
    transport: "gateway" as const,
    provider: response?.result?.meta?.agentMeta?.provider,
    model: response?.result?.meta?.agentMeta?.model,
    attempts: [],
    outputs: (response?.result?.payloads ?? []).map((payload) => ({
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
    })),
  } satisfies CapabilityEnvelope;
}

async function buildModelProviders() {
  const cfg = loadConfig();
  const catalog = await loadModelCatalog({ config: cfg });
  const selectedProvider = resolveSelectedProviderFromModelRef(
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
  );
  const grouped = new Map<
    string,
    {
      provider: string;
      count: number;
      defaults: string[];
      available: boolean;
      configured: boolean;
      selected: boolean;
    }
  >();
  for (const entry of catalog) {
    const current = grouped.get(entry.provider) ?? {
      provider: entry.provider,
      count: 0,
      defaults: [],
      available: true,
      configured: providerHasGenericConfig({ cfg, providerId: entry.provider }),
      selected: selectedProvider === entry.provider,
    };
    current.count += 1;
    if (current.defaults.length < 3) {
      current.defaults.push(entry.id);
    }
    grouped.set(entry.provider, current);
  }
  return [...grouped.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
}

async function runModelAuthStatus() {
  const captured: string[] = [];
  await modelsStatusCommand(
    { json: true },
    {
      log: (...args) => captured.push(args.join(" ")),
      error: (message) => {
        throw message instanceof Error ? message : new Error(String(message));
      },
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  );
  const raw = captured.find((line) => line.trim().startsWith("{"));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function runModelAuthLogout(provider: string) {
  const cfg = loadConfig();
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const store = loadAuthProfileStoreForRuntime(agentDir);
  const profileIds = listProfilesForProvider(store, provider);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (nextStore) => {
      let changed = false;
      for (const profileId of profileIds) {
        if (nextStore.profiles[profileId]) {
          delete nextStore.profiles[profileId];
          changed = true;
        }
        if (nextStore.usageStats?.[profileId]) {
          delete nextStore.usageStats[profileId];
          changed = true;
        }
      }
      if (nextStore.order?.[provider]) {
        delete nextStore.order[provider];
        changed = true;
      }
      if (nextStore.lastGood?.[provider]) {
        delete nextStore.lastGood[provider];
        changed = true;
      }
      return changed;
    },
  });
  if (!updated) {
    throw new Error(`Failed to remove saved auth profiles for provider ${provider}.`);
  }
  return {
    provider,
    removedProfiles: profileIds,
  };
}

async function runImageGenerate(params: {
  capability: "image.generate" | "image.edit";
  prompt: string;
  model?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: "1K" | "2K" | "4K";
  file?: string[];
  output?: string;
}) {
  const cfg = loadConfig();
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const inputImages =
    params.file && params.file.length > 0
      ? await Promise.all(
          (await readInputFiles(params.file)).map(async (entry) => ({
            buffer: entry.buffer,
            fileName: path.basename(entry.path),
            mimeType:
              (await detectMime({ buffer: entry.buffer, filePath: entry.path })) ?? "image/png",
          })),
        )
      : undefined;
  const result = await generateImage({
    cfg,
    agentDir,
    prompt: params.prompt,
    modelOverride: params.model,
    count: params.count,
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    inputImages,
  });
  const outputs = await Promise.all(
    result.images.map(async (image, index) => {
      const written = await writeOutputAsset({
        buffer: image.buffer,
        mimeType: image.mimeType,
        originalFilename: image.fileName,
        outputPath: params.output,
        outputIndex: index,
        outputCount: result.images.length,
        subdir: "generated",
      });
      const metadata = await getImageMetadata(image.buffer).catch(() => undefined);
      return {
        ...written,
        width: metadata?.width,
        height: metadata?.height,
        revisedPrompt: image.revisedPrompt,
      };
    }),
  );
  return {
    ok: true,
    capability: params.capability,
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    outputs,
  } satisfies CapabilityEnvelope;
}

async function runImageDescribe(params: {
  capability: "image.describe" | "image.describe-many";
  files: string[];
  model?: string;
}) {
  const cfg = loadConfig();
  const activeModel = requireProviderModelOverride(params.model);
  const outputs = await Promise.all(
    params.files.map(async (filePath) => {
      const result = await describeImageFile({
        filePath: path.resolve(filePath),
        cfg,
        activeModel,
      });
      if (!result.text) {
        throw new Error(`No description returned for image: ${path.resolve(filePath)}`);
      }
      return {
        path: path.resolve(filePath),
        text: result.text,
        provider: result.provider,
        model: result.model,
        kind: "image.description",
      };
    }),
  );
  return {
    ok: true,
    capability: params.capability,
    transport: "local" as const,
    provider: outputs[0]?.provider,
    model: outputs[0]?.model,
    attempts: [],
    outputs,
  } satisfies CapabilityEnvelope;
}

async function runAudioTranscribe(params: {
  file: string;
  language?: string;
  model?: string;
  prompt?: string;
}) {
  const cfg = loadConfig();
  const activeModel = requireProviderModelOverride(params.model);
  const result = await transcribeAudioFile({
    filePath: path.resolve(params.file),
    cfg,
    language: params.language,
    activeModel,
    prompt: params.prompt,
  });
  if (!result.text) {
    throw new Error(`No transcript returned for audio: ${path.resolve(params.file)}`);
  }
  return {
    ok: true,
    capability: "audio.transcribe",
    transport: "local" as const,
    attempts: [],
    outputs: [{ path: path.resolve(params.file), text: result.text, kind: "audio.transcription" }],
  } satisfies CapabilityEnvelope;
}

async function runVideoGenerate(params: { prompt: string; model?: string; output?: string }) {
  const cfg = loadConfig();
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const result = await generateVideo({
    cfg,
    agentDir,
    prompt: params.prompt,
    modelOverride: params.model,
  });
  const outputs = await Promise.all(
    result.videos.map(async (video, index) => {
      if (!video.buffer && !video.url) {
        throw new Error(`Video asset at index ${index} has neither buffer nor url`);
      }

      let videoBuffer = video.buffer;
      if (!videoBuffer && video.url) {
        const response = await fetch(video.url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          throw new Error(`Failed to download video from ${video.url}: ${response.status}`);
        }
        if (params.output && response.body) {
          const { pipeline } = await import("node:stream/promises");
          const { Readable } = await import("node:stream");
          const { createWriteStream } = await import("node:fs");
          const mimeType = normalizeMimeType(video.mimeType);
          const ext =
            extensionForMime(mimeType) ||
            path.extname(video.fileName ?? "") ||
            path.extname(params.output ?? "");
          const resolvedOutput = path.resolve(params.output);
          const parsed = path.parse(resolvedOutput);
          const filePath =
            result.videos.length <= 1
              ? path.join(parsed.dir, `${parsed.name}${ext}`)
              : path.join(parsed.dir, `${parsed.name}-${String(index + 1)}${ext}`);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await pipeline(
            Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
            createWriteStream(filePath),
          );
          const stat = await fs.stat(filePath);
          return { path: filePath, mimeType: video.mimeType, size: stat.size };
        }
        videoBuffer = Buffer.from(await response.arrayBuffer());
      }

      return {
        ...(await writeOutputAsset({
          buffer: videoBuffer!,
          mimeType: video.mimeType,
          originalFilename: video.fileName,
          outputPath: params.output,
          outputIndex: index,
          outputCount: result.videos.length,
          subdir: "generated",
        })),
      };
    }),
  );
  return {
    ok: true,
    capability: "video.generate",
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    outputs,
  } satisfies CapabilityEnvelope;
}

async function runVideoDescribe(params: { file: string; model?: string }) {
  const cfg = loadConfig();
  const activeModel = requireProviderModelOverride(params.model);
  const result = await describeVideoFile({
    filePath: path.resolve(params.file),
    cfg,
    activeModel,
  });
  if (!result.text) {
    throw new Error(`No description returned for video: ${path.resolve(params.file)}`);
  }
  return {
    ok: true,
    capability: "video.describe",
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: [],
    outputs: [{ path: path.resolve(params.file), text: result.text, kind: "video.description" }],
  } satisfies CapabilityEnvelope;
}

async function runTtsConvert(params: {
  text: string;
  channel?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  output?: string;
  transport: CapabilityTransport;
}) {
  if (params.transport === "gateway") {
    const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({ config: loadConfig() });
    const result: {
      audioPath?: string;
      provider?: string;
      outputFormat?: string;
      voiceCompatible?: boolean;
    } = await callGateway({
      method: "tts.convert",
      params: {
        text: params.text,
        channel: params.channel,
        provider: normalizeOptionalString(params.provider),
        modelId: params.modelId,
        voiceId: params.voiceId,
      },
      timeoutMs: 120_000,
    });
    let outputPath = result.audioPath;
    if (params.output && result.audioPath) {
      const gatewayHost = new URL(gatewayConnection.url).hostname;
      if (!isLoopbackHost(gatewayHost)) {
        throw new Error(
          `--output is not supported for remote gateway TTS yet (gateway target: ${gatewayConnection.url}).`,
        );
      }
      const target = path.resolve(params.output);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(result.audioPath, target);
      outputPath = target;
    }
    return {
      ok: true,
      capability: "tts.convert",
      transport: "gateway" as const,
      provider: result.provider,
      attempts: [],
      outputs: [
        {
          path: outputPath,
          format: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        },
      ],
    } satisfies CapabilityEnvelope;
  }

  const cfg = loadConfig();
  const overrides = resolveExplicitTtsOverrides({
    cfg,
    provider: params.provider,
    modelId: params.modelId,
    voiceId: params.voiceId,
  });
  const hasExplicitSelection = Boolean(
    overrides.provider ||
    normalizeOptionalString(params.modelId) ||
    normalizeOptionalString(params.voiceId),
  );
  const result = await textToSpeech({
    text: params.text,
    cfg,
    channel: params.channel,
    overrides,
    disableFallback: hasExplicitSelection,
  });
  if (!result.success || !result.audioPath) {
    throw new Error(result.error ?? "TTS conversion failed");
  }
  let outputPath = result.audioPath;
  if (params.output) {
    const target = path.resolve(params.output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(result.audioPath, target);
    outputPath = target;
  }
  return {
    ok: true,
    capability: "tts.convert",
    transport: "local" as const,
    provider: result.provider,
    attempts: result.attempts ?? [],
    outputs: [
      {
        path: outputPath,
        format: result.outputFormat,
        voiceCompatible: result.voiceCompatible,
      },
    ],
  } satisfies CapabilityEnvelope;
}

async function runTtsProviders(transport: CapabilityTransport) {
  const cfg = loadConfig();
  if (transport === "gateway") {
    const payload: {
      providers?: Array<Record<string, unknown>>;
      active?: string;
    } = await callGateway({
      method: "tts.providers",
      timeoutMs: 30_000,
    });
    return {
      ...payload,
      providers: (payload.providers ?? []).map((provider) => {
        const id = typeof provider.id === "string" ? provider.id : "";
        return {
          available: true,
          configured:
            typeof provider.configured === "boolean"
              ? provider.configured
              : providerHasGenericConfig({ cfg, providerId: id }),
          selected: Boolean(id && payload.active === id),
          ...provider,
        };
      }),
    };
  }
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const active = getTtsProvider(config, prefsPath);
  return {
    providers: listSpeechProviders(cfg).map((provider) => ({
      available: true,
      configured:
        active === provider.id || providerHasGenericConfig({ cfg, providerId: provider.id }),
      selected: active === provider.id,
      id: provider.id,
      name: provider.label,
      models: [...(provider.models ?? [])],
      voices: [...(provider.voices ?? [])],
    })),
    active,
  };
}

async function runTtsVoices(providerRaw?: string) {
  const cfg = loadConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const provider = normalizeOptionalString(providerRaw) || getTtsProvider(config, prefsPath);
  return await listSpeechVoices({
    provider,
    cfg,
    config,
  });
}

async function runTtsStateMutation(params: {
  capability: "tts.enable" | "tts.disable" | "tts.set-provider";
  transport: CapabilityTransport;
  provider?: string;
}) {
  if (params.transport === "gateway") {
    const method =
      params.capability === "tts.enable"
        ? "tts.enable"
        : params.capability === "tts.disable"
          ? "tts.disable"
          : "tts.setProvider";
    const payload = await callGateway({
      method,
      params: params.provider ? { provider: params.provider } : undefined,
      timeoutMs: 30_000,
    });
    return payload;
  }

  const cfg = loadConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  if (params.capability === "tts.enable") {
    setTtsEnabled(prefsPath, true);
    return { enabled: true };
  }
  if (params.capability === "tts.disable") {
    setTtsEnabled(prefsPath, false);
    return { enabled: false };
  }
  if (!params.provider) {
    throw new Error("--provider is required");
  }
  const provider = canonicalizeSpeechProviderId(params.provider, cfg);
  if (!provider) {
    throw new Error(`Unknown speech provider: ${params.provider}`);
  }
  setTtsProvider(prefsPath, provider);
  return { provider };
}

async function runWebSearchCommand(params: { query: string; provider?: string; limit?: number }) {
  const cfg = loadConfig();
  const result = await runWebSearch({
    config: cfg,
    providerId: params.provider,
    args: {
      query: params.query,
      count: params.limit,
      limit: params.limit,
    },
  });
  return {
    ok: true,
    capability: "web.search",
    transport: "local" as const,
    provider: result.provider,
    attempts: [],
    outputs: [{ result: result.result }],
  } satisfies CapabilityEnvelope;
}

async function runWebFetchCommand(params: { url: string; provider?: string; format?: string }) {
  const cfg = loadConfig();
  const resolved = resolveWebFetchDefinition({
    config: cfg,
    providerId: params.provider,
  });
  if (!resolved) {
    throw new Error("web.fetch is disabled or no provider is available.");
  }
  const result = await resolved.definition.execute({
    url: params.url,
    format: params.format,
  });
  return {
    ok: true,
    capability: "web.fetch",
    transport: "local" as const,
    provider: resolved.provider.id,
    attempts: [],
    outputs: [{ result }],
  } satisfies CapabilityEnvelope;
}

async function runMemoryEmbeddingCreate(params: {
  texts: string[];
  provider?: string;
  model?: string;
}) {
  ensureMemoryEmbeddingProvidersRegistered();
  const cfg = loadConfig();
  const modelRef = resolveModelRefOverride(params.model);
  const requestedProvider = normalizeOptionalString(params.provider) || modelRef.provider || "auto";
  const result = await createEmbeddingProvider({
    config: cfg,
    agentDir: resolveAgentDir(cfg, resolveDefaultAgentId(cfg)),
    provider: requestedProvider,
    fallback: "none",
    model: modelRef.model ?? "",
  });
  if (!result.provider) {
    throw new Error(result.providerUnavailableReason ?? "No embedding provider available.");
  }
  const embeddings = await result.provider.embedBatch(params.texts);
  return {
    ok: true,
    capability: "embedding.create",
    transport: "local" as const,
    provider: result.provider.id,
    model: result.provider.model,
    attempts: result.fallbackFrom
      ? [{ provider: result.fallbackFrom, outcome: "failed", error: result.fallbackReason }]
      : [],
    outputs: embeddings.map((embedding, index) => ({
      text: params.texts[index],
      embedding,
      dimensions: embedding.length,
    })),
  } satisfies CapabilityEnvelope;
}

function ensureMemoryEmbeddingProvidersRegistered(): void {
  if (listMemoryEmbeddingProviders().length > 0) {
    return;
  }
  registerBuiltInMemoryEmbeddingProviders({
    registerMemoryEmbeddingProvider,
  });
}

function registerCapabilityListAndInspect(capability: Command) {
  capability
    .command("list")
    .description("List canonical capability ids and supported transports")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = CAPABILITY_METADATA.map((entry) => ({
          id: entry.id,
          transports: entry.transports,
          description: entry.description,
        }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  capability
    .command("inspect")
    .description("Inspect one canonical capability id")
    .requiredOption("--name <capability>", "Capability id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const entry = findCapabilityMetadata(String(opts.name));
        if (!entry) {
          throw new Error(`Unknown capability: ${String(opts.name)}`);
        }
        emitJsonOrText(defaultRuntime, Boolean(opts.json), entry, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });
}

export function registerCapabilityCli(program: Command) {
  const capability = program
    .command("infer")
    .alias("capability")
    .description("Run provider-backed inference commands through a stable CLI surface")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/infer", "docs.openclaw.ai/cli/infer")}\n`,
    );

  registerCapabilityListAndInspect(capability);

  const model = capability
    .command("model")
    .description("Text inference and model catalog commands");

  model
    .command("run")
    .description("Run a one-shot model turn")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <provider/model>", "Model override")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const result = await runModelRun({
          prompt: String(opts.prompt),
          model: opts.model as string | undefined,
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  model
    .command("list")
    .description("List known models")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await loadModelCatalog({ config: loadConfig() });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  model
    .command("inspect")
    .description("Inspect one model catalog entry")
    .requiredOption("--model <provider/model>", "Model id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const target = normalizeStringifiedOptionalString(opts.model) ?? "";
        const catalog = await loadModelCatalog({ config: loadConfig() });
        const entry =
          catalog.find((candidate) => `${candidate.provider}/${candidate.id}` === target) ??
          catalog.find((candidate) => candidate.id === target);
        if (!entry) {
          throw new Error(`Model not found: ${target}`);
        }
        emitJsonOrText(defaultRuntime, Boolean(opts.json), entry, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  model
    .command("providers")
    .description("List model providers from the catalog")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await buildModelProviders();
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  const modelAuth = model.command("auth").description("Provider auth helpers");

  modelAuth
    .command("login")
    .description("Run provider auth login")
    .requiredOption("--provider <id>", "Provider id")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await modelsAuthLoginCommand({ provider: String(opts.provider) }, defaultRuntime);
      });
    });

  modelAuth
    .command("logout")
    .description("Remove saved auth profiles for one provider")
    .requiredOption("--provider <id>", "Provider id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runModelAuthLogout(String(opts.provider));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  modelAuth
    .command("status")
    .description("Show configured auth state")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runModelAuthStatus();
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  const image = capability.command("image").description("Image generation and description");

  image
    .command("generate")
    .description("Generate images")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <provider/model>", "Model override")
    .option("--count <n>", "Number of images")
    .option("--size <size>", "Size hint like 1024x1024")
    .option("--aspect-ratio <ratio>", "Aspect ratio hint like 16:9")
    .option("--resolution <value>", "Resolution hint: 1K, 2K, or 4K")
    .option("--output <path>", "Output path")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runImageGenerate({
          capability: "image.generate",
          prompt: String(opts.prompt),
          model: opts.model as string | undefined,
          count: opts.count ? Number.parseInt(String(opts.count), 10) : undefined,
          size: opts.size as string | undefined,
          aspectRatio: opts.aspectRatio as string | undefined,
          resolution: opts.resolution as "1K" | "2K" | "4K" | undefined,
          output: opts.output as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  image
    .command("edit")
    .description("Edit images with one or more input files")
    .requiredOption("--file <path>", "Input file", collectOption, [])
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <provider/model>", "Model override")
    .option("--output <path>", "Output path")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const files = Array.isArray(opts.file) ? (opts.file as string[]) : [String(opts.file)];
        const result = await runImageGenerate({
          capability: "image.edit",
          prompt: String(opts.prompt),
          model: opts.model as string | undefined,
          file: files,
          output: opts.output as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  image
    .command("describe")
    .description("Describe one image file")
    .requiredOption("--file <path>", "Image file")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runImageDescribe({
          capability: "image.describe",
          files: [String(opts.file)],
          model: opts.model as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  image
    .command("describe-many")
    .description("Describe multiple image files")
    .requiredOption("--file <path>", "Image file", collectOption, [])
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runImageDescribe({
          capability: "image.describe-many",
          files: opts.file as string[],
          model: opts.model as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  image
    .command("providers")
    .description("List image generation providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const selectedProvider = resolveSelectedProviderFromModelRef(
          resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageGenerationModel),
        );
        const result = listRuntimeImageGenerationProviders({ config: cfg }).map((provider) => ({
          available: true,
          configured:
            selectedProvider === provider.id ||
            providerHasGenericConfig({ cfg, providerId: provider.id }),
          selected: selectedProvider === provider.id,
          id: provider.id,
          label: provider.label,
          defaultModel: provider.defaultModel,
          models: provider.models ?? [],
          capabilities: provider.capabilities,
        }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  const audio = capability.command("audio").description("Audio transcription");

  audio
    .command("transcribe")
    .description("Transcribe one audio file")
    .requiredOption("--file <path>", "Audio file")
    .option("--language <code>", "Language hint")
    .option("--prompt <text>", "Prompt hint")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runAudioTranscribe({
          file: String(opts.file),
          language: opts.language as string | undefined,
          model: opts.model as string | undefined,
          prompt: opts.prompt as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  audio
    .command("providers")
    .description("List audio transcription providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const providers = [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
          .filter((provider) => provider.capabilities?.includes("audio"))
          .map((provider) => ({
            available: true,
            configured: providerHasGenericConfig({ cfg, providerId: provider.id }),
            selected: false,
            id: provider.id,
            capabilities: provider.capabilities,
            defaultModels: provider.defaultModels,
          }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), providers, providerSummaryText);
      });
    });

  const tts = capability.command("tts").description("Text to speech");

  tts
    .command("convert")
    .description("Convert text to speech")
    .requiredOption("--text <text>", "Input text")
    .option("--channel <id>", "Channel hint")
    .option("--voice <id>", "Voice hint")
    .option("--model <provider/model>", "Model override")
    .option("--output <path>", "Output path")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const modelRef = resolveModelRefOverride(opts.model as string | undefined);
        if (opts.model && !modelRef.provider) {
          throw new Error("TTS model overrides must use the form <provider/model>.");
        }
        const result = await runTtsConvert({
          text: String(opts.text),
          channel: opts.channel as string | undefined,
          provider: modelRef.provider,
          modelId: modelRef.provider ? modelRef.model : undefined,
          voiceId: opts.voice as string | undefined,
          output: opts.output as string | undefined,
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  tts
    .command("voices")
    .description("List voices for a TTS provider")
    .option("--provider <id>", "Speech provider id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const voices = await runTtsVoices(opts.provider as string | undefined);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), voices, providerSummaryText);
      });
    });

  tts
    .command("providers")
    .description("List speech providers")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const result = await runTtsProviders(transport);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  tts
    .command("status")
    .description("Show TTS status")
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          gateway: Boolean(opts.gateway),
          supported: ["gateway"],
          defaultTransport: "gateway",
        });
        const result = await callGateway({
          method: "tts.status",
          timeoutMs: 30_000,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), { transport, ...result }, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  for (const [commandName, capabilityId] of [
    ["enable", "tts.enable"],
    ["disable", "tts.disable"],
  ] as const) {
    tts
      .command(commandName)
      .description(`${commandName === "enable" ? "Enable" : "Disable"} TTS`)
      .option("--local", "Force local execution", false)
      .option("--gateway", "Force gateway execution", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        await runCommandWithRuntime(defaultRuntime, async () => {
          const transport = resolveTransport({
            local: Boolean(opts.local),
            gateway: Boolean(opts.gateway),
            supported: ["local", "gateway"],
            defaultTransport: "gateway",
          });
          const result = await runTtsStateMutation({
            capability: capabilityId,
            transport,
          });
          emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
            JSON.stringify(value, null, 2),
          );
        });
      });
  }

  tts
    .command("set-provider")
    .description("Set the active TTS provider")
    .requiredOption("--provider <id>", "Speech provider id")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "gateway",
        });
        const result = await runTtsStateMutation({
          capability: "tts.set-provider",
          provider: String(opts.provider),
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  const video = capability.command("video").description("Video generation and description");

  video
    .command("generate")
    .description("Generate video")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <provider/model>", "Model override")
    .option("--output <path>", "Output path")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runVideoGenerate({
          prompt: String(opts.prompt),
          model: opts.model as string | undefined,
          output: opts.output as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  video
    .command("describe")
    .description("Describe one video file")
    .requiredOption("--file <path>", "Video file")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runVideoDescribe({
          file: String(opts.file),
          model: opts.model as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  video
    .command("providers")
    .description("List video generation and description providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const selectedGenerationProvider = resolveSelectedProviderFromModelRef(
          resolveAgentModelPrimaryValue(cfg.agents?.defaults?.videoGenerationModel),
        );
        const result = {
          generation: listRuntimeVideoGenerationProviders({ config: cfg }).map((provider) => ({
            available: true,
            configured:
              selectedGenerationProvider === provider.id ||
              providerHasGenericConfig({ cfg, providerId: provider.id }),
            selected: selectedGenerationProvider === provider.id,
            id: provider.id,
            label: provider.label,
            defaultModel: provider.defaultModel,
            models: provider.models ?? [],
            capabilities: provider.capabilities,
          })),
          description: [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
            .filter((provider) => provider.capabilities?.includes("video"))
            .map((provider) => ({
              available: true,
              configured: providerHasGenericConfig({ cfg, providerId: provider.id }),
              selected: false,
              id: provider.id,
              capabilities: provider.capabilities,
              defaultModels: provider.defaultModels,
            })),
        };
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  const web = capability.command("web").description("Web capabilities");

  web
    .command("search")
    .description("Run web search")
    .requiredOption("--query <text>", "Search query")
    .option("--provider <id>", "Provider id")
    .option("--limit <n>", "Result limit")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runWebSearchCommand({
          query: String(opts.query),
          provider: opts.provider as string | undefined,
          limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  web
    .command("fetch")
    .description("Fetch one URL")
    .requiredOption("--url <url>", "URL")
    .option("--provider <id>", "Provider id")
    .option("--format <format>", "Format hint")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runWebFetchCommand({
          url: String(opts.url),
          provider: opts.provider as string | undefined,
          format: opts.format as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  web
    .command("providers")
    .description("List web providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const selectedSearchProvider =
          typeof cfg.tools?.web?.search?.provider === "string"
            ? normalizeLowercaseStringOrEmpty(cfg.tools.web.search.provider)
            : "";
        const selectedFetchProvider =
          typeof cfg.tools?.web?.fetch?.provider === "string"
            ? normalizeLowercaseStringOrEmpty(cfg.tools.web.fetch.provider)
            : "";
        const result = {
          search: listWebSearchProviders({ config: cfg }).map((provider) => ({
            available: true,
            configured: isWebSearchProviderConfigured({ provider, config: cfg }),
            selected: provider.id === selectedSearchProvider,
            id: provider.id,
            envVars: provider.envVars,
          })),
          fetch: listWebFetchProviders({ config: cfg }).map((provider) => ({
            available: true,
            configured: isWebFetchProviderConfigured({ provider, config: cfg }),
            selected: provider.id === selectedFetchProvider,
            id: provider.id,
            envVars: provider.envVars,
          })),
        };
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  const embedding = capability.command("embedding").description("Embedding providers");

  embedding
    .command("create")
    .description("Create embeddings")
    .requiredOption("--text <text>", "Input text", collectOption, [])
    .option("--provider <id>", "Provider id")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runMemoryEmbeddingCreate({
          texts: opts.text as string[],
          provider: opts.provider as string | undefined,
          model: opts.model as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  embedding
    .command("providers")
    .description("List embedding providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        ensureMemoryEmbeddingProvidersRegistered();
        const cfg = loadConfig();
        const agentId = resolveDefaultAgentId(cfg);
        const resolvedMemory = resolveMemorySearchConfig(cfg, agentId);
        const selectedProvider =
          resolvedMemory?.provider && resolvedMemory.provider !== "auto"
            ? resolvedMemory.provider
            : undefined;
        const autoSelectedProvider =
          resolvedMemory?.provider === "auto"
            ? (
                await createEmbeddingProvider({
                  config: cfg,
                  agentDir: resolveAgentDir(cfg, agentId),
                  provider: "auto",
                  fallback: "none",
                  model: resolvedMemory.model,
                  local: resolvedMemory.local,
                  remote: resolvedMemory.remote,
                  outputDimensionality: resolvedMemory.outputDimensionality,
                }).catch(() => ({ provider: null }))
              )?.provider?.id
            : undefined;
        const result = listMemoryEmbeddingProviders().map((provider) => ({
          available: true,
          configured:
            provider.id === selectedProvider ||
            provider.id === autoSelectedProvider ||
            providerHasGenericConfig({
              cfg,
              providerId: provider.id,
            }),
          selected: provider.id === selectedProvider || provider.id === autoSelectedProvider,
          id: provider.id,
          defaultModel: provider.defaultModel,
          transport: provider.transport,
          autoSelectPriority: provider.autoSelectPriority,
        }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });
}
