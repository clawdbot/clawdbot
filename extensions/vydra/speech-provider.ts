import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asObject } from "openclaw/plugin-sdk/speech-core";
import {
  DEFAULT_VYDRA_BASE_URL,
  DEFAULT_VYDRA_SPEECH_MODEL,
  DEFAULT_VYDRA_VOICE_ID,
  downloadVydraAsset,
  extractVydraResultUrls,
  normalizeVydraBaseUrl,
  trimToUndefined,
} from "./shared.js";

type VydraSpeechConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voiceId: string;
};

const VYDRA_SPEECH_VOICES = [
  {
    id: DEFAULT_VYDRA_VOICE_ID,
    name: "Rachel",
  },
] as const;

function normalizeVydraSpeechConfig(rawConfig: Record<string, unknown>): VydraSpeechConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.vydra) ?? asObject(rawConfig.vydra);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.vydra.apiKey",
    }),
    baseUrl: normalizeVydraBaseUrl(
      trimToUndefined(raw?.baseUrl) ?? trimToUndefined(process.env.VYDRA_BASE_URL),
    ),
    model:
      trimToUndefined(raw?.model) ??
      trimToUndefined(process.env.VYDRA_TTS_MODEL) ??
      DEFAULT_VYDRA_SPEECH_MODEL,
    voiceId:
      trimToUndefined(raw?.voiceId) ??
      trimToUndefined(process.env.VYDRA_TTS_VOICE_ID) ??
      DEFAULT_VYDRA_VOICE_ID,
  };
}

function readVydraSpeechConfig(config: SpeechProviderConfig): VydraSpeechConfig {
  const normalized = normalizeVydraSpeechConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: normalizeVydraBaseUrl(trimToUndefined(config.baseUrl) ?? normalized.baseUrl),
    model: trimToUndefined(config.model) ?? normalized.model,
    voiceId: trimToUndefined(config.voiceId) ?? normalized.voiceId,
  };
}

function readVydraOverrides(overrides: SpeechProviderOverrides | undefined): {
  model?: string;
  voiceId?: string;
} {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model),
    voiceId: trimToUndefined(overrides.voiceId),
  };
}

export function buildVydraSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "vydra",
    label: "Vydra",
    models: [DEFAULT_VYDRA_SPEECH_MODEL],
    voices: VYDRA_SPEECH_VOICES.map((voice) => voice.id),
    resolveConfig: ({ rawConfig }) => normalizeVydraSpeechConfig(rawConfig),
    listVoices: async () => VYDRA_SPEECH_VOICES.map((voice) => ({ ...voice })),
    isConfigured: ({ providerConfig }) =>
      Boolean(readVydraSpeechConfig(providerConfig).apiKey || process.env.VYDRA_API_KEY),
    synthesize: async (req) => {
      const config = readVydraSpeechConfig(req.providerConfig);
      const overrides = readVydraOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.VYDRA_API_KEY;
      if (!apiKey) {
        throw new Error("Vydra API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: config.baseUrl,
          defaultBaseUrl: DEFAULT_VYDRA_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "vydra",
          capability: "audio",
          transport: "http",
        });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/models/${overrides.model ?? config.model}`,
        headers,
        body: {
          text: req.text,
          voice_id: overrides.voiceId ?? config.voiceId,
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "Vydra speech synthesis failed");
        const payload = await response.json();
        const audioUrl = extractVydraResultUrls(payload, "audio")[0];
        if (!audioUrl) {
          throw new Error("Vydra speech synthesis response missing audio URL");
        }
        const audio = await downloadVydraAsset({
          url: audioUrl,
          kind: "audio",
          timeoutMs: req.timeoutMs,
          fetchFn,
        });
        return {
          audioBuffer: audio.buffer,
          outputFormat: audio.mimeType.includes("wav") ? "wav" : "mp3",
          fileExtension: audio.fileName.endsWith(".wav") ? ".wav" : ".mp3",
          voiceCompatible: false,
        };
      } finally {
        await release();
      }
    },
  };
}
