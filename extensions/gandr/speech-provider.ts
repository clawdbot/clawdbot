// Gandr provider module builds the speech provider on the shared OpenAI-compatible factory.
import {
  createOpenAiCompatibleSpeechProvider,
  type SpeechProviderPlugin,
  type SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-provider";
import {
  DEFAULT_GANDR_BASE_URL,
  DEFAULT_GANDR_MODEL_ID,
  DEFAULT_GANDR_VOICE_ID,
  GANDR_MAX_INPUT_CHARS,
  GANDR_PCM_SAMPLE_RATE_HERTZ,
  GANDR_TTS_MODELS,
  GANDR_TTS_RESPONSE_FORMATS,
  GANDR_TTS_VOICE_IDS,
  listGandrVoices,
} from "./tts.js";

// Behind every bundled provider (Volcengine sits at 90): configuring Gandr must
// never replace an automatic choice that already works.
export const GANDR_AUTO_SELECT_ORDER = 95;

export function buildGandrSpeechProvider(): SpeechProviderPlugin {
  // Configuration, directives, guarded HTTP, bounded reads and cleanup all
  // come from the shared factory; only the Gandr-specific pieces stay here.
  const base = createOpenAiCompatibleSpeechProvider({
    id: "gandr",
    label: "Gandr",
    autoSelectOrder: GANDR_AUTO_SELECT_ORDER,
    models: GANDR_TTS_MODELS,
    voices: GANDR_TTS_VOICE_IDS,
    defaultModel: DEFAULT_GANDR_MODEL_ID,
    defaultVoice: DEFAULT_GANDR_VOICE_ID,
    defaultBaseUrl: DEFAULT_GANDR_BASE_URL,
    envKey: "GANDR_API_KEY",
    responseFormats: GANDR_TTS_RESPONSE_FORMATS,
    defaultResponseFormat: "mp3",
    voiceCompatibleResponseFormats: [],
    baseUrlPolicy: { kind: "trim-trailing-slash" },
    apiErrorLabel: "Gandr TTS API error",
    missingApiKeyError: "Gandr API key missing",
  });

  return {
    ...base,
    // Gandr caps input per request; fail before the network round trip.
    prepareSynthesis: ({ text }) => {
      if (text.length > GANDR_MAX_INPUT_CHARS) {
        throw new Error(
          `Gandr TTS input too long: ${text.length} chars (limit: ${GANDR_MAX_INPUT_CHARS} chars)`,
        );
      }
      return undefined;
    },
    // No listing endpoint upstream; the stock catalog carries display names.
    listVoices: async () => listGandrVoices(),
    // Telephony reuses the shared transport and only pins the headerless PCM format.
    synthesizeTelephony: async (req: SpeechTelephonySynthesisRequest) => {
      const { audioBuffer } = await base.synthesize({
        ...req,
        target: "telephony",
        providerConfig: { ...req.providerConfig, responseFormat: "pcm" },
      });
      return { audioBuffer, outputFormat: "pcm", sampleRate: GANDR_PCM_SAMPLE_RATE_HERTZ };
    },
  };
}
