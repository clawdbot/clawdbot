// Xai plugin module implements tts behavior.
import {
  assertOkOrThrowProviderError,
  postJsonRequest,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { asObject, trimToUndefined, type SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import WebSocket, { type RawData } from "ws";
import { XAI_BASE_URL } from "./api.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";
export { XAI_BASE_URL };

const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;
const XAI_TTS_VOICE_LIST_TIMEOUT_MS = 30_000;
const XAI_TTS_VOICE_LIST_MAX_BYTES = 1024 * 1024;
const XAI_TTS_STREAM_TEXT_DELTA_MAX_CHARS = 15_000;
export const XAI_TTS_FALLBACK_VOICES = ["ara", "eve", "leo", "rex", "sal"] as const;

export function normalizeXaiTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return XAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export function isValidXaiTtsVoice(voice: string): boolean {
  return trimToUndefined(voice) !== undefined;
}

export async function listXaiTtsVoices(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const baseUrl = normalizeXaiTtsBaseUrl(params.baseUrl);
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/tts/voices`,
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        ...xaiUserAgentHeaderFor(baseUrl),
      },
    },
    timeoutMs: XAI_TTS_VOICE_LIST_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "xai tts voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS voices API error");
    const payload = await readProviderJsonResponse<unknown>(response, "xAI TTS voices", {
      maxBytes: XAI_TTS_VOICE_LIST_MAX_BYTES,
    });
    const voices = asObject(payload)?.voices;
    if (!Array.isArray(voices)) {
      throw new Error("xAI TTS voices: malformed JSON response");
    }
    return voices.flatMap((value) => {
      const voice = asObject(value);
      const id = trimToUndefined(voice?.voice_id);
      if (!id) {
        return [];
      }
      return [
        {
          id,
          name: trimToUndefined(voice?.name),
          locale: trimToUndefined(voice?.language),
          gender: trimToUndefined(voice?.gender),
        },
      ];
    });
  } finally {
    await release();
  }
}

export function normalizeXaiLanguageCode(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) {
    return normalized;
  }
  throw new Error(
    `xAI language must be "auto" or a BCP-47 tag (e.g. "en", "pt-br", "zh-cn"); got: ${normalized}`,
  );
}

type XaiTtsResponseFormat = "mp3" | "wav" | "pcm" | "mulaw" | "alaw";

const XAI_NATIVE_TTS_STREAM_HOST = "api.x.ai";

type XaiTtsStreamServerEvent = {
  type?: string;
  delta?: string;
  message?: string;
};

function toXaiTtsWsUrl(params: {
  baseUrl: string;
  voiceId: string;
  language: string;
  responseFormat: XaiTtsResponseFormat;
  speed?: number;
}): string {
  assertXaiNativeTtsStreamEndpoint(params.baseUrl);
  const url = new URL(normalizeXaiTtsBaseUrl(params.baseUrl));
  url.protocol = "wss:";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/tts`;
  url.searchParams.set("language", params.language);
  url.searchParams.set("voice", params.voiceId);
  url.searchParams.set("codec", params.responseFormat);
  if (params.speed != null) {
    url.searchParams.set("speed", String(params.speed));
  }
  return url.toString();
}

function readXaiTtsStreamErrorMessage(event: XaiTtsStreamServerEvent): string {
  const message = trimToUndefined(event.message);
  return message ?? "xAI TTS stream error";
}

function parseXaiTtsStreamBaseUrl(baseUrl: string): URL {
  try {
    return new URL(normalizeXaiTtsBaseUrl(baseUrl));
  } catch {
    throw new Error(`Invalid xAI TTS stream baseUrl: ${baseUrl}`);
  }
}

function assertXaiNativeTtsStreamEndpoint(baseUrl: string): void {
  const url = parseXaiTtsStreamBaseUrl(baseUrl);
  if (url.protocol !== "https:") {
    throw new Error(
      `xAI streaming TTS only supports HTTPS for the native ${XAI_NATIVE_TTS_STREAM_HOST} endpoint; got protocol "${url.protocol}"`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== XAI_NATIVE_TTS_STREAM_HOST) {
    throw new Error(
      `xAI streaming TTS only supports the native ${XAI_NATIVE_TTS_STREAM_HOST} endpoint; got host "${hostname}"`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (url.username || url.password || url.port || pathname !== "/v1" || url.search || url.hash) {
    throw new Error(`xAI streaming TTS requires the canonical ${XAI_BASE_URL} base URL`);
  }
}

function decodeWebSocketTextMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  throw new Error("xAI TTS stream received unsupported WebSocket message payload");
}

export async function xaiTTSStream(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: XaiTtsResponseFormat;
  timeoutMs: number;
  maxBytes?: number;
}): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    language: rawLanguage,
    speed,
    responseFormat = "mp3",
    timeoutMs,
    maxBytes = DEFAULT_TTS_MAX_BYTES,
  } = params;
  const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";

  if (!isValidXaiTtsVoice(voiceId)) {
    throw new Error(`Invalid voice: ${voiceId}`);
  }
  assertXaiNativeTtsStreamEndpoint(baseUrl);

  const wsUrl = toXaiTtsWsUrl({
    baseUrl,
    voiceId,
    language,
    responseFormat,
    speed,
  });
  // Bound the encoded JSON frame before ws buffers it. Base64 expands audio by
  // roughly 4/3; the fixed allowance covers the event envelope and metadata.
  const maxPayload = Math.ceil(maxBytes / 3) * 4 + 1024;

  return await new Promise((resolve, reject) => {
    let connectSettled = false;
    let released = false;
    let synthesisTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;
    let errorStream: ((error: Error) => void) | undefined;
    let closeStream: (() => void) | undefined;
    let streamClosed = false;

    const clearTimers = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (synthesisTimer) {
        clearTimeout(synthesisTimer);
        synthesisTimer = undefined;
      }
    };

    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      clearTimers();
      closeStream?.();
      const socket = ws;
      ws = undefined;
      if (!socket) {
        return;
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    };

    const failConnect = (error: Error) => {
      if (connectSettled) {
        return;
      }
      connectSettled = true;
      clearTimers();
      void release();
      reject(error);
    };

    const failStream = (error: Error) => {
      if (released || streamClosed) {
        return;
      }
      clearTimers();
      errorStream?.(error);
      void release();
    };

    // Refresh the watchdog while xAI is sending audio so it measures idle time.
    const refreshSynthesisTimer = () => {
      if (synthesisTimer) {
        clearTimeout(synthesisTimer);
      }
      synthesisTimer = setTimeout(() => {
        failStream(new Error("xAI TTS stream synthesis timeout"));
      }, timeoutMs);
    };

    try {
      ws = new WebSocket(wsUrl, {
        maxPayload,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...xaiUserAgentHeaderFor(baseUrl),
        },
      });
    } catch (error) {
      failConnect(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    connectTimer = setTimeout(() => {
      failConnect(new Error("xAI TTS stream connection timeout"));
    }, timeoutMs);

    ws.once("unexpected-response", (_request, response) => {
      failConnect(
        new Error(
          `xAI TTS stream connection failed (${response.statusCode ?? "unknown"}): ${
            response.statusMessage ?? "upgrade rejected"
          }`,
        ),
      );
    });

    ws.once("error", (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (connectSettled) {
        failStream(normalized);
        return;
      }
      failConnect(normalized);
    });

    ws.once("close", () => {
      if (connectSettled) {
        return;
      }
      failConnect(new Error("xAI TTS stream connection closed before open"));
    });

    ws.once("open", () => {
      if (connectSettled) {
        return;
      }
      connectSettled = true;
      clearTimers();
      refreshSynthesisTimer();

      let totalBytes = 0;
      let enqueue: ((chunk: Uint8Array) => void) | undefined;

      const wiredStream = new ReadableStream<Uint8Array>({
        start(streamController) {
          enqueue = (chunk) => {
            if (streamClosed) {
              return;
            }
            streamController.enqueue(chunk);
          };
          closeStream = () => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;
            streamController.close();
          };
          errorStream = (error) => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;
            streamController.error(error);
          };
        },
        cancel() {
          streamClosed = true;
          void release();
        },
      });

      const handleServerEvent = (event: XaiTtsStreamServerEvent) => {
        switch (event.type) {
          case "audio.delta": {
            const encoded = trimToUndefined(event.delta);
            if (!encoded) {
              return;
            }
            const chunk = Buffer.from(encoded, "base64");
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              errorStream?.(new Error(`xAI TTS audio stream exceeds ${maxBytes} bytes`));
              void release();
              return;
            }
            enqueue?.(new Uint8Array(chunk));
            refreshSynthesisTimer();
            return;
          }
          case "audio.done":
            clearTimers();
            closeStream?.();
            void release();
            return;
          case "error":
            failStream(new Error(readXaiTtsStreamErrorMessage(event)));
          default:
        }
      };

      ws?.on("message", (data) => {
        if (streamClosed || released) {
          return;
        }
        try {
          const payload = decodeWebSocketTextMessage(data);
          handleServerEvent(JSON.parse(payload) as XaiTtsStreamServerEvent);
        } catch (error) {
          failStream(error instanceof Error ? error : new Error(String(error)));
        }
      });

      ws?.on("close", () => {
        if (streamClosed || released) {
          return;
        }
        failStream(new Error("xAI TTS stream closed before audio.done"));
      });

      try {
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(offset + XAI_TTS_STREAM_TEXT_DELTA_MAX_CHARS, text.length);
          // Keep a surrogate pair in the same frame, even if that frame is one unit shorter.
          if (
            end < text.length &&
            text.charCodeAt(end - 1) >= 0xd800 &&
            text.charCodeAt(end - 1) <= 0xdbff &&
            text.charCodeAt(end) >= 0xdc00 &&
            text.charCodeAt(end) <= 0xdfff
          ) {
            end -= 1;
          }
          ws?.send(
            JSON.stringify({
              type: "text.delta",
              delta: text.slice(offset, end),
            }),
          );
          offset = end;
        }
        ws?.send(JSON.stringify({ type: "text.done" }));
      } catch (error) {
        failStream(error instanceof Error ? error : new Error(String(error)));
      }

      resolve({ audioStream: wiredStream, release });
    });
  });
}

export async function xaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: "mp3" | "wav" | "pcm" | "mulaw" | "alaw";
  timeoutMs: number;
  maxBytes?: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    language: rawLanguage,
    speed,
    responseFormat = "mp3",
    timeoutMs,
    maxBytes = DEFAULT_TTS_MAX_BYTES,
  } = params;
  const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";

  if (!isValidXaiTtsVoice(voiceId)) {
    throw new Error(`Invalid voice: ${voiceId}`);
  }

  const ttsBaseUrl = normalizeXaiTtsBaseUrl(baseUrl);
  const { response, release } = await postJsonRequest({
    url: `${ttsBaseUrl}/tts`,
    headers: new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...xaiUserAgentHeaderFor(ttsBaseUrl),
    }),
    body: {
      text,
      voice_id: voiceId,
      language,
      output_format: {
        codec: responseFormat,
      },
      ...(speed != null && { speed }),
    },
    timeoutMs,
    fetchFn: fetch,
    auditContext: "xai tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS API error");

    return await readResponseWithLimit(response, maxBytes, {
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`xAI TTS audio response exceeds ${maxBytesLocal} bytes`),
    });
  } finally {
    await release();
  }
}
