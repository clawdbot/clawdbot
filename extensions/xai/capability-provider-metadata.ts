import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import {
  isProviderApiKeyConfigured,
  isProviderAuthProfileConfigured,
} from "openclaw/plugin-sdk/provider-auth";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/realtime-transcription";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  isRecord,
  normalizeOptionalString,
  parseBooleanValue,
  parseFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
} from "openclaw/plugin-sdk/video-generation";
import { XAI_DEFAULT_IMAGE_MODEL, XAI_IMAGE_MODELS } from "./model-definitions.js";
import {
  XAI_REALTIME_DEFAULT_MODEL,
  XAI_REALTIME_VOICES,
  hasXaiRealtimeApiKeyInput,
  normalizeXaiRealtimeProviderConfig,
} from "./realtime-voice-config.js";

export const XAI_IMAGE_DEFAULT_TIMEOUT_MS = 600_000;
export const XAI_SUPPORTED_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

export function createXaiImageGenerationProviderMetadata() {
  return {
    id: "xai",
    label: "xAI",
    defaultModel: XAI_DEFAULT_IMAGE_MODEL,
    defaultTimeoutMs: XAI_IMAGE_DEFAULT_TIMEOUT_MS,
    models: [...XAI_IMAGE_MODELS],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 3,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: false,
      },
      geometry: {
        aspectRatios: [...XAI_SUPPORTED_IMAGE_ASPECT_RATIOS],
        resolutions: ["1K", "2K"],
      },
    },
  } satisfies Omit<ImageGenerationProvider, "generateImage">;
}

export function createXaiMediaUnderstandingProviderMetadata() {
  return {
    id: "xai",
    capabilities: ["audio"],
    autoPriority: { audio: 25 },
  } satisfies Omit<MediaUnderstandingProvider, "transcribeAudio">;
}

export const DEFAULT_XAI_VIDEO_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
const XAI_VIDEO_15_MODEL = "grok-imagine-video-1.5";
export const XAI_VIDEO_DEFAULT_TIMEOUT_MS = 600_000;
export const XAI_VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const XAI_VIDEO_15_CAPABILITIES = {
  imageToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 1,
    maxDurationSeconds: 15,
    aspectRatios: [...XAI_VIDEO_ASPECT_RATIOS],
    resolutions: ["480P", "720P", "1080P"],
    supportsAspectRatio: true,
    supportsResolution: true,
  },
  videoToVideo: {
    enabled: false,
  },
} satisfies VideoGenerationProviderCapabilities;

const XAI_VIDEO_15_MODEL_IDS = new Set([
  XAI_VIDEO_15_MODEL,
  "grok-imagine-video-1.5-preview",
  "grok-imagine-video-1.5-2026-05-30",
]);

export function isXaiVideo15Model(model: string | undefined): boolean {
  const normalized = normalizeOptionalString(model);
  return normalized ? XAI_VIDEO_15_MODEL_IDS.has(normalized) : false;
}

export function createXaiVideoGenerationProviderMetadata() {
  return {
    id: "xai",
    label: "xAI",
    defaultModel: DEFAULT_XAI_VIDEO_MODEL,
    defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
    models: [DEFAULT_XAI_VIDEO_MODEL, XAI_VIDEO_15_MODEL],
    catalogByModel: {
      [XAI_VIDEO_15_MODEL]: {
        capabilities: XAI_VIDEO_15_CAPABILITIES,
        modes: ["imageToVideo"],
      },
    },
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: "xai", ...ctx }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 15,
        aspectRatios: [...XAI_VIDEO_ASPECT_RATIOS],
        resolutions: ["480P", "720P"],
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 7,
        maxDurationSeconds: 15,
        aspectRatios: [...XAI_VIDEO_ASPECT_RATIOS],
        resolutions: ["480P", "720P"],
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        maxDurationSeconds: 10,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
    },
    resolveModelCapabilities: ({ model }) =>
      isXaiVideo15Model(model) ? XAI_VIDEO_15_CAPABILITIES : undefined,
  } satisfies Omit<VideoGenerationProvider, "generateVideo">;
}

export type XaiRealtimeTranscriptionEncoding = "pcm" | "mulaw" | "alaw";

type XaiRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  sampleRate?: number;
  encoding?: XaiRealtimeTranscriptionEncoding;
  interimResults?: boolean;
  endpointingMs?: number;
  language?: string;
};

function normalizeRealtimeTranscriptionEncoding(
  value: unknown,
): XaiRealtimeTranscriptionEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "ulaw" || normalized === "g711_ulaw" || normalized === "g711-mulaw") {
    return "mulaw";
  }
  if (normalized === "g711_alaw" || normalized === "g711-alaw") {
    return "alaw";
  }
  if (normalized === "pcm" || normalized === "mulaw" || normalized === "alaw") {
    return normalized;
  }
  throw new Error(`Invalid xAI realtime transcription encoding: ${normalized}`);
}

export function normalizeXaiRealtimeTranscriptionProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): XaiRealtimeTranscriptionProviderConfig {
  const raw = isRecord(config) ? config : undefined;
  const providers = isRecord(raw?.providers) ? raw.providers : undefined;
  const nested = providers?.xai ?? raw?.xai ?? raw;
  const xai = isRecord(nested) ? nested : {};
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: xai.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(xai.baseUrl),
    sampleRate: parseFiniteNumber(xai.sampleRate ?? xai.sample_rate),
    encoding: normalizeRealtimeTranscriptionEncoding(xai.encoding),
    interimResults: parseBooleanValue(xai.interimResults ?? xai.interim_results),
    endpointingMs: parseFiniteNumber(xai.endpointingMs ?? xai.endpointing ?? xai.silenceDurationMs),
    language: normalizeOptionalString(xai.language),
  };
}

export function createXaiRealtimeTranscriptionProviderMetadata() {
  return {
    id: "xai",
    label: "xAI Realtime Transcription",
    aliases: ["xai-realtime", "grok-stt-streaming"],
    autoSelectOrder: 25,
    resolveConfig: ({ rawConfig }) => normalizeXaiRealtimeTranscriptionProviderConfig(rawConfig),
    isConfigured: ({ providerConfig, cfg }) =>
      Boolean(
        normalizeXaiRealtimeTranscriptionProviderConfig(providerConfig).apiKey ??
        normalizeOptionalString(process.env.XAI_API_KEY),
      ) || isProviderAuthProfileConfigured({ provider: "xai", cfg }),
  } satisfies Omit<RealtimeTranscriptionProviderPlugin, "createSession">;
}

const XAI_REALTIME_AUDIO_FORMAT_G711_ULAW_8KHZ = {
  encoding: "g711_ulaw",
  sampleRateHz: 8000,
  channels: 1,
} satisfies RealtimeVoiceAudioFormat;
const XAI_REALTIME_AUDIO_FORMAT_PCM16_24KHZ = {
  encoding: "pcm16",
  sampleRateHz: 24000,
  channels: 1,
} satisfies RealtimeVoiceAudioFormat;

export function createXaiRealtimeVoiceProviderMetadata() {
  return {
    id: "xai",
    label: "xAI Grok Voice",
    aliases: ["xai-realtime-voice", "grok-voice"],
    defaultModel: XAI_REALTIME_DEFAULT_MODEL,
    voices: XAI_REALTIME_VOICES,
    autoSelectOrder: 25,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [
        XAI_REALTIME_AUDIO_FORMAT_G711_ULAW_8KHZ,
        XAI_REALTIME_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        XAI_REALTIME_AUDIO_FORMAT_G711_ULAW_8KHZ,
        XAI_REALTIME_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
      supportsSessionResumption: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeXaiRealtimeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig, cfg }) =>
      hasXaiRealtimeApiKeyInput(normalizeXaiRealtimeProviderConfig(providerConfig).apiKey, cfg),
  } satisfies Omit<RealtimeVoiceProviderPlugin, "createBridge" | "createBrowserSession">;
}

export function assertXaiRealtimeVoiceRequestSupported(
  req: RealtimeVoiceBridgeCreateRequest,
): void {
  const config = normalizeXaiRealtimeProviderConfig(req.providerConfig);
  if (req.autoRespondToAudio === false) {
    throw new Error(
      'xAI realtime voice requires automatic server-VAD responses; use consultRouting: "provider-direct"',
    );
  }
  if ((req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio) === false) {
    throw new Error("xAI realtime voice requires automatic server-VAD interruption handling");
  }
}
