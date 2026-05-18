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
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import {
  resolveVideoGenerationMode,
  resolveVideoGenerationModeCapabilities,
} from "../../video-generation/capabilities.js";
import { parseVideoGenerationModelRef } from "../../video-generation/model-ref.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationProvider,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../../video-generation/types.js";
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
  applyVideoGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  hasGenerationToolAvailability,
  normalizeMediaReferenceInputs,
  readBooleanToolParam,
  readGenerationTimeoutMs,
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
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";
import {
  completeVideoGenerationTaskRun,
  createVideoGenerationTaskRun,
  failVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  videoGenerationTaskLifecycle,
  type VideoGenerationTaskHandle,
} from "./video-generate-background.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateListActionResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_INPUT_IMAGES = 9;
const MAX_INPUT_VIDEOS = 4;
const MAX_INPUT_AUDIOS = 3;

const VideoGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description: '"generate" default, "status" active task, "list" providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Video prompt." })),
  image: Type.Optional(
    Type.String({
      description: "One reference image path/URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images; max ${MAX_INPUT_IMAGES}.`,
    }),
  ),
  imageRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`image` + `images` roles by index after de-dupe. Values: first_frame, last_frame, reference_image; empty string leaves unset.",
    }),
  ),
  video: Type.Optional(
    Type.String({
      description: "One reference video path/URL.",
    }),
  ),
  videos: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference videos; max ${MAX_INPUT_VIDEOS}.`,
    }),
  ),
  videoRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`video` + `videos` roles by index after de-dupe. Value: reference_video; empty string leaves unset.",
    }),
  ),
  audioRef: Type.Optional(
    Type.String({
      description: "One reference audio path/URL, e.g. music.",
    }),
  ),
  audioRefs: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference audios; max ${MAX_INPUT_AUDIOS}.`,
    }),
  ),
  audioRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`audioRef` + `audioRefs` roles by index after de-dupe. Value: reference_audio; empty string leaves unset.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Provider/model override, e.g. qwen/wan2.6-t2v." }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Output filename hint; basename preserved in managed media dir.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Size hint, e.g. 1280x720, 1920x1080.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        'Aspect ratio: 1:1, 16:9, 9:16, "adaptive", or provider value; unsupported normalized/ignored.',
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description:
        "Resolution: 480P, 720P, 768P, 1080P, 4K, or provider value; unsupported normalized/ignored.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      description: "Target seconds; may round to nearest supported duration.",
      minimum: 1,
    }),
  ),
  audio: Type.Optional(
    Type.Boolean({
      description: "Generated-audio toggle.",
    }),
  ),
  watermark: Type.Optional(
    Type.Boolean({
      description: "Watermark toggle.",
    }),
  ),
  providerOptions: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Provider JSON options, e.g. {"seed":42}. Keys/types must match provider capabilities; mismatch skips candidate. Use action=list for accepted keys.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Provider timeout ms.",
      minimum: 1,
    }),
  ),
});

export function resolveVideoGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    modelConfig: params.cfg?.agents?.defaults?.videoGenerationModel,
    providers: () => listRuntimeVideoGenerationProviders({ config: params.cfg }),
  });
}

function hasExplicitVideoGenerationModelConfig(cfg?: OpenClawConfig): boolean {
  return hasToolModelConfig(coerceToolModelConfig(cfg?.agents?.defaults?.videoGenerationModel));
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  return resolveGenerateAction({
    args,
    allowed: ["generate", "status", "list"],
    defaultAction: "generate",
  });
}

function normalizeResolution(raw: string | undefined): VideoGenerationResolution | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  const uppercase = normalized.toUpperCase();
  if (/^\d+P$/.test(uppercase) || /^\d+K$/.test(uppercase)) {
    return uppercase;
  }
  return normalized;
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

/**
 * Parse a `*Roles` parallel string array for `video_generate`. Throws when
 * the caller supplies more roles than assets so off-by-one alignment bugs
 * fail loudly at the tool boundary instead of silently dropping the
 * trailing roles. Empty strings in the array are allowed and mean "no
 * role at this position". Non-string entries are coerced to empty strings
 * and treated as "unset" so providers can leave individual slots empty.
 */
function parseRoleArray(params: {
  raw: unknown;
  kind: "imageRoles" | "videoRoles" | "audioRoles";
  assetCount: number;
}): string[] {
  if (params.raw === undefined || params.raw === null) {
    return [];
  }
  if (!Array.isArray(params.raw)) {
    throw new ToolInputError(
      `${params.kind} must be a JSON array of role strings, parallel to the reference list.`,
    );
  }
  const roles = params.raw.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (roles.length > params.assetCount) {
    throw new ToolInputError(
      `${params.kind} has ${roles.length} entries but only ${params.assetCount} reference ${params.kind === "imageRoles" ? "image" : params.kind === "videoRoles" ? "video" : "audio"}${params.assetCount === 1 ? "" : "s"} were provided; extra roles cannot be aligned positionally.`,
    );
  }
  return roles;
}

function normalizeReferenceInputs(params: {
  args: Record<string, unknown>;
  singularKey: "image" | "video" | "audioRef";
  pluralKey: "images" | "videos" | "audioRefs";
  maxCount: number;
}): string[] {
  return normalizeMediaReferenceInputs({
    args: params.args,
    singularKey: params.singularKey,
    pluralKey: params.pluralKey,
    maxCount: params.maxCount,
    label: `reference ${params.pluralKey}`,
  });
}

function resolveSelectedVideoGenerationProvider(params: {
  config?: OpenClawConfig;
  videoGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): VideoGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: listRuntimeVideoGenerationProviders({ config: params.config }),
    modelConfig: params.videoGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
  });
}

function validateVideoGenerationCapabilities(params: {
  provider: VideoGenerationProvider | undefined;
  model?: string;
  inputImageCount: number;
  inputVideoCount: number;
  inputAudioCount: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const mode = resolveVideoGenerationMode({
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    provider,
    model: params.model,
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  if (!caps && mode === "imageToVideo" && params.inputVideoCount === 0) {
    throw new ToolInputError(`${provider.id} does not support image-to-video reference inputs.`);
  }
  if (!caps && mode === "videoToVideo" && params.inputImageCount === 0) {
    throw new ToolInputError(`${provider.id} does not support video-to-video reference inputs.`);
  }
  if (!caps) {
    return;
  }
  if (
    mode === "imageToVideo" &&
    "enabled" in caps &&
    !caps.enabled &&
    params.inputVideoCount === 0
  ) {
    throw new ToolInputError(`${provider.id} does not support image-to-video reference inputs.`);
  }
  if (
    mode === "videoToVideo" &&
    "enabled" in caps &&
    !caps.enabled &&
    params.inputImageCount === 0
  ) {
    throw new ToolInputError(`${provider.id} does not support video-to-video reference inputs.`);
  }
  if (params.inputImageCount > 0) {
    const maxInputImages = caps.maxInputImages ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
  if (params.inputVideoCount > 0) {
    const maxInputVideos = caps.maxInputVideos ?? MAX_INPUT_VIDEOS;
    if (params.inputVideoCount > maxInputVideos) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputVideos} reference video${maxInputVideos === 1 ? "" : "s"}.`,
      );
    }
  }
  // Audio-count validation is intentionally deferred to runtime.ts (generateVideo).
  // The runtime guard skips per-candidate providers that lack audio support, allowing
  // fallback candidates that do support audio to run. A ToolInputError here would fire
  // against only the primary provider and prevent valid fallback-based audio requests.
  // maxDurationSeconds validation is intentionally deferred to runtime.ts (generateVideo).
  // The runtime guard skips per-candidate providers whose hard cap is below the requested
  // duration, allowing a fallback with a higher cap to run — same rationale as the audio
  // check above. When providers declare an explicit supportedDurationSeconds list, runtime
  // normalization snaps to the nearest valid value instead of skipping.
}

function formatIgnoredVideoGenerationOverride(override: VideoGenerationIgnoredOverride): string {
  return `${override.key}=${String(override.value)}`;
}

type VideoGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

const defaultScheduleVideoGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "video_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

async function loadReferenceAssets(params: {
  inputs: string[];
  expectedKind: "image" | "video" | "audio";
  maxBytes?: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
  ssrfPolicy?: SsrFPolicy;
}): Promise<
  Array<{
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }> = [];

  for (const rawInput of params.inputs) {
    const trimmed = rawInput.trim();
    const inputRaw = normalizeMediaReferenceSource(
      trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed,
    );
    if (!inputRaw) {
      throw new ToolInputError(`${params.expectedKind} required (empty string in array)`);
    }
    const refInfo = classifyMediaReferenceSource(inputRaw);
    const { isDataUrl, isHttpUrl } = refInfo;
    if (refInfo.hasUnsupportedScheme) {
      throw new ToolInputError(
        `Unsupported ${params.expectedKind} reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError(
        `Sandboxed video_generate does not allow remote ${params.expectedKind} URLs.`,
      );
    }

    const resolvedInput = (() => {
      if (params.sandboxConfig) {
        return inputRaw;
      }
      if (inputRaw.startsWith("~")) {
        return resolveUserPath(inputRaw);
      }
      return inputRaw;
    })();

    if (isHttpUrl && !params.sandboxConfig) {
      loaded.push({
        sourceAsset: { url: resolvedInput },
        resolvedInput,
      });
      continue;
    }

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
      ? params.expectedKind === "image"
        ? decodeDataUrl(resolvedInput)
        : (() => {
            throw new ToolInputError(
              `${params.expectedKind} data: URLs are not supported for video_generate.`,
            );
          })()
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedInput, {
            maxBytes: params.maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await loadWebMedia(resolvedPath ?? resolvedInput, {
            maxBytes: params.maxBytes,
            localRoots,
            ssrfPolicy: params.ssrfPolicy,
          });
    if (media.kind !== params.expectedKind) {
      throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
    }
    const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
    const fileName = "fileName" in media ? media.fileName : undefined;
    loaded.push({
      sourceAsset: {
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

type LoadedReferenceAsset = Awaited<ReturnType<typeof loadReferenceAssets>>[number];

type ExecutedVideoGeneration = {
  provider: string;
  model: string;
  savedPaths: string[];
  /** URLs of url-only assets that were not saved locally. */
  urlOnlyUrls: string[];
  /** Total generated video count, including url-only assets. */
  count: number;
  paths: string[];
  mediaUrls: string[];
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

function isGeneratedMediaSizeLimitError(error: unknown): boolean {
  return error instanceof Error && /^Media exceeds \d+MB limit$/.test(error.message);
}

async function executeVideoGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  filename?: string;
  loadedReferenceImages: LoadedReferenceAsset[];
  loadedReferenceVideos: LoadedReferenceAsset[];
  loadedReferenceAudios: LoadedReferenceAsset[];
  taskHandle?: VideoGenerationTaskHandle | null;
  providerOptions?: Record<string, unknown>;
  autoProviderFallback?: boolean;
  timeoutMs?: number;
}): Promise<ExecutedVideoGeneration> {
  if (params.taskHandle) {
    recordVideoGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating video",
    });
  }
  const result = await generateVideo({
    cfg: params.effectiveCfg,
    prompt: params.prompt,
    agentDir: params.agentDir,
    modelOverride: params.model,
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    durationSeconds: params.durationSeconds,
    audio: params.audio,
    watermark: params.watermark,
    inputImages: params.loadedReferenceImages.map((entry) => entry.sourceAsset),
    inputVideos: params.loadedReferenceVideos.map((entry) => entry.sourceAsset),
    inputAudios: params.loadedReferenceAudios.map((entry) => entry.sourceAsset),
    autoProviderFallback: params.autoProviderFallback,
    providerOptions: params.providerOptions,
    timeoutMs: params.timeoutMs,
  });
  if (params.taskHandle) {
    recordVideoGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated video",
    });
  }

  const urlOnlyVideos: Array<{ url: string; mimeType: string; fileName?: string }> = [];
  const bufferVideos: Array<(typeof result.videos)[number] & { buffer: Buffer }> = [];
  for (const video of result.videos) {
    if (video.buffer) {
      bufferVideos.push(video as (typeof result.videos)[number] & { buffer: Buffer });
      continue;
    }
    if (video.url) {
      urlOnlyVideos.push({
        url: video.url,
        mimeType: video.mimeType,
        fileName: video.fileName,
      });
      continue;
    }
    throw new Error(
      `Provider ${result.provider} returned a video asset with neither buffer nor url — cannot deliver.`,
    );
  }

  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "video");
  const savedVideos: Array<Awaited<ReturnType<typeof saveMediaBuffer>>> = [];
  for (const video of bufferVideos) {
    try {
      const saved = await saveMediaBuffer(
        video.buffer,
        video.mimeType,
        "tool-video-generation",
        mediaMaxBytes,
        params.filename || video.fileName,
      );
      savedVideos.push(saved);
    } catch (error) {
      if (video.url && isGeneratedMediaSizeLimitError(error)) {
        urlOnlyVideos.push({
          url: video.url,
          mimeType: video.mimeType,
          fileName: video.fileName,
        });
        continue;
      }
      throw error;
    }
  }
  const totalCount = savedVideos.length + urlOnlyVideos.length;
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(", ")}.`
      : undefined;
  const normalizedDurationSeconds =
    result.normalization?.durationSeconds?.applied ??
    (typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : requestedDurationSeconds);
  const supportedDurationSeconds =
    result.normalization?.durationSeconds?.supportedValues ??
    (Array.isArray(result.metadata?.supportedDurationSeconds)
      ? result.metadata.supportedDurationSeconds.filter(
          (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
        )
      : undefined);
  const normalizedSize =
    result.normalization?.size?.applied ??
    (typeof result.metadata?.normalizedSize === "string" && result.metadata.normalizedSize.trim()
      ? result.metadata.normalizedSize
      : undefined);
  const normalizedAspectRatio =
    result.normalization?.aspectRatio?.applied ??
    (typeof result.metadata?.normalizedAspectRatio === "string" &&
    result.metadata.normalizedAspectRatio.trim()
      ? result.metadata.normalizedAspectRatio
      : undefined);
  const normalizedResolution =
    result.normalization?.resolution?.applied ??
    (typeof result.metadata?.normalizedResolution === "string" &&
    result.metadata.normalizedResolution.trim()
      ? result.metadata.normalizedResolution
      : undefined);
  const sizeTranslatedToAspectRatio =
    result.normalization?.aspectRatio?.derivedFrom === "size" ||
    (!normalizedSize &&
      typeof result.metadata?.requestedSize === "string" &&
      result.metadata.requestedSize === params.size &&
      Boolean(normalizedAspectRatio));
  const allMediaUrls = [
    ...savedVideos.map((video) => video.path),
    ...urlOnlyVideos.map((video) => video.url),
  ];
  const attachments: AgentGeneratedAttachment[] = [
    ...savedVideos.map((video) => ({
      type: "video" as const,
      path: video.path,
      mimeType: video.contentType,
      name: video.id,
    })),
    ...urlOnlyVideos.map((video) => ({
      type: "video" as const,
      url: video.url,
      mimeType: video.mimeType,
      name: video.fileName,
    })),
  ];
  const lines = [
    `Generated ${totalCount} video${totalCount === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    typeof requestedDurationSeconds === "number" &&
    typeof normalizedDurationSeconds === "number" &&
    requestedDurationSeconds !== normalizedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${normalizedDurationSeconds}s.`
      : null,
    ...formatGeneratedAttachmentLines(attachments),
  ].filter((entry): entry is string => Boolean(entry));

  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedVideos.map((video) => video.path),
    urlOnlyUrls: urlOnlyVideos.map((video) => video.url),
    count: totalCount,
    paths: savedVideos.map((video) => video.path),
    mediaUrls: allMediaUrls,
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: totalCount,
      media: {
        mediaUrls: allMediaUrls,
        attachments,
      },
      attachments,
      paths: allMediaUrls,
      ...buildTaskRunDetails(params.taskHandle),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedInput,
      }),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceVideos,
        singleKey: "video",
        pluralKey: "videos",
        getResolvedInput: (entry) => entry.resolvedInput,
        singleRewriteKey: "videoRewrittenFrom",
      }),
      ...(normalizedSize ||
      (!ignoredOverrideKeys.has("size") && params.size && !sizeTranslatedToAspectRatio)
        ? { size: normalizedSize ?? params.size }
        : {}),
      ...(normalizedAspectRatio || (!ignoredOverrideKeys.has("aspectRatio") && params.aspectRatio)
        ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio }
        : {}),
      ...(normalizedResolution || (!ignoredOverrideKeys.has("resolution") && params.resolution)
        ? { resolution: normalizedResolution ?? params.resolution }
        : {}),
      ...(typeof normalizedDurationSeconds === "number"
        ? { durationSeconds: normalizedDurationSeconds }
        : {}),
      ...(typeof requestedDurationSeconds === "number" &&
      typeof normalizedDurationSeconds === "number" &&
      requestedDurationSeconds !== normalizedDurationSeconds
        ? { requestedDurationSeconds }
        : {}),
      ...(supportedDurationSeconds && supportedDurationSeconds.length > 0
        ? { supportedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("audio") && typeof params.audio === "boolean"
        ? { audio: params.audio }
        : {}),
      ...(!ignoredOverrideKeys.has("watermark") && typeof params.watermark === "boolean"
        ? { watermark: params.watermark }
        : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
  };
}

export function createVideoGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: VideoGenerateSandboxConfig;
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
      modelConfig: cfg.agents?.defaults?.videoGenerationModel,
      providerKey: "videoGenerationProviders",
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
    options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;

  return {
    label: "Video Generation",
    name: "video_generate",
    displaySummary: "Generate videos",
    description:
      'Create videos. Session chats: background task; do not call video_generate again for same request; wait completion, then send attachments via message tool. "status" checks active task. Duration may round to provider-supported value.',
    parameters: VideoGenerateToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);

      if (action === "list") {
        return createVideoGenerateListActionResult(cfg, {
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      if (action === "status") {
        return createVideoGenerateStatusActionResult(options?.agentSessionKey);
      }

      const videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({
        cfg,
        agentDir: options?.agentDir,
        authStore: options?.authProfileStore,
      });
      if (!videoGenerationModelConfig) {
        throw new ToolInputError("No video-generation model configured.");
      }
      const explicitModelConfig = hasExplicitVideoGenerationModelConfig(cfg);
      const effectiveCfg =
        applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) ?? cfg;
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);

      const duplicateGuardResult = createVideoGenerateDuplicateGuardResult(
        options?.agentSessionKey,
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }

      const prompt = readStringParam(args, "prompt", { required: true });
      const model = readStringParam(args, "model");
      const filename = readStringParam(args, "filename");
      const size = readStringParam(args, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(args, "aspectRatio"));
      const resolution = normalizeResolution(readStringParam(args, "resolution"));
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        integer: true,
        strict: true,
      });
      const audio = readBooleanToolParam(args, "audio");
      const watermark = readBooleanToolParam(args, "watermark");
      const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;
      // providerOptions must be a plain object. Arrays are objects in JS, so
      // exclude them explicitly — a bogus call like `providerOptions: ["seed", 42]`
      // would otherwise be cast to `Record<string, unknown>` with numeric-string
      // keys and silently forwarded to the provider.
      const providerOptionsRaw = readSnakeCaseParamRaw(args, "providerOptions");
      if (
        providerOptionsRaw != null &&
        (typeof providerOptionsRaw !== "object" || Array.isArray(providerOptionsRaw))
      ) {
        throw new ToolInputError(
          "providerOptions must be a JSON object keyed by provider-specific option name.",
        );
      }
      const providerOptions =
        providerOptionsRaw != null ? (providerOptionsRaw as Record<string, unknown>) : undefined;
      const imageInputs = normalizeReferenceInputs({
        args,
        singularKey: "image",
        pluralKey: "images",
        maxCount: MAX_INPUT_IMAGES,
      });
      // *Roles: parallel string arrays giving each asset a semantic role hint.
      // Use readSnakeCaseParamRaw so both camelCase and snake_case keys are accepted.
      const imageRoles = parseRoleArray({
        raw: readSnakeCaseParamRaw(args, "imageRoles"),
        kind: "imageRoles",
        assetCount: imageInputs.length,
      });
      const videoInputs = normalizeReferenceInputs({
        args,
        singularKey: "video",
        pluralKey: "videos",
        maxCount: MAX_INPUT_VIDEOS,
      });
      const videoRoles = parseRoleArray({
        raw: readSnakeCaseParamRaw(args, "videoRoles"),
        kind: "videoRoles",
        assetCount: videoInputs.length,
      });
      const audioInputs = normalizeReferenceInputs({
        args,
        singularKey: "audioRef",
        pluralKey: "audioRefs",
        maxCount: MAX_INPUT_AUDIOS,
      });
      const audioRoles = parseRoleArray({
        raw: readSnakeCaseParamRaw(args, "audioRoles"),
        kind: "audioRoles",
        assetCount: audioInputs.length,
      });

      const selectedProvider = resolveSelectedVideoGenerationProvider({
        config: effectiveCfg,
        videoGenerationModelConfig,
        modelOverride: model,
      });
      const loadedReferenceImages = await loadReferenceAssets({
        inputs: imageInputs,
        expectedKind: "image",
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
      });
      // Attach roles to the loaded image assets (positional, by index into images[]).
      for (let i = 0; i < loadedReferenceImages.length; i++) {
        const role = imageRoles[i];
        if (role) {
          loadedReferenceImages[i].sourceAsset.role = role;
        }
      }
      const loadedReferenceVideos = await loadReferenceAssets({
        inputs: videoInputs,
        expectedKind: "video",
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
      });
      for (let i = 0; i < loadedReferenceVideos.length; i++) {
        const role = videoRoles[i];
        if (role) {
          loadedReferenceVideos[i].sourceAsset.role = role;
        }
      }
      const loadedReferenceAudios = await loadReferenceAssets({
        inputs: audioInputs,
        expectedKind: "audio",
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
      });
      for (let i = 0; i < loadedReferenceAudios.length; i++) {
        const role = audioRoles[i];
        if (role) {
          loadedReferenceAudios[i].sourceAsset.role = role;
        }
      }
      validateVideoGenerationCapabilities({
        provider: selectedProvider,
        model:
          parseVideoGenerationModelRef(model)?.model ?? model ?? selectedProvider?.defaultModel,
        inputImageCount: loadedReferenceImages.length,
        inputVideoCount: loadedReferenceVideos.length,
        inputAudioCount: loadedReferenceAudios.length,
        size,
        aspectRatio,
        resolution,
        durationSeconds,
        audio,
        watermark,
      });
      const taskHandle = createVideoGenerationTaskRun({
        sessionKey: options?.agentSessionKey,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        providerId: selectedProvider?.id,
      });
      const shouldDetach = Boolean(taskHandle && options?.agentSessionKey?.trim());

      if (shouldDetach) {
        scheduleMediaGenerationTaskCompletion({
          lifecycle: videoGenerationTaskLifecycle,
          handle: taskHandle,
          scheduleBackgroundWork,
          progressSummary: "Generating video",
          config: effectiveCfg,
          toolName: "Video generation",
          onWakeFailure: (message, meta) => log.warn(message, meta),
          run: () =>
            executeVideoGenerationJob({
              effectiveCfg,
              prompt,
              agentDir: options?.agentDir,
              model,
              size,
              aspectRatio,
              resolution,
              durationSeconds,
              audio,
              watermark,
              filename,
              loadedReferenceImages,
              loadedReferenceVideos,
              loadedReferenceAudios,
              taskHandle,
              providerOptions,
              autoProviderFallback: explicitModelConfig ? false : undefined,
              timeoutMs,
            }),
        });

        return buildMediaGenerationStartedToolResult({
          toolName: "video_generate",
          generationLabel: "video",
          completionLabel: "video",
          taskHandle,
          detailExtras: {
            ...buildMediaReferenceDetails({
              entries: loadedReferenceImages,
              singleKey: "image",
              pluralKey: "images",
              getResolvedInput: (entry) => entry.resolvedInput,
            }),
            ...buildMediaReferenceDetails({
              entries: loadedReferenceVideos,
              singleKey: "video",
              pluralKey: "videos",
              getResolvedInput: (entry) => entry.resolvedInput,
              singleRewriteKey: "videoRewrittenFrom",
            }),
            ...(model ? { model } : {}),
            ...(size ? { size } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(typeof audio === "boolean" ? { audio } : {}),
            ...(typeof watermark === "boolean" ? { watermark } : {}),
            ...(filename ? { filename } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        });
      }

      try {
        const executed = await executeVideoGenerationJob({
          effectiveCfg,
          prompt,
          agentDir: options?.agentDir,
          model,
          size,
          aspectRatio,
          resolution,
          durationSeconds,
          audio,
          watermark,
          filename,
          loadedReferenceImages,
          loadedReferenceVideos,
          loadedReferenceAudios,
          taskHandle,
          providerOptions,
          autoProviderFallback: explicitModelConfig ? false : undefined,
          timeoutMs,
        });
        completeVideoGenerationTaskRun({
          handle: taskHandle,
          provider: executed.provider,
          model: executed.model,
          count: executed.count,
          paths: executed.savedPaths,
        });

        return {
          content: [{ type: "text", text: executed.contentText }],
          details: executed.details,
        };
      } catch (error) {
        failVideoGenerationTaskRun({
          handle: taskHandle,
          error,
        });
        throw error;
      }
    },
  };
}
