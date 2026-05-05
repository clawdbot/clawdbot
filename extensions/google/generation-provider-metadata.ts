import type { MusicGenerationProvider } from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import type {
  VideoGenerationProvider,
  VideoGenerationProviderConfiguredContext,
} from "openclaw/plugin-sdk/video-generation";

export const DEFAULT_GOOGLE_MUSIC_MODEL = "lyria-3-clip-preview";
export const GOOGLE_PRO_MUSIC_MODEL = "lyria-3-pro-preview";
export const GOOGLE_MAX_INPUT_IMAGES = 10;

export const DEFAULT_GOOGLE_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
export const GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS = [4, 6, 8] as const;
export const GOOGLE_VIDEO_MIN_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[0];
export const GOOGLE_VIDEO_MAX_DURATION_SECONDS =
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.length - 1];

function isGoogleProviderConfigured(
  ctx: { agentDir?: string } | VideoGenerationProviderConfiguredContext,
): boolean {
  return isProviderApiKeyConfigured({
    provider: "google",
    agentDir: ctx.agentDir,
  });
}

export function createGoogleMusicGenerationProviderMetadata(): Omit<
  MusicGenerationProvider,
  "generateMusic"
> {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_MUSIC_MODEL,
    models: [DEFAULT_GOOGLE_MUSIC_MODEL, GOOGLE_PRO_MUSIC_MODEL],
    isConfigured: isGoogleProviderConfigured,
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormatsByModel: {
          [DEFAULT_GOOGLE_MUSIC_MODEL]: ["mp3"],
          [GOOGLE_PRO_MUSIC_MODEL]: ["mp3", "wav"],
        },
      },
      edit: {
        enabled: true,
        maxTracks: 1,
        maxInputImages: GOOGLE_MAX_INPUT_IMAGES,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormatsByModel: {
          [DEFAULT_GOOGLE_MUSIC_MODEL]: ["mp3"],
          [GOOGLE_PRO_MUSIC_MODEL]: ["mp3", "wav"],
        },
      },
    },
  };
}

export function createGoogleVideoGenerationProviderMetadata(): Omit<
  VideoGenerationProvider,
  "generateVideo"
> {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    models: [
      DEFAULT_GOOGLE_VIDEO_MODEL,
      "veo-3.1-generate-preview",
      "veo-3.1-lite-generate-preview",
      "veo-3.0-fast-generate-001",
      "veo-3.0-generate-001",
      "veo-2.0-generate-001",
    ],
    isConfigured: isGoogleProviderConfigured,
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: false,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: false,
      },
    },
  };
}
