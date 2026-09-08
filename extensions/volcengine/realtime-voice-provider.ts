// Doubao end-to-end realtime voice provider for OpenClaw's gateway relay.
import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import WebSocket from "ws";
import {
  extractDoubaoSpeakableMessage,
  resamplePcm16Mono24kTo16k,
  truncateCharacters,
  type Pcm24kTo16kResamplerState,
} from "./realtime-voice-utils.js";
import {
  DOUBAO_CLIENT_EVENT,
  DOUBAO_SERVER_EVENT,
  decodeDoubaoFrame,
  encodeDoubaoFrame,
  type DecodedDoubaoFrame,
} from "./realtime-wire.js";

const DOUBAO_REALTIME_URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const DOUBAO_REALTIME_RESOURCE_ID = "volc.speech.dialog";
const DOUBAO_REALTIME_DEFAULT_MODEL = "1.2.1.1";
const DOUBAO_REALTIME_DEFAULT_VOICE = "zh_male_yunzhou_jupiter_bigtts";
const DOUBAO_REALTIME_CONNECT_TIMEOUT_MS = 15_000;
const DOUBAO_MAX_PENDING_AUDIO_BYTES = 1024 * 1024;
const DOUBAO_MAX_PENDING_TEXT_BYTES = 16 * 1024;
const DOUBAO_CHAT_TTS_CHUNK_CHARACTERS = 400;

const DOUBAO_REALTIME_CAPABILITIES: RealtimeVoiceProviderCapabilities = {
  transports: ["gateway-relay"],
  inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
  outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
  supportsBrowserSession: false,
  supportsBargeIn: true,
  handlesInputAudioBargeIn: true,
  supportsToolCalls: false,
  supportsVideoFrames: false,
};

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

type DoubaoRealtimeProviderConfig = {
  apiKey?: string;
  model?: string;
  voice?: string;
  botName?: string;
  speakingStyle?: string;
  silenceDurationMs?: number;
};

type DoubaoSocket = {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): DoubaoSocket;
  send(data: Buffer): void;
  close(): void;
};

type DoubaoSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => DoubaoSocket;

type DoubaoRealtimeVoiceProviderOptions = {
  createSocket?: DoubaoSocketFactory;
  connectTimeoutMs?: number;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeDoubaoProviderConfig(
  raw: RealtimeVoiceProviderConfig,
): DoubaoRealtimeProviderConfig {
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "talk.realtime.providers.doubao.apiKey",
    }),
    model: optionalString(raw.model),
    voice: optionalString(raw.speakerVoice) ?? optionalString(raw.voice),
    botName: optionalString(raw.botName),
    speakingStyle: optionalString(raw.speakingStyle),
    silenceDurationMs: optionalNonNegativeInteger(raw.silenceDurationMs),
  };
}

function readText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = optionalString(record.text) ?? optionalString(record.transcript);
  if (direct) {
    return direct;
  }
  const results = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.result)
      ? record.result
      : undefined;
  if (!results) {
    return undefined;
  }
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const entry = results[index];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const text = optionalString((entry as Record<string, unknown>).text);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function readTtsType(payload: unknown): string | undefined {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? optionalString((payload as Record<string, unknown>).tts_type)
    : undefined;
}

function readFailureDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "status_code"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncateCharacters(value.trim(), 240);
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function resultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "result", "output", "error", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return JSON.stringify(result ?? "");
}

function toBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry))) {
    return Buffer.concat(value);
  }
  return undefined;
}

class DoubaoRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;
  readonly handlesInputAudioBargeIn = true;

  private socket: DoubaoSocket | undefined;
  private sessionId = "";
  private ready = false;
  private closing = false;
  private terminalNotified = false;
  private sessionStartSent = false;
  private lastUserTranscript = "";
  private lastAssistantTranscript = "";
  private activeTtsType: string | undefined;
  private forwardActiveTts = false;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private pendingText: string[] = [];
  private pendingTextBytes = 0;
  private pendingGreeting: string | undefined;
  private readonly resamplerState: Pcm24kTo16kResamplerState = {
    pending: Buffer.alloc(0),
    sourcePosition: 0,
  };

  constructor(
    private readonly request: RealtimeVoiceBridgeCreateRequest,
    private readonly config: Required<
      Pick<DoubaoRealtimeProviderConfig, "apiKey" | "model" | "voice" | "botName">
    > &
      DoubaoRealtimeProviderConfig,
    private readonly createSocket: DoubaoSocketFactory,
    private readonly connectTimeoutMs: number,
  ) {}

  connect(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    if (this.socket) {
      return Promise.reject(new Error("Doubao realtime connection is already starting"));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishResolve = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      const finishReject = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      };
      const timeout = setTimeout(() => {
        const error = new Error("Doubao realtime connection timed out");
        this.request.onError?.(error);
        finishReject(error);
        this.socket?.close();
      }, this.connectTimeoutMs);

      try {
        this.socket = this.createSocket(DOUBAO_REALTIME_URL, {
          headers: {
            "X-Api-Key": this.config.apiKey,
            "X-Api-Resource-Id": DOUBAO_REALTIME_RESOURCE_ID,
            "X-Api-Request-Id": randomUUID(),
            "X-Api-Connect-Id": randomUUID(),
            "X-Api-Sequence": "-1",
          },
        });
      } catch (cause) {
        finishReject(cause instanceof Error ? cause : new Error("Doubao socket creation failed"));
        return;
      }

      this.socket
        .on("open", () => {
          this.sendJson(DOUBAO_CLIENT_EVENT.StartConnection, {}, false);
          this.emitEvent("client", "connection.start");
        })
        .on("message", (data) => {
          const buffer = toBuffer(data);
          if (!buffer) {
            return;
          }
          const frame = decodeDoubaoFrame(buffer);
          if (frame) {
            this.handleServerFrame(frame, finishResolve, finishReject);
          }
        })
        .on("error", (cause) => {
          const error = cause instanceof Error ? cause : new Error("Doubao realtime socket failed");
          this.request.onError?.(error);
          finishReject(error);
        })
        .on("close", () => {
          this.ready = false;
          if (!this.closing) {
            const error = new Error("Doubao realtime socket closed unexpectedly");
            this.request.onError?.(error);
            finishReject(error);
            this.notifyClose("error");
          } else {
            this.notifyClose("completed");
          }
        });
    });
  }

  sendAudio(audio: Buffer): void {
    if (!this.ready) {
      this.queueAudio(audio);
      return;
    }
    const resampled = resamplePcm16Mono24kTo16k(audio, this.resamplerState);
    if (resampled.byteLength > 0) {
      this.sendRaw(DOUBAO_CLIENT_EVENT.TaskRequest, resampled);
    }
  }

  setMediaTimestamp(_timestamp: number): void {}

  sendUserMessage(text: string): void {
    const speakable = extractDoubaoSpeakableMessage(text);
    if (!speakable) {
      return;
    }
    if (!this.ready) {
      this.queueText(speakable);
      return;
    }
    this.sendChatTtsText(speakable);
  }

  triggerGreeting(instructions?: string): void {
    const content = extractDoubaoSpeakableMessage(
      instructions?.trim() || "你好，我是 OpenClaw，有什么可以帮你？",
    );
    if (!content) {
      return;
    }
    if (!this.ready) {
      this.pendingGreeting = content;
      return;
    }
    this.sendJson(DOUBAO_CLIENT_EVENT.SayHello, { content });
    this.request.onTranscript?.("assistant", content, true);
  }

  handleBargeIn(): void {
    this.request.onClearAudio("barge-in");
    this.emitEvent("server", "input_audio_buffer.speech_started");
  }

  submitToolResult(
    _callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (!options?.suppressResponse) {
      this.sendUserMessage(resultText(result));
    }
  }

  acknowledgeMark(_markName?: string): void {}

  close(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (this.sessionStartSent) {
        this.sendJson(DOUBAO_CLIENT_EVENT.FinishSession, {});
      }
      this.sendJson(DOUBAO_CLIENT_EVENT.FinishConnection, {}, false);
    }
    this.socket?.close();
    if (!this.socket) {
      this.notifyClose("completed");
    }
  }

  isConnected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  private handleServerFrame(
    frame: DecodedDoubaoFrame,
    resolveConnect: () => void,
    rejectConnect: (error: Error) => void,
  ): void {
    if (frame.messageType === 0x0f || frame.errorCode !== undefined) {
      const error = new Error(`Doubao realtime protocol error (${frame.errorCode ?? "unknown"})`);
      this.request.onError?.(error);
      rejectConnect(error);
      return;
    }

    switch (frame.event) {
      case DOUBAO_SERVER_EVENT.ConnectionStarted:
        if (!this.sessionStartSent) {
          if (!frame.sessionId) {
            const error = new Error("Doubao realtime connection did not return a session id");
            this.request.onError?.(error);
            rejectConnect(error);
            break;
          }
          this.sessionId = frame.sessionId;
          this.sessionStartSent = true;
          this.sendJson(DOUBAO_CLIENT_EVENT.StartSession, this.buildStartSessionPayload());
          this.emitEvent("client", "session.start");
        }
        break;
      case DOUBAO_SERVER_EVENT.SessionStarted:
        this.ready = true;
        this.request.onReady?.();
        this.emitEvent("server", "session.ready");
        resolveConnect();
        this.flushPending();
        break;
      case DOUBAO_SERVER_EVENT.ASRInfo:
        this.request.onClearAudio("barge-in");
        this.emitEvent("server", "input_audio_buffer.speech_started");
        break;
      case DOUBAO_SERVER_EVENT.ASRResponse: {
        const text = readText(frame.jsonPayload);
        if (text) {
          this.lastUserTranscript = text;
          this.request.onTranscript?.("user", text, false);
        }
        break;
      }
      case DOUBAO_SERVER_EVENT.ASREnded: {
        const text = readText(frame.jsonPayload) ?? this.lastUserTranscript;
        if (text) {
          this.request.onTranscript?.("user", text, true);
        }
        this.lastUserTranscript = "";
        break;
      }
      case DOUBAO_SERVER_EVENT.ChatResponse: {
        const text = readText(frame.jsonPayload);
        if (text) {
          this.lastAssistantTranscript = text;
          if (this.request.autoRespondToAudio !== false) {
            this.request.onTranscript?.("assistant", text, false);
          }
        }
        break;
      }
      case DOUBAO_SERVER_EVENT.ChatEnded: {
        const text = readText(frame.jsonPayload) ?? this.lastAssistantTranscript;
        if (text && this.request.autoRespondToAudio !== false) {
          this.request.onTranscript?.("assistant", text, true);
        }
        this.lastAssistantTranscript = "";
        break;
      }
      case DOUBAO_SERVER_EVENT.TTSSentenceStart:
        this.activeTtsType = readTtsType(frame.jsonPayload);
        this.forwardActiveTts =
          this.request.autoRespondToAudio !== false || this.activeTtsType === "chat_tts_text";
        break;
      case DOUBAO_SERVER_EVENT.TTSResponse:
        if (this.forwardActiveTts && frame.binaryPayload?.byteLength) {
          this.request.onAudio(frame.binaryPayload);
          this.emitEvent("server", "response.audio.delta");
        }
        break;
      case DOUBAO_SERVER_EVENT.TTSEnded:
        if (this.forwardActiveTts) {
          this.emitEvent("server", "response.audio.done");
        }
        this.activeTtsType = undefined;
        this.forwardActiveTts = false;
        break;
      case DOUBAO_SERVER_EVENT.ConnectionFailed:
      case DOUBAO_SERVER_EVENT.SessionFailed:
      case DOUBAO_SERVER_EVENT.ChatFailed: {
        const detail = readFailureDetail(frame.jsonPayload);
        const error = new Error(
          `Doubao realtime request failed (event ${frame.event}${detail ? `: ${detail}` : ""})`,
        );
        this.request.onError?.(error);
        rejectConnect(error);
        break;
      }
      case DOUBAO_SERVER_EVENT.SessionFinished:
      case DOUBAO_SERVER_EVENT.ConnectionFinished:
        if (!this.closing) {
          this.close();
        }
        break;
      default:
        break;
    }
  }

  private buildStartSessionPayload(): Record<string, unknown> {
    const dialog: Record<string, unknown> = {
      bot_name: this.config.botName,
      extra: {
        model: this.config.model,
        strict_audit: false,
      },
    };
    if (this.request.instructions?.trim()) {
      dialog.system_role = this.request.instructions.trim();
    }
    if (this.config.speakingStyle) {
      dialog.speaking_style = this.config.speakingStyle;
    }
    return {
      asr: {
        audio_info: { format: "pcm", sample_rate: 16_000, channel: 1 },
        extra: {
          end_smooth_window_ms: Math.max(
            500,
            Math.min(50_000, this.config.silenceDurationMs ?? 1_500),
          ),
        },
      },
      tts: {
        speaker: this.config.voice,
        audio_config: { channel: 1, format: "pcm_s16le", sample_rate: 24_000 },
        extra: {},
      },
      dialog,
    };
  }

  private sendChatTtsText(text: string): void {
    const characters = Array.from(text);
    const chunks: string[] = [];
    for (let offset = 0; offset < characters.length; offset += DOUBAO_CHAT_TTS_CHUNK_CHARACTERS) {
      chunks.push(characters.slice(offset, offset + DOUBAO_CHAT_TTS_CHUNK_CHARACTERS).join(""));
    }
    chunks.forEach((content, index) => {
      this.sendJson(DOUBAO_CLIENT_EVENT.ChatTTSText, {
        start: index === 0,
        content,
        end: false,
      });
    });
    this.sendJson(DOUBAO_CLIENT_EVENT.ChatTTSText, { start: false, content: "", end: true });
    this.request.onTranscript?.("assistant", text, true);
    this.emitEvent("client", "response.text.injected");
  }

  private queueAudio(audio: Buffer): void {
    const copy = Buffer.from(audio);
    if (copy.byteLength > DOUBAO_MAX_PENDING_AUDIO_BYTES) {
      return;
    }
    while (
      this.pendingAudio.length > 0 &&
      this.pendingAudioBytes + copy.byteLength > DOUBAO_MAX_PENDING_AUDIO_BYTES
    ) {
      const dropped = this.pendingAudio.shift();
      this.pendingAudioBytes -= dropped?.byteLength ?? 0;
    }
    if (this.pendingAudioBytes + copy.byteLength <= DOUBAO_MAX_PENDING_AUDIO_BYTES) {
      this.pendingAudio.push(copy);
      this.pendingAudioBytes += copy.byteLength;
    }
  }

  private queueText(text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > DOUBAO_MAX_PENDING_TEXT_BYTES) {
      return;
    }
    while (
      this.pendingText.length > 0 &&
      this.pendingTextBytes + bytes > DOUBAO_MAX_PENDING_TEXT_BYTES
    ) {
      const dropped = this.pendingText.shift();
      this.pendingTextBytes -= dropped ? Buffer.byteLength(dropped, "utf8") : 0;
    }
    this.pendingText.push(text);
    this.pendingTextBytes += bytes;
  }

  private flushPending(): void {
    const audio = this.pendingAudio;
    const text = this.pendingText;
    const greeting = this.pendingGreeting;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingText = [];
    this.pendingTextBytes = 0;
    this.pendingGreeting = undefined;
    if (greeting) {
      this.sendJson(DOUBAO_CLIENT_EVENT.SayHello, { content: greeting });
      this.request.onTranscript?.("assistant", greeting, true);
    }
    for (const chunk of audio) {
      this.sendAudio(chunk);
    }
    for (const message of text) {
      this.sendChatTtsText(message);
    }
  }

  private sendJson(event: number, payload: unknown, includeSession = true): void {
    this.sendFrame(
      encodeDoubaoFrame({
        messageType: 0x01,
        event,
        sessionId: includeSession ? this.sessionId : undefined,
        serialization: "json",
        payload,
      }),
    );
  }

  private sendRaw(event: number, payload: Buffer): void {
    this.sendFrame(
      encodeDoubaoFrame({
        messageType: 0x02,
        event,
        sessionId: this.sessionId,
        serialization: "raw",
        payload,
      }),
    );
  }

  private sendFrame(frame: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
    }
  }

  private emitEvent(direction: "client" | "server", type: string): void {
    this.request.onEvent?.({ direction, type });
  }

  private notifyClose(reason: "completed" | "error"): void {
    if (!this.terminalNotified) {
      this.terminalNotified = true;
      this.request.onClose?.(reason);
    }
  }
}

export function buildDoubaoRealtimeVoiceProvider(
  options: DoubaoRealtimeVoiceProviderOptions = {},
): RealtimeVoiceProviderPlugin {
  const createSocket: DoubaoSocketFactory =
    options.createSocket ??
    ((url, socketOptions) => new WebSocket(url, socketOptions) as unknown as DoubaoSocket);
  const provider: RealtimeVoiceProviderPlugin = {
    id: "doubao",
    label: "Doubao Realtime Voice",
    aliases: ["volcengine-realtime"],
    defaultModel: DOUBAO_REALTIME_DEFAULT_MODEL,
    models: [DOUBAO_REALTIME_DEFAULT_MODEL],
    voices: [DOUBAO_REALTIME_DEFAULT_VOICE],
    autoSelectOrder: 30,
    capabilities: DOUBAO_REALTIME_CAPABILITIES,
    resolveConfig: ({ rawConfig }) => normalizeDoubaoProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeDoubaoProviderConfig(providerConfig).apiKey),
    createBridge: (request) => {
      const config = normalizeDoubaoProviderConfig(request.providerConfig);
      if (!config.apiKey) {
        throw new Error("Doubao realtime API key missing");
      }
      return new DoubaoRealtimeVoiceBridge(
        request,
        {
          ...config,
          apiKey: config.apiKey,
          model: config.model ?? DOUBAO_REALTIME_DEFAULT_MODEL,
          voice: config.voice ?? DOUBAO_REALTIME_DEFAULT_VOICE,
          botName: config.botName ?? "OpenClaw",
        },
        createSocket,
        options.connectTimeoutMs ?? DOUBAO_REALTIME_CONNECT_TIMEOUT_MS,
      );
    },
  };
  const internalApi = {
    isBrowserSessionConfigured: () => false,
    resolveGatewayRelayCapabilities: () => ({
      ...DOUBAO_REALTIME_CAPABILITIES,
      handlesAgentConsult: true,
    }),
  };
  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: internalApi,
  });
  return provider;
}
