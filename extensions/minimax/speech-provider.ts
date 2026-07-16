// Minimax provider module implements model/runtime integration.
import { transcodeAudioBufferToOpus } from "openclaw/plugin-sdk/media-runtime";
import {
  isProviderAuthProfileConfigured,
  type OpenClawConfig,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import {
  asObject,
  parseSpeechDirectiveNumberOverride,
  resolveSpeechProviderApiKey,
  trimToUndefined,
} from "openclaw/plugin-sdk/speech-core";
import { asFiniteNumberInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MINIMAX_TTS_BASE_URL,
  MINIMAX_TTS_MODELS,
  MINIMAX_TTS_VOICES,
  minimaxTTS,
  normalizeMinimaxTtsBaseUrl,
} from "./tts.js";

const MINIMAX_PORTAL_PROVIDER_ID = "minimax-portal";
const MINIMAX_TOKEN_PLAN_ENV_VARS = [
  "MINIMAX_OAUTH_TOKEN",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
] as const;

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

function resolveConfiguredPortalTtsBaseUrl(cfg: OpenClawConfig | undefined): string | undefined {
  const providers = asObject(asObject(cfg?.models)?.providers);
  const portalProvider = asObject(providers?.[MINIMAX_PORTAL_PROVIDER_ID]);
  const portalBaseUrl = trimToUndefined(portalProvider?.baseUrl);
  return portalBaseUrl ? normalizeMinimaxTtsBaseUrl(portalBaseUrl) : undefined;
}

function resolveMinimaxTokenPlanEnvKey(): string | undefined {
  return resolveSpeechProviderApiKey(
    ...MINIMAX_TOKEN_PLAN_ENV_VARS.map((envVar) => process.env[envVar]),
  );
}

async function resolveMinimaxPortalProfileToken(
  cfg: OpenClawConfig | undefined,
): Promise<string | undefined> {
  return await resolveProviderAuthProfileApiKey({
    cfg,
    provider: MINIMAX_PORTAL_PROVIDER_ID,
  });
}

async function resolveMinimaxTtsApiKey(params: {
  cfg: OpenClawConfig | undefined;
  configApiKey?: string;
}): Promise<string | undefined> {
  return resolveSpeechProviderApiKey(
    params.configApiKey,
    await resolveMinimaxPortalProfileToken(params.cfg),
    resolveMinimaxDirectTtsApiKey(),
  );
}

function resolveMinimaxDirectTtsApiKey(configApiKey?: string): string | undefined {
  return resolveSpeechProviderApiKey(
    configApiKey,
    resolveMinimaxTokenPlanEnvKey(),
    process.env.MINIMAX_API_KEY,
  );
}

function normalizeMinimaxProviderConfig(
  rawConfig: Record<string, unknown>,
  cfg?: OpenClawConfig,
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
        resolveConfiguredPortalTtsBaseUrl(cfg) ??
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
    speed: normalizeMinimaxSpeed(raw?.speed),
    vol: normalizeMinimaxVolume(raw?.vol),
    pitch: normalizeMinimaxPitch(raw?.pitch),
  };
}

function normalizeMinimaxSpeed(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0.5, max: 2 });
}

function normalizeMinimaxVolume(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0, max: 10, minExclusive: true });
}

function normalizeMinimaxPitch(value: unknown): number | undefined {
  const pitch = asFiniteNumberInRange(value, { min: -12, max: 12 });
  return pitch !== undefined ? Math.trunc(pitch) : undefined;
}

function readMinimaxProviderConfig(
  config: SpeechProviderConfig,
  cfg?: OpenClawConfig,
): MinimaxTtsProviderConfig {
  const normalized = normalizeMinimaxProviderConfig({}, cfg);
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: normalizeMinimaxTtsBaseUrl(trimToUndefined(config.baseUrl) ?? normalized.baseUrl),
    model: trimToUndefined(config.model) ?? normalized.model,
    voiceId: trimToUndefined(config.voiceId) ?? normalized.voiceId,
    speed: normalizeMinimaxSpeed(config.speed) ?? normalized.speed,
    vol: normalizeMinimaxVolume(config.vol) ?? normalized.vol,
    pitch: normalizeMinimaxPitch(config.pitch) ?? normalized.pitch,
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
    speed: normalizeMinimaxSpeed(overrides.speed),
    vol: normalizeMinimaxVolume(overrides.vol),
    pitch: normalizeMinimaxPitch(overrides.pitch),
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
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid MiniMax speed "${value}" (0.5-2.0)`,
      });
    }
    case "vol":
    case "volume": {
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "vol",
        range: { min: 0, minExclusive: true, max: 10 },
        warning: (value) =>
          `invalid MiniMax volume "${value}" (must be greater than 0 and at most 10)`,
      });
    }
    case "pitch": {
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "pitch",
        range: { min: -12, max: 12 },
        warning: (value) => `invalid MiniMax pitch "${value}" (-12 to 12)`,
      });
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
    defaultModel: MINIMAX_TTS_MODELS[0],
    models: MINIMAX_TTS_MODELS,
    voices: MINIMAX_TTS_VOICES,
    resolveConfig: ({ rawConfig, cfg }) => normalizeMinimaxProviderConfig(rawConfig, cfg),
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
        ...(normalizeMinimaxSpeed(talkProviderConfig.speed) == null
          ? {}
          : { speed: normalizeMinimaxSpeed(talkProviderConfig.speed) }),
        ...(normalizeMinimaxVolume(talkProviderConfig.vol) == null
          ? {}
          : { vol: normalizeMinimaxVolume(talkProviderConfig.vol) }),
        ...(normalizeMinimaxPitch(talkProviderConfig.pitch) == null
          ? {}
          : { pitch: normalizeMinimaxPitch(talkProviderConfig.pitch) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: trimToUndefined(params.modelId) }),
      ...(normalizeMinimaxSpeed(params.speed) == null
        ? {}
        : { speed: normalizeMinimaxSpeed(params.speed) }),
      ...(normalizeMinimaxVolume(params.vol) == null
        ? {}
        : { vol: normalizeMinimaxVolume(params.vol) }),
      ...(normalizeMinimaxPitch(params.pitch) == null
        ? {}
        : { pitch: normalizeMinimaxPitch(params.pitch) }),
    }),
    listVoices: async () => MINIMAX_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        resolveMinimaxDirectTtsApiKey(readMinimaxProviderConfig(providerConfig, cfg).apiKey) ||
        isProviderAuthProfileConfigured({ cfg, provider: MINIMAX_PORTAL_PROVIDER_ID }),
      ),
    synthesize: async (req) => {
      const config = readMinimaxProviderConfig(req.providerConfig, req.cfg);
      const overrides = readMinimaxOverrides(req.providerOverrides);
      const apiKey = await resolveMinimaxTtsApiKey({
        cfg: req.cfg,
        configApiKey: config.apiKey,
      });
      if (!apiKey) {
        throw new Error("MiniMax TTS auth missing");
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
      if (req.target === "voice-note") {
        const opusBuffer = await transcodeAudioBufferToOpus({
          audioBuffer,
          inputExtension: "mp3",
          tempPrefix: "tts-minimax-",
          timeoutMs: req.timeoutMs,
        });
        return {
          audioBuffer: opusBuffer,
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
