import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asFiniteNumber, asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  DEFAULT_MINIMAX_TTS_BASE_URL,
  MINIMAX_TTS_MODELS,
  MINIMAX_TTS_VOICES,
  minimaxTTS,
  normalizeMinimaxTtsBaseUrl,
} from "./tts.js";

type MinimaxTtsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed?: number;
  vol?: number;
  pitch?: number;
};

type MinimaxTtsProviderOverrides = {
  model?: string;
  voiceId?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
};

function normalizeMinimaxProviderConfig(
  rawConfig: Record<string, unknown>,
): MinimaxTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.minimax) ?? asObject(rawConfig.minimax);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.minimax.apiKey",
    }),
    baseUrl: normalizeMinimaxTtsBaseUrl(
      trimToUndefined(raw?.baseUrl) ??
        trimToUndefined(process.env.MINIMAX_API_HOST) ??
        DEFAULT_MINIMAX_TTS_BASE_URL,
    ),
    model:
      trimToUndefined(raw?.model) ??
      trimToUndefined(process.env.MINIMAX_TTS_MODEL) ??
      "speech-2.8-hd",
    voiceId:
      trimToUndefined(raw?.voiceId) ??
      trimToUndefined(process.env.MINIMAX_TTS_VOICE_ID) ??
      "English_expressive_narrator",
    speed: asFiniteNumber(raw?.speed),
    vol: asFiniteNumber(raw?.vol),
    pitch: asFiniteNumber(raw?.pitch),
  };
}

function readMinimaxProviderConfig(config: SpeechProviderConfig): MinimaxTtsProviderConfig {
  const normalized = normalizeMinimaxProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    model: trimToUndefined(config.model) ?? normalized.model,
    voiceId: trimToUndefined(config.voiceId) ?? normalized.voiceId,
    speed: asFiniteNumber(config.speed) ?? normalized.speed,
    vol: asFiniteNumber(config.vol) ?? normalized.vol,
    pitch: asFiniteNumber(config.pitch) ?? normalized.pitch,
  };
}

function readMinimaxOverrides(
  overrides: SpeechProviderOverrides | undefined,
): MinimaxTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model),
    voiceId: trimToUndefined(overrides.voiceId),
    speed: asFiniteNumber(overrides.speed),
    vol: asFiniteNumber(overrides.vol),
    pitch: asFiniteNumber(overrides.pitch),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "minimax_voice":
    case "minimaxvoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceId: ctx.value } };
    case "model":
    case "minimax_model":
    case "minimaxmodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    case "speed": {
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      const speed = Number(ctx.value);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
        return { handled: true, warnings: [`invalid MiniMax speed "${ctx.value}" (0.5-2.0)`] };
      }
      return { handled: true, overrides: { speed } };
    }
    case "vol":
    case "volume": {
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      const vol = Number(ctx.value);
      if (!Number.isFinite(vol) || vol <= 0 || vol > 10) {
        return {
          handled: true,
          warnings: [`invalid MiniMax volume "${ctx.value}" (0-10, exclusive)`],
        };
      }
      return { handled: true, overrides: { vol } };
    }
    case "pitch": {
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      const pitch = Number(ctx.value);
      if (!Number.isFinite(pitch) || pitch < -12 || pitch > 12) {
        return { handled: true, warnings: [`invalid MiniMax pitch "${ctx.value}" (-12 to 12)`] };
      }
      return { handled: true, overrides: { pitch } };
    }
    default:
      return { handled: false };
  }
}

export function buildMinimaxSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    autoSelectOrder: 40,
    models: MINIMAX_TTS_MODELS,
    voices: MINIMAX_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeMinimaxProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeMinimaxProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.minimax.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeMinimaxTtsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asFiniteNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asFiniteNumber(talkProviderConfig.speed) }),
        ...(asFiniteNumber(talkProviderConfig.vol) == null
          ? {}
          : { vol: asFiniteNumber(talkProviderConfig.vol) }),
        ...(asFiniteNumber(talkProviderConfig.pitch) == null
          ? {}
          : { pitch: asFiniteNumber(talkProviderConfig.pitch) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: trimToUndefined(params.modelId) }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
      ...(asFiniteNumber(params.vol) == null ? {} : { vol: asFiniteNumber(params.vol) }),
      ...(asFiniteNumber(params.pitch) == null ? {} : { pitch: asFiniteNumber(params.pitch) }),
    }),
    listVoices: async () => MINIMAX_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ providerConfig }) =>
      Boolean(readMinimaxProviderConfig(providerConfig).apiKey || process.env.MINIMAX_API_KEY),
    synthesize: async (req) => {
      const config = readMinimaxProviderConfig(req.providerConfig);
      const overrides = readMinimaxOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrides.model ?? config.model,
        voiceId: overrides.voiceId ?? config.voiceId,
        speed: overrides.speed ?? config.speed,
        vol: overrides.vol ?? config.vol,
        pitch: overrides.pitch ?? config.pitch,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
