import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveMusicGenerationModeCapabilities } from "../../music-generation/capabilities.js";
import { parseMusicGenerationModelRef } from "../../music-generation/model-ref.js";
import {
  generateMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import type { MusicGenerationOutputFormat } from "../../music-generation/types.js";
import type {
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  formatGeneratedAttachmentLines,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  buildMediaGenerationStartedToolResult,
  createDefaultMediaGenerateBackgroundScheduler,
  scheduleMediaGenerationTaskCompletion,
  type MediaGenerateBackgroundScheduler,
} from "./media-generate-background-shared.js";
import {
  applyMusicGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  hasGenerationToolAvailability,
  normalizeMediaReferenceInputs,
  readBooleanToolParam,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import {
  coerceToolModelConfig,
  hasToolModelConfig,
  type ToolModelConfig,
} from "./model-config.helpers.js";
import {
  completeMusicGenerationTaskRun,
  createMusicGenerationTaskRun,
  failMusicGenerationTaskRun,
  musicGenerationTaskLifecycle,
  recordMusicGenerationTaskProgress,
  type MusicGenerationTaskHandle,
} from "./music-generate-background.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateListActionResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES = 10;
const SUPPORTED_OUTPUT_FORMATS = new Set<MusicGenerationOutputFormat>(["mp3", "wav"]);
const DEFAULT_REFERENCE_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MUSIC_GENERATION_TIMEOUT_MS = 300_000;
const MIN_MUSIC_GENERATION_TIMEOUT_MS = 120_000;

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
    Type.Number({
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
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    modelConfig: params.cfg?.agents?.defaults?.musicGenerationModel,
    providers: () => listRuntimeMusicGenerationProviders({ config: params.cfg }),
  });
}

function hasExplicitMusicGenerationModelConfig(cfg?: OpenClawConfig): boolean {
  return hasToolModelConfig(coerceToolModelConfig(cfg?.agents?.defaults?.musicGenerationModel));
}

function resolveSelectedMusicGenerationProvider(params: {
  config?: OpenClawConfig;
  musicGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): MusicGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: listRuntimeMusicGenerationProviders({ config: params.config }),
    modelConfig: params.musicGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
  });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  return resolveGenerateAction({
    args,
    allowed: ["generate", "status", "list"],
    defaultAction: "generate",
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
  if (!caps) {
    return;
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
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
}): Promise<
  Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }> = [];

  for (const rawInput of params.inputs) {
    const trimmed = rawInput.trim();
    const inputRaw = normalizeMediaReferenceSource(
      trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed,
    );
    if (!inputRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const refInfo = classifyMediaReferenceSource(inputRaw);
    const { isDataUrl, isHttpUrl } = refInfo;
    if (refInfo.hasUnsupportedScheme) {
      throw new ToolInputError(
        `Unsupported image reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError("Sandboxed music_generate does not allow remote image URLs.");
    }

    const resolvedInput = params.sandboxConfig
      ? inputRaw
      : inputRaw.startsWith("~")
        ? resolveUserPath(inputRaw)
        : inputRaw;
    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedInput,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedInput.startsWith("file://")
              ? resolvedInput.slice("file://".length)
              : resolvedInput,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );
    const media = isDataUrl
      ? decodeDataUrl(resolvedInput)
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedInput, {
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await (async () => {
            const referenceTarget = resolvedPath ?? resolvedInput;
            const isRemoteReference = /^https?:\/\//i.test(referenceTarget);
            const { signal, cleanup } = buildTimeoutAbortSignal({
              timeoutMs: params.timeoutMs ?? DEFAULT_REFERENCE_FETCH_TIMEOUT_MS,
              operation: "music-generate.reference-fetch",
              ...(isRemoteReference ? { url: referenceTarget } : {}),
            });
            try {
              return await loadWebMedia(resolvedPath ?? resolvedInput, {
                localRoots,
                requestInit: signal ? { signal } : undefined,
                ssrfPolicy: params.ssrfPolicy,
              });
            } finally {
              cleanup();
            }
          })();
    if (media.kind !== "image") {
      throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
    }
    const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
    const fileName = "fileName" in media ? media.fileName : undefined;
    loaded.push({
      sourceImage: {
        buffer: media.buffer,
        mimeType,
        fileName,
      },
      resolvedInput,
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

type LoadedReferenceImage = Awaited<ReturnType<typeof loadReferenceImages>>[number];

type ExecutedMusicGeneration = {
  provider: string;
  model: string;
  savedPaths: string[];
  count: number;
  paths: string[];
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
}): Promise<ExecutedMusicGeneration> {
  if (params.taskHandle) {
    recordMusicGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating music",
    });
  }
  const result = await generateMusic({
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
  });
  if (params.taskHandle) {
    recordMusicGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated music",
    });
  }
  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "audio");
  const savedTracks = await Promise.all(
    result.tracks.map((track) =>
      saveMediaBuffer(
        track.buffer,
        track.mimeType,
        "tool-music-generation",
        mediaMaxBytes,
        params.filename || track.fileName,
      ),
    ),
  );
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
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map((entry) => `${entry.key}=${String(entry.value)}`).join(", ")}.`
      : undefined;
  const attachments: AgentGeneratedAttachment[] = savedTracks.map((track, index) => ({
    type: "audio",
    path: track.path,
    mimeType: track.contentType,
    name: result.tracks[index]?.fileName,
  }));
  const lines = [
    `Generated ${savedTracks.length} track${savedTracks.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
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
    ...(result.lyrics?.length ? ["Lyrics returned.", ...result.lyrics] : []),
    ...formatGeneratedAttachmentLines(attachments),
  ].filter((entry): entry is string => Boolean(entry));
  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedTracks.map((track) => track.path),
    count: savedTracks.length,
    paths: savedTracks.map((track) => track.path),
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
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: MusicGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? getRuntimeConfig();
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.musicGenerationModel,
      providerKey: "musicGenerationProviders",
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
      'Create audio/music for song, jingle, beat, loop, soundtrack, anthem, instrumental requests. If user asks make/generate/create song/music, call music_generate; do not just write lyrics unless lyrics/text only. Prompt gets style/genre/mood/tempo/instruments/purpose. lyrics only exact sung words. Session chats: background task; do not call again for same request; wait completion, send attachments via message tool. "status" checks active task.',
    parameters: MusicGenerateToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);

      if (action === "list") {
        return createMusicGenerateListActionResult(cfg, {
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      if (action === "status") {
        return createMusicGenerateStatusActionResult(options?.agentSessionKey);
      }

      const musicGenerationModelConfig = resolveMusicGenerationModelConfigForTool({
        cfg,
        agentDir: options?.agentDir,
        authStore: options?.authProfileStore,
      });
      if (!musicGenerationModelConfig) {
        throw new ToolInputError("No music-generation model configured.");
      }
      const explicitModelConfig = hasExplicitMusicGenerationModelConfig(cfg);
      const effectiveCfg =
        applyMusicGenerationModelConfigDefaults(cfg, musicGenerationModelConfig) ?? cfg;

      const duplicateGuardResult = createMusicGenerateDuplicateGuardResult(
        options?.agentSessionKey,
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }

      const prompt = readStringParam(args, "prompt", { required: true });
      const lyrics = readStringParam(args, "lyrics");
      const instrumental = readBooleanToolParam(args, "instrumental");
      const model = readStringParam(args, "model");
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        integer: true,
        strict: true,
      });
      const format = normalizeOutputFormat(readStringParam(args, "format"));
      const filename = readStringParam(args, "filename");
      const timeout = normalizeMusicGenerationTimeoutMs(musicGenerationModelConfig.timeoutMs);
      const timeoutMs = timeout.timeoutMs;
      const imageInputs = normalizeReferenceImageInputs(args);
      const selectedModelRef =
        parseMusicGenerationModelRef(model) ??
        parseMusicGenerationModelRef(musicGenerationModelConfig.primary);
      const selectedProvider =
        imageInputs.length > 0
          ? resolveSelectedMusicGenerationProvider({
              config: effectiveCfg,
              musicGenerationModelConfig,
              modelOverride: model,
            })
          : undefined;
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
      const loadedReferenceImages = await loadReferenceImages({
        inputs: imageInputs,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
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
      const taskHandle = createMusicGenerationTaskRun({
        sessionKey: options?.agentSessionKey,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        providerId: selectedProvider?.id ?? selectedModelRef?.provider,
      });
      const shouldDetach = Boolean(taskHandle && options?.agentSessionKey?.trim());

      if (shouldDetach) {
        scheduleMediaGenerationTaskCompletion({
          lifecycle: musicGenerationTaskLifecycle,
          handle: taskHandle,
          scheduleBackgroundWork,
          progressSummary: "Generating music",
          config: effectiveCfg,
          toolName: "Music generation",
          onWakeFailure: (message, meta) => log.warn(message, meta),
          run: () =>
            executeMusicGenerationJob({
              effectiveCfg,
              prompt,
              agentDir: options?.agentDir,
              model,
              lyrics,
              instrumental,
              durationSeconds,
              format,
              filename,
              loadedReferenceImages,
              taskHandle,
              autoProviderFallback: explicitModelConfig ? false : undefined,
              timeoutMs,
              timeoutNormalization: timeout.normalization,
            }),
        });

        return buildMediaGenerationStartedToolResult({
          toolName: "music_generate",
          generationLabel: "music",
          completionLabel: "music",
          taskHandle,
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
        });
      }

      try {
        const executed = await executeMusicGenerationJob({
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
        });
        completeMusicGenerationTaskRun({
          handle: taskHandle,
          provider: executed.provider,
          model: executed.model,
          count: executed.savedPaths.length,
          paths: executed.savedPaths,
        });
        return {
          content: [{ type: "text", text: executed.contentText }],
          details: executed.details,
        };
      } catch (error) {
        failMusicGenerationTaskRun({
          handle: taskHandle,
          error,
        });
        throw error;
      }
    },
  };
}
