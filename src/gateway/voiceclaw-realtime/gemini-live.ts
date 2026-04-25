import WebSocket, { type RawData } from "ws";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildInstructions } from "./instructions.js";
import type {
  VoiceClawRealtimeAdapterOptions,
  VoiceClawRealtimeAdapter,
  VoiceClawSendToClient,
  VoiceClawSessionConfigEvent,
  VoiceClawRealtimeToolDeclaration,
} from "./types.js";

const log = createSubsystemLogger("gateway").child("voiceclaw-realtime");

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const SETUP_TIMEOUT_MS = 15_000;
const WATCHDOG_TIMEOUT_MS = 20_000;
const MAX_PENDING_AUDIO = 50;
const MAX_PENDING_VIDEO = 5;
const MAX_PENDING_CONTROL = 20;
const RECONNECTABLE_CLOSE_CODES = new Set([1001, 1006, 1007, 1011, 1012, 1013]);
const MAX_RECONNECT_ATTEMPTS = 2;
const RECONNECT_BACKOFF_MS = 500;

const GEMINI_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
const DEFAULT_GEMINI_VOICE = "Zephyr";

type GeminiMessage = Record<string, unknown>;

export class VoiceClawGeminiLiveAdapter implements VoiceClawRealtimeAdapter {
  private upstream: WebSocket | null = null;
  private sendToClient: VoiceClawSendToClient | null = null;
  private config: VoiceClawSessionConfigEvent | null = null;
  private tools: VoiceClawRealtimeToolDeclaration[] = [];
  private transcript: { role: "user" | "assistant"; text: string }[] = [];
  private currentAssistantText = "";
  private currentUserText = "";
  private userSpeaking = false;
  private pendingToolCalls = 0;
  private disconnected = false;
  private isReconnecting = false;
  private resumptionHandle: string | null = null;
  private currentlyResumable = false;
  private rotateAfterToolCalls = false;
  private pendingToolCallIds = new Set<string>();
  private asyncToolCallIds = new Set<string>();
  private pendingAudio: string[] = [];
  private pendingVideo: string[] = [];
  private pendingControl: string[] = [];
  private pendingToolResults: string[] = [];
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogEnabled = false;

  private turnStartedAtMs: number | null = null;
  private lastInputTranscriptionAtMs: number | null = null;
  private lastUpstreamAudioAtMs: number | null = null;
  private firstModelAudioAtMs: number | null = null;
  private firstModelTextAtMs: number | null = null;
  private turnWasInterrupted = false;

  async connect(
    config: VoiceClawSessionConfigEvent,
    sendToClient: VoiceClawSendToClient,
    options?: VoiceClawRealtimeAdapterOptions,
  ): Promise<void> {
    this.config = config;
    this.sendToClient = sendToClient;
    this.tools = options?.tools ?? [];
    this.disconnected = false;
    this.watchdogEnabled = config.watchdog === "enabled";
    await this.openUpstream();
  }

  sendAudio(data: string): void {
    const downsampled = downsample24to16(data);
    this.sendUpstream(
      {
        realtimeInput: {
          audio: {
            data: downsampled,
            mimeType: "audio/pcm;rate=16000",
          },
        },
      },
      "audio",
    );
    this.lastUpstreamAudioAtMs = Date.now();
    this.resetWatchdog();
  }

  commitAudio(): void {
    // Gemini Live uses automatic activity detection.
  }

  sendFrame(data: string, mimeType?: string): void {
    this.sendUpstream(
      {
        realtimeInput: {
          video: {
            data,
            mimeType: mimeType || "image/jpeg",
          },
        },
      },
      "video",
    );
  }

  createResponse(): void {
    // Gemini Live auto-responds based on VAD.
  }

  cancelResponse(): void {
    // Gemini Live handles barge-in/interruption server-side.
  }

  beginAsyncToolCall(callId: string): void {
    this.asyncToolCallIds.add(callId);
    this.pauseWatchdog();
  }

  finishAsyncToolCall(callId: string): void {
    if (!this.asyncToolCallIds.delete(callId)) {
      return;
    }
    this.resetWatchdog();
    this.maybeReconnectAfterToolCalls("deferred goAway");
  }

  sendToolResult(callId: string, output: string): void {
    this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
    this.pendingToolCallIds.delete(callId);
    this.sendUpstream(
      {
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              response: parseToolOutput(output),
            },
          ],
        },
      },
      "tool",
    );

    if (this.pendingToolCalls === 0) {
      this.resetWatchdog();
      this.maybeReconnectAfterToolCalls("deferred goAway");
    }
  }

  injectContext(text: string): void {
    log.info(`injecting async context into Gemini Live (${text.length} chars)`);
    this.sendUpstream({
      realtimeInput: {
        text,
      },
    });
  }

  getTranscript(): { role: "user" | "assistant"; text: string }[] {
    return [...this.transcript];
  }

  disconnect(): void {
    this.disconnected = true;
    this.clearWatchdog();
    this.asyncToolCallIds.clear();
    this.flushPendingTranscripts();
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      this.upstream.close();
    }
    this.upstream = null;
    this.sendToClient = null;
  }

  private openUpstream(): Promise<void> {
    if (!this.config) {
      throw new Error("Gemini Live adapter opened before session config");
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for VoiceClaw real-time brain mode");
    }

    const model = this.config.model || DEFAULT_MODEL;
    const ws = new WebSocket(`${GEMINI_WS_URL}?key=${encodeURIComponent(apiKey)}`);
    this.upstream = ws;

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (err) {
          ws.off("open", onOpen);
          ws.off("message", onMessage);
          ws.off("error", onError);
          ws.off("close", onClose);
          ws.on("error", () => {});
          ws.on("close", () => {});
          if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            try {
              ws.close(1011, "setup failed");
            } catch {
              // ignore close errors
            }
          }
          if (this.upstream === ws) {
            this.upstream = null;
          }
          reject(err);
          return;
        }
        resolve();
      };

      const onOpen = () => {
        try {
          this.sendSetup(this.config!, model);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const onMessage = (raw: RawData) => {
        try {
          const msg = JSON.parse(rawDataToString(raw)) as GeminiMessage;
          if ("setupComplete" in msg) {
            log.info(`Gemini Live setup complete model=${model}`);
            finish();
            this.flushPending();
            this.resetWatchdog();
            return;
          }
          this.handleServerMessage(msg);
        } catch (err) {
          log.warn(`failed to parse Gemini Live message: ${String(err)}`);
        }
      };

      const onError = (err: Error) => {
        finish(err);
      };

      const onClose = (code: number, reason: Buffer) => {
        if (!settled) {
          finish(new Error(String(reason) || "Gemini Live setup failed"));
          return;
        }
        this.handleUpstreamClose(code);
      };

      const timeoutHandle = setTimeout(
        () => finish(new Error("Gemini Live setup timed out")),
        SETUP_TIMEOUT_MS,
      );

      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private sendSetup(config: VoiceClawSessionConfigEvent, model: string): void {
    const setup: Record<string, unknown> = {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: resolveVoice(config.voice),
            },
          },
        },
      },
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      systemInstruction: {
        parts: [{ text: buildInstructions(config) }],
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          prefixPaddingMs: 20,
          silenceDurationMs: 500,
        },
      },
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
      contextWindowCompression: {
        slidingWindow: {},
        triggerTokens: 10_000,
      },
    };

    if (this.tools.length > 0) {
      setup.tools = [{ functionDeclarations: this.tools }];
    }

    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(JSON.stringify({ setup }));
    }
  }

  private handleServerMessage(msg: GeminiMessage): void {
    const serverContent = asRecord(msg.serverContent);
    if (serverContent) {
      this.handleServerContent(serverContent);
      return;
    }

    const toolCall = asRecord(msg.toolCall);
    if (toolCall) {
      this.handleToolCall(toolCall);
      return;
    }

    const cancellation = asRecord(msg.toolCallCancellation);
    if (cancellation) {
      const ids = Array.isArray(cancellation.ids)
        ? cancellation.ids.filter((id): id is string => typeof id === "string")
        : [];
      let cancelledCount = 0;
      for (const id of ids) {
        if (this.pendingToolCallIds.delete(id)) {
          cancelledCount += 1;
        }
        this.asyncToolCallIds.delete(id);
      }
      this.pendingToolCalls = Math.max(0, this.pendingToolCalls - cancelledCount);
      if (ids.length > 0) {
        this.sendToClient?.({ type: "tool.cancelled", callIds: ids });
      }
      this.resetWatchdog();
      this.maybeReconnectAfterToolCalls("deferred goAway");
      return;
    }

    if (asRecord(msg.goAway)) {
      if (this.pendingToolCalls > 0 || this.asyncToolCallIds.size > 0 || !this.currentlyResumable) {
        this.rotateAfterToolCalls = true;
        return;
      }
      void this.reconnect("goAway");
      return;
    }

    const sessionResumptionUpdate = asRecord(msg.sessionResumptionUpdate);
    if (sessionResumptionUpdate) {
      this.currentlyResumable = sessionResumptionUpdate.resumable === true;
      if (typeof sessionResumptionUpdate.newHandle === "string" && this.currentlyResumable) {
        this.resumptionHandle = sessionResumptionUpdate.newHandle;
      }
      this.maybeReconnectAfterToolCalls("deferred goAway");
      return;
    }

    const usageMetadata = asRecord(msg.usageMetadata);
    if (usageMetadata) {
      this.sendToClient?.({
        type: "usage.metrics",
        promptTokens: asNumber(usageMetadata.promptTokenCount),
        completionTokens: asNumber(usageMetadata.responseTokenCount),
        totalTokens: asNumber(usageMetadata.totalTokenCount),
        inputAudioTokens: findModalityTokens(usageMetadata.promptTokensDetails, "AUDIO"),
        outputAudioTokens: findModalityTokens(usageMetadata.responseTokensDetails, "AUDIO"),
      });
    }
  }

  private handleServerContent(content: Record<string, unknown>): void {
    const modelTurn = asRecord(content.modelTurn);
    const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
    for (const part of parts) {
      const inlineData = asRecord(asRecord(part)?.inlineData);
      if (typeof inlineData?.data === "string") {
        this.firstModelAudioAtMs ??= Date.now();
        this.sendToClient?.({ type: "audio.delta", data: inlineData.data });
        this.resetWatchdog();
      }
    }

    const outputText = asText(asRecord(content.outputTranscription)?.text);
    if (outputText) {
      this.flushUserTranscript();
      this.userSpeaking = false;
      this.firstModelTextAtMs ??= Date.now();
      this.currentAssistantText += outputText;
      this.sendToClient?.({ type: "transcript.delta", text: outputText, role: "assistant" });
    }

    const inputText = asText(asRecord(content.inputTranscription)?.text);
    if (inputText) {
      this.lastInputTranscriptionAtMs = Date.now();
      if (!this.userSpeaking) {
        this.userSpeaking = true;
        this.resetLatencyMarks();
        this.turnStartedAtMs = Date.now();
        this.sendToClient?.({ type: "turn.started" });
      }
      this.flushAssistantTranscript();
      this.currentUserText += inputText;
      this.sendToClient?.({ type: "transcript.delta", text: inputText, role: "user" });
    }

    if (content.turnComplete) {
      this.emitLatencyMetrics();
      this.flushPendingTranscripts();
      this.userSpeaking = false;
      this.sendToClient?.({ type: "turn.ended" });
    }

    if (content.interrupted) {
      this.turnWasInterrupted = true;
      if (!this.userSpeaking) {
        this.userSpeaking = true;
        this.sendToClient?.({ type: "turn.started" });
      }
      this.flushUserTranscript();
      this.flushAssistantTranscript("...");
    }
  }

  private handleToolCall(toolCall: Record<string, unknown>): void {
    const calls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    for (const rawCall of calls) {
      const call = asRecord(rawCall);
      if (!call || typeof call.id !== "string" || typeof call.name !== "string") {
        continue;
      }
      this.pendingToolCalls += 1;
      this.pendingToolCallIds.add(call.id);
      this.pauseWatchdog();
      this.sendToClient?.({
        type: "tool.call",
        callId: call.id,
        name: call.name,
        arguments: JSON.stringify(asRecord(call.args) ?? {}),
      });
    }
  }

  private handleUpstreamClose(code: number): void {
    if (this.disconnected || this.isReconnecting) {
      return;
    }
    if (this.hasActiveToolCalls()) {
      this.cancelActiveToolCalls("Gemini Live closed while a tool call was in flight");
      return;
    }
    if (code === 1000) {
      return;
    }
    if (!RECONNECTABLE_CLOSE_CODES.has(code) || !this.resumptionHandle) {
      this.sendToClient?.({ type: "error", message: "Gemini Live connection closed", code: 502 });
      return;
    }
    void this.reconnect(`close code ${code}`);
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.isReconnecting || this.disconnected || !this.resumptionHandle) {
      return;
    }
    this.isReconnecting = true;
    this.currentlyResumable = false;
    this.flushPendingTranscripts();
    this.userSpeaking = false;
    this.pauseWatchdog();
    this.sendToClient?.({ type: "session.rotating" });
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      this.upstream.removeAllListeners();
      try {
        this.upstream.close();
      } catch {
        // ignore close errors
      }
    }
    this.upstream = null;

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.openUpstream();
        this.isReconnecting = false;
        this.sendToClient?.({ type: "session.rotated", sessionId: `gemini-resumed-${Date.now()}` });
        return;
      } catch (err) {
        log.warn(
          `Gemini Live reconnect failed reason=${reason} attempt=${attempt}: ${sanitizeErrorMessage(String(err))}`,
        );
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));
        }
      }
    }
    this.isReconnecting = false;
    if (this.hasActiveToolCalls()) {
      this.cancelActiveToolCalls("Gemini Live reconnect failed while a tool call was in flight");
      return;
    }
    this.sendToClient?.({ type: "error", message: "Gemini Live reconnect failed", code: 502 });
  }

  private hasActiveToolCalls(): boolean {
    return (
      this.pendingToolCalls > 0 ||
      this.pendingToolCallIds.size > 0 ||
      this.asyncToolCallIds.size > 0 ||
      this.rotateAfterToolCalls
    );
  }

  private cancelActiveToolCalls(message: string): void {
    const callIds = Array.from(new Set([...this.pendingToolCallIds, ...this.asyncToolCallIds]));
    this.pendingToolCalls = 0;
    this.pendingToolCallIds.clear();
    this.asyncToolCallIds.clear();
    this.rotateAfterToolCalls = false;
    if (callIds.length > 0) {
      this.sendToClient?.({ type: "tool.cancelled", callIds });
    }
    this.sendToClient?.({ type: "error", message, code: 502 });
  }

  private maybeReconnectAfterToolCalls(reason: string): void {
    if (
      !this.rotateAfterToolCalls ||
      !this.currentlyResumable ||
      this.pendingToolCalls > 0 ||
      this.asyncToolCallIds.size > 0
    ) {
      return;
    }
    this.rotateAfterToolCalls = false;
    void this.reconnect(reason);
  }

  private sendUpstream(
    msg: Record<string, unknown>,
    kind: "audio" | "video" | "control" | "tool" = "control",
  ): void {
    const payload = JSON.stringify(msg);
    if (this.isReconnecting) {
      queueBounded(kind, payload, {
        audio: this.pendingAudio,
        video: this.pendingVideo,
        control: this.pendingControl,
        tool: this.pendingToolResults,
      });
      return;
    }
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(payload);
    }
  }

  private flushPending(): void {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      return;
    }
    const control = this.pendingControl;
    const audio = this.pendingAudio;
    const video = this.pendingVideo;
    const tool = this.pendingToolResults;
    this.pendingControl = [];
    this.pendingAudio = [];
    this.pendingVideo = [];
    this.pendingToolResults = [];
    for (const payload of tool) {
      this.upstream.send(payload);
    }
    for (const payload of control) {
      this.upstream.send(payload);
    }
    for (const payload of audio) {
      this.upstream.send(payload);
    }
    for (const payload of video) {
      this.upstream.send(payload);
    }
  }

  private flushPendingTranscripts(): void {
    this.flushUserTranscript();
    this.flushAssistantTranscript();
  }

  private flushUserTranscript(): void {
    if (!this.currentUserText) {
      return;
    }
    this.transcript.push({ role: "user", text: this.currentUserText });
    this.sendToClient?.({ type: "transcript.done", text: this.currentUserText, role: "user" });
    this.currentUserText = "";
  }

  private flushAssistantTranscript(suffix = ""): void {
    if (!this.currentAssistantText) {
      return;
    }
    const text = `${this.currentAssistantText}${suffix}`;
    this.transcript.push({ role: "assistant", text });
    this.sendToClient?.({ type: "transcript.done", text, role: "assistant" });
    this.currentAssistantText = "";
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    if (!this.watchdogEnabled || this.pendingToolCalls > 0 || this.asyncToolCallIds.size > 0) {
      return;
    }
    this.watchdogTimer = setTimeout(() => {
      this.sendUpstream({
        realtimeInput: {
          text: "(The user has been silent. If the conversation naturally ended, stay quiet. Otherwise, gently check if they are still there.)",
        },
      });
    }, WATCHDOG_TIMEOUT_MS);
  }

  private pauseWatchdog(): void {
    this.clearWatchdog();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private resetLatencyMarks(): void {
    this.turnStartedAtMs = null;
    this.lastInputTranscriptionAtMs = null;
    this.lastUpstreamAudioAtMs = null;
    this.firstModelAudioAtMs = null;
    this.firstModelTextAtMs = null;
    this.turnWasInterrupted = false;
  }

  private emitLatencyMetrics(): void {
    if (this.turnWasInterrupted) {
      this.resetLatencyMarks();
      return;
    }
    const firstOutputAt = pickEarliest(this.firstModelAudioAtMs, this.firstModelTextAtMs);
    if (firstOutputAt == null) {
      this.resetLatencyMarks();
      return;
    }
    const endpointStart = this.lastInputTranscriptionAtMs ?? this.lastUpstreamAudioAtMs ?? null;
    this.sendToClient?.({
      type: "latency.metrics",
      endpointMs: endpointStart != null ? Math.max(0, firstOutputAt - endpointStart) : undefined,
      endpointSource:
        this.lastInputTranscriptionAtMs != null
          ? "transcription_proxy"
          : this.lastUpstreamAudioAtMs != null
            ? "last_audio_frame"
            : undefined,
      providerFirstByteMs:
        this.lastUpstreamAudioAtMs != null
          ? Math.max(0, firstOutputAt - this.lastUpstreamAudioAtMs)
          : undefined,
      firstAudioFromTurnStartMs:
        this.firstModelAudioAtMs != null && this.turnStartedAtMs != null
          ? Math.max(0, this.firstModelAudioAtMs - this.turnStartedAtMs)
          : undefined,
      firstTextFromTurnStartMs:
        this.firstModelTextAtMs != null && this.turnStartedAtMs != null
          ? Math.max(0, this.firstModelTextAtMs - this.turnStartedAtMs)
          : undefined,
      firstOutputFromTurnStartMs:
        this.turnStartedAtMs != null
          ? Math.max(0, firstOutputAt - this.turnStartedAtMs)
          : undefined,
      firstOutputModality:
        this.firstModelAudioAtMs != null &&
        (this.firstModelTextAtMs == null || this.firstModelAudioAtMs <= this.firstModelTextAtMs)
          ? "audio"
          : "text",
    });
    this.resetLatencyMarks();
  }
}

function parseToolOutput(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
  } catch {
    return { result: output };
  }
}

function queueBounded(
  kind: "audio" | "video" | "control" | "tool",
  payload: string,
  queues: { audio: string[]; video: string[]; control: string[]; tool: string[] },
): void {
  if (kind === "tool") {
    queues.tool.push(payload);
    return;
  }
  if (kind === "audio") {
    if (queues.audio.length >= MAX_PENDING_AUDIO) {
      queues.audio.shift();
    }
    queues.audio.push(payload);
    return;
  }
  if (kind === "video") {
    if (queues.video.length >= MAX_PENDING_VIDEO) {
      queues.video.shift();
    }
    queues.video.push(payload);
    return;
  }
  if (queues.control.length < MAX_PENDING_CONTROL) {
    queues.control.push(payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickEarliest(a: number | null, b: number | null): number | null {
  if (a == null) {
    return b;
  }
  if (b == null) {
    return a;
  }
  return Math.min(a, b);
}

function resolveVoice(voice?: string): string {
  if (!voice) {
    return DEFAULT_GEMINI_VOICE;
  }
  return (
    GEMINI_VOICES.find((candidate) => candidate.toLowerCase() === voice.toLowerCase()) ??
    DEFAULT_GEMINI_VOICE
  );
}

function downsample24to16(base64Audio: string): string {
  const inputBuf = Buffer.from(base64Audio, "base64");
  const inputSamples = inputBuf.length / 2;
  const outputSamples = Math.floor((inputSamples * 16000) / 24000);
  const outputBuf = Buffer.alloc(outputSamples * 2);
  const ratio = 24000 / 16000;

  for (let i = 0; i < outputSamples; i += 1) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = inputBuf.readInt16LE(srcIdx * 2);
    const s1 = srcIdx + 1 < inputSamples ? inputBuf.readInt16LE((srcIdx + 1) * 2) : s0;
    const sample = Math.round(s0 * (1 - frac) + s1 * frac);
    outputBuf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return outputBuf.toString("base64");
}

function findModalityTokens(details: unknown, modality: string): number | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }
  for (const rawDetail of details) {
    const detail = asRecord(rawDetail);
    if (detail?.modality === modality) {
      return asNumber(detail.tokenCount);
    }
  }
  return undefined;
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/([?&]key=)[^&\s]+/g, "$1***");
}
