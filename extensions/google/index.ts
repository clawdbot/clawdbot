import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { MusicGenerationProvider } from "openclaw/plugin-sdk/music-generation";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import {
  createGoogleMusicGenerationProviderMetadata,
  createGoogleVideoGenerationProviderMetadata,
} from "./generation-provider-metadata.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { registerGoogleProvider } from "./provider-registration.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { buildGoogleSpeechProvider } from "./speech-provider.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

let googleImageGenerationProviderPromise: Promise<ImageGenerationProvider> | null = null;
let googleMediaUnderstandingProviderPromise: Promise<MediaUnderstandingProvider> | null = null;
let googleMusicGenerationProviderPromise: Promise<MusicGenerationProvider> | null = null;
let googleVideoGenerationProviderPromise: Promise<VideoGenerationProvider> | null = null;

type GoogleMediaUnderstandingProvider = Required<
  Pick<
    MediaUnderstandingProvider,
    "describeImage" | "describeImages" | "transcribeAudio" | "describeVideo"
  >
>;

async function loadGoogleImageGenerationProvider(): Promise<ImageGenerationProvider> {
  if (!googleImageGenerationProviderPromise) {
    googleImageGenerationProviderPromise = import("./image-generation-provider.js").then((mod) =>
      mod.buildGoogleImageGenerationProvider(),
    );
  }
  return await googleImageGenerationProviderPromise;
}

async function loadGoogleMediaUnderstandingProvider(): Promise<MediaUnderstandingProvider> {
  if (!googleMediaUnderstandingProviderPromise) {
    googleMediaUnderstandingProviderPromise = import("./media-understanding-provider.js").then(
      (mod) => mod.googleMediaUnderstandingProvider,
    );
  }
  return await googleMediaUnderstandingProviderPromise;
}

async function loadGoogleMusicGenerationProvider(): Promise<MusicGenerationProvider> {
  if (!googleMusicGenerationProviderPromise) {
    googleMusicGenerationProviderPromise = import("./music-generation-provider.js").then((mod) =>
      mod.buildGoogleMusicGenerationProvider(),
    );
  }
  return await googleMusicGenerationProviderPromise;
}

async function loadGoogleVideoGenerationProvider(): Promise<VideoGenerationProvider> {
  if (!googleVideoGenerationProviderPromise) {
    googleVideoGenerationProviderPromise = import("./video-generation-provider.js").then((mod) =>
      mod.buildGoogleVideoGenerationProvider(),
    );
  }
  return await googleVideoGenerationProviderPromise;
}

async function loadGoogleRequiredMediaUnderstandingProvider(): Promise<GoogleMediaUnderstandingProvider> {
  const provider = await loadGoogleMediaUnderstandingProvider();
  if (
    !provider.describeImage ||
    !provider.describeImages ||
    !provider.transcribeAudio ||
    !provider.describeVideo
  ) {
    throw new Error("google media understanding provider missing required handlers");
  }
  return provider as GoogleMediaUnderstandingProvider;
}

function createLazyGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: "gemini-3.1-flash-image-preview",
    models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req),
  };
}

function createLazyGoogleMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "google",
    capabilities: ["image", "audio", "video"],
    defaultModels: {
      image: "gemini-3-flash-preview",
      audio: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    autoPriority: { image: 30, audio: 40, video: 10 },
    nativeDocumentInputs: ["pdf"],
    describeImage: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImage(...args),
    describeImages: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImages(...args),
    transcribeAudio: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).transcribeAudio(...args),
    describeVideo: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeVideo(...args),
  };
}

function createLazyGoogleMusicGenerationProvider(): MusicGenerationProvider {
  return {
    ...createGoogleMusicGenerationProviderMetadata(),
    generateMusic: async (...args) =>
      await (await loadGoogleMusicGenerationProvider()).generateMusic(...args),
  };
}

function createLazyGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createGoogleVideoGenerationProviderMetadata(),
    generateVideo: async (...args) =>
      await (await loadGoogleVideoGenerationProvider()).generateVideo(...args),
  };
}

export default definePluginEntry({
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    registerGoogleGeminiCliProvider(api);
    registerGoogleProvider(api);
    api.registerMemoryEmbeddingProvider(geminiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(createLazyGoogleMediaUnderstandingProvider());
    api.registerMusicGenerationProvider(createLazyGoogleMusicGenerationProvider());
    api.registerRealtimeVoiceProvider(buildGoogleRealtimeVoiceProvider());
    api.registerSpeechProvider(buildGoogleSpeechProvider());
    api.registerVideoGenerationProvider(createLazyGoogleVideoGenerationProvider());
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
