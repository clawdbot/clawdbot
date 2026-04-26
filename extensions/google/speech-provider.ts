import { transcodeAudioBufferToOpus } from "openclaw/plugin-sdk/media-runtime";
import {
  assertOkOrThrowProviderError,
  postJsonRequest,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
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
const GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE = "audio-profile-v1";

const GOOGLE_TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
] as const;

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
  promptTemplate?: typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE;
  personaPrompt?: string;
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

class GoogleTtsRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTtsRetryableError";
  }
}

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

function normalizeGooglePromptTemplate(
  value: unknown,
): typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE) {
    return trimmed;
  }
  throw new Error(`Invalid Google TTS promptTemplate: ${trimmed}`);
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
  const promptTemplate = normalizeGooglePromptTemplate(raw?.promptTemplate);
  const personaPrompt = trimToUndefined(raw?.personaPrompt);
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
    ...(promptTemplate ? { promptTemplate } : {}),
    ...(personaPrompt ? { personaPrompt } : {}),
  };
}

function readGoogleTtsProviderConfig(config: SpeechProviderConfig): GoogleTtsProviderConfig {
  const normalized = normalizeGoogleTtsProviderConfig({});
  const promptTemplate =
    normalizeGooglePromptTemplate(config.promptTemplate) ?? normalized.promptTemplate;
  const personaPrompt = trimToUndefined(config.personaPrompt) ?? normalized.personaPrompt;
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    model: normalizeGoogleTtsModel(config.model ?? normalized.model),
    voiceName: normalizeGoogleTtsVoiceName(
      config.voiceName ?? config.voice ?? normalized.voiceName,
    ),
    audioProfile: trimToUndefined(config.audioProfile) ?? normalized.audioProfile,
    speakerName: trimToUndefined(config.speakerName) ?? normalized.speakerName,
    ...(promptTemplate ? { promptTemplate } : {}),
    ...(personaPrompt ? { personaPrompt } : {}),
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

function normalizePromptSectionText(value: string | undefined): string | undefined {
  const trimmed = trimToUndefined(value?.replace(/\r\n?/g, "\n"));
  if (!trimmed) {
    return undefined;
  }
  let sanitized = "";
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    sanitized += char;
  }
  return sanitized;
}

function normalizePromptList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizePromptSectionText(value))
    .filter((value): value is string => Boolean(value));
}

function isOpenClawGoogleAudioProfilePrompt(text: string): boolean {
  return (
    text.includes("# AUDIO PROFILE:") &&
    text.includes("### TRANSCRIPT") &&
    text.startsWith("Synthesize speech from the TRANSCRIPT section only.")
  );
}

function renderGoogleAudioProfilePrompt(params: {
  text: string;
  persona?: {
    id: string;
    label?: string;
    prompt?: {
      profile?: string;
      scene?: string;
      sampleContext?: string;
      style?: string;
      accent?: string;
      pacing?: string;
      constraints?: string[];
    };
  };
  personaPrompt?: string;
}): string {
  const transcript = params.text.replace(/\r\n?/g, "\n").trim();
  const prompt = params.persona?.prompt;
  const profile = normalizePromptSectionText(prompt?.profile);
  const scene = normalizePromptSectionText(prompt?.scene);
  const sampleContext = normalizePromptSectionText(prompt?.sampleContext);
  const style = normalizePromptSectionText(prompt?.style);
  const accent = normalizePromptSectionText(prompt?.accent);
  const pacing = normalizePromptSectionText(prompt?.pacing);
  const constraints = normalizePromptList(prompt?.constraints);
  const personaPrompt = normalizePromptSectionText(params.personaPrompt);
  const label =
    normalizePromptSectionText(params.persona?.label) ??
    normalizePromptSectionText(params.persona?.id);

  const sections = [
    [
      "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
      "as performance direction. Do not read section titles, notes, labels, or",
      "configuration aloud.",
    ].join("\n"),
  ];

  if (label || profile) {
    sections.push([`# AUDIO PROFILE: ${label ?? "voice"}`, profile].filter(Boolean).join("\n"));
  }
  if (scene) {
    sections.push(["## THE SCENE", scene].join("\n"));
  }

  const directorNotes: string[] = [];
  if (style) {
    directorNotes.push(`Style: ${style}`);
  }
  if (accent) {
    directorNotes.push(`Accent: ${accent}`);
  }
  if (pacing) {
    directorNotes.push(`Pacing: ${pacing}`);
  }
  if (constraints.length > 0) {
    directorNotes.push(["Constraints:", ...constraints.map((item) => `- ${item}`)].join("\n"));
  }
  if (personaPrompt) {
    directorNotes.push(["Provider notes:", personaPrompt].join("\n"));
  }
  if (directorNotes.length > 0) {
    sections.push(["### DIRECTOR'S NOTES", ...directorNotes].join("\n"));
  }

  if (sampleContext) {
    sections.push(["### SAMPLE CONTEXT", sampleContext].join("\n"));
  }

  sections.push(["### TRANSCRIPT", transcript].join("\n"));
  return sections.join("\n\n");
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

async function synthesizeGoogleTtsPcmOnce(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  request?: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
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
      request: params.request,
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
    if (!res.ok) {
      try {
        await assertOkOrThrowProviderError(res, "Google TTS failed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (res.status >= 500 && res.status < 600) {
          throw new GoogleTtsRetryableError(message);
        }
        throw err;
      }
    }
    try {
      return extractGoogleSpeechPcm((await res.json()) as GoogleGenerateSpeechResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GoogleTtsRetryableError(message);
    }
  } finally {
    await release();
  }
}

async function synthesizeGoogleTtsPcm(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  request?: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await synthesizeGoogleTtsPcmOnce(params);
    } catch (err) {
      lastError = err;
      if (!(err instanceof GoogleTtsRetryableError) || attempt > 0) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function buildGoogleSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "google",
    label: "Google",
    autoSelectOrder: 50,
    models: GOOGLE_TTS_MODELS,
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
    prepareSynthesis: (ctx) => {
      const config = readGoogleTtsProviderConfig(ctx.providerConfig);
      const shouldWrap =
        config.promptTemplate === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE ||
        Boolean(config.personaPrompt);
      if (!shouldWrap || isOpenClawGoogleAudioProfilePrompt(ctx.text)) {
        return undefined;
      }
      return {
        text: renderGoogleAudioProfilePrompt({
          text: ctx.text,
          persona: ctx.persona,
          personaPrompt: config.personaPrompt,
        }),
      };
    },
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
        request: sanitizeConfiguredModelProviderRequest(
          req.cfg?.models?.providers?.google?.request,
        ),
        model: normalizeGoogleTtsModel(overrides.model ?? config.model),
        voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
        audioProfile: overrides.audioProfile ?? config.audioProfile,
        speakerName: overrides.speakerName ?? config.speakerName,
        timeoutMs: req.timeoutMs,
      });
      if (req.target === "voice-note") {
        return {
          audioBuffer: await transcodeAudioBufferToOpus({
            audioBuffer: wrapPcm16MonoToWav(pcm),
            inputExtension: "wav",
            tempPrefix: "tts-google-",
            timeoutMs: req.timeoutMs,
          }),
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
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
        request: sanitizeConfiguredModelProviderRequest(
          req.cfg?.models?.providers?.google?.request,
        ),
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
  GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE,
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_SAMPLE_RATE,
  normalizeGoogleTtsModel,
  renderGoogleAudioProfilePrompt,
  wrapPcm16MonoToWav,
};
