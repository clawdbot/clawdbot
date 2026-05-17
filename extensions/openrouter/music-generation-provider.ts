import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationSourceImage,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_MUSIC_MODEL = "google/lyria-3-pro-preview";
const OPENROUTER_CLIP_MUSIC_MODEL = "google/lyria-3-clip-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const OPENROUTER_MUSIC_MODELS = [
  DEFAULT_OPENROUTER_MUSIC_MODEL,
  OPENROUTER_CLIP_MUSIC_MODEL,
] as const;

type OpenRouterAudioStreamResult = {
  audioBuffer: Buffer;
  transcript: string;
};

type OpenRouterStreamDeadline = {
  deadlineAtMs: number;
  timeoutMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveOpenRouterMusicModel(model: string | undefined): string {
  return normalizeOptionalString(model) ?? DEFAULT_OPENROUTER_MUSIC_MODEL;
}

function outputFormatToMimeType(format: "mp3" | "wav" | undefined): string {
  return format === "mp3" ? "audio/mpeg" : "audio/wav";
}

function imageToContentPart(image: MusicGenerationSourceImage): {
  type: "image_url";
  image_url: { url: string };
} {
  const url =
    normalizeOptionalString(image.url) ??
    (image.buffer
      ? `data:${normalizeOptionalString(image.mimeType) ?? "image/png"};base64,${image.buffer.toString("base64")}`
      : undefined);
  if (!url) {
    throw new Error("OpenRouter music generation reference image is missing data.");
  }
  return {
    type: "image_url",
    image_url: { url },
  };
}

function buildOpenRouterMusicPrompt(req: MusicGenerationRequest): string {
  const parts = [req.prompt.trim()];
  const lyrics = normalizeOptionalString(req.lyrics);
  if (req.instrumental === true) {
    parts.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
  }
  if (lyrics) {
    parts.push(`Lyrics:\n${lyrics}`);
  }
  if (typeof req.durationSeconds === "number") {
    parts.push(`Target duration: about ${Math.round(req.durationSeconds)} seconds.`);
  }
  return parts.join("\n\n");
}

function buildOpenRouterMessageContent(
  req: MusicGenerationRequest,
):
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const prompt = buildOpenRouterMusicPrompt(req);
  const images = req.inputImages ?? [];
  if (images.length === 0) {
    return prompt;
  }
  return [{ type: "text", text: prompt }, ...images.map((image) => imageToContentPart(image))];
}

function readDeltaAudio(part: unknown): { data?: string; transcript?: string } | undefined {
  if (!isRecord(part)) {
    return undefined;
  }
  const choices = part.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return undefined;
  }
  const delta = first.delta;
  if (!isRecord(delta)) {
    return undefined;
  }
  const audio = delta.audio;
  if (!isRecord(audio)) {
    return undefined;
  }
  return {
    data: normalizeOptionalString(audio.data),
    transcript: typeof audio.transcript === "string" ? audio.transcript : undefined,
  };
}

function processOpenRouterSseLine(
  line: string,
  result: { audioBuffers: Buffer[]; transcriptChunks: string[] },
): boolean {
  if (!line.startsWith("data:")) {
    return false;
  }
  const data = line.slice("data:".length).trim();
  if (!data) {
    return false;
  }
  if (data === "[DONE]") {
    return true;
  }
  const audio = readDeltaAudio(JSON.parse(data));
  if (audio?.data) {
    result.audioBuffers.push(Buffer.from(audio.data, "base64"));
  }
  if (audio?.transcript) {
    result.transcriptChunks.push(audio.transcript);
  }
  return false;
}

function createOpenRouterStreamDeadline(timeoutMs: number): OpenRouterStreamDeadline {
  return {
    deadlineAtMs: Date.now() + Math.max(1, Math.floor(timeoutMs)),
    timeoutMs,
  };
}

function resolveOpenRouterStreamRemainingMs(deadline: OpenRouterStreamDeadline): number {
  const remainingMs = deadline.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`OpenRouter music generation timed out after ${deadline.timeoutMs}ms`);
  }
  return Math.max(1, remainingMs);
}

async function readOpenRouterStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: OpenRouterStreamDeadline,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutMs = resolveOpenRouterStreamRemainingMs(deadline);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`OpenRouter music generation timed out after ${deadline.timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function readOpenRouterAudioStream(
  response: Response,
  deadline: OpenRouterStreamDeadline,
): Promise<OpenRouterAudioStreamResult> {
  if (!response.body) {
    throw new Error("OpenRouter music generation response missing stream body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const result = { audioBuffers: [] as Buffer[], transcriptChunks: [] as string[] };
  let buffer = "";
  let doneSeen = false;
  for (;;) {
    const { value, done } = await readOpenRouterStreamChunk(reader, deadline);
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (processOpenRouterSseLine(line.trim(), result)) {
        doneSeen = true;
        await reader.cancel();
        return {
          audioBuffer: Buffer.concat(result.audioBuffers),
          transcript: result.transcriptChunks.join(""),
        };
      }
    }
  }
  resolveOpenRouterStreamRemainingMs(deadline);
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/u)) {
      if (processOpenRouterSseLine(line.trim(), result)) {
        doneSeen = true;
      }
    }
  }
  if (!doneSeen) {
    throw new Error("OpenRouter music generation stream ended before completion");
  }
  return {
    audioBuffer: Buffer.concat(result.audioBuffers),
    transcript: result.transcriptChunks.join(""),
  };
}

export function buildOpenRouterMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_MUSIC_MODEL,
    models: [...OPENROUTER_MUSIC_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openrouter",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxTracks: 1,
        maxDurationSeconds: 180,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
      edit: {
        enabled: true,
        maxTracks: 1,
        maxInputImages: 1,
        maxDurationSeconds: 180,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("OpenRouter music generation supports at most one reference image.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          provider: "openrouter",
          capability: "audio",
          transport: "http",
        });
      const model = resolveOpenRouterMusicModel(req.model);
      const format = req.format ?? "wav";
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const streamDeadline = createOpenRouterStreamDeadline(timeoutMs);
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/chat/completions`,
        headers,
        body: {
          model,
          messages: [{ role: "user", content: buildOpenRouterMessageContent(req) }],
          modalities: ["text", "audio"],
          audio: { format },
          stream: true,
        },
        timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter music generation failed");
        const streamResult = await readOpenRouterAudioStream(response, streamDeadline);
        if (streamResult.audioBuffer.byteLength === 0) {
          throw new Error("OpenRouter music generation response missing audio data");
        }
        return {
          tracks: [
            {
              buffer: streamResult.audioBuffer,
              mimeType: outputFormatToMimeType(format),
              fileName: `track-1.${format}`,
            },
          ],
          model,
          ...(streamResult.transcript ? { lyrics: [streamResult.transcript] } : {}),
          metadata: {
            inputImageCount: req.inputImages?.length ?? 0,
            instrumental: req.instrumental === true,
            requestedFormat: format,
          },
        };
      } finally {
        await release();
      }
    },
  };
}

export const _openRouterMusicTestInternals = {
  readOpenRouterAudioStream,
};
