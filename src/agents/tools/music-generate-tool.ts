/** Runs music generation, persistence, and detached completion. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseMusicGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import { saveMediaBuffer } from "../../media/store.js";
import { resolveMusicGenerationModeCapabilities } from "../../music-generation/capabilities.js";
import {
  generateMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import type {
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  formatGeneratedAttachmentLines,
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { ToolInputError, readNumberParam, readToolStringParam } from "./common.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import {
  createDefaultMediaGenerateBackgroundScheduler,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
} from "./media-generate-background-shared.js";
import {
  musicGenerationTaskLifecycle,
  runMediaGenerationTask,
  type MusicGenerationTaskHandle,
} from "./media-generate-background.js";
import {
  applyAgentDefaultModelConfig,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  createCapabilityProviderRuntimeDeps,
  hasExplicitMediaModel,
  hasGenerationToolAvailability,
  loadMediaToolReferences,
  normalizeMediaReferenceInputs,
  readBooleanToolParam,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import type { ToolModelConfig } from "./model-config.helpers.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateListActionResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";
import type { AnyAgentTool, SandboxFsBridge, ToolFsPolicy } from "./tool-runtime.helpers.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES = 10;
const GENERATED_MUSIC_MEDIA_SUBDIR = "tool-music-generation";
const SUPPORTED_OUTPUT_FORMATS = new Set<MusicGenerationOutputFormat>(["mp3", "wav"]);
const DEFAULT_MUSIC_GENERATION_TIMEOUT_MS = 300_000;
const MIN_MUSIC_GENERATION_TIMEOUT_MS = 120_000;
const GENERATED_MUSIC_PROBE_BUDGET_MS = 3000;
const GENERATED_MUSIC_PROBE_CONCURRENCY = 2;
const MAX_GENERATED_MUSIC_PROBES = 8;

const MusicGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description: '"generate" default, "status" active task, "list" providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Music prompt: style, genre, mood, purpose." })),
  lyrics: Type.Optional(
    Type.String({
      description:
        "Exact sung lyrics only when the user supplies lyrics or asks for vocal words. For song/style requests, use prompt instead.",
    }),
  ),
  instrumental: Type.Optional(
    Type.Boolean({
      description: "Instrumental-only toggle.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description: "Reference image path/URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images; max ${MAX_INPUT_IMAGES}.`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Provider/model override, e.g. google/lyria-3-pro-preview.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Integer({
      description: "Target seconds; provider may clamp.",
      minimum: 1,
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: "Output format: mp3, wav.",
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Output filename hint; basename preserved in managed media dir.",
    }),
  ),
});

function resolveMusicGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    modelConfig: params.cfg?.agents?.defaults?.mediaModels?.music,
    modelOverride: params.modelOverride,
    providers: () => listRuntimeMusicGenerationProviders({ config: params.cfg }),
  });
}

function resolveSelectedMusicGenerationProvider(params: {
  config?: OpenClawConfig;
  providers?: MusicGenerationProvider[];
  musicGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): MusicGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: params.providers ?? listRuntimeMusicGenerationProviders({ config: params.config }),
    modelConfig: params.musicGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
  });
}

function normalizeOutputFormat(raw: string | undefined): MusicGenerationOutputFormat | undefined {
  const normalized = normalizeOptionalLowercaseString(raw) as
    | MusicGenerationOutputFormat
    | undefined;
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_OUTPUT_FORMATS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError('format must be one of "mp3" or "wav"');
}

function normalizeReferenceImageInputs(args: Record<string, unknown>): string[] {
  return normalizeMediaReferenceInputs({
    args,
    singularKey: "image",
    pluralKey: "images",
    maxCount: MAX_INPUT_IMAGES,
    label: "reference images",
  });
}

function validateMusicGenerationCapabilities(params: {
  provider: MusicGenerationProvider | undefined;
  model?: string;
  inputImageCount: number;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
    provider,
    inputImageCount: params.inputImageCount,
  });
  if (params.inputImageCount > 0) {
    if (!caps) {
      throw new ToolInputError(`${provider.id} does not support reference-image edit inputs.`);
    }
    if ("enabled" in caps && !caps.enabled) {
      throw new ToolInputError(`${provider.id} does not support reference-image edit inputs.`);
    }
    const maxInputImages =
      ("maxInputImages" in caps ? caps.maxInputImages : undefined) ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
}

type MusicGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

type MusicGenerationTimeoutNormalization = {
  requested: number;
  applied: number;
  minimum: number;
};

function normalizeMusicGenerationTimeoutMs(timeoutMs: number | undefined): {
  timeoutMs?: number;
  normalization?: MusicGenerationTimeoutNormalization;
  message?: string;
} {
  if (timeoutMs === undefined) {
    return { timeoutMs: DEFAULT_MUSIC_GENERATION_TIMEOUT_MS };
  }
  if (timeoutMs >= MIN_MUSIC_GENERATION_TIMEOUT_MS) {
    return { timeoutMs };
  }

  const normalization = {
    requested: timeoutMs,
    applied: MIN_MUSIC_GENERATION_TIMEOUT_MS,
    minimum: MIN_MUSIC_GENERATION_TIMEOUT_MS,
  };
  const message = `Timeout normalized: requested ${timeoutMs}ms; used ${MIN_MUSIC_GENERATION_TIMEOUT_MS}ms.`;
  log.warn("music_generate timeoutMs is below provider minimum; using minimum", {
    requestedTimeoutMs: timeoutMs,
    appliedTimeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
    minimumTimeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
  });
  return {
    timeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
    normalization,
    message,
  };
}

const defaultScheduleMusicGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "music_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

async function loadReferenceImages(params: {
  inputs: string[];
  maxBytes: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded = await loadMediaToolReferences<MusicGenerationSourceImage>({
    inputs: params.inputs,
    toolName: "music_generate",
    expectedKind: "image",
    sandbox: params.sandboxConfig,
    workspaceDir: params.workspaceDir,
    maxBytes: params.maxBytes,
    ssrfPolicy: params.ssrfPolicy,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    mapMedia: (media) => ({
      buffer: media.buffer,
      mimeType: "mimeType" in media ? media.mimeType : media.contentType,
      fileName: "fileName" in media ? media.fileName : undefined,
    }),
  });
  return loaded.map(({ source, resolvedInput, rewrittenFrom }) =>
    Object.assign({ sourceImage: source, resolvedInput }, rewrittenFrom ? { rewrittenFrom } : {}),
  );
}

type LoadedReferenceImage = Awaited<ReturnType<typeof loadReferenceImages>>[number];

type ExecutedMusicGeneration = {
  provider: string;
  model: string;
  count: number;
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

async function executeMusicGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  filename?: string;
  loadedReferenceImages: LoadedReferenceImage[];
  taskHandle?: MusicGenerationTaskHandle | null;
  autoProviderFallback?: boolean;
  timeoutMs?: number;
  timeoutNormalization?: MusicGenerationTimeoutNormalization;
  providers?: MusicGenerationProvider[];
}): Promise<ExecutedMusicGeneration> {
  if (params.taskHandle) {
    musicGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating music",
    });
  }
  const result = await generateMusic(
    {
      cfg: params.effectiveCfg,
      prompt: params.prompt,
      agentDir: params.agentDir,
      modelOverride: params.model,
      lyrics: params.lyrics,
      instrumental: params.instrumental,
      durationSeconds: params.durationSeconds,
      format: params.format,
      inputImages: params.loadedReferenceImages.map((entry) => entry.sourceImage),
      autoProviderFallback: params.autoProviderFallback,
      timeoutMs: params.timeoutMs,
    },
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  if (params.taskHandle) {
    musicGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated music",
    });
  }
  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "audio");
  const savedTracks = await persistGeneratedMediaBatch({
    subdir: GENERATED_MUSIC_MEDIA_SUBDIR,
    mode: "concurrent",
    saves: result.tracks.map((track) => async () => {
      const savedMedia = await saveMediaBuffer(
        track.buffer,
        track.mimeType,
        GENERATED_MUSIC_MEDIA_SUBDIR,
        mediaMaxBytes,
        params.filename || track.fileName,
      );
      return { value: savedMedia, savedMedia };
    }),
  });
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const runtimeNormalizedDurationSeconds =
    result.normalization?.durationSeconds?.applied ??
    (typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : undefined);
  const appliedDurationSeconds =
    runtimeNormalizedDurationSeconds ??
    (!ignoredOverrideKeys.has("durationSeconds") && typeof params.durationSeconds === "number"
      ? params.durationSeconds
      : undefined);
  const displayProvider = sanitizeGeneratedMediaDisplayText(result.provider);
  const displayModel = sanitizeGeneratedMediaDisplayText(result.model);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides
          .map(
            (entry) =>
              `${sanitizeGeneratedMediaDisplayText(entry.key)}=${sanitizeGeneratedMediaDisplayText(String(entry.value))}`,
          )
          .join(", ")}.`
      : undefined;
  const savedTrackMetadata = await probeMediaFilesWithinBudget(
    savedTracks.map((track) => ({ filePath: track.path, kind: "audio" })),
    {
      budgetMs: GENERATED_MUSIC_PROBE_BUDGET_MS,
      concurrency: GENERATED_MUSIC_PROBE_CONCURRENCY,
      maxProbes: MAX_GENERATED_MUSIC_PROBES,
    },
  );
  const attachments: AgentGeneratedAttachment[] = savedTracks.map((track, index) => ({
    type: "audio",
    path: track.path,
    mimeType: track.contentType,
    name: result.tracks[index]?.fileName,
    sizeBytes: track.size,
    ...(typeof appliedDurationSeconds === "number"
      ? { durationMs: appliedDurationSeconds * 1000 }
      : {}),
    ...savedTrackMetadata[index],
  }));
  const lines = [
    `Generated ${savedTracks.length} track${savedTracks.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    ...(params.timeoutNormalization
      ? [
          `Timeout normalized: requested ${params.timeoutNormalization.requested}ms; used ${params.timeoutNormalization.applied}ms.`,
        ]
      : []),
    typeof requestedDurationSeconds === "number" &&
    typeof appliedDurationSeconds === "number" &&
    requestedDurationSeconds !== appliedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${appliedDurationSeconds}s.`
      : null,
    ...(result.lyrics?.length
      ? [
          "Lyrics returned.",
          ...result.lyrics.flatMap((lyric) =>
            lyric
              .replace(/\r\n?|[\u2028\u2029]/gu, "\n")
              .split("\n")
              .map((line) =>
                sanitizeGeneratedMediaDisplayText(line)
                  .replace(/^(\s*)(media):/iu, "$1$2：")
                  // An open provider fence would swallow the trusted attachment lines appended below.
                  .replace(/^( {0,3})(`{3,}|~{3,})/u, "$1\\$2"),
              ),
          ),
        ]
      : []),
    ...formatGeneratedAttachmentLines(attachments),
  ].filter((entry): entry is string => Boolean(entry));
  return {
    provider: result.provider,
    model: result.model,
    count: savedTracks.length,
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedTracks.length,
      media: {
        mediaUrls: savedTracks.map((track) => track.path),
        attachments,
      },
      attachments,
      paths: savedTracks.map((track) => track.path),
      ...buildTaskRunDetails(params.taskHandle),
      ...(!ignoredOverrideKeys.has("lyrics") && params.lyrics
        ? { requestedLyrics: params.lyrics }
        : {}),
      ...(!ignoredOverrideKeys.has("instrumental") && typeof params.instrumental === "boolean"
        ? { instrumental: params.instrumental }
        : {}),
      ...(typeof appliedDurationSeconds === "number"
        ? { durationSeconds: appliedDurationSeconds }
        : {}),
      ...(typeof requestedDurationSeconds === "number" &&
      typeof appliedDurationSeconds === "number" &&
      requestedDurationSeconds !== appliedDurationSeconds
        ? { requestedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("format") && params.format ? { format: params.format } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.timeoutNormalization
        ? {
            requestedTimeoutMs: params.timeoutNormalization.requested,
            timeoutNormalization: params.timeoutNormalization,
          }
        : {}),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedInput,
      }),
      ...(result.lyrics?.length ? { lyrics: result.lyrics } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
  };
}

export function createMusicGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MusicGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? getRuntimeConfig();
  const preparedProviders = options?.preparedModelRuntime?.mediaCapabilityProviders
    ?.musicGenerationProviders
    ? [...options.preparedModelRuntime.mediaCapabilityProviders.musicGenerationProviders]
    : undefined;
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.mediaModels?.music,
      providerKey: "musicGenerationProviders",
      providers: preparedProviders,
    })
  ) {
    return null;
  }

  const sandboxConfig = options?.sandbox
    ? {
        root: options.sandbox.root,
        bridge: options.sandbox.bridge,
        workspaceOnly: options.fsPolicy?.workspaceOnly === true,
      }
    : null;
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleMusicGenerateBackgroundWork;

  return {
    label: "Music Generation",
    name: "music_generate",
    displaySummary: "Generate music",
    description:
      "Create song/jingle/beat/loop/soundtrack/anthem/instrumental. Make/generate music => call; lyrics-only request => text only. prompt: style/genre/mood/tempo/instruments/purpose; lyrics: exact sung words; image/images condition on reference image(s). action=list discovers providers/models. Session chat background: call once/request, await, then visible reply + structured media. status checks active task.",
    parameters: MusicGenerateToolSchema,
    execute: async (_toolCallId, rawArgs, signal) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveGenerateAction(args);

      if (action === "list") {
        return createMusicGenerateListActionResult(cfg, {
          workspaceDir: options?.workspaceDir,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      if (action === "status") {
        return createMusicGenerateStatusActionResult(
          options?.agentSessionKey,
          options?.requesterAgentId,
        );
      }

      const model = readToolStringParam(args, "model");
      const musicGenerationModelConfig = resolveMusicGenerationModelConfigForTool({
        cfg,
        workspaceDir: options?.workspaceDir,
        agentDir: options?.agentDir,
        authStore: options?.authProfileStore,
        modelOverride: model,
      });
      if (!musicGenerationModelConfig) {
        throw new ToolInputError("No music-generation model configured.");
      }
      const explicitModelConfig = hasExplicitMediaModel(cfg.agents?.defaults?.mediaModels?.music);
      const effectiveCfg =
        applyAgentDefaultModelConfig(cfg, "music", musicGenerationModelConfig) ?? cfg;
      const prompt = readToolStringParam(args, "prompt", { required: true });

      const activeDuplicateGuardResult = createMusicGenerateDuplicateGuardResult(
        options?.agentSessionKey,
        { prompt, agentId: options?.requesterAgentId },
      );
      if (activeDuplicateGuardResult) {
        return activeDuplicateGuardResult;
      }

      const lyrics = readToolStringParam(args, "lyrics");
      const instrumental = readBooleanToolParam(args, "instrumental");
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        positiveInteger: true,
        strict: true,
      });
      if (
        durationSeconds === undefined &&
        readSnakeCaseParamRaw(args, "durationSeconds") !== undefined
      ) {
        throw new ToolInputError("durationSeconds must be a positive integer");
      }
      const format = normalizeOutputFormat(readToolStringParam(args, "format"));
      const filename = readToolStringParam(args, "filename");
      const timeout = normalizeMusicGenerationTimeoutMs(musicGenerationModelConfig.timeoutMs);
      const timeoutMs = timeout.timeoutMs;
      const imageInputs = normalizeReferenceImageInputs(args);
      const explicitModelRef = parseMusicGenerationModelRef(model);
      const primaryModelRef = parseMusicGenerationModelRef(musicGenerationModelConfig.primary);
      const selectedModelRef = explicitModelRef ?? primaryModelRef;
      const shouldResolveSelectedProvider =
        imageInputs.length > 0 ||
        (model !== undefined && !explicitModelRef) ||
        (model === undefined && !primaryModelRef);
      const selectedProvider = shouldResolveSelectedProvider
        ? resolveSelectedMusicGenerationProvider({
            config: effectiveCfg,
            providers: preparedProviders,
            musicGenerationModelConfig,
            modelOverride: model,
          })
        : undefined;
      const selectedProviderId = selectedProvider?.id ?? selectedModelRef?.provider;
      const requestKey = buildMediaGenerationRequestKey({
        tool: "music_generate",
        prompt,
        provider: selectedProviderId,
        model:
          model !== undefined
            ? (explicitModelRef?.model ?? model)
            : (primaryModelRef?.model ??
              musicGenerationModelConfig.primary ??
              selectedProvider?.defaultModel),
        lyrics,
        instrumental,
        durationSeconds,
        format,
        filename,
        imageInputs,
      });
      const duplicateGuardResult = createMusicGenerateDuplicateGuardResult(
        options?.agentSessionKey,
        { prompt, requestKey, agentId: options?.requesterAgentId },
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
      const loadedReferenceImages = await loadReferenceImages({
        inputs: imageInputs,
        maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "image"),
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
        signal,
      });
      validateMusicGenerationCapabilities({
        provider: selectedProvider,
        model: selectedModelRef?.model ?? model ?? selectedProvider?.defaultModel,
        inputImageCount: loadedReferenceImages.length,
        lyrics,
        instrumental,
        durationSeconds,
        format,
      });
      // Accepted tasks own their paid work independently; cancellation applies only before admission.
      signal?.throwIfAborted();
      return runMediaGenerationTask({
        lifecycle: musicGenerationTaskLifecycle,
        generationLabel: "music",
        sessionKey: options?.agentSessionKey,
        requesterAgentId: options?.requesterAgentId,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        requestKey,
        providerId: selectedProviderId,
        config: effectiveCfg,
        scheduleBackgroundWork,
        onAsyncTaskStarted: options?.onAsyncTaskStarted,
        onFailure: (message, meta) => log.warn(message, meta),
        messages: [timeout.message],
        detailExtras: {
          ...buildMediaReferenceDetails({
            entries: loadedReferenceImages,
            singleKey: "image",
            pluralKey: "images",
            getResolvedInput: (entry) => entry.resolvedInput,
          }),
          ...(model ? { model } : {}),
          ...(lyrics ? { requestedLyrics: lyrics } : {}),
          ...(typeof instrumental === "boolean" ? { instrumental } : {}),
          ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
          ...(format ? { format } : {}),
          ...(filename ? { filename } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(timeout.normalization
            ? {
                requestedTimeoutMs: timeout.normalization.requested,
                timeoutNormalization: timeout.normalization,
                warning: timeout.message,
              }
            : {}),
        },
        run: (taskHandle) =>
          executeMusicGenerationJob({
            effectiveCfg,
            prompt,
            agentDir: options?.agentDir,
            lyrics,
            instrumental,
            durationSeconds,
            model,
            format,
            filename,
            loadedReferenceImages,
            taskHandle,
            autoProviderFallback: explicitModelConfig ? false : undefined,
            timeoutMs,
            timeoutNormalization: timeout.normalization,
            providers: preparedProviders,
          }),
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
