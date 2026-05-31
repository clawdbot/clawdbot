import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  TALK_TEST_PROVIDER_ID,
  TALK_TEST_PROVIDER_LABEL,
} from "../test-utils/talk-test-provider.js";

type StubSpeechProviderOptions = {
  id: SpeechProviderPlugin["id"];
  label: string;
  aliases?: string[];
  voices?: string[];
  resolveTalkOverrides?: SpeechProviderPlugin["resolveTalkOverrides"];
  synthesize?: SpeechProviderPlugin["synthesize"];
};

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchStubSpeechAudio(
  url: string,
  init: RequestInit,
  providerId: string,
): Promise<Buffer> {
  const withTimeout = async <T>(label: string, run: Promise<T>): Promise<T> =>
    await Promise.race([
      run,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${providerId} stub ${label} timed out`)), 5_000),
      ),
    ]);
  const response = await withTimeout("fetch", globalThis.fetch(url, init));
  const arrayBuffer = await withTimeout("read", response.arrayBuffer());
  return Buffer.from(arrayBuffer);
}

const createStubSpeechProvider = (params: StubSpeechProviderOptions): SpeechProviderPlugin => ({
  id: params.id,
  label: params.label,
  aliases: params.aliases,
  voices: params.voices,
  resolveTalkOverrides: params.resolveTalkOverrides,
  isConfigured: () => true,
  synthesize:
    params.synthesize ??
    (async () => ({
      audioBuffer: Buffer.from(`${params.id}-audio`, "utf8"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    })),
  listVoices: async () =>
    (params.voices ?? []).map((voiceId) => ({
      id: voiceId,
      name: voiceId,
    })),
});

export function createDefaultGatewayTestSpeechProviders() {
  return [
    {
      pluginId: "openai",
      source: "test" as const,
      provider: createStubSpeechProvider({
        id: "openai",
        label: "OpenAI",
        voices: ["alloy", "nova"],
        resolveTalkOverrides: ({ params }) => ({
          ...(normalizeOptionalString(params.voiceId) == null
            ? {}
            : { voice: normalizeOptionalString(params.voiceId) }),
          ...(normalizeOptionalString(params.modelId) == null
            ? {}
            : { model: normalizeOptionalString(params.modelId) }),
          ...(asNumber(params.speed) == null ? {} : { speed: asNumber(params.speed) }),
        }),
        synthesize: async (req) => {
          const config = req.providerConfig as Record<string, unknown>;
          const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;
          const body = JSON.stringify({
            input: req.text,
            model:
              normalizeOptionalString(overrides.model) ??
              normalizeOptionalString(config.modelId) ??
              "gpt-4o-mini-tts",
            voice:
              normalizeOptionalString(overrides.voice) ??
              normalizeOptionalString(config.voiceId) ??
              "alloy",
            ...(asNumber(overrides.speed) == null ? {} : { speed: asNumber(overrides.speed) }),
          });
          const audioBuffer = await fetchStubSpeechAudio(
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            },
            "openai",
          );
          return {
            audioBuffer,
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: false,
          };
        },
      }),
    },
    {
      pluginId: TALK_TEST_PROVIDER_ID,
      source: "test" as const,
      provider: createStubSpeechProvider({
        id: TALK_TEST_PROVIDER_ID,
        label: TALK_TEST_PROVIDER_LABEL,
        voices: ["stub-default-voice", "stub-alt-voice"],
        resolveTalkOverrides: ({ params }) => ({
          ...(normalizeOptionalString(params.voiceId) == null
            ? {}
            : { voiceId: normalizeOptionalString(params.voiceId) }),
          ...(normalizeOptionalString(params.modelId) == null
            ? {}
            : { modelId: normalizeOptionalString(params.modelId) }),
          ...(normalizeOptionalString(params.outputFormat) == null
            ? {}
            : { outputFormat: normalizeOptionalString(params.outputFormat) }),
          ...(asNumber(params.latencyTier) == null
            ? {}
            : { latencyTier: asNumber(params.latencyTier) }),
        }),
      }),
    },
  ];
}
