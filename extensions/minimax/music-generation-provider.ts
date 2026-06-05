// Minimax provider module implements model/runtime integration.
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchProviderDownloadResponse,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_MINIMAX_MUSIC_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_MUSIC_MODEL = "music-2.6";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_GENERATED_MUSIC_MAX_BYTES = 16 * 1024 * 1024;
const STREAM_ENVELOPE_MAX_BYTES_MULTIPLIER = 5;
const STREAM_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

type MinimaxMusicCreateResponse = {
  task_id?: string;
  audio?: string;
  audio_url?: string;
  lyrics?: string;
  data?: {
    audio?: string;
    audio_url?: string;
    lyrics?: string;
  };
  base_resp?: MinimaxBaseResp;
};

type MinimaxMusicStreamFrame = {
  data?: {
    audio?: string;
    status?: number | string;
  };
  base_resp?: MinimaxBaseResp;
};

function resolveMinimaxMusicBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  const direct = normalizeOptionalString(cfg?.models?.providers?.[providerId]?.baseUrl);
  if (!direct) {
    return DEFAULT_MINIMAX_MUSIC_BASE_URL;
  }
  try {
    return new URL(direct).origin;
  } catch {
    return DEFAULT_MINIMAX_MUSIC_BASE_URL;
  }
}

function assertMinimaxBaseResp(baseResp: MinimaxBaseResp | undefined, context: string): void {
  if (!baseResp || typeof baseResp.status_code !== "number" || baseResp.status_code === 0) {
    return;
  }
  throw new Error(
    `${context} (${baseResp.status_code}): ${baseResp.status_msg ?? "unknown error"}`,
  );
}

function decodePossibleBinaryWithLimit(data: string, maxBytes: number): Buffer {
  const trimmed = data.trim();
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) {
    if (trimmed.length / 2 > maxBytes) {
      throw createGeneratedMusicTooLargeError(maxBytes);
    }
    return Buffer.from(trimmed, "hex");
  }
  if (Buffer.byteLength(trimmed, "base64") > maxBytes) {
    throw createGeneratedMusicTooLargeError(maxBytes);
  }
  return Buffer.from(trimmed, "base64");
}

function decodePossibleText(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex").toString("utf8").trim();
  }
  return trimmed;
}

function isLikelyRemoteUrl(value: string | undefined): boolean {
  const trimmed = normalizeOptionalString(value);
  return Boolean(trimmed && /^https?:\/\//iu.test(trimmed));
}

function resolveGeneratedMusicMaxBytes(req: MusicGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_MUSIC_MAX_BYTES;
}

async function downloadTrackFromUrl(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  maxBytes: number;
}): Promise<GeneratedMusicAsset> {
  const response = await fetchProviderDownloadResponse({
    url: params.url,
    init: { method: "GET" },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    provider: "minimax",
    requestFailedMessage: "MiniMax generated music download failed",
  });
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "audio/mpeg";
  const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
  return {
    buffer: await readResponseWithLimit(response, params.maxBytes, {
      onOverflow: ({ maxBytes }) =>
        new Error(`MiniMax generated music download exceeds ${maxBytes} bytes`),
    }),
    mimeType,
    fileName: `track-1.${ext}`,
  };
}

function createMinimaxMusicTimeoutError(deadline: ProviderOperationDeadline): Error {
  const timeoutLabel =
    typeof deadline.timeoutMs === "number" ? ` after ${deadline.timeoutMs}ms` : "";
  return new Error(`${deadline.label} timed out${timeoutLabel}`);
}

function resolveBodyReadTimeoutMs(deadline: ProviderOperationDeadline): number {
  return resolveProviderOperationTimeoutMs({
    deadline,
    defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  });
}

function createGeneratedMusicTooLargeError(maxBytes: number): Error {
  return new Error(`MiniMax generated music download exceeds ${maxBytes} bytes`);
}

function resolveStreamEnvelopeMaxBytes(maxBytes: number): number {
  return Math.max(
    STREAM_ENVELOPE_OVERHEAD_BYTES,
    maxBytes * STREAM_ENVELOPE_MAX_BYTES_MULTIPLIER + STREAM_ENVELOPE_OVERHEAD_BYTES,
  );
}

async function readResponseBufferWithDeadline(
  response: Response,
  deadline: ProviderOperationDeadline,
  maxBytes: number,
): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = resolveBodyReadTimeoutMs(deadline);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(createMinimaxMusicTimeoutError(deadline)), timeoutMs);
        });
        const result = await Promise.race([reader.read(), timeoutPromise]);
        if (result.done) {
          break;
        }
        if (!result.value || result.value.length === 0) {
          continue;
        }
        const nextTotalBytes = totalBytes + result.value.byteLength;
        if (nextTotalBytes > maxBytes) {
          const error = createGeneratedMusicTooLargeError(maxBytes);
          try {
            await reader.cancel(error);
          } catch {
            // Preserve the size-limit failure that caused cancellation.
          }
          throw error;
        }
        chunks.push(result.value);
        totalBytes = nextTotalBytes;
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          // Preserve the timeout or stream read failure that caused cancellation.
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function readStreamingTrack(
  response: Response,
  deadline: ProviderOperationDeadline,
  maxBytes: number,
): Promise<GeneratedMusicAsset> {
  const contentType = normalizeOptionalString(response.headers.get("content-type")) ?? "";
  if (contentType.toLowerCase().startsWith("audio/")) {
    const ext = extensionForMime(contentType)?.replace(/^\./u, "") || "mp3";
    return {
      buffer: await readResponseBufferWithDeadline(response, deadline, maxBytes),
      mimeType: contentType,
      fileName: `track-1.${ext}`,
    };
  }
  const chunks: Buffer[] = [];
  let decodedBytes = 0;
  const text = new TextDecoder().decode(
    await readResponseBufferWithDeadline(
      response,
      deadline,
      resolveStreamEnvelopeMaxBytes(maxBytes),
    ),
  );
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const json = line.slice("data:".length).trim();
    if (!json || json === "[DONE]") {
      continue;
    }
    const frame = JSON.parse(json) as MinimaxMusicStreamFrame;
    assertMinimaxBaseResp(frame.base_resp, "MiniMax music generation failed");
    const audio = normalizeOptionalString(frame.data?.audio);
    if (audio) {
      if (String(frame.data?.status ?? "") === "2" && chunks.length > 0) {
        continue;
      }
      const chunk = decodePossibleBinaryWithLimit(audio, maxBytes - decodedBytes);
      const nextDecodedBytes = decodedBytes + chunk.byteLength;
      if (nextDecodedBytes > maxBytes) {
        throw createGeneratedMusicTooLargeError(maxBytes);
      }
      chunks.push(chunk);
      decodedBytes = nextDecodedBytes;
    }
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.byteLength === 0) {
    throw new Error("MiniMax music generation response missing audio output");
  }
  return {
    buffer,
    mimeType: "audio/mpeg",
    fileName: "track-1.mp3",
  };
}

function resolveMinimaxMusicModel(model: string | undefined): string {
  const trimmed = normalizeOptionalString(model);
  if (!trimmed) {
    return DEFAULT_MINIMAX_MUSIC_MODEL;
  }
  return trimmed;
}

function buildMinimaxMusicProvider(providerId: string): MusicGenerationProvider {
  return {
    id: providerId,
    label: "MiniMax",
    defaultModel: DEFAULT_MINIMAX_MUSIC_MODEL,
    models: [DEFAULT_MINIMAX_MUSIC_MODEL, "music-2.6-free", "music-cover", "music-cover-free"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: providerId,
        agentDir,
      }),
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormats: ["mp3"],
      },
      edit: {
        enabled: false,
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("MiniMax music generation does not support image reference inputs.");
      }
      if (req.instrumental === true && normalizeOptionalString(req.lyrics)) {
        throw new Error("MiniMax music generation cannot use lyrics when instrumental=true.");
      }
      if (req.format && req.format !== "mp3") {
        throw new Error("MiniMax music generation currently supports mp3 output only.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: providerId,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const fetchFn = fetch;
      const operationTimeoutMs = req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
      const deadline = createProviderOperationDeadline({
        timeoutMs: operationTimeoutMs,
        label: "MiniMax music generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveMinimaxMusicBaseUrl(req.cfg, providerId),
          defaultBaseUrl: DEFAULT_MINIMAX_MUSIC_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: providerId,
          capability: "audio",
          transport: "http",
        });
      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");

      const model = resolveMinimaxMusicModel(req.model);
      const requestedLyrics = normalizeOptionalString(req.lyrics);
      const body = {
        model,
        prompt: req.prompt.trim(),
        ...(req.instrumental === true ? { is_instrumental: true } : {}),
        ...(requestedLyrics
          ? { lyrics: requestedLyrics }
          : req.instrumental === true
            ? {}
            : { lyrics_optimizer: true }),
        stream: true,
        output_format: "hex",
        audio_setting: {
          sample_rate: 44_100,
          bitrate: 256_000,
          format: "mp3",
        },
      };

      const { response: res, release } = await postJsonRequest({
        url: `${baseUrl}/v1/music_generation`,
        headers: jsonHeaders,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: operationTimeoutMs,
        }),
        fetchFn,
        pinDns: false,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(res, "MiniMax music generation failed");
        const contentType = normalizeOptionalString(res.headers.get("content-type")) ?? "";
        const lowerContentType = contentType.toLowerCase();
        const maxGeneratedMusicBytes = resolveGeneratedMusicMaxBytes(req);
        const payload =
          lowerContentType.includes("text/event-stream") || lowerContentType.startsWith("audio/")
            ? null
            : (JSON.parse(
                new TextDecoder().decode(
                  await readResponseBufferWithDeadline(
                    res.clone(),
                    deadline,
                    resolveStreamEnvelopeMaxBytes(maxGeneratedMusicBytes),
                  ),
                ),
              ) as MinimaxMusicCreateResponse);
        if (payload) {
          assertMinimaxBaseResp(payload.base_resp, "MiniMax music generation failed");
        }

        const audioCandidate =
          normalizeOptionalString(payload?.audio) ?? normalizeOptionalString(payload?.data?.audio);
        const audioUrl =
          normalizeOptionalString(payload?.audio_url) ||
          normalizeOptionalString(payload?.data?.audio_url) ||
          (isLikelyRemoteUrl(audioCandidate) ? audioCandidate : undefined);
        const inlineAudio = isLikelyRemoteUrl(audioCandidate) ? undefined : audioCandidate;
        const responseLyrics = decodePossibleText(payload?.lyrics ?? payload?.data?.lyrics ?? "");

        const track = audioUrl
          ? await downloadTrackFromUrl({
              url: audioUrl,
              timeoutMs: resolveProviderOperationTimeoutMs({
                deadline,
                defaultTimeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              }),
              fetchFn,
              maxBytes: resolveGeneratedMusicMaxBytes(req),
            })
          : inlineAudio
            ? (() => {
                const buffer = decodePossibleBinaryWithLimit(inlineAudio, maxGeneratedMusicBytes);
                return {
                  buffer,
                  mimeType: "audio/mpeg",
                  fileName: "track-1.mp3",
                };
              })()
            : await readStreamingTrack(res, deadline, maxGeneratedMusicBytes);
        if (!track) {
          throw new Error("MiniMax music generation response missing audio output");
        }

        return {
          tracks: [track],
          ...(responseLyrics ? { lyrics: [responseLyrics] } : {}),
          model,
          metadata: {
            ...(normalizeOptionalString(payload?.task_id)
              ? { taskId: normalizeOptionalString(payload?.task_id) }
              : {}),
            ...(audioUrl ? { audioUrl } : {}),
            instrumental: req.instrumental === true,
            ...(requestedLyrics ? { requestedLyrics: true } : {}),
          },
        };
      } finally {
        await release();
      }
    },
  };
}

export function buildMinimaxMusicGenerationProvider(): MusicGenerationProvider {
  return buildMinimaxMusicProvider("minimax");
}

export function buildMinimaxPortalMusicGenerationProvider(): MusicGenerationProvider {
  return buildMinimaxMusicProvider("minimax-portal");
}
