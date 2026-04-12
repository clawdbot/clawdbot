// Public video-generation helpers and types for provider plugins.
//
// Keep these public type declarations local to the plugin-sdk entrypoint so the
// emitted declaration surface stays stable for package-boundary consumers.

import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  GeneratedVideoAsset as CoreGeneratedVideoAsset,
  VideoGenerationAssetRole as CoreVideoGenerationAssetRole,
  VideoGenerationMode as CoreVideoGenerationMode,
  VideoGenerationModeCapabilities as CoreVideoGenerationModeCapabilities,
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

export type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";

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

export type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

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

export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";

/**
 * Primitive type tag for a declared `providerOptions` key. Keep narrow —
 * plugins that need richer shapes should leave them out of the typed contract
 * and interpret the forwarded opaque value inside their own provider code.
 */
export type VideoGenerationProviderOptionType = "number" | "boolean" | "string";

export type VideoGenerationModeCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputVideos?: number;
  /** Max number of reference audio assets the provider accepts (e.g. background music, voice reference). */
  maxInputAudios?: number;
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

export type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean;
};

export type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;
  imageToVideo?: VideoGenerationTransformCapabilities;
  videoToVideo?: VideoGenerationTransformCapabilities;
};

export type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

type AssertAssignable<_Left extends _Right, _Right> = true;

type _VideoGenerationSdkCompat = [
  AssertAssignable<GeneratedVideoAsset, CoreGeneratedVideoAsset>,
  AssertAssignable<CoreGeneratedVideoAsset, GeneratedVideoAsset>,
  AssertAssignable<VideoGenerationAssetRole, CoreVideoGenerationAssetRole>,
  AssertAssignable<CoreVideoGenerationAssetRole, VideoGenerationAssetRole>,
  AssertAssignable<VideoGenerationProviderOptionType, CoreVideoGenerationProviderOptionType>,
  AssertAssignable<CoreVideoGenerationProviderOptionType, VideoGenerationProviderOptionType>,
  AssertAssignable<VideoGenerationMode, CoreVideoGenerationMode>,
  AssertAssignable<CoreVideoGenerationMode, VideoGenerationMode>,
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
];

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
