import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asFiniteNumber, asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import { volcengineTTS, type VolcengineTtsEncoding } from "./tts.js";

const DEFAULT_VOICE = "en_female_anna_mars_bigtts";
const DEFAULT_CLUSTER = "volcano_tts";
const DEFAULT_RESOURCE_ID = "seed-tts-1.0";
const DEFAULT_APP_KEY = "aGjiRDfUWi";

const VOLCENGINE_VOICES: readonly string[] = [
  "en_female_anna_mars_bigtts",
  "en_male_adam_mars_bigtts",
  "en_female_sarah_mars_bigtts",
  "en_male_smith_mars_bigtts",
  "zh_female_cancan_mars_bigtts",
  "zh_female_qingxinnvsheng_mars_bigtts",
  "zh_female_linjia_mars_bigtts",
  "zh_male_wennuanahu_moon_bigtts",
  "zh_male_shaonianzixin_moon_bigtts",
  "zh_female_shuangkuaisisi_moon_bigtts",
];

type VolcengineTtsProviderConfig = {
  apiKey?: string;
  appId?: string;
  token?: string;
  voice: string;
  cluster: string;
  resourceId: string;
  appKey: string;
  baseUrl?: string;
  speedRatio?: number;
  emotion?: string;
};

type VolcengineTtsProviderOverrides = {
  voice?: string;
  speedRatio?: number;
  emotion?: string;
};

function normalizeVolcengineProviderConfig(
  rawConfig: Record<string, unknown>,
): VolcengineTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.volcengine) ?? asObject(rawConfig.volcengine);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.volcengine.apiKey",
    }),
    appId: trimToUndefined(raw?.appId),
    token: normalizeResolvedSecretInputString({
      value: raw?.token,
      path: "messages.tts.providers.volcengine.token",
    }),
    voice:
      trimToUndefined(raw?.voice) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_VOICE) ??
      DEFAULT_VOICE,
    cluster:
      trimToUndefined(raw?.cluster) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_CLUSTER) ??
      DEFAULT_CLUSTER,
    resourceId:
      trimToUndefined(raw?.resourceId) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_RESOURCE_ID) ??
      DEFAULT_RESOURCE_ID,
    appKey:
      trimToUndefined(raw?.appKey) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_APP_KEY) ??
      DEFAULT_APP_KEY,
    baseUrl: trimToUndefined(raw?.baseUrl) ?? trimToUndefined(process.env.VOLCENGINE_TTS_BASE_URL),
    speedRatio: asFiniteNumber(raw?.speedRatio),
    emotion: trimToUndefined(raw?.emotion),
  };
}

function resolveSeedSpeechApiKey(configApiKey?: string): string | undefined {
  return (
    configApiKey ??
    trimToUndefined(process.env.VOLCENGINE_TTS_API_KEY) ??
    trimToUndefined(process.env.BYTEPLUS_SEED_SPEECH_API_KEY)
  );
}

function readProviderConfig(config: SpeechProviderConfig): VolcengineTtsProviderConfig {
  const normalized = normalizeVolcengineProviderConfig({});
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: config.apiKey,
        path: "messages.tts.providers.volcengine.apiKey",
      }) ?? normalized.apiKey,
    appId: trimToUndefined(config.appId) ?? normalized.appId,
    token: trimToUndefined(config.token) ?? normalized.token,
    voice: trimToUndefined(config.voice) ?? normalized.voice,
    cluster: trimToUndefined(config.cluster) ?? normalized.cluster,
    resourceId: trimToUndefined(config.resourceId) ?? normalized.resourceId,
    appKey: trimToUndefined(config.appKey) ?? normalized.appKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    speedRatio: asFiniteNumber(config.speedRatio) ?? normalized.speedRatio,
    emotion: trimToUndefined(config.emotion) ?? normalized.emotion,
  };
}

function readVolcengineOverrides(
  overrides: SpeechProviderOverrides | undefined,
): VolcengineTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voice: trimToUndefined(overrides.voice),
    speedRatio: asFiniteNumber(overrides.speedRatio),
    emotion: trimToUndefined(overrides.emotion),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voice":
    case "volcengine_voice":
    case "volcenginevoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, voice: ctx.value } };
    case "speed":
    case "speedratio":
    case "speed_ratio": {
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      const speedRatio = Number(ctx.value);
      if (!Number.isFinite(speedRatio) || speedRatio < 0.2 || speedRatio > 3.0) {
        return { handled: true, warnings: [`invalid Volcengine speedRatio "${ctx.value}"`] };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, speedRatio } };
    }
    case "emotion":
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, emotion: ctx.value } };
    default:
      return { handled: false };
  }
}

export function buildVolcengineSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "volcengine",
    label: "Volcengine",
    autoSelectOrder: 90,
    aliases: ["bytedance", "doubao"],
    voices: VOLCENGINE_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeVolcengineProviderConfig(rawConfig),
    parseDirectiveToken,

    listVoices: async () =>
      VOLCENGINE_VOICES.map((v) => ({
        id: v,
        name: v.replace(/^(?:en|zh)_(female|male)_/, "").replace(/_.*$/, ""),
        locale: v.startsWith("en_") ? "en-US" : "zh-CN",
        gender: v.includes("_female_") ? "female" : "male",
      })),

    isConfigured: ({ providerConfig }) => {
      const cfg = readProviderConfig(providerConfig);
      return Boolean(
        resolveSeedSpeechApiKey(cfg.apiKey) ||
        ((cfg.appId || process.env.VOLCENGINE_TTS_APPID) &&
          (cfg.token || process.env.VOLCENGINE_TTS_TOKEN)),
      );
    },

    synthesize: async (req) => {
      const cfg = readProviderConfig(req.providerConfig);
      const overrides = readVolcengineOverrides(req.providerOverrides);
      const apiKey = resolveSeedSpeechApiKey(cfg.apiKey);
      const appId = cfg.appId || process.env.VOLCENGINE_TTS_APPID;
      const token = cfg.token || process.env.VOLCENGINE_TTS_TOKEN;

      if (!apiKey && (!appId || !token)) {
        throw new Error(
          "Volcengine TTS credentials missing. Set VOLCENGINE_TTS_API_KEY, " +
            "BYTEPLUS_SEED_SPEECH_API_KEY, or legacy VOLCENGINE_TTS_APPID and VOLCENGINE_TTS_TOKEN.",
        );
      }

      const isVoiceNote = req.target === "voice-note";
      const encoding: VolcengineTtsEncoding = isVoiceNote ? "ogg_opus" : "mp3";

      const audioBuffer = await volcengineTTS({
        text: req.text,
        apiKey,
        appId,
        token,
        voice: overrides.voice ?? cfg.voice,
        cluster: cfg.cluster,
        resourceId: cfg.resourceId,
        appKey: cfg.appKey,
        baseUrl: cfg.baseUrl,
        speedRatio: overrides.speedRatio ?? cfg.speedRatio,
        emotion: overrides.emotion ?? cfg.emotion,
        encoding,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: encoding === "ogg_opus" ? "opus" : "mp3",
        fileExtension: encoding === "ogg_opus" ? ".opus" : ".mp3",
        voiceCompatible: isVoiceNote,
      };
    },
  };
}
