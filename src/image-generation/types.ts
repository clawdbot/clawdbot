import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaNormalizationEntry } from "../media-generation/normalization.types.js";

export type GeneratedImageAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationResolution = "1K" | "2K" | "4K";

export type ImageGenerationQuality = "low" | "medium" | "high" | "auto";

export type ImageGenerationOutputFormat = "png" | "jpeg" | "webp";

export type ImageGenerationOpenAIBackground = "transparent" | "opaque" | "auto";

export type ImageGenerationOpenAIModeration = "low" | "auto";

export type ImageGenerationOpenAIOptions = {
  background?: ImageGenerationOpenAIBackground;
  moderation?: ImageGenerationOpenAIModeration;
  outputCompression?: number;
  user?: string;
};

export type ImageGenerationProviderOptions = {
  openai?: ImageGenerationOpenAIOptions;
};

export type ImageGenerationIgnoredOverrideKey =
  | "size"
  | "aspectRatio"
  | "resolution"
  | "quality"
  | "outputFormat";

export type ImageGenerationIgnoredOverride = {
  key: ImageGenerationIgnoredOverrideKey;
  value: string;
};

export type ImageGenerationSourceImage = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

export type ImageGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  inputImages?: ImageGenerationSourceImage[];
  providerOptions?: ImageGenerationProviderOptions;
};

export type ImageGenerationResult = {
  images: GeneratedImageAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationModeCapabilities = {
  maxCount?: number;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
};

export type ImageGenerationEditCapabilities = ImageGenerationModeCapabilities & {
  enabled: boolean;
  maxInputImages?: number;
};

export type ImageGenerationGeometryCapabilities = {
  sizes?: string[];
  aspectRatios?: string[];
  resolutions?: ImageGenerationResolution[];
};

export type ImageGenerationOutputCapabilities = {
  qualities?: ImageGenerationQuality[];
  formats?: ImageGenerationOutputFormat[];
};

export type ImageGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<ImageGenerationResolution>;
};

export type ImageGenerationProviderCapabilities = {
  generate: ImageGenerationModeCapabilities;
  edit: ImageGenerationEditCapabilities;
  geometry?: ImageGenerationGeometryCapabilities;
  output?: ImageGenerationOutputCapabilities;
};

export type ImageGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: ImageGenerationProviderCapabilities;
  isConfigured?: (ctx: ImageGenerationProviderConfiguredContext) => boolean;
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
