/** Runs capability-aware video generation and persistence. */
import { Type, type TSchema } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseVideoGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import { saveMediaBuffer } from "../../media/store.js";
import { SaveMediaSourceError } from "../../media/store.shared.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
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
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { getCustomProviderApiKey } from "../model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { ToolInputError, readNumberParam, readToolStringParam } from "./common.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import {
  hasSnapshotCapabilityProviderAvailability,
  loadCapabilityMetadataSnapshot,
} from "./manifest-capability-availability.js";
import {
  createDefaultMediaGenerateBackgroundScheduler,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
} from "./media-generate-background-shared.js";
import {
  runMediaGenerationTask,
  videoGenerationTaskLifecycle,
  type VideoGenerationTaskHandle,
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
  readGenerationTimeoutMs,
  resolveMediaToolSandboxConfig,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import {
  hasAuthForProvider,
  coerceToolModelConfig,
  type ToolModelConfig,
} from "./model-config.helpers.js";
import type { AnyAgentTool, ToolFsPolicy } from "./tool-runtime.helpers.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateListActionResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_INPUT_IMAGES = 9;
const MAX_INPUT_VIDEOS = 4;
const MAX_INPUT_AUDIOS = 3;
const GENERATED_VIDEO_MEDIA_SUBDIR = "tool-video-generation";
const GENERATED_VIDEO_PROBE_BUDGET_MS = 3000;
const GENERATED_VIDEO_PROBE_CONCURRENCY = 2;
const MAX_GENERATED_VIDEO_PROBES = 8;

const VideoGenerateToolProperties = {
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
        "Resolution: 360P, 480P, 540P, 720P, 768P, 1080P, 4K, or provider value; unsupported normalized/ignored.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Integer({
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
    Type.Integer({
      description: "Provider timeout ms.",
      minimum: 1,
    }),
  ),
} satisfies Record<string, TSchema>;

function createVideoGenerateToolSchema(params: { includeAudioReferences: boolean }) {
  const properties: Record<string, TSchema> = { ...VideoGenerateToolProperties };
  if (!params.includeAudioReferences) {
    delete properties.audioRef;
    delete properties.audioRefs;
    delete properties.audioRoles;
  }
  return Type.Object(properties);
}

function collectVideoGenerationModelProviderIds(params: {
  cfg: OpenClawConfig;
  modelConfig: ToolModelConfig;
  workspaceDir?: string;
}): Set<string> {
  const providerIds = new Set<string>();
  for (const modelRef of [params.modelConfig.primary, ...(params.modelConfig.fallbacks ?? [])]) {
    const parsed = parseVideoGenerationModelRef(modelRef);
    if (parsed?.provider) {
      providerIds.add(
        resolveProviderIdForAuth(parsed.provider, {
          config: params.cfg,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        }),
      );
    }
  }
  return providerIds;
}

function isVideoGenerationProviderConfigured(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  providerId: string;
}): boolean {
  return (
    getCustomProviderApiKey(params.cfg, params.providerId) !== undefined ||
    hasSnapshotCapabilityProviderAvailability({
      snapshot: params.snapshot,
      key: "videoGenerationProviders",
      providerId: params.providerId,
      config: params.cfg,
      authStore: params.authStore,
    }) ||
    hasAuthForProvider({
      provider: params.providerId,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
    })
  );
}

function shouldExposeVideoReferenceAudioParams(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  workspaceDir?: string;
}): boolean {
  const snapshot = loadCapabilityMetadataSnapshot({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const knownProviderIds = new Set<string>();
  const audioCandidateProviderIds = new Set<string>();
  const explicitProviderIds = collectVideoGenerationModelProviderIds({
    cfg: params.cfg,
    modelConfig: coerceToolModelConfig(params.cfg.agents?.defaults?.mediaModels?.video),
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });

  for (const plugin of snapshot.plugins) {
    if (
      !plugin.contracts?.videoGenerationProviders?.length ||
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.cfg,
      })
    ) {
      continue;
    }
    for (const providerId of plugin.contracts.videoGenerationProviders) {
      knownProviderIds.add(providerId);
      const metadata = plugin.videoGenerationProviderMetadata?.[providerId];
      const providerCanUseReferenceAudio = metadata?.referenceAudioInputs === true;
      for (const alias of metadata?.aliases ?? []) {
        knownProviderIds.add(alias);
        if (providerCanUseReferenceAudio) {
          audioCandidateProviderIds.add(alias);
        }
      }
      if (providerCanUseReferenceAudio) {
        audioCandidateProviderIds.add(providerId);
      }
    }
  }

  for (const providerId of explicitProviderIds) {
    if (!knownProviderIds.has(providerId) || audioCandidateProviderIds.has(providerId)) {
      return true;
    }
  }

  for (const providerId of audioCandidateProviderIds) {
    if (
      isVideoGenerationProviderConfigured({
        snapshot,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
        providerId,
      })
    ) {
      return true;
    }
  }
  return false;
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
  providers?: VideoGenerationProvider[];
  videoGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): VideoGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: params.providers ?? listRuntimeVideoGenerationProviders({ config: params.config }),
    modelConfig: params.videoGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
  });
}

function formatIgnoredVideoGenerationOverride(override: VideoGenerationIgnoredOverride): string {
  return `${sanitizeGeneratedMediaDisplayText(override.key)}=${sanitizeGeneratedMediaDisplayText(String(override.value))}`;
}

type VideoGenerateSandboxConfig = MediaToolSandbox;

const defaultScheduleVideoGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "video_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

async function loadReferenceAssets(params: {
  inputs: string[];
  expectedKind: "image" | "video" | "audio";
  maxBytes: number;
  workspaceDir?: string;
  sandboxConfig: ReturnType<typeof resolveMediaToolSandboxConfig>;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<
  Array<{
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded = await loadMediaToolReferences<VideoGenerationSourceAsset>({
    inputs: params.inputs,
    toolName: "video_generate",
    expectedKind: params.expectedKind,
    sandbox: params.sandboxConfig,
    workspaceDir: params.workspaceDir,
    maxBytes: params.maxBytes,
    ssrfPolicy: params.ssrfPolicy,
    signal: params.signal,
    mapMedia: (media) => ({
      buffer: media.buffer,
      mimeType: "mimeType" in media ? media.mimeType : media.contentType,
      fileName: "fileName" in media ? media.fileName : undefined,
    }),
    mapRemote: (url) => ({ url }),
  });
  return loaded.map(({ source, resolvedInput, rewrittenFrom }) =>
    Object.assign({ sourceAsset: source, resolvedInput }, rewrittenFrom ? { rewrittenFrom } : {}),
  );
}

type LoadedReferenceAsset = Awaited<ReturnType<typeof loadReferenceAssets>>[number];

type ExecutedVideoGeneration = {
  provider: string;
  model: string;
  /** URLs of url-only assets that were not saved locally. */
  urlOnlyUrls: string[];
  /** Total generated video count, including url-only assets. */
  count: number;
  mediaUrls: string[];
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

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
  providers?: VideoGenerationProvider[];
}): Promise<ExecutedVideoGeneration> {
  if (params.taskHandle) {
    videoGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating video",
    });
  }
  const result = await generateVideo(
    {
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
    },
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  if (params.taskHandle) {
    videoGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated video",
    });
  }

  type UrlVideo = { url: string; mimeType: string; fileName?: string };
  type PersistedVideo =
    | { kind: "saved"; media: Awaited<ReturnType<typeof saveMediaBuffer>> }
    | { kind: "url"; media: UrlVideo };
  const videoOrder: Array<PersistedVideo | number> = [];
  const bufferVideos: Array<(typeof result.videos)[number] & { buffer: Buffer }> = [];
  for (const video of result.videos) {
    if (video.buffer) {
      videoOrder.push(bufferVideos.length);
      bufferVideos.push(video as (typeof result.videos)[number] & { buffer: Buffer });
      continue;
    }
    if (video.url) {
      videoOrder.push({
        kind: "url",
        media: { url: video.url, mimeType: video.mimeType, fileName: video.fileName },
      });
      continue;
    }
    throw new Error(
      `Provider ${result.provider} returned a video asset with neither buffer nor url — cannot deliver.`,
    );
  }

  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "video");
  const persistedVideos = await persistGeneratedMediaBatch<PersistedVideo>({
    subdir: GENERATED_VIDEO_MEDIA_SUBDIR,
    mode: "sequential",
    saves: bufferVideos.map((video) => async () => {
      try {
        const savedMedia = await saveMediaBuffer(
          video.buffer,
          video.mimeType,
          GENERATED_VIDEO_MEDIA_SUBDIR,
          mediaMaxBytes,
          params.filename || video.fileName,
        );
        return {
          value: { kind: "saved" as const, media: savedMedia },
          savedMedia,
        };
      } catch (error) {
        if (video.url && error instanceof SaveMediaSourceError && error.code === "too-large") {
          return {
            value: {
              kind: "url" as const,
              media: {
                url: video.url,
                mimeType: video.mimeType,
                fileName: video.fileName,
              },
            },
          };
        }
        throw error;
      }
    }),
  });
  // Preserve provider ordinals while replacing only buffer-backed slots with persistence results.
  const deliveredVideos = videoOrder.map((video) =>
    typeof video === "number" ? persistedVideos[video]! : video,
  );
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const displayProvider = sanitizeGeneratedMediaDisplayText(result.provider);
  const displayModel = sanitizeGeneratedMediaDisplayText(result.model);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(", ")}.`
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
  const allMediaUrls = deliveredVideos.map((video) =>
    video.kind === "saved" ? video.media.path : video.media.url,
  );
  const savedVideoMetadata = await probeMediaFilesWithinBudget(
    deliveredVideos.flatMap((video) =>
      video.kind === "saved" ? [{ filePath: video.media.path, kind: "video" as const }] : [],
    ),
    {
      budgetMs: GENERATED_VIDEO_PROBE_BUDGET_MS,
      concurrency: GENERATED_VIDEO_PROBE_CONCURRENCY,
      maxProbes: MAX_GENERATED_VIDEO_PROBES,
    },
  );
  let savedMetadataIndex = 0;
  const attachments: AgentGeneratedAttachment[] = deliveredVideos.map((video) => {
    if (video.kind === "url") {
      return {
        type: "video" as const,
        url: video.media.url,
        mimeType: video.media.mimeType,
        name: video.media.fileName,
        ...(typeof normalizedDurationSeconds === "number"
          ? { durationMs: normalizedDurationSeconds * 1000 }
          : {}),
      };
    }
    return Object.assign(
      {
        type: "video" as const,
        path: video.media.path,
        mimeType: video.media.contentType,
        name: video.media.id,
        sizeBytes: video.media.size,
        ...(typeof normalizedDurationSeconds === "number"
          ? { durationMs: normalizedDurationSeconds * 1000 }
          : {}),
      },
      savedVideoMetadata[savedMetadataIndex++] ?? {},
    );
  });
  const lines = [
    `Generated ${deliveredVideos.length} video${deliveredVideos.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
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
    urlOnlyUrls: deliveredVideos.flatMap((video) =>
      video.kind === "url" ? [video.media.url] : [],
    ),
    count: deliveredVideos.length,
    mediaUrls: allMediaUrls,
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: deliveredVideos.length,
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
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: VideoGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? getRuntimeConfig();
  const preparedProviders = options?.preparedModelRuntime?.mediaCapabilityProviders
    ?.videoGenerationProviders
    ? [...options.preparedModelRuntime.mediaCapabilityProviders.videoGenerationProviders]
    : undefined;
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.mediaModels?.video,
      providerKey: "videoGenerationProviders",
      providers: preparedProviders,
    })
  ) {
    return null;
  }

  const sandboxConfig = resolveMediaToolSandboxConfig(
    options?.sandbox,
    options?.fsPolicy?.workspaceOnly,
  );
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;
  const includeAudioReferences = shouldExposeVideoReferenceAudioParams({
    cfg,
    agentDir: options?.agentDir,
    authStore: options?.authProfileStore,
    workspaceDir: options?.workspaceDir,
  });

  return {
    label: "Video Generation",
    name: "video_generate",
    displaySummary: "Generate videos",
    description:
      "Create video, incl. image-to-video: image refs take first_frame/last_frame/reference_image roles; video refs condition style" +
      (includeAudioReferences ? "; audio refs condition sound" : "") +
      ". resolution up to 4K; audio/watermark toggles. action=list discovers providers/models. Session chat background: call once/request, await, then visible reply + structured media. status checks active task. Duration may round to provider value.",
    parameters: createVideoGenerateToolSchema({ includeAudioReferences }),
    execute: async (_toolCallId, rawArgs, signal) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveGenerateAction(args);

      if (action === "list") {
        return createVideoGenerateListActionResult(cfg, {
          workspaceDir: options?.workspaceDir,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      if (action === "status") {
        return createVideoGenerateStatusActionResult(
          options?.agentSessionKey,
          options?.requesterAgentId,
        );
      }

      const model = readToolStringParam(args, "model");
      const videoGenerationModelConfig = resolveCapabilityModelConfigForTool({
        cfg,
        workspaceDir: options?.workspaceDir,
        agentDir: options?.agentDir,
        authStore: options?.authProfileStore,
        modelConfig: cfg.agents?.defaults?.mediaModels?.video,
        modelOverride: model,
        providers: () => listRuntimeVideoGenerationProviders({ config: cfg }),
      });
      if (!videoGenerationModelConfig) {
        throw new ToolInputError("No video-generation model configured.");
      }
      const explicitModelConfig = hasExplicitMediaModel(cfg.agents?.defaults?.mediaModels?.video);
      const effectiveCfg =
        applyAgentDefaultModelConfig(cfg, "video", videoGenerationModelConfig) ?? cfg;
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
      const prompt = readToolStringParam(args, "prompt", { required: true });

      const activeDuplicateGuardResult = createVideoGenerateDuplicateGuardResult(
        options?.agentSessionKey,
        { prompt, agentId: options?.requesterAgentId },
      );
      if (activeDuplicateGuardResult) {
        return activeDuplicateGuardResult;
      }

      const filename = readToolStringParam(args, "filename");
      const size = readToolStringParam(args, "size");
      const aspectRatio = normalizeAspectRatio(readToolStringParam(args, "aspectRatio"));
      const resolution = normalizeResolution(readToolStringParam(args, "resolution"));
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
      const audio = readBooleanParam(args, "audio");
      const watermark = readBooleanParam(args, "watermark");
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
        providers: preparedProviders,
        videoGenerationModelConfig,
        modelOverride: model,
      });
      const explicitModelRef = parseVideoGenerationModelRef(model);
      const primaryModelRef = parseVideoGenerationModelRef(videoGenerationModelConfig.primary);
      const requestKey = buildMediaGenerationRequestKey({
        tool: "video_generate",
        prompt,
        provider: selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
        model:
          model !== undefined
            ? (explicitModelRef?.model ?? model)
            : (primaryModelRef?.model ??
              videoGenerationModelConfig.primary ??
              selectedProvider?.defaultModel),
        size,
        aspectRatio,
        resolution,
        durationSeconds,
        audio,
        watermark,
        filename,
        providerOptions,
        imageInputs,
        imageRoles,
        videoInputs,
        videoRoles,
        audioInputs,
        audioRoles,
      });
      const duplicateGuardResult = createVideoGenerateDuplicateGuardResult(
        options?.agentSessionKey,
        { prompt, requestKey, agentId: options?.requesterAgentId },
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }
      const loadedReferenceImages = await loadReferenceAssets({
        inputs: imageInputs,
        expectedKind: "image",
        maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "image"),
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
        signal,
      });
      // Attach roles to the loaded image assets (positional, by index into images[]).
      for (let i = 0; i < loadedReferenceImages.length; i++) {
        const role = imageRoles[i];
        const asset = loadedReferenceImages.at(i);
        if (role && asset) {
          asset.sourceAsset.role = role;
        }
      }
      const loadedReferenceVideos = await loadReferenceAssets({
        inputs: videoInputs,
        expectedKind: "video",
        maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "video"),
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
        signal,
      });
      for (let i = 0; i < loadedReferenceVideos.length; i++) {
        const role = videoRoles[i];
        const asset = loadedReferenceVideos.at(i);
        if (role && asset) {
          asset.sourceAsset.role = role;
        }
      }
      const loadedReferenceAudios = await loadReferenceAssets({
        inputs: audioInputs,
        expectedKind: "audio",
        maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "audio"),
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
        signal,
      });
      for (let i = 0; i < loadedReferenceAudios.length; i++) {
        const role = audioRoles[i];
        const asset = loadedReferenceAudios.at(i);
        if (role && asset) {
          asset.sourceAsset.role = role;
        }
      }
      // Accepted tasks own their paid work independently; cancellation applies only before admission.
      signal?.throwIfAborted();
      return runMediaGenerationTask({
        lifecycle: videoGenerationTaskLifecycle,
        generationLabel: "video",
        sessionKey: options?.agentSessionKey,
        requesterAgentId: options?.requesterAgentId,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        requestKey,
        providerId: selectedProvider?.id,
        config: effectiveCfg,
        scheduleBackgroundWork,
        onAsyncTaskStarted: options?.onAsyncTaskStarted,
        onFailure: (message, meta) => log.warn(message, meta),
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
        run: (taskHandle) =>
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
            providers: preparedProviders,
          }),
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
