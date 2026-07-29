// Public video-generation helpers and types for provider plugins.
//
// Keep these public type declarations local to the plugin-sdk entrypoint so the
// emitted declaration surface stays stable for package-boundary consumers.

import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  GeneratedVideoAsset as CoreGeneratedVideoAsset,
  VideoGenerationAssetRole as CoreVideoGenerationAssetRole,
  VideoGenerationCatalogModelEntry as CoreVideoGenerationCatalogModelEntry,
  VideoGenerationMode as CoreVideoGenerationMode,
  VideoGenerationModeCapabilities as CoreVideoGenerationModeCapabilities,
  VideoGenerationModelCapabilitiesContext as CoreVideoGenerationModelCapabilitiesContext,
  VideoGenerationProvider as CoreVideoGenerationProvider,
  VideoGenerationProviderCapabilities as CoreVideoGenerationProviderCapabilities,
  VideoGenerationProviderConfiguredContext as CoreVideoGenerationProviderConfiguredContext,
  VideoGenerationProviderOptionType as CoreVideoGenerationProviderOptionType,
  VideoGenerationRequest as CoreVideoGenerationRequest,
  VideoGenerationResolution as CoreVideoGenerationResolution,
  VideoGenerationResult as CoreVideoGenerationResult,
  VideoGenerationSourceAsset as CoreVideoGenerationSourceAsset,
  VideoGenerationTransformCapabilities as CoreVideoGenerationTransformCapabilities,
} from "../video-generation/types.js";

/** Video asset returned by a provider after generation or transformation. */
export type GeneratedVideoAsset = {
  /** Raw video bytes. Either buffer or url must be present. */
  buffer?: Buffer;
  /** Pre-signed or provider-hosted URL for the video. When set and buffer is
   * absent, callers can deliver or download the asset without requiring the
   * provider to materialize the full file in memory first. */
  url?: string;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

/** Resolution label accepted by video generation providers. */
export type VideoGenerationResolution =
  | "360P"
  | "480P"
  | "540P"
  | "720P"
  | "768P"
  | "1080P"
  | (string & {});

/**
 * Canonical semantic role hints for reference assets (first/last frame,
 * reference image/video/audio). Providers may accept additional role strings;
 * the asset.role type accepts both canonical values and arbitrary strings.
 */
export type VideoGenerationAssetRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio";

/** Source media asset supplied to image/video/audio-to-video providers. */
export type VideoGenerationSourceAsset = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  /**
   * Optional semantic role hint forwarded to the provider. Canonical values
   * come from `VideoGenerationAssetRole`; plain strings are accepted for
   * provider-specific extensions.
   */
  role?: VideoGenerationAssetRole | (string & {});
  metadata?: Record<string, unknown>;
};

/** Context passed when checking whether a video provider is configured. */
export type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

/** Context passed when resolving model-specific video generation capabilities. */
export type VideoGenerationModelCapabilitiesContext = {
  provider: string;
  model: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
};

/** Normalized request object passed to a selected video generation provider. */
export type VideoGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
  /** Reference audio assets (e.g. background music) forwarded to the provider. */
  inputAudios?: VideoGenerationSourceAsset[];
  /** Arbitrary provider-specific parameters forwarded as-is (e.g. seed, draft, camerafixed). */
  providerOptions?: Record<string, unknown>;
};

/** Provider video generation response returned to the runtime. */
export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

/** Supported high-level video generation operation modes. */
export type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";

/**
 * Primitive type tag for a declared `providerOptions` key. Keep narrow —
 * plugins that need richer shapes should leave them out of the typed contract
 * and interpret the forwarded opaque value inside their own provider code.
 */
export type VideoGenerationProviderOptionType = "number" | "boolean" | "string";

/** Capability limits and supported options for one video generation mode. */
export type VideoGenerationModeCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputImagesByModel?: Readonly<Record<string, number>>;
  maxInputVideos?: number;
  maxInputVideosByModel?: Readonly<Record<string, number>>;
  /** Max number of reference audio assets the provider accepts (e.g. background music, voice reference). */
  maxInputAudios?: number;
  maxInputAudiosByModel?: Readonly<Record<string, number>>;
  maxDurationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  supportedDurationSecondsByModel?: Readonly<Record<string, readonly number[]>>;
  sizes?: readonly string[];
  aspectRatios?: readonly string[];
  resolutions?: readonly VideoGenerationResolution[];
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  supportsAudio?: boolean;
  supportsWatermark?: boolean;
  /**
   * Declared typed schema for `VideoGenerationRequest.providerOptions`. Keys
   * listed here are accepted and validated against the declared primitive
   * type before forwarding; unknown keys or type mismatches skip the
   * candidate provider at runtime so mis-typed or provider-specific options
   * never silently reach the wrong provider.
   */
  providerOptions?: Readonly<Record<string, VideoGenerationProviderOptionType>>;
};

/** Capability block for transform modes that may be independently enabled. */
export type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean;
};

/** Full provider capability map including base and transform mode overrides. */
export type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;
  imageToVideo?: VideoGenerationTransformCapabilities;
  videoToVideo?: VideoGenerationTransformCapabilities;
};

/** Static catalog metadata that overrides provider defaults for one video model. */
export type VideoGenerationCatalogModelEntry = {
  capabilities?: VideoGenerationProviderCapabilities;
  modes?: readonly VideoGenerationMode[];
};

/** Video generation provider contract implemented by provider plugins. */
export type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  catalogByModel?: Readonly<Record<string, VideoGenerationCatalogModelEntry>>;
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  resolveModelCapabilities?: (
    ctx: VideoGenerationModelCapabilitiesContext,
  ) =>
    | VideoGenerationProviderCapabilities
    | undefined
    | Promise<VideoGenerationProviderCapabilities | undefined>;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

type AssertAssignable<_Left extends _Right, _Right> = true;
const videoGenerationSdkCompat: [
  AssertAssignable<GeneratedVideoAsset, CoreGeneratedVideoAsset>,
  AssertAssignable<CoreGeneratedVideoAsset, GeneratedVideoAsset>,
  AssertAssignable<VideoGenerationAssetRole, CoreVideoGenerationAssetRole>,
  AssertAssignable<CoreVideoGenerationAssetRole, VideoGenerationAssetRole>,
  AssertAssignable<VideoGenerationProviderOptionType, CoreVideoGenerationProviderOptionType>,
  AssertAssignable<CoreVideoGenerationProviderOptionType, VideoGenerationProviderOptionType>,
  AssertAssignable<VideoGenerationMode, CoreVideoGenerationMode>,
  AssertAssignable<CoreVideoGenerationMode, VideoGenerationMode>,
  AssertAssignable<VideoGenerationCatalogModelEntry, CoreVideoGenerationCatalogModelEntry>,
  AssertAssignable<CoreVideoGenerationCatalogModelEntry, VideoGenerationCatalogModelEntry>,
  AssertAssignable<VideoGenerationModeCapabilities, CoreVideoGenerationModeCapabilities>,
  AssertAssignable<CoreVideoGenerationModeCapabilities, VideoGenerationModeCapabilities>,
  AssertAssignable<VideoGenerationProvider, CoreVideoGenerationProvider>,
  AssertAssignable<CoreVideoGenerationProvider, VideoGenerationProvider>,
  AssertAssignable<VideoGenerationProviderCapabilities, CoreVideoGenerationProviderCapabilities>,
  AssertAssignable<CoreVideoGenerationProviderCapabilities, VideoGenerationProviderCapabilities>,
  AssertAssignable<
    VideoGenerationProviderConfiguredContext,
    CoreVideoGenerationProviderConfiguredContext
  >,
  AssertAssignable<
    CoreVideoGenerationProviderConfiguredContext,
    VideoGenerationProviderConfiguredContext
  >,
  AssertAssignable<
    VideoGenerationModelCapabilitiesContext,
    CoreVideoGenerationModelCapabilitiesContext
  >,
  AssertAssignable<
    CoreVideoGenerationModelCapabilitiesContext,
    VideoGenerationModelCapabilitiesContext
  >,
  AssertAssignable<VideoGenerationRequest, CoreVideoGenerationRequest>,
  AssertAssignable<CoreVideoGenerationRequest, VideoGenerationRequest>,
  AssertAssignable<VideoGenerationResolution, CoreVideoGenerationResolution>,
  AssertAssignable<CoreVideoGenerationResolution, VideoGenerationResolution>,
  AssertAssignable<VideoGenerationResult, CoreVideoGenerationResult>,
  AssertAssignable<CoreVideoGenerationResult, VideoGenerationResult>,
  AssertAssignable<VideoGenerationSourceAsset, CoreVideoGenerationSourceAsset>,
  AssertAssignable<CoreVideoGenerationSourceAsset, VideoGenerationSourceAsset>,
  AssertAssignable<VideoGenerationTransformCapabilities, CoreVideoGenerationTransformCapabilities>,
  AssertAssignable<CoreVideoGenerationTransformCapabilities, VideoGenerationTransformCapabilities>,
] = [] as never;
void videoGenerationSdkCompat;

export {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  DEFAULT_VIDEO_GENERATION_DURATION_SECONDS,
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
  DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  extractDashscopeVideoUrls,
  pollDashscopeVideoTaskUntilComplete,
  resolveVideoGenerationReferenceUrls,
  runDashscopeVideoGenerationTask,
} from "../video-generation/dashscope-compatible.js";

export type { DashscopeVideoGenerationResponse } from "../video-generation/dashscope-compatible.js";
