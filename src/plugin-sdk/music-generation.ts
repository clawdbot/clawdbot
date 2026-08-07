// Public music-generation helpers and types for provider plugins.

export type {
  GeneratedMusicAsset,
  MusicGenerationEditCapabilities,
  MusicGenerationMode,
  MusicGenerationModeCapabilities,
  MusicGenerationProvider,
  MusicGenerationProviderCapabilities,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicGenerationSourceAudio,
  MusicGenerationSourceImage,
  MusicGenerationOutputFormat,
} from "../music-generation/types.js";
export {
  downloadGeneratedMusicAsset,
  extractGeneratedMusicFileCandidates,
  generatedMusicAssetFromBase64,
  type GeneratedMusicFileCandidate,
} from "../music-generation/provider-assets.js";
