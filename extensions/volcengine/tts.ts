import * as crypto from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export type VolcengineTtsEncoding = "ogg_opus" | "mp3" | "pcm" | "wav";

type VolcengineTTSParams = {
  text: string;
  apiKey?: string;
  appId?: string;
  token?: string;
  voice?: string;
  cluster?: string;
  resourceId?: string;
  appKey?: string;
  baseUrl?: string;
  speedRatio?: number;
  volumeRatio?: number;
  pitchRatio?: number;
  emotion?: string;
  encoding?: VolcengineTtsEncoding;
  timeoutMs?: number;
};

const DEFAULT_SEED_VOICE = "en_female_anna_mars_bigtts";
const DEFAULT_LEGACY_VOICE = "zh_female_xiaohe_uranus_bigtts";
const DEFAULT_CLUSTER = "volcano_tts";
const DEFAULT_SEED_TTS_RESOURCE_ID = "seed-tts-1.0";
const DEFAULT_SEED_TTS_APP_KEY = "aGjiRDfUWi";
const BYTEPLUS_SEED_TTS_URL =
  "https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional";
const VOLCENGINE_LEGACY_TTS_URL = "https://openspeech.bytedance.com/api/v1/tts";

type VolcengineTtsResponse = {
  code?: number;
  message?: string;
  data?: string;
};

function parseJsonObject(text: string, providerName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${providerName} TTS: failed to parse response JSON: ${detail}`, {
      cause: err,
    });
  }
}

function toTtsResponse(parsed: Record<string, unknown>): VolcengineTtsResponse {
  const header =
    parsed.header && typeof parsed.header === "object" && !Array.isArray(parsed.header)
      ? (parsed.header as Record<string, unknown>)
      : undefined;
  return {
    code:
      typeof parsed.code === "number"
        ? parsed.code
        : typeof header?.code === "number"
          ? header.code
          : undefined,
    message:
      typeof parsed.message === "string"
        ? parsed.message
        : typeof header?.message === "string"
          ? header.message
          : undefined,
    data: typeof parsed.data === "string" ? parsed.data : undefined,
  };
}

function parseLegacyTtsResponse(text: string): VolcengineTtsResponse {
  return toTtsResponse(parseJsonObject(text, "Volcengine"));
}

function parseSeedTtsFrames(text: string): VolcengineTtsResponse[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    return [toTtsResponse(parseJsonObject(trimmed, "BytePlus Seed Speech"))];
  } catch {
    // The HTTP API streams JSON frames; Response.text() preserves line breaks.
  }

  const frames: VolcengineTtsResponse[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) {
      continue;
    }
    const json = item.startsWith("data:") ? item.slice("data:".length).trim() : item;
    frames.push(toTtsResponse(parseJsonObject(json, "BytePlus Seed Speech")));
  }
  return frames;
}

function hostnameAllowlist(url: string): string[] {
  return [new URL(url).hostname];
}

function seedAudioFormat(encoding: VolcengineTtsEncoding): "ogg_opus" | "mp3" | "pcm" {
  return encoding === "wav" ? "pcm" : encoding;
}

async function seedSpeechTTS(params: VolcengineTTSParams & { apiKey: string }): Promise<Buffer> {
  const {
    text,
    apiKey,
    voice = DEFAULT_SEED_VOICE,
    resourceId = DEFAULT_SEED_TTS_RESOURCE_ID,
    appKey = DEFAULT_SEED_TTS_APP_KEY,
    baseUrl = BYTEPLUS_SEED_TTS_URL,
    speedRatio = 1.0,
    emotion,
    encoding = "ogg_opus",
    timeoutMs = 30_000,
  } = params;
  const audioFormat = seedAudioFormat(encoding);

  const payload = JSON.stringify({
    user: { uid: "openclaw" },
    req_params: {
      text,
      speaker: voice,
      audio_params: {
        format: audioFormat,
        sample_rate: 24_000,
      },
      ...(speedRatio !== 1.0 ? { speed_ratio: speedRatio } : {}),
      ...(emotion ? { emotion } : {}),
    },
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: baseUrl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Connection: "keep-alive",
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-App-Key": appKey,
      },
      body: payload,
    },
    timeoutMs,
    policy: { hostnameAllowlist: hostnameAllowlist(baseUrl) },
    auditContext: "volcengine.tts",
  });

  try {
    const frames = parseSeedTtsFrames(await response.text());
    const chunks: Buffer[] = [];
    for (const frame of frames) {
      if (frame.code === 0) {
        if (frame.data) {
          chunks.push(Buffer.from(frame.data, "base64"));
        }
        continue;
      }
      if (frame.code === 20000000) {
        continue;
      }
      throw new Error(
        `BytePlus Seed Speech TTS error ${frame.code ?? response.status}: ${
          frame.message ?? "unknown"
        }`,
      );
    }

    if (!response.ok || chunks.length === 0) {
      throw new Error(`BytePlus Seed Speech TTS error ${response.status}: no audio data`);
    }

    return Buffer.concat(chunks);
  } finally {
    await release();
  }
}

async function legacyVolcengineTTS(
  params: VolcengineTTSParams & { appId: string; token: string },
): Promise<Buffer> {
  const {
    text,
    appId,
    token,
    voice = DEFAULT_LEGACY_VOICE,
    cluster = DEFAULT_CLUSTER,
    baseUrl = VOLCENGINE_LEGACY_TTS_URL,
    speedRatio = 1.0,
    volumeRatio = 1.0,
    pitchRatio = 1.0,
    emotion,
    encoding = "ogg_opus",
    timeoutMs = 30_000,
  } = params;

  const payload = JSON.stringify({
    app: { appid: appId, token, cluster },
    user: { uid: "openclaw" },
    audio: {
      voice_type: voice,
      encoding,
      speed_ratio: speedRatio,
      volume_ratio: volumeRatio,
      pitch_ratio: pitchRatio,
      ...(emotion ? { emotion } : {}),
    },
    request: {
      reqid: crypto.randomUUID(),
      text,
      text_type: "plain",
      operation: "query",
    },
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: baseUrl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer;${token}`,
      },
      body: payload,
    },
    timeoutMs,
    policy: { hostnameAllowlist: hostnameAllowlist(baseUrl) },
    auditContext: "volcengine.tts",
  });

  try {
    const body = parseLegacyTtsResponse(await response.text());
    if (!response.ok || body.code !== 3000 || !body.data) {
      throw new Error(
        `Volcengine TTS error ${body.code ?? response.status}: ${body.message ?? "unknown"}`,
      );
    }
    return Buffer.from(body.data, "base64");
  } finally {
    await release();
  }
}

export async function volcengineTTS(params: VolcengineTTSParams): Promise<Buffer> {
  if (params.apiKey) {
    return seedSpeechTTS({ ...params, apiKey: params.apiKey });
  }

  if (params.appId && params.token) {
    return legacyVolcengineTTS({ ...params, appId: params.appId, token: params.token });
  }

  throw new Error(
    "Volcengine TTS credentials missing. Set a BytePlus Seed Speech API key or legacy AppID/token.",
  );
}
