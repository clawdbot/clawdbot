// Minimax provider module implements model/runtime integration.
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  assertProviderBinaryResponseContent,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertMinimaxBaseResp,
  DEFAULT_MINIMAX_MEDIA_BASE_URL,
  normalizeMinimaxHexAudio,
  resolveMinimaxGuardedRequestOptions,
  resolveMinimaxMediaBaseUrl,
  type MinimaxBaseResp,
  type MinimaxRequestPolicy,
} from "./media-provider-runtime.js";

const DEFAULT_MINIMAX_MUSIC_MODEL = "music-2.6";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const STREAM_ENVELOPE_MAX_BYTES_MULTIPLIER = 5;
const STREAM_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

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

function decodeHexAudioWithLimit(data: string, maxBytes: number): Buffer {
  const trimmed = normalizeMinimaxHexAudio(data, "MiniMax music generation");
  if (trimmed.length / 2 > maxBytes) {
    throw createGeneratedMusicTooLargeError(maxBytes);
  }
  return Buffer.from(trimmed, "hex");
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

async function downloadTrackFromUrl(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  maxBytes: number;
  policy: MinimaxRequestPolicy;
}): Promise<GeneratedMusicAsset> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label: "MiniMax generated music download",
  });
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const result = await executeProviderOperationWithRetry({
    provider: "minimax",
    stage: "download",
    operation: async () => {
      const guardedResult = await fetchWithTimeoutGuarded(
        params.url,
        { method: "GET" },
        timeoutMs(),
        params.fetchFn,
        resolveMinimaxGuardedRequestOptions(params.policy),
      );
      try {
        await assertOkOrThrowHttpError(
          guardedResult.response,
          "MiniMax generated music download failed",
        );
      } catch (error) {
        await guardedResult.release();
        throw error;
      }
      return guardedResult;
    },
  });
  try {
    try {
      assertProviderBinaryResponseContent(
        result.response,
        "MiniMax generated music download",
        "audio",
      );
    } catch (error) {
      // Release the unread response before its guarded dispatcher is closed.
      await result.response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const mimeType =
      normalizeOptionalString(result.response.headers.get("content-type")) ?? "audio/mpeg";
    const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
    const buffer = await readResponseWithLimit(result.response, params.maxBytes, {
      timeoutMs,
      onTimeout: ({ timeoutMs: bodyTimeoutMs }) =>
        new Error(
          `MiniMax generated music download timed out after ${deadline.timeoutMs ?? bodyTimeoutMs}ms`,
        ),
      onOverflow: ({ maxBytes }) =>
        new Error(`MiniMax generated music download exceeds ${maxBytes} bytes`),
    });
    if (buffer.byteLength === 0) {
      throw new Error("MiniMax generated music download: malformed audio response");
    }
    return {
      buffer,
      mimeType,
      fileName: `track-1.${ext}`,
    };
  } finally {
    await result.release();
  }
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

function createMinimaxMusicTimeoutError(deadline: ProviderOperationDeadline): Error {
  const timeoutLabel =
    typeof deadline.timeoutMs === "number" ? ` after ${deadline.timeoutMs}ms` : "";
  return new Error(`${deadline.label} timed out${timeoutLabel}`);
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
  return await readResponseWithLimit(response, maxBytes, {
    timeoutMs: () => resolveBodyReadTimeoutMs(deadline),
    onTimeout: () => createMinimaxMusicTimeoutError(deadline),
    onOverflow: ({ maxBytes: limit }) => createGeneratedMusicTooLargeError(limit),
  });
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
  let completed = false;
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
    if (String(frame.data?.status ?? "") === "2") {
      completed = true;
      if (chunks.length > 0) {
        continue;
      }
    }
    const audio = normalizeOptionalString(frame.data?.audio);
    if (audio) {
      const chunk = decodeHexAudioWithLimit(audio, maxBytes - decodedBytes);
      chunks.push(chunk);
      decodedBytes += chunk.byteLength;
    }
  }
  if (!completed) {
    throw new Error("MiniMax music generation stream ended without completion");
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
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: providerId, ...ctx }),
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
          baseUrl: resolveMinimaxMediaBaseUrl(req.cfg, providerId),
          defaultBaseUrl: DEFAULT_MINIMAX_MEDIA_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: providerId,
          capability: "audio",
          transport: "http",
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg.models?.providers?.[providerId]?.request,
          ),
        });
      const requestPolicy: MinimaxRequestPolicy = { allowPrivateNetwork, dispatcherPolicy };
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
        const maxGeneratedMusicBytes = resolveGeneratedMediaMaxBytes(req.cfg, "audio");
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
              maxBytes: maxGeneratedMusicBytes,
              policy: requestPolicy,
            })
          : inlineAudio
            ? (() => {
                const buffer = decodeHexAudioWithLimit(inlineAudio, maxGeneratedMusicBytes);
                return {
                  buffer,
                  mimeType: "audio/mpeg",
                  fileName: "track-1.mp3",
                };
              })()
            : await readStreamingTrack(res, deadline, maxGeneratedMusicBytes);
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
