import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import { withMediaGenerationTaskKeepalive } from "./media-generate-background-shared.js";
import {
  applyVideoGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  normalizeMediaReferenceInputs,
  readBooleanToolParam,
  readGenerationTimeoutMs,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
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
  type VideoGenerationTaskHandle,
  wakeVideoGenerationTaskCompletion,
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
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  // Provider-specific sentinel: accepted at the tool boundary, then forwarded
  // to the active provider only if that provider declares "adaptive" in its
  // capabilities.aspectRatios list. Providers that do not declare it see the
  // value pushed into `ignoredOverrides` in the normalization layer so the
  // tool surfaces a user-visible "ignored override" warning rather than
  // silently dropping the request. Seedance uses this to auto-detect the
  // ratio from input image dimensions.
  "adaptive",
]);

const VideoGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default), "status" to inspect the active session task, or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Video generation prompt." })),
  image: Type.Optional(
    Type.String({
      description: "Optional single reference image path or URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  imageRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional semantic roles for the combined reference image list, parallel by index. " +
        "The list is `image` (if provided) followed by each entry in `images`, in order, " +
        "after de-duplication. " +
        'Canonical values: "first_frame", "last_frame", "reference_image". ' +
        "Providers may accept additional role strings. " +
        "Must not have more entries than the combined image list; use an empty string to leave a position unset.",
    }),
  ),
  video: Type.Optional(
    Type.String({
      description: "Optional single reference video path or URL.",
    }),
  ),
  videos: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference videos (up to ${MAX_INPUT_VIDEOS}).`,
    }),
  ),
  videoRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional semantic roles for the combined reference video list, parallel by index. " +
        "The list is `video` (if provided) followed by each entry in `videos`, in order, " +
        "after de-duplication. " +
        'Canonical value: "reference_video". Providers may accept additional role strings. ' +
        "Must not have more entries than the combined video list; use an empty string to leave a position unset.",
    }),
  ),
  audioRef: Type.Optional(
    Type.String({
      description: "Optional single reference audio path or URL (e.g. background music).",
    }),
  ),
  audioRefs: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference audios (up to ${MAX_INPUT_AUDIOS}).`,
    }),
  ),
  audioRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional semantic roles for the combined reference audio list, parallel by index. " +
        "The list is `audioRef` (if provided) followed by each entry in `audioRefs`, in order, " +
        "after de-duplication. " +
        'Canonical value: "reference_audio". Providers may accept additional role strings. ' +
        "Must not have more entries than the combined audio list; use an empty string to leave a position unset.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional provider/model override, e.g. qwen/wan2.6-t2v." }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename hint. OpenClaw preserves the basename and saves under its managed media directory.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Optional size hint like 1280x720 or 1920x1080 when the provider supports it.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        'Optional aspect ratio hint: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, or "adaptive".',
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description: "Optional resolution hint: 480P, 720P, 768P, or 1080P.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      description:
        "Optional target duration in seconds. OpenClaw may round this to the nearest provider-supported duration.",
      minimum: 1,
    }),
  ),
  audio: Type.Optional(
    Type.Boolean({
      description: "Optional audio toggle when the provider supports generated audio.",
    }),
  ),
  watermark: Type.Optional(
    Type.Boolean({
      description: "Optional watermark toggle when the provider supports it.",
    }),
  ),
  providerOptions: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Optional provider-specific options as a JSON object, e.g. `{"seed": 42, "draft": true}`. ' +
        "Each provider declares its own accepted keys and primitive types (number/boolean/string) " +
        "via its capabilities; unknown keys or type mismatches skip the candidate during fallback " +
        "and never silently reach the wrong provider. Run `video_generate action=list` to see which " +
        "keys each provider accepts.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Optional provider request timeout in milliseconds.",
      minimum: 1,
    }),
  ),
});

export function resolveVideoGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    modelConfig: params.cfg?.agents?.defaults?.videoGenerationModel,
    providers: listRuntimeVideoGenerationProviders({ config: params.cfg }),
  });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  return resolveGenerateAction({
    args,
    allowed: ["generate", "status", "list"],
    defaultAction: "generate",
  });
}

function normalizeResolution(raw: string | undefined): VideoGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "480P" ||
    normalized === "720P" ||
    normalized === "768P" ||
    normalized === "1080P"
  ) {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 480P, 720P, 768P, or 1080P");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, or adaptive",
  );
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

type VideoGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

function defaultScheduleVideoGenerateBackgroundWork(work: () => Promise<void>) {
  queueMicrotask(() => {
    void work().catch((error) => {
      log.error("Detached video generation job crashed", {
        error,
      });
    });
  });
}

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
  const lines = [
    `Generated ${totalCount} video${totalCount === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    typeof requestedDurationSeconds === "number" &&
    typeof normalizedDurationSeconds === "number" &&
    requestedDurationSeconds !== normalizedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${normalizedDurationSeconds}s.`
      : null,
    ...savedVideos.map((video) => `MEDIA:${video.path}`),
    ...urlOnlyVideos.map((video) => `MEDIA:${video.url}`),
  ].filter((entry): entry is string => Boolean(entry));

  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedVideos.map((video) => video.path),
    urlOnlyUrls: urlOnlyVideos.map((video) => video.url),
    count: totalCount,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: totalCount,
      media: {
        mediaUrls: allMediaUrls,
      },
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
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: VideoGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: VideoGenerateBackgroundScheduler;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? getRuntimeConfig();
  const videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({
    cfg,
    agentDir: options?.agentDir,
  });
  if (!videoGenerationModelConfig) {
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
      "Generate videos using configured providers. Generated videos are saved under OpenClaw-managed media storage and delivered automatically as attachments. Duration requests may be rounded to the nearest provider-supported value.",
    parameters: VideoGenerateToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);
      const effectiveCfg =
        applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) ?? cfg;
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);

      if (action === "list") {
        return createVideoGenerateListActionResult(effectiveCfg);
      }

      if (action === "status") {
        return createVideoGenerateStatusActionResult(options?.agentSessionKey);
      }

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
      const timeoutMs = readGenerationTimeoutMs(args);
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
        scheduleBackgroundWork(async () => {
          try {
            const executed = await withMediaGenerationTaskKeepalive({
              handle: taskHandle,
              progressSummary: "Generating video",
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
                  timeoutMs,
                }),
            });
            completeVideoGenerationTaskRun({
              handle: taskHandle,
              provider: executed.provider,
              model: executed.model,
              count: executed.count,
              paths: executed.savedPaths,
            });
            try {
              await wakeVideoGenerationTaskCompletion({
                config: effectiveCfg,
                handle: taskHandle,
                status: "ok",
                statusLabel: "completed successfully",
                result: executed.wakeResult,
                mediaUrls: [...executed.savedPaths, ...executed.urlOnlyUrls],
              });
            } catch (error) {
              log.warn("Video generation completion wake failed after successful generation", {
                taskId: taskHandle?.taskId,
                runId: taskHandle?.runId,
                error,
              });
            }
          } catch (error) {
            failVideoGenerationTaskRun({
              handle: taskHandle,
              error,
            });
            await wakeVideoGenerationTaskCompletion({
              config: effectiveCfg,
              handle: taskHandle,
              status: "error",
              statusLabel: "failed",
              result: formatErrorMessage(error),
            });
            return;
          }
        });

        return {
          content: [
            {
              type: "text",
              text: `Background task started for video generation (${taskHandle?.taskId ?? "unknown"}). Do not call video_generate again for this request. Wait for the completion event; I'll post the finished video here when it's ready.`,
            },
          ],
          details: {
            async: true,
            status: "started",
            ...buildTaskRunDetails(taskHandle),
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
        };
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
