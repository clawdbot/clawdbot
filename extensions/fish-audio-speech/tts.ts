// Fish Audio HTTP client for buffered and streaming TTS plus voice discovery.
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { createBoundedProviderBinaryStream } from "openclaw/plugin-sdk/provider-binary-stream";
import {
  assertOkOrThrowProviderError,
  assertProviderBinaryResponseContent,
  readProviderBinaryResponse,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { trimToUndefined, type SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const FISH_AUDIO_BASE_URL = "https://api.fish.audio";
const FISH_AUDIO_VOICES_MAX_BYTES = 2 * 1024 * 1024;
const FISH_AUDIO_VOICE_PAGE_SIZE = 100;
const FISH_AUDIO_MAX_OWN_VOICE_PAGES = 20;

export type FishAudioModel = "s2.1-pro-free" | "s2.1-pro" | "s2-pro" | "s1";
export type FishAudioLatency = "low" | "balanced" | "normal";
export type FishAudioFormat = "mp3" | "opus" | "wav" | "pcm";

export type FishAudioTtsRequest = {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: FishAudioModel;
  referenceId?: string;
  format: FishAudioFormat;
  sampleRate?: number;
  latency?: FishAudioLatency;
  speed?: number;
  temperature?: number;
  topP?: number;
  normalize?: boolean;
  timeoutMs: number;
  maxBytes: number;
};

export function normalizeFishAudioBaseUrl(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/u, "") : FISH_AUDIO_BASE_URL;
}

function buildFishAudioRequestBody(params: FishAudioTtsRequest): string {
  return JSON.stringify({
    text: params.text,
    format: params.format,
    ...(params.referenceId ? { reference_id: params.referenceId } : {}),
    ...(params.sampleRate == null ? {} : { sample_rate: params.sampleRate }),
    ...(params.latency == null ? {} : { latency: params.latency }),
    ...(params.speed == null ? {} : { prosody: { speed: params.speed } }),
    ...(params.temperature == null ? {} : { temperature: params.temperature }),
    ...(params.topP == null ? {} : { top_p: params.topP }),
    ...(params.normalize == null ? {} : { normalize: params.normalize }),
  });
}

async function requestFishAudioTts(params: FishAudioTtsRequest): Promise<{
  response: Response;
  release: () => Promise<void>;
}> {
  const baseUrl = normalizeFishAudioBaseUrl(params.baseUrl);
  return await fetchWithSsrFGuard({
    url: `${baseUrl}/v1/tts`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        model: params.model,
      },
      body: buildFishAudioRequestBody(params),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "fish-audio.tts",
  });
}

export async function fishAudioTts(params: FishAudioTtsRequest): Promise<Buffer> {
  const { response, release } = await requestFishAudioTts(params);
  try {
    await assertOkOrThrowProviderError(response, "Fish Audio TTS API error");
    return Buffer.from(
      await readProviderBinaryResponse(response, "Fish Audio TTS API error", "audio", {
        maxBytes: params.maxBytes,
      }),
    );
  } finally {
    await release();
  }
}

export async function fishAudioTtsStream(params: FishAudioTtsRequest): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const { response, release } = await requestFishAudioTts(params);
  let handedOff = false;
  try {
    await assertOkOrThrowProviderError(response, "Fish Audio TTS API error");
    assertProviderBinaryResponseContent(response, "Fish Audio TTS API error", "audio");
    if (!response.body) {
      throw new Error("Fish Audio TTS API response missing audio stream");
    }
    const bounded = createBoundedProviderBinaryStream(response.body, {
      maxBytes: params.maxBytes,
      createOverflowError: ({ maxBytes }) =>
        new Error(`Fish Audio TTS API error: audio response exceeds ${maxBytes} bytes`),
      createReleaseError: () => new Error("Fish Audio TTS stream released"),
    });
    let releasePromise: Promise<void> | undefined;
    const releaseAll = () => {
      releasePromise ??= (async () => {
        try {
          await bounded.release();
        } finally {
          await release();
        }
      })();
      return releasePromise;
    };
    handedOff = true;
    return { audioStream: bounded.stream, release: releaseAll };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}

type FishAudioVoicePayload = {
  total?: number;
  items?: unknown[];
};

function parseVoiceItem(value: unknown): SpeechVoiceOption | undefined {
  const item = asOptionalRecord(value);
  const id = trimToUndefined(item?.["_id"]);
  if (!id) {
    return undefined;
  }
  const languages = Array.isArray(item?.languages)
    ? item.languages.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
  const tags = Array.isArray(item?.tags)
    ? item.tags.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
  return {
    id,
    name: trimToUndefined(item?.title),
    description: trimToUndefined(item?.description),
    category: trimToUndefined(item?.visibility),
    locale: languages[0],
    personalities: tags.length > 0 ? tags : undefined,
  };
}

async function requestVoicePage(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  self: boolean;
  pageNumber: number;
}): Promise<FishAudioVoicePayload> {
  const url = new URL(`${normalizeFishAudioBaseUrl(params.baseUrl)}/model`);
  url.searchParams.set("type", "tts");
  url.searchParams.set("page_size", String(FISH_AUDIO_VOICE_PAGE_SIZE));
  url.searchParams.set("page_number", String(params.pageNumber));
  if (params.self) {
    url.searchParams.set("self", "true");
  } else {
    url.searchParams.set("sort_by", "score");
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: { headers: { Authorization: `Bearer ${params.apiKey}` } },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
    auditContext: "fish-audio.voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "Fish Audio voices API error");
    return await readProviderJsonResponse<FishAudioVoicePayload>(response, "Fish Audio voices", {
      maxBytes: FISH_AUDIO_VOICES_MAX_BYTES,
    });
  } finally {
    await release();
  }
}

export async function listFishAudioVoices(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<SpeechVoiceOption[]> {
  const own: SpeechVoiceOption[] = [];
  for (let pageNumber = 1; pageNumber <= FISH_AUDIO_MAX_OWN_VOICE_PAGES; pageNumber += 1) {
    const payload = await requestVoicePage({ ...params, self: true, pageNumber });
    const items = Array.isArray(payload.items) ? payload.items : [];
    own.push(...items.flatMap((item) => parseVoiceItem(item) ?? []));
    if (
      items.length < FISH_AUDIO_VOICE_PAGE_SIZE ||
      own.length >= (payload.total ?? Number.MAX_SAFE_INTEGER)
    ) {
      break;
    }
  }

  let publicVoices: SpeechVoiceOption[] = [];
  try {
    const payload = await requestVoicePage({ ...params, self: false, pageNumber: 1 });
    publicVoices = (Array.isArray(payload.items) ? payload.items : []).flatMap(
      (item) => parseVoiceItem(item) ?? [],
    );
  } catch {
    // Own voices remain useful when the public catalog is temporarily unavailable.
  }

  const seen = new Set<string>();
  return [...own, ...publicVoices].filter((voice) => {
    if (seen.has(voice.id)) {
      return false;
    }
    seen.add(voice.id);
    return true;
  });
}

export const FISH_AUDIO_STREAM_MAX_BYTES = MAX_AUDIO_BYTES;
