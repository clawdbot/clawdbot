// Xai provider module implements model/runtime integration.
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createXaiSpeechProviderMetadata,
  readXaiSpeechOverrides,
  readXaiSpeechProviderConfig,
  resolveDirectXaiAudioApiKey,
  resolveXaiSpeechResponseFormat,
  xaiSpeechResponseFormatToFileExtension,
  XAI_TTS_FALLBACK_VOICES,
  normalizeXaiTtsBaseUrl,
  type XaiSpeechResponseFormat,
} from "./speech-provider-metadata.js";
import { listXaiTtsVoices, xaiTTS, xaiTTSStream } from "./tts.js";

async function resolveXaiSpeechSynthesisRequest(
  req: Pick<
    SpeechSynthesisRequest,
    "cfg" | "providerConfig" | "providerOverrides" | "text" | "timeoutMs"
  > & { target?: SpeechSynthesisTarget },
  forcedResponseFormat?: XaiSpeechResponseFormat,
) {
  const config = readXaiSpeechProviderConfig(req.providerConfig);
  const overrides = readXaiSpeechOverrides(req.providerOverrides);
  return {
    text: req.text,
    apiKey: await resolveXaiAudioApiKey(config.apiKey, req.cfg),
    baseUrl: config.baseUrl,
    voiceId: overrides.voiceId ?? config.voiceId,
    language: overrides.language ?? config.language,
    speed: overrides.speed ?? config.speed,
    responseFormat:
      forcedResponseFormat ?? resolveXaiSpeechResponseFormat(req.target, config.responseFormat),
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
  };
}

export function buildXaiSpeechProvider(): SpeechProviderPlugin {
  return {
    ...createXaiSpeechProviderMetadata(),
    listVoices: async (req) => {
      const config = readXaiSpeechProviderConfig(req.providerConfig ?? {});
      const directApiKey = normalizeOptionalString(req.apiKey) ?? config.apiKey;
      const apiKey = await resolveOptionalXaiAudioApiKey(directApiKey, req.cfg);
      if (!apiKey) {
        return XAI_TTS_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice }));
      }
      return await listXaiTtsVoices({
        apiKey,
        baseUrl: normalizeXaiTtsBaseUrl(normalizeOptionalString(req.baseUrl) ?? config.baseUrl),
      });
    },
    synthesize: async (req) => {
      const params = await resolveXaiSpeechSynthesisRequest(req);
      return {
        audioBuffer: await xaiTTS(params),
        outputFormat: params.responseFormat,
        fileExtension: xaiSpeechResponseFormatToFileExtension(params.responseFormat),
        voiceCompatible: false,
      };
    },
    streamSynthesize: async (req) => {
      const params = await resolveXaiSpeechSynthesisRequest(req);
      const stream = await xaiTTSStream(params);
      return {
        audioStream: stream.audioStream,
        outputFormat: params.responseFormat,
        fileExtension: xaiSpeechResponseFormatToFileExtension(params.responseFormat),
        voiceCompatible: false,
        release: stream.release,
      };
    },
    synthesizeTelephony: async (req) => {
      const params = await resolveXaiSpeechSynthesisRequest(req, "pcm");
      return { audioBuffer: await xaiTTS(params), outputFormat: "pcm", sampleRate: 24000 };
    },
  };
}

// Resolve an xAI bearer for `/v1/tts`:
// 1. Configured `tts.providers.xai.apiKey` (or talk equivalent)
// 2. `XAI_API_KEY` env var
// 3. xAI OAuth auth profile (cfg-scoped)
async function resolveOptionalXaiAudioApiKey(
  configApiKey: string | undefined,
  cfg?: OpenClawConfig,
): Promise<string | undefined> {
  const direct = resolveDirectXaiAudioApiKey(configApiKey);
  if (direct) {
    return direct;
  }
  if (!cfg) {
    return undefined;
  }
  const auth = await resolveApiKeyForProvider({ provider: "xai", cfg });
  return normalizeOptionalString(auth?.apiKey);
}

async function resolveXaiAudioApiKey(
  configApiKey: string | undefined,
  cfg: OpenClawConfig,
): Promise<string> {
  const apiKey = await resolveOptionalXaiAudioApiKey(configApiKey, cfg);
  if (apiKey) {
    return apiKey;
  }
  throw new Error(
    "xAI credentials missing for TTS. Sign in with `openclaw onboard --auth-choice xai-oauth`, or run `openclaw onboard --auth-choice xai-api-key`, or set XAI_API_KEY.",
  );
}
