// Deepgram Flux voice-note transcription uses the provider's one-shot WebSocket protocol.
import {
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
  resolveFfmpegBin,
} from "openclaw/plugin-sdk/media-runtime";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  openProviderWebSocket,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEEPGRAM_FLUX_SAMPLE_RATE = 16_000;
// Deepgram recommends 80 ms chunks. 16 kHz mono linear16 contains 32 bytes per millisecond.
const DEEPGRAM_FLUX_AUDIO_CHUNK_BYTES = 2_560;
const DEEPGRAM_FLUX_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEEPGRAM_FLUX_MAX_TRANSCRIPT_BYTES = 256 * 1024;
const DEEPGRAM_FLUX_MAX_PCM_BYTES =
  DEEPGRAM_FLUX_SAMPLE_RATE * 2 * MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS;
const DEEPGRAM_FLUX_QUERY_KEYS = new Set([
  "eager_eot_threshold",
  "eot_threshold",
  "eot_timeout_ms",
  "keyterm",
  "language_hint",
  "mip_opt_out",
  "numerals",
  "profanity_filter",
  "redact",
  "tag",
]);

type DeepgramFluxRequestConfig = {
  allowPrivateNetwork: boolean;
  baseUrl: string;
  dispatcherPolicy?: Parameters<typeof openProviderWebSocket>[0]["dispatcherPolicy"];
  headers: Headers;
  trustConfiguredBaseUrlOrigin: boolean;
};

export function isDeepgramFluxModel(model?: string): boolean {
  return model?.trim().toLowerCase().startsWith("flux-") ?? false;
}

function buildDeepgramFluxUrl(params: {
  baseUrl: string;
  language?: string;
  model: string;
  query?: Record<string, string | number | boolean | undefined>;
}): string {
  let url: URL;
  try {
    url = new URL(params.baseUrl);
  } catch {
    throw new Error("Invalid Deepgram baseUrl: value is not a valid URL");
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(
      `Invalid Deepgram baseUrl: unsupported scheme "${url.protocol}" (expected http, https, ws, or wss)`,
    );
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath ? basePath.replace(/\/v1$/u, "/v2") : "/v2"}/listen`;
  url.search = "";
  url.searchParams.set("model", params.model);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(DEEPGRAM_FLUX_SAMPLE_RATE));
  if (params.language?.trim()) {
    url.searchParams.set("language_hint", params.language.trim());
  }
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined && DEEPGRAM_FLUX_QUERY_KEYS.has(key)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function readFluxEvent(data: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  const event = asOptionalRecord(parsed);
  if (!event) {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  return event;
}

function readFluxErrorDetail(event: Record<string, unknown>): string {
  const nested = asOptionalRecord(event.error);
  for (const value of [event.description, event.message, nested?.message]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "Deepgram Flux transcription error";
}

type DeepgramFluxSocket = Awaited<ReturnType<typeof openProviderWebSocket>>;

function sendSocketFrame(socket: DeepgramFluxSocket, data: Buffer | string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(data, (error) => (error ? reject(error) : resolve()));
  });
}

async function decodeDeepgramFluxAudio(params: {
  buffer: Buffer;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<Buffer> {
  const result = await runCommandBuffered(
    [
      resolveFfmpegBin(),
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-t",
      String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "pcm_s16le",
      "-ar",
      String(DEEPGRAM_FLUX_SAMPLE_RATE),
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ],
    {
      input: params.buffer,
      maxOutputBytes: { stdout: DEEPGRAM_FLUX_MAX_PCM_BYTES, stderr: 64 * 1024 },
      signal: params.signal,
      terminateOnOutputError: true,
      timeoutMs: params.timeoutMs,
    },
  );
  if (result.termination === "exit" && result.code === 0) {
    return result.stdout;
  }
  if (result.termination === "output-limit") {
    throw new Error("Audio transcription failed: decoded audio exceeds size limit");
  }
  const detail = result.stderr.toString("utf8").trim();
  throw new Error(
    `Audio transcription failed: ffmpeg ${result.termination}${detail ? `: ${detail}` : ""}`,
    { cause: result.error },
  );
}

export async function transcribeDeepgramFluxAudio(params: {
  request: AudioTranscriptionRequest;
  requestConfig: DeepgramFluxRequestConfig;
  model: string;
}): Promise<AudioTranscriptionResult> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.request.timeoutMs,
    label: "Deepgram Flux transcription",
  });
  const resolveTimeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: params.request.timeoutMs,
  });
  const pcm = await decodeDeepgramFluxAudio({
    buffer: params.request.buffer,
    signal: params.request.signal,
    timeoutMs: resolveTimeoutMs(),
  });
  if (pcm.byteLength === 0) {
    throw new Error("Audio transcription failed: decoded audio is empty");
  }

  const url = buildDeepgramFluxUrl({
    baseUrl: params.requestConfig.baseUrl,
    language: params.request.language,
    model: params.model,
    query: params.request.query,
  });
  const timeoutMs = resolveTimeoutMs();
  const socket = await openProviderWebSocket({
    allowPrivateNetwork: params.requestConfig.allowPrivateNetwork,
    baseUrl: params.requestConfig.baseUrl,
    dispatcherPolicy: params.requestConfig.dispatcherPolicy,
    headers: params.requestConfig.headers,
    maxPayloadBytes: DEEPGRAM_FLUX_MAX_MESSAGE_BYTES,
    signal: params.request.signal,
    timeoutMs,
    trustConfiguredBaseUrlOrigin: params.requestConfig.trustConfiguredBaseUrlOrigin,
    url,
  });

  const transcript = await new Promise<string>((resolve, reject) => {
    const finalizedTurns: string[] = [];
    let finalizedTranscriptBytes = 0;
    let lastPartial = "";
    let settled = false;
    let closeStreamSent = false;

    const settle = (outcome: { error?: Error; text?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (outcome.error) {
        reject(outcome.error);
      } else {
        resolve(outcome.text ?? "");
      }
    };
    const timer = setTimeout(
      () => settle({ error: new Error("Deepgram Flux transcription timed out") }),
      timeoutMs,
    );

    socket.on("open", () => {
      void (async () => {
        try {
          for (let offset = 0; offset < pcm.byteLength; offset += DEEPGRAM_FLUX_AUDIO_CHUNK_BYTES) {
            await sendSocketFrame(
              socket,
              pcm.subarray(offset, offset + DEEPGRAM_FLUX_AUDIO_CHUNK_BYTES),
            );
          }
          await sendSocketFrame(socket, JSON.stringify({ type: "CloseStream" }));
          closeStreamSent = true;
        } catch (error) {
          settle({
            error: new Error(
              `Audio transcription failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          });
        }
      })();
    });

    socket.on("message", (data) => {
      try {
        const event = readFluxEvent(data);
        if (event.type === "Error" || event.type === "error") {
          settle({
            error: new Error(`Audio transcription failed: ${readFluxErrorDetail(event)}`),
          });
          return;
        }
        if (event.type !== "TurnInfo" || typeof event.transcript !== "string") {
          return;
        }
        if (event.event === "EndOfTurn") {
          finalizedTranscriptBytes += Buffer.byteLength(event.transcript, "utf8");
          finalizedTurns.push(event.transcript);
          lastPartial = "";
        } else {
          lastPartial = event.transcript;
        }
        if (
          finalizedTranscriptBytes + Buffer.byteLength(lastPartial, "utf8") >
          DEEPGRAM_FLUX_MAX_TRANSCRIPT_BYTES
        ) {
          settle({ error: new Error("Audio transcription failed: transcript exceeds size limit") });
        }
      } catch (error) {
        settle({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    });

    socket.on("error", (error) => {
      settle({ error: new Error(`Audio transcription failed: ${error.message}`) });
    });

    socket.on("close", (code, reason) => {
      if (!closeStreamSent) {
        settle({ error: new Error("Audio transcription failed: Flux closed before flush") });
        return;
      }
      if (code !== 1000 && code !== 1005) {
        const detail = reason.toString().trim();
        settle({
          error: new Error(
            `Audio transcription failed: Flux closed abnormally (code ${code}${detail ? `: ${detail}` : ""})`,
          ),
        });
        return;
      }
      settle({
        text: [...finalizedTurns, lastPartial]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" "),
      });
    });
  });

  return {
    text: requireTranscriptionText(
      transcript || undefined,
      "Audio transcription response missing transcript",
    ),
    model: params.model,
  };
}
