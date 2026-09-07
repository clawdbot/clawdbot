// Vydra provider module implements model/runtime integration.
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_VYDRA_BASE_URL,
  DEFAULT_VYDRA_SPEECH_MODEL,
  DEFAULT_VYDRA_VOICE_ID,
  normalizeVydraBaseUrl,
} from "./defaults.js";

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
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.vydra) ?? asOptionalRecord(rawConfig.vydra);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.vydra.apiKey",
    }),
    baseUrl: normalizeVydraBaseUrl(
      normalizeOptionalString(raw?.baseUrl) ?? normalizeOptionalString(process.env.VYDRA_BASE_URL),
    ),
    model:
      normalizeOptionalString(raw?.model) ??
      normalizeOptionalString(process.env.VYDRA_TTS_MODEL) ??
      DEFAULT_VYDRA_SPEECH_MODEL,
    voiceId:
      normalizeOptionalString(raw?.voiceId) ??
      normalizeOptionalString(process.env.VYDRA_TTS_VOICE_ID) ??
      DEFAULT_VYDRA_VOICE_ID,
  };
}

function readVydraSpeechConfig(config: SpeechProviderConfig): VydraSpeechConfig {
  const normalized = normalizeVydraSpeechConfig({});
  return {
    apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
    baseUrl: normalizeVydraBaseUrl(normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl),
    model: normalizeOptionalString(config.model) ?? normalized.model,
    voiceId: normalizeOptionalString(config.voiceId) ?? normalized.voiceId,
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
    model: normalizeOptionalString(overrides.model),
    voiceId: normalizeOptionalString(overrides.voiceId),
  };
}

export function buildVydraSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "vydra",
    label: "Vydra",
    models: [DEFAULT_VYDRA_SPEECH_MODEL],
    voices: VYDRA_SPEECH_VOICES.map((voice) => voice.id),
    resolveConfig: ({ rawConfig }) => normalizeVydraSpeechConfig(rawConfig),
    listVoices: async () => VYDRA_SPEECH_VOICES.map((voice) => Object.assign({}, voice)),
    isConfigured: ({ providerConfig }) =>
      Boolean(
        resolveSpeechProviderApiKey(
          readVydraSpeechConfig(providerConfig).apiKey,
          process.env.VYDRA_API_KEY,
        ),
      ),
    synthesize: async (req) => {
      const { downloadVydraAsset, extractVydraResultUrls } = await import("./shared.js");
      const config = readVydraSpeechConfig(req.providerConfig);
      const overrides = readVydraOverrides(req.providerOverrides);
      const apiKey = resolveSpeechProviderApiKey(config.apiKey, process.env.VYDRA_API_KEY);
      if (!apiKey) {
        throw new Error("Vydra API key missing");
      }
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      const {
        assertOkOrThrowHttpError,
        postJsonRequest,
        readProviderJsonResponse,
        resolveProviderHttpRequestConfig,
      } = await import("openclaw/plugin-sdk/provider-http");

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
        const payload = await readProviderJsonResponse<unknown>(response, "Vydra speech synthesis");
        const audioUrl = extractVydraResultUrls(payload, "audio")[0];
        if (!audioUrl) {
          throw new Error("Vydra speech synthesis response missing audio URL");
        }
        const audio = await downloadVydraAsset({
          url: audioUrl,
          kind: "audio",
          timeoutMs: req.timeoutMs,
          fetchFn,
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
          requestPolicy: {
            allowPrivateNetwork,
            dispatcherPolicy,
            headers,
            headerOrigin: new URL(baseUrl).origin,
          },
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
