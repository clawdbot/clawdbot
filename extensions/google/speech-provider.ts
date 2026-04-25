import { assertOkOrThrowProviderError, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveGoogleGenerativeAiHttpRequestConfig } from "./api.js";

const DEFAULT_GOOGLE_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GOOGLE_TTS_VOICE = "Kore";
const GOOGLE_TTS_SAMPLE_RATE = 24_000;
const GOOGLE_TTS_CHANNELS = 1;
const GOOGLE_TTS_BITS_PER_SAMPLE = 16;

const GOOGLE_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

type GoogleTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
};

type GoogleTtsProviderOverrides = {
  model?: string;
  voiceName?: string;
  audioProfile?: string;
  speakerName?: string;
};

type Maybe<T> = T | undefined;

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateSpeechResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
};

function normalizeGoogleTtsModel(model: unknown): string {
  const trimmed = normalizeOptionalString(model);
  if (!trimmed) {
    return DEFAULT_GOOGLE_TTS_MODEL;
  }
  const withoutProvider = trimmed.startsWith("google/") ? trimmed.slice("google/".length) : trimmed;
  return withoutProvider === "gemini-3.1-flash-tts" ? DEFAULT_GOOGLE_TTS_MODEL : withoutProvider;
}

function normalizeGoogleTtsVoiceName(voiceName: unknown): string {
  return normalizeOptionalString(voiceName) ?? DEFAULT_GOOGLE_TTS_VOICE;
}

function resolveGoogleTtsEnvApiKey(): string | undefined {
  return (
    normalizeOptionalString(process.env.GEMINI_API_KEY) ??
    normalizeOptionalString(process.env.GOOGLE_API_KEY)
  );
}

function resolveGoogleTtsModelProviderApiKey(cfg?: OpenClawConfig): string | undefined {
  return normalizeResolvedSecretInputString({
    value: cfg?.models?.providers?.google?.apiKey,
    path: "models.providers.google.apiKey",
  });
}

function resolveGoogleTtsApiKey(params: {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
}): string | undefined {
  return (
    readGoogleTtsProviderConfig(params.providerConfig).apiKey ??
    resolveGoogleTtsModelProviderApiKey(params.cfg) ??
    resolveGoogleTtsEnvApiKey()
  );
}

function resolveGoogleTtsBaseUrl(params: {
  cfg?: OpenClawConfig;
  providerConfig: GoogleTtsProviderConfig;
}): string | undefined {
  return (
    params.providerConfig.baseUrl ?? trimToUndefined(params.cfg?.models?.providers?.google?.baseUrl)
  );
}

function resolveGoogleTtsConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.google) ?? asObject(rawConfig.google);
}

function normalizeGoogleTtsProviderConfig(
  rawConfig: Record<string, unknown>,
): GoogleTtsProviderConfig {
  const raw = resolveGoogleTtsConfigRecord(rawConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.google.apiKey",
    }),
    baseUrl: trimToUndefined(raw?.baseUrl),
    model: normalizeGoogleTtsModel(raw?.model),
    voiceName: normalizeGoogleTtsVoiceName(raw?.voiceName ?? raw?.voice),
    audioProfile: trimToUndefined(raw?.audioProfile),
    speakerName: trimToUndefined(raw?.speakerName),
  };
}

function readGoogleTtsProviderConfig(config: SpeechProviderConfig): GoogleTtsProviderConfig {
  const normalized = normalizeGoogleTtsProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    model: normalizeGoogleTtsModel(config.model ?? normalized.model),
    voiceName: normalizeGoogleTtsVoiceName(
      config.voiceName ?? config.voice ?? normalized.voiceName,
    ),
    audioProfile: trimToUndefined(config.audioProfile) ?? normalized.audioProfile,
    speakerName: trimToUndefined(config.speakerName) ?? normalized.speakerName,
  };
}

function readGoogleTtsOverrides(
  overrides: Maybe<SpeechProviderOverrides>,
): GoogleTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: normalizeOptionalString(overrides.model),
    voiceName: normalizeOptionalString(overrides.voiceName ?? overrides.voice),
    audioProfile: normalizeOptionalString(overrides.audioProfile),
    speakerName: normalizeOptionalString(overrides.speakerName),
  };
}

function composeGoogleTtsText(params: {
  text: string;
  audioProfile?: string;
  speakerName?: string;
}): string {
  return [
    trimToUndefined(params.audioProfile),
    trimToUndefined(params.speakerName) ? `Speaker name: ${params.speakerName}` : undefined,
    params.text,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voicename":
    case "voice_name":
    case "google_voice":
    case "googlevoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceName: ctx.value } };
    case "google_model":
    case "googlemodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    default:
      return { handled: false };
  }
}

function extractGoogleSpeechPcm(payload: GoogleGenerateSpeechResponse): Buffer {
  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      const data = normalizeOptionalString(inline?.data);
      if (!data) {
        continue;
      }
      return Buffer.from(data, "base64");
    }
  }
  throw new Error("Google TTS response missing audio data");
}

function wrapPcm16MonoToWav(pcm: Buffer, sampleRate = GOOGLE_TTS_SAMPLE_RATE): Buffer {
  const byteRate = sampleRate * GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
  const blockAlign = GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(GOOGLE_TTS_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(GOOGLE_TTS_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function synthesizeGoogleTtsPcm(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      capability: "audio",
      transport: "http",
    });

  const { response: res, release } = await postJsonRequest({
    url: `${baseUrl}/models/${params.model}:generateContent`,
    headers,
    body: {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: composeGoogleTtsText({
                text: params.text,
                audioProfile: params.audioProfile,
                speakerName: params.speakerName,
              }),
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: params.voiceName,
            },
          },
        },
      },
    },
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    pinDns: false,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowProviderError(res, "Google TTS failed");
    return extractGoogleSpeechPcm((await res.json()) as GoogleGenerateSpeechResponse);
  } finally {
    await release();
  }
}

export function buildGoogleSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "google",
    label: "Google",
    autoSelectOrder: 50,
    models: [DEFAULT_GOOGLE_TTS_MODEL],
    voices: GOOGLE_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeGoogleTtsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeGoogleTtsProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.google.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: trimToUndefined(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: normalizeGoogleTtsModel(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceName: normalizeGoogleTtsVoiceName(talkProviderConfig.voiceId) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceName: normalizeGoogleTtsVoiceName(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: normalizeGoogleTtsModel(params.modelId) }),
    }),
    listVoices: async () => GOOGLE_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(resolveGoogleTtsApiKey({ cfg, providerConfig })),
    synthesize: async (req) => {
      const config = readGoogleTtsProviderConfig(req.providerConfig);
      const overrides = readGoogleTtsOverrides(req.providerOverrides);
      const apiKey = resolveGoogleTtsApiKey({
        cfg: req.cfg,
        providerConfig: req.providerConfig,
      });
      if (!apiKey) {
        throw new Error("Google API key missing");
      }
      const pcm = await synthesizeGoogleTtsPcm({
        text: req.text,
        apiKey,
        baseUrl: resolveGoogleTtsBaseUrl({ cfg: req.cfg, providerConfig: config }),
        model: normalizeGoogleTtsModel(overrides.model ?? config.model),
        voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
        audioProfile: overrides.audioProfile ?? config.audioProfile,
        speakerName: overrides.speakerName ?? config.speakerName,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer: wrapPcm16MonoToWav(pcm),
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readGoogleTtsProviderConfig(req.providerConfig);
      const apiKey = resolveGoogleTtsApiKey({
        cfg: req.cfg,
        providerConfig: req.providerConfig,
      });
      if (!apiKey) {
        throw new Error("Google API key missing");
      }
      const pcm = await synthesizeGoogleTtsPcm({
        text: req.text,
        apiKey,
        baseUrl: resolveGoogleTtsBaseUrl({ cfg: req.cfg, providerConfig: config }),
        model: config.model,
        voiceName: config.voiceName,
        audioProfile: config.audioProfile,
        speakerName: config.speakerName,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer: pcm,
        outputFormat: "pcm",
        sampleRate: GOOGLE_TTS_SAMPLE_RATE,
      };
    },
  };
}

export const __testing = {
  DEFAULT_GOOGLE_TTS_MODEL,
  DEFAULT_GOOGLE_TTS_VOICE,
  GOOGLE_TTS_SAMPLE_RATE,
  normalizeGoogleTtsModel,
  wrapPcm16MonoToWav,
};
