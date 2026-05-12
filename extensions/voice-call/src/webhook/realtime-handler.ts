import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  createTalkSessionController,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  recordTalkObservabilityEvent,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { WebSocketServer } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";
import { RealtimeAudioPacer, RealtimeMulawSpeechStartDetector } from "./realtime-audio-pacer.js";
import {
  type StreamFrameAdapter,
  TelnyxStreamFrameAdapter,
  TwilioStreamFrameAdapter,
} from "./stream-frame-adapter.js";

export type ToolHandlerContext = {
  partialUserTranscript?: string;
};
export type ToolHandlerFn = (
  args: unknown,
  callId: string,
  context: ToolHandlerContext,
) => Promise<unknown>;

const STREAM_TOKEN_TTL_MS = 30_000;
const DEFAULT_HOST = "localhost:8443";
const MAX_REALTIME_MESSAGE_BYTES = 256 * 1024;
const MAX_REALTIME_WS_BUFFERED_BYTES = 1024 * 1024;
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_NATIVE_DEDUPE_MS = 2_000;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1800;
const CONSULT_TRANSCRIPT_SETTLE_MS = 350;
const CONSULT_TRANSCRIPT_SETTLE_MAX_MS = 1_000;
const MAX_PARTIAL_USER_TRANSCRIPT_CHARS = 1_200;
const RECENT_FINAL_USER_TRANSCRIPT_TTL_MS = 2_000;
const BARGE_IN_REQUIRED_LOUD_CHUNKS = 2;

function normalizePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (prefixed === "/") {
    return prefixed;
  }
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function buildGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return undefined;
  }
  const intro =
    "Start the call by greeting the caller naturally. Include this greeting in your first spoken reply:";
  return baseInstructions
    ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"`
    : `${intro} "${trimmedGreeting}"`;
}

function readSpeakableToolResultText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result.trim() || undefined;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const text = (result as { text?: unknown }).text;
  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }
  const output = (result as { output?: unknown }).output;
  return typeof output === "string" && output.trim() ? output.trim() : undefined;
}

function readConsultArgText(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConsultQuestionText(args: unknown): string | undefined {
  return (
    readConsultArgText(args, "question") ??
    readConsultArgText(args, "prompt") ??
    readConsultArgText(args, "query") ??
    readConsultArgText(args, "task")
  );
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findTextOverlap(base: string, next: string): number {
  const max = Math.min(base.length, next.length);
  for (let size = max; size > 0; size -= 1) {
    if (base.slice(-size) === next.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function shouldInsertTranscriptSpace(base: string, next: string): boolean {
  if (!base || !next) {
    return false;
  }
  const last = base.at(-1);
  if (
    /\s$/.test(base) ||
    last === "(" ||
    last === "[" ||
    last === "{" ||
    last === '"' ||
    last === "'" ||
    /^[\s,.;:!?)]/.test(next)
  ) {
    return false;
  }
  return true;
}

function appendTranscriptText(base: string | undefined, fragment: string): string {
  const next = normalizeTranscriptText(fragment);
  if (!next) {
    return base ?? "";
  }
  const current = normalizeTranscriptText(base ?? "");
  if (!current) {
    return next;
  }
  const currentLower = current.toLowerCase();
  const nextLower = next.toLowerCase();
  if (currentLower === nextLower || currentLower.endsWith(nextLower)) {
    return current;
  }
  if (nextLower.startsWith(currentLower)) {
    return next;
  }
  const overlap = findTextOverlap(currentLower, nextLower);
  if (overlap >= 6 || (overlap >= 3 && next.length <= 12)) {
    return `${current}${next.slice(overlap)}`.trim();
  }
  const separator = shouldInsertTranscriptSpace(current, next) ? " " : "";
  return `${current}${separator}${next}`.trim();
}

function limitPartialUserTranscript(text: string): string {
  if (text.length <= MAX_PARTIAL_USER_TRANSCRIPT_CHARS) {
    return text;
  }
  const tail = text.slice(-MAX_PARTIAL_USER_TRANSCRIPT_CHARS);
  return tail.replace(/^\S+\s+/, "").trimStart() || tail.trimStart();
}

function withFallbackConsultQuestion(args: unknown, fallback: string | undefined): unknown {
  const providerQuestion = readConsultQuestionText(args);
  const question = fallback?.trim();
  if (providerQuestion) {
    if (
      question &&
      providerQuestion.length <= 40 &&
      question.length >= providerQuestion.length + 8
    ) {
      const context = readConsultArgText(args, "context");
      const fallbackContext = `Realtime provider supplied a shorter consult question: ${providerQuestion}`;
      return args && typeof args === "object" && !Array.isArray(args)
        ? {
            ...args,
            question,
            context: context ? `${context}\n\n${fallbackContext}` : fallbackContext,
          }
        : { question, context: fallbackContext };
    }
    return args;
  }
  if (!question) {
    return args;
  }
  return args && typeof args === "object" && !Array.isArray(args)
    ? { ...args, question }
    : { question };
}

function buildForcedConsultSpeechPrompt(result: string): string {
  const trimmed = result.trim();
  const bounded =
    trimmed.length <= FORCED_CONSULT_RESULT_MAX_CHARS
      ? trimmed
      : `${trimmed.slice(0, FORCED_CONSULT_RESULT_MAX_CHARS - 16).trimEnd()} [truncated]`;
  return [
    "Internal OpenClaw consult result is ready.",
    "Do not call tools for this internal result.",
    "Speak the following answer to the caller now, briefly and naturally:",
    bounded,
  ].join("\n");
}

type PendingStreamToken = {
  expiry: number;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
  providerName?: "twilio" | "telnyx";
  callId?: string;
};

export type StreamSessionRequest = {
  providerName?: "twilio" | "telnyx";
  callId?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};

export type StreamSession = {
  token: string;
  streamUrl: string;
};

type CallRegistration = {
  callId: string;
  initialGreetingInstructions?: string;
};

type ActiveRealtimeVoiceBridge = RealtimeVoiceBridgeSession;

type RealtimeSpeakResult = {
  success: boolean;
  error?: string;
};

type ForcedConsultState = {
  promise: Promise<unknown>;
  sendSpeechPrompt: boolean;
  completedAt?: number;
};

type NativeConsultState = {
  startedAt: number;
  promise: Promise<unknown>;
  partialUserTranscript?: string;
};

type TelephonyCloseReason = "completed" | "error";

function appendRecentTalkEventMetadata(
  call: CallRecord | null | undefined,
  event: TalkEvent,
): void {
  if (!call) {
    return;
  }
  const metadata = call.metadata ?? {};
  const previous = Array.isArray(metadata.recentTalkEvents) ? metadata.recentTalkEvents : [];
  metadata.lastTalkEventAt = event.timestamp;
  metadata.lastTalkEventType = event.type;
  metadata.recentTalkEvents = [
    ...previous,
    {
      id: event.id,
      brain: event.brain,
      mode: event.mode,
      provider: event.provider,
      seq: event.seq,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      transport: event.transport,
      type: event.type,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.final !== undefined ? { final: event.final } : {}),
    },
  ].slice(-12);
  call.metadata = metadata;
}

export class RealtimeCallHandler {
  private readonly toolHandlers = new Map<string, ToolHandlerFn>();
  private readonly pendingStreamTokens = new Map<string, PendingStreamToken>();
  private readonly activeBridgesByCallId = new Map<string, ActiveRealtimeVoiceBridge>();
  private readonly activeTelephonyClosersByCallId = new Map<
    string,
    (reason: TelephonyCloseReason) => void
  >();
  private readonly partialUserTranscriptsByCallId = new Map<string, string>();
  private readonly partialUserTranscriptUpdatedAtByCallId = new Map<string, number>();
  private readonly recentFinalUserTranscriptsByCallId = new Map<string, string>();
  private readonly recentFinalUserTranscriptTimersByCallId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly forcedConsultTimersByCallId = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly forcedConsultInFlightByCallId = new Set<string>();
  private readonly forcedConsultsByCallId = new Map<string, ForcedConsultState>();
  private readonly lastProviderConsultAtByCallId = new Map<string, number>();
  private readonly nativeConsultsInFlightByCallId = new Map<string, NativeConsultState>();
  private publicOrigin: string | null = null;
  private publicPathPrefix = "";

  constructor(
    private readonly config: VoiceCallRealtimeConfig,
    private readonly manager: CallManager,
    private readonly provider: VoiceCallProvider,
    private readonly realtimeProvider: RealtimeVoiceProviderPlugin,
    private readonly providerConfig: RealtimeVoiceProviderConfig,
    private readonly servePath: string,
    private readonly coreConfig?: OpenClawConfig,
  ) {}

  setPublicUrl(url: string): void {
    try {
      const parsed = new URL(url);
      this.publicOrigin = parsed.host;
      const normalizedServePath = normalizePath(this.servePath);
      const normalizedPublicPath = normalizePath(parsed.pathname);
      const idx = normalizedPublicPath.indexOf(normalizedServePath);
      this.publicPathPrefix = idx > 0 ? normalizedPublicPath.slice(0, idx) : "";
    } catch {
      this.publicOrigin = null;
      this.publicPathPrefix = "";
    }
  }

  getStreamPathPattern(): string {
    return `${this.publicPathPrefix}${normalizePath(this.config.streamPath ?? "/voice/stream/realtime")}`;
  }

  buildTwiMLPayload(req: http.IncomingMessage, params?: URLSearchParams): WebhookResponsePayload {
    const rawDirection = params?.get("Direction");
    const previousOrigin = this.publicOrigin;
    if (!previousOrigin) {
      this.publicOrigin = req.headers.host ?? DEFAULT_HOST;
    }
    try {
      const { streamUrl } = this.issueStreamSession({
        providerName: "twilio",
        from: params?.get("From") ?? undefined,
        to: params?.get("To") ?? undefined,
        direction: rawDirection?.startsWith("outbound") ? "outbound" : "inbound",
      });
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml,
      };
    } finally {
      this.publicOrigin = previousOrigin;
    }
  }

  handleWebSocketUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "wss://localhost");
    const token = url.pathname.split("/").pop() ?? null;
    const callerMeta = token ? this.consumeStreamToken(token) : null;
    if (!callerMeta) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const providerName = callerMeta.providerName ?? "twilio";
    const adapter: StreamFrameAdapter =
      providerName === "telnyx" ? new TelnyxStreamFrameAdapter() : new TwilioStreamFrameAdapter();

    const wss = new WebSocketServer({
      noServer: true,
      // Reject oversized realtime frames before JSON parsing or bridge setup runs.
      maxPayload: MAX_REALTIME_MESSAGE_BYTES,
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      let bridge: ActiveRealtimeVoiceBridge | null = null;
      let initialized = false;
      let activeCallSid = "unknown";
      let stopReceived = false;
      let lastMediaTimestamp: number | undefined;
      let lastMediaGapWarnAt = 0;

      ws.on("message", (data: Buffer) => {
        try {
          const frame = adapter.parseInbound(data.toString());
          if (frame.kind === "ignored") {
            return;
          }
          if (frame.kind === "start") {
            if (initialized) {
              return;
            }
            initialized = true;
            activeCallSid = frame.providerCallId;
            const nextBridge = this.handleCall(
              frame.streamId,
              frame.providerCallId,
              ws,
              callerMeta,
              adapter,
            );
            if (!nextBridge) {
              return;
            }
            bridge = nextBridge;
            return;
          }
          if (!bridge) {
            return;
          }
          if (frame.kind === "media") {
            const audio = Buffer.from(frame.payloadBase64, "base64");
            bridge.sendAudio(audio);
            if (frame.timestampMs !== undefined) {
              if (lastMediaTimestamp !== undefined) {
                const gapMs = frame.timestampMs - lastMediaTimestamp;
                const now = Date.now();
                if ((gapMs > 120 || gapMs < 0) && now - lastMediaGapWarnAt > 5_000) {
                  lastMediaGapWarnAt = now;
                  console.warn(
                    `[voice-call] realtime media timestamp gap providerCallId=${activeCallSid} gapMs=${gapMs} timestamp=${frame.timestampMs}`,
                  );
                }
              }
              lastMediaTimestamp = frame.timestampMs;
              bridge.setMediaTimestamp(frame.timestampMs);
            }
            return;
          }
          if (frame.kind === "mark") {
            bridge.acknowledgeMark();
            return;
          }
          if (frame.kind === "error") {
            console.error(
              `[voice-call] realtime WS error frame providerCallId=${activeCallSid} code=${frame.code ?? "?"} title=${frame.title ?? ""} detail=${frame.detail ?? ""}`,
            );
            return;
          }
          if (frame.kind === "stop") {
            stopReceived = true;
            this.closeTelephonyBridge(activeCallSid, bridge, "completed");
          }
        } catch (error) {
          console.error("[voice-call] realtime WS parse failed:", error);
        }
      });

      ws.on("close", (code) => {
        const reason = stopReceived || code === 1000 || code === 1005 ? "completed" : "error";
        this.closeTelephonyBridge(activeCallSid, bridge, reason);
      });

      ws.on("error", (error) => {
        console.error("[voice-call] realtime WS error:", error);
      });
    });
  }

  registerToolHandler(name: string, fn: ToolHandlerFn): void {
    this.toolHandlers.set(name, fn);
  }

  speak(callId: string, instructions: string): RealtimeSpeakResult {
    const bridge = this.activeBridgesByCallId.get(callId);
    if (!bridge) {
      return { success: false, error: "No active realtime bridge for call" };
    }
    try {
      bridge.triggerGreeting(instructions);
      return { success: true };
    } catch (error) {
      return { success: false, error: formatErrorMessage(error) };
    }
  }

  issueStreamSession(request: StreamSessionRequest = {}): StreamSession {
    const token = this.issueStreamToken({
      providerName: request.providerName ?? "twilio",
      callId: request.callId,
      from: request.from,
      to: request.to,
      direction: request.direction,
    });
    const host = this.publicOrigin || DEFAULT_HOST;
    const streamUrl = `wss://${host}${this.getStreamPathPattern()}/${token}`;
    return { token, streamUrl };
  }

  private issueStreamToken(meta: Omit<PendingStreamToken, "expiry"> = {}): string {
    const token = randomUUID();
    this.pendingStreamTokens.set(token, { expiry: Date.now() + STREAM_TOKEN_TTL_MS, ...meta });
    for (const [candidate, entry] of this.pendingStreamTokens) {
      if (Date.now() > entry.expiry) {
        this.pendingStreamTokens.delete(candidate);
      }
    }
    return token;
  }

  private consumeStreamToken(token: string): Omit<PendingStreamToken, "expiry"> | null {
    const entry = this.pendingStreamTokens.get(token);
    if (!entry) {
      return null;
    }
    this.pendingStreamTokens.delete(token);
    if (Date.now() > entry.expiry) {
      return null;
    }
    return {
      from: entry.from,
      to: entry.to,
      direction: entry.direction,
      providerName: entry.providerName,
      callId: entry.callId,
    };
  }

  private handleCall(
    streamSid: string,
    callSid: string,
    ws: WebSocket,
    callerMeta: Omit<PendingStreamToken, "expiry">,
    adapter: StreamFrameAdapter,
  ): ActiveRealtimeVoiceBridge | null {
    const registration = this.registerCallInManager(callSid, callerMeta);
    if (!registration) {
      ws.close(1008, "Caller rejected by policy");
      return null;
    }

    const { callId, initialGreetingInstructions } = registration;
    const callRecord = this.manager.getCallByProviderCallId(callSid);
    const talk: TalkSessionController = createTalkSessionController(
      {
        sessionId: `voice-call:${callId}:realtime`,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: this.realtimeProvider.id,
      },
      { onEvent: recordTalkObservabilityEvent },
    );
    const rememberTalkEvent = (event: TalkEvent | undefined): TalkEvent | undefined => {
      if (event) {
        appendRecentTalkEventMetadata(callRecord, event);
      }
      return event;
    };
    const emitTalkEvent = (input: TalkEventInput): TalkEvent => {
      return rememberTalkEvent(talk.emit(input)) as TalkEvent;
    };
    const ensureTalkTurn = (): string => {
      const turn = talk.ensureTurn({
        payload: { callId, providerCallId: callSid },
      });
      rememberTalkEvent(turn.event);
      return turn.turnId;
    };
    const endTalkTurn = (reason = "completed"): void => {
      const ended = talk.endTurn({
        payload: { callId, providerCallId: callSid, reason },
      });
      if (ended.ok) {
        rememberTalkEvent(ended.event);
      }
    };
    const finishOutputAudio = (reason: string): void => {
      rememberTalkEvent(
        talk.finishOutputAudio({
          payload: { callId, providerCallId: callSid, reason },
        }),
      );
    };
    emitTalkEvent({
      type: "session.started",
      payload: { callId, providerCallId: callSid, streamSid },
    });
    console.log(
      `[voice-call] Realtime bridge starting for call ${callId} (providerCallId=${callSid}, initialGreeting=${initialGreetingInstructions ? "queued" : "absent"})`,
    );
    let callEndEmitted = false;
    const emitCallEnd = (reason: "completed" | "error") => {
      if (callEndEmitted) {
        return;
      }
      callEndEmitted = true;
      this.endCallInManager(callSid, callId, reason);
    };

    const sendString = (message: string): boolean => {
      if (ws.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
        console.warn(
          `[voice-call] realtime outbound websocket backpressure before send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`,
        );
        ws.close(1013, "Backpressure: send buffer exceeded");
        return false;
      }
      ws.send(message);
      if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
        console.warn(
          `[voice-call] realtime outbound websocket backpressure after send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`,
        );
        ws.close(1013, "Backpressure: send buffer exceeded");
        return false;
      }
      return true;
    };
    const audioPacer = new RealtimeAudioPacer({
      send: sendString,
      serializer: {
        media: (payload) => adapter.serializeMedia(payload),
        clear: () => adapter.serializeClear(),
        mark: (name) => adapter.serializeMark(name),
      },
      onBackpressure: () => {
        console.warn(
          `[voice-call] realtime paced audio backpressure callId=${callId} providerCallId=${callSid}`,
        );
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1013, "Backpressure: paced audio queue exceeded");
        }
      },
    });
    const speechDetector = new RealtimeMulawSpeechStartDetector({
      requiredLoudChunks: BARGE_IN_REQUIRED_LOUD_CHUNKS,
    });
    const session = createRealtimeVoiceBridgeSession({
      provider: this.realtimeProvider,
      cfg: this.coreConfig,
      providerConfig: this.providerConfig,
      instructions: this.config.instructions,
      tools: this.config.tools,
      initialGreetingInstructions,
      triggerGreetingOnReady: Boolean(initialGreetingInstructions),
      audioSink: {
        isOpen: () => ws.readyState === WebSocket.OPEN,
        sendAudio: (muLaw) => {
          const turnId = ensureTalkTurn();
          rememberTalkEvent(
            talk.startOutputAudio({
              turnId,
              payload: { callId, providerCallId: callSid },
            }).event,
          );
          emitTalkEvent({
            type: "output.audio.delta",
            turnId,
            payload: { byteLength: muLaw.length },
          });
          audioPacer.sendAudio(muLaw);
        },
        clearAudio: () => {
          const clearedBytes = audioPacer.clearAudio();
          console.log(
            `[voice-call] realtime outbound audio clear requested callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`,
          );
          finishOutputAudio("clear");
        },
        sendMark: (markName) => {
          audioPacer.sendMark(markName);
        },
      },
      onTranscript: (role, text, isFinal) => {
        const turnId = ensureTalkTurn();
        const eventType =
          role === "assistant"
            ? isFinal
              ? "output.text.done"
              : "output.text.delta"
            : isFinal
              ? "transcript.done"
              : "transcript.delta";
        const payload = role === "assistant" ? { text } : { role, text };
        emitTalkEvent({
          type: eventType,
          turnId,
          payload,
          final: isFinal,
        });
        if (role === "user" && isFinal) {
          emitTalkEvent({
            type: "input.audio.committed",
            turnId,
            payload: { callId, providerCallId: callSid },
            final: true,
          });
        }
        if (!isFinal) {
          if (role === "user" && text.trim()) {
            const transcript = this.recordPartialUserTranscript(callId, text);
            console.log(
              `[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=false chars=${text.trim().length} aggregateChars=${transcript.length}`,
            );
          }
          return;
        }
        if (role === "user") {
          const transcript = this.recordPartialUserTranscript(callId, text);
          this.clearPartialUserTranscript(callId);
          this.setRecentFinalUserTranscript(callId, transcript);
          console.log(
            `[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=true chars=${text.trim().length} aggregateChars=${transcript.length}`,
          );
          const event: NormalizedEvent = {
            id: `realtime-speech-${callSid}-${Date.now()}`,
            type: "call.speech",
            callId,
            providerCallId: callSid,
            timestamp: Date.now(),
            transcript,
            isFinal: true,
          };
          this.manager.processEvent(event);
          this.scheduleForcedAgentConsult({
            session,
            callId,
            callSid,
            transcript,
            clearAudio: () => {
              const clearedBytes = audioPacer.clearAudio();
              console.log(
                `[voice-call] realtime forced consult cleared outbound audio callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`,
              );
            },
          });
          return;
        }
        this.manager.processEvent({
          id: `realtime-bot-${callSid}-${Date.now()}`,
          type: "call.speaking",
          callId,
          providerCallId: callSid,
          timestamp: Date.now(),
          text,
        });
      },
      onToolCall: (toolEvent, session) => {
        const turnId = ensureTalkTurn();
        emitTalkEvent({
          type: "tool.call",
          turnId,
          itemId: toolEvent.itemId,
          callId: toolEvent.callId,
          payload: { name: toolEvent.name, args: toolEvent.args },
        });
        console.log(
          `[voice-call] realtime tool call received callId=${callId} providerCallId=${callSid} tool=${toolEvent.name}`,
        );
        void this.executeToolCall(
          session,
          callId,
          toolEvent.callId || toolEvent.itemId,
          toolEvent.name,
          toolEvent.args,
          turnId,
          emitTalkEvent,
        );
      },
      onEvent: (event) => {
        if (event.type === "input_audio_buffer.speech_started") {
          ensureTalkTurn();
          return;
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          const turnId = talk.activeTurnId;
          if (!turnId) {
            return;
          }
          emitTalkEvent({
            type: "input.audio.committed",
            turnId,
            payload: { callId, providerCallId: callSid, source: event.type },
            final: true,
          });
          return;
        }
        if (event.type === "response.done") {
          finishOutputAudio("response.done");
          endTalkTurn("response.done");
          return;
        }
        if (event.type === "error") {
          emitTalkEvent({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
      },
      onReady: () => {
        emitTalkEvent({
          type: "session.ready",
          payload: { callId, providerCallId: callSid },
        });
      },
      onError: (error) => {
        console.error("[voice-call] realtime voice error:", error.message);
        emitTalkEvent({
          type: "session.error",
          payload: { message: error.message },
          final: true,
        });
      },
      onClose: (reason) => {
        this.activeBridgesByCallId.delete(callId);
        this.activeBridgesByCallId.delete(callSid);
        this.activeTelephonyClosersByCallId.delete(callId);
        this.activeTelephonyClosersByCallId.delete(callSid);
        this.clearUserTranscriptState(callId);
        finishOutputAudio(reason);
        emitTalkEvent({
          type: "session.closed",
          payload: { reason },
          final: true,
        });
        if (reason !== "error") {
          return;
        }
        emitCallEnd("error");
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "Bridge disconnected");
        }
        void this.provider
          .hangupCall({ callId, providerCallId: callSid, reason: "error" })
          .catch((error: unknown) => {
            console.warn(
              `[voice-call] Failed to hang up realtime call ${callSid}: ${formatErrorMessage(
                error,
              )}`,
            );
          });
      },
    });
    const closeTelephony = (reason: TelephonyCloseReason) => {
      emitCallEnd(reason);
      session.close();
    };
    this.activeBridgesByCallId.set(callId, session);
    this.activeBridgesByCallId.set(callSid, session);
    this.activeTelephonyClosersByCallId.set(callId, closeTelephony);
    this.activeTelephonyClosersByCallId.set(callSid, closeTelephony);
    const sendAudioToSession = session.sendAudio.bind(session);
    session.sendAudio = (audio) => {
      if (speechDetector.accept(audio)) {
        const interruptedTurnId = ensureTalkTurn();
        const clearedBytes = audioPacer.clearAudio();
        console.log(
          `[voice-call] realtime outbound audio cleared by barge-in callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`,
        );
        finishOutputAudio("barge-in");
        const cancelled = talk.cancelTurn({
          turnId: interruptedTurnId,
          payload: { callId, providerCallId: callSid, reason: "barge-in" },
        });
        if (cancelled.ok) {
          rememberTalkEvent(cancelled.event);
        }
      }
      emitTalkEvent({
        type: "input.audio.delta",
        turnId: ensureTalkTurn(),
        payload: { byteLength: audio.length },
      });
      sendAudioToSession(audio);
    };
    const closeSession = session.close.bind(session);
    session.close = () => {
      this.activeBridgesByCallId.delete(callId);
      this.activeBridgesByCallId.delete(callSid);
      this.activeTelephonyClosersByCallId.delete(callId);
      this.activeTelephonyClosersByCallId.delete(callSid);
      this.clearUserTranscriptState(callId);
      this.clearForcedConsultState(callId);
      audioPacer.close();
      closeSession();
    };

    session.connect().catch((error: Error) => {
      console.error("[voice-call] Failed to connect realtime bridge:", error);
      session.close();
      emitCallEnd("error");
      ws.close(1011, "Failed to connect");
    });

    return session;
  }

  private recordPartialUserTranscript(callId: string, text: string): string {
    const current = this.partialUserTranscriptsByCallId.get(callId);
    const next = limitPartialUserTranscript(appendTranscriptText(current, text));
    this.partialUserTranscriptsByCallId.set(callId, next);
    this.partialUserTranscriptUpdatedAtByCallId.set(callId, Date.now());
    return next;
  }

  private clearPartialUserTranscript(callId: string): void {
    this.partialUserTranscriptsByCallId.delete(callId);
    this.partialUserTranscriptUpdatedAtByCallId.delete(callId);
  }

  private setRecentFinalUserTranscript(callId: string, text: string): void {
    this.clearRecentFinalUserTranscript(callId);
    this.recentFinalUserTranscriptsByCallId.set(callId, text);
    const timer = setTimeout(() => {
      if (this.recentFinalUserTranscriptsByCallId.get(callId) === text) {
        this.recentFinalUserTranscriptsByCallId.delete(callId);
      }
      this.recentFinalUserTranscriptTimersByCallId.delete(callId);
    }, RECENT_FINAL_USER_TRANSCRIPT_TTL_MS);
    timer.unref?.();
    this.recentFinalUserTranscriptTimersByCallId.set(callId, timer);
  }

  private clearRecentFinalUserTranscript(callId: string): void {
    const timer = this.recentFinalUserTranscriptTimersByCallId.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.recentFinalUserTranscriptTimersByCallId.delete(callId);
    }
    this.recentFinalUserTranscriptsByCallId.delete(callId);
  }

  private clearUserTranscriptState(callId: string): void {
    this.clearPartialUserTranscript(callId);
    this.clearRecentFinalUserTranscript(callId);
  }

  private resolveUserTranscriptContext(callId: string): string | undefined {
    return (
      this.partialUserTranscriptsByCallId.get(callId) ??
      this.recentFinalUserTranscriptsByCallId.get(callId)
    );
  }

  private consumePartialUserTranscript(callId: string, consumed: string | undefined): void {
    const text = consumed?.trim();
    if (!text) {
      return;
    }
    const current = this.partialUserTranscriptsByCallId.get(callId);
    if (!current) {
      return;
    }
    if (current === text) {
      this.clearPartialUserTranscript(callId);
      return;
    }
    if (current.toLowerCase().startsWith(text.toLowerCase())) {
      const remaining = current.slice(text.length).trimStart();
      if (remaining) {
        this.partialUserTranscriptsByCallId.set(callId, remaining);
      } else {
        this.clearPartialUserTranscript(callId);
      }
    }
    const recent = this.recentFinalUserTranscriptsByCallId.get(callId);
    if (!recent) {
      return;
    }
    if (recent === text || recent.toLowerCase().startsWith(text.toLowerCase())) {
      this.clearRecentFinalUserTranscript(callId);
    }
  }

  private async waitForConsultTranscriptSettle(callId: string, startedAt: number): Promise<void> {
    const deadline = startedAt + CONSULT_TRANSCRIPT_SETTLE_MAX_MS;
    while (true) {
      const updatedAt = this.partialUserTranscriptUpdatedAtByCallId.get(callId);
      if (!updatedAt) {
        return;
      }
      const now = Date.now();
      const quietFor = now - updatedAt;
      if (quietFor >= CONSULT_TRANSCRIPT_SETTLE_MS || now >= deadline) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(CONSULT_TRANSCRIPT_SETTLE_MS - quietFor, deadline - now)),
      );
    }
  }

  private clearForcedConsultState(callId: string): void {
    const timer = this.forcedConsultTimersByCallId.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.forcedConsultTimersByCallId.delete(callId);
    }
    this.forcedConsultInFlightByCallId.delete(callId);
    this.forcedConsultsByCallId.delete(callId);
    this.lastProviderConsultAtByCallId.delete(callId);
  }

  private closeTelephonyBridge(
    callIdOrSid: string,
    bridge: ActiveRealtimeVoiceBridge | null,
    reason: TelephonyCloseReason,
  ): void {
    const closer = this.activeTelephonyClosersByCallId.get(callIdOrSid);
    if (closer) {
      closer(reason);
      return;
    }
    bridge?.close();
  }

  private scheduleForcedAgentConsult(params: {
    session: ActiveRealtimeVoiceBridge;
    callId: string;
    callSid: string;
    transcript: string;
    clearAudio: () => void;
  }): void {
    if (this.config.consultPolicy !== "always") {
      return;
    }
    const question = params.transcript.trim();
    if (!question) {
      return;
    }
    const handler = this.toolHandlers.get(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
    if (!handler) {
      return;
    }
    const existingTimer = this.forcedConsultTimersByCallId.get(params.callId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.forcedConsultTimersByCallId.delete(params.callId);
      if (this.forcedConsultInFlightByCallId.has(params.callId)) {
        return;
      }
      const lastProviderConsultAt = this.lastProviderConsultAtByCallId.get(params.callId) ?? 0;
      if (Date.now() - lastProviderConsultAt < 2_000) {
        return;
      }
      void this.runForcedAgentConsult({
        ...params,
        question,
        handler,
      });
    }, FORCED_CONSULT_FALLBACK_DELAY_MS);
    this.forcedConsultTimersByCallId.set(params.callId, timer);
  }

  private async runForcedAgentConsult(params: {
    session: ActiveRealtimeVoiceBridge;
    callId: string;
    callSid: string;
    question: string;
    clearAudio: () => void;
    handler: ToolHandlerFn;
  }): Promise<void> {
    this.forcedConsultInFlightByCallId.add(params.callId);
    const startedAt = Date.now();
    console.log(
      `[voice-call] realtime forced agent consult starting callId=${params.callId} providerCallId=${params.callSid} chars=${params.question.length}`,
    );
    params.clearAudio();
    const state: ForcedConsultState = {
      sendSpeechPrompt: true,
      promise: Promise.resolve().then(() =>
        params.handler(
          {
            question: params.question,
            context:
              "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult because consultPolicy is always.",
          },
          params.callId,
          {},
        ),
      ),
    };
    this.forcedConsultsByCallId.set(params.callId, state);
    try {
      const result = await state.promise;
      state.completedAt = Date.now();
      const text = readSpeakableToolResultText(result);
      if (!text) {
        console.warn(
          `[voice-call] realtime forced agent consult returned no speakable text callId=${params.callId} providerCallId=${params.callSid}`,
        );
        return;
      }
      if (state.sendSpeechPrompt) {
        params.clearAudio();
        params.session.sendUserMessage(buildForcedConsultSpeechPrompt(text));
      }
      console.log(
        `[voice-call] realtime forced agent consult completed callId=${params.callId} providerCallId=${params.callSid} elapsedMs=${Date.now() - startedAt}`,
      );
      this.consumePartialUserTranscript(params.callId, params.question);
    } catch (error) {
      console.warn(
        `[voice-call] realtime forced agent consult failed callId=${params.callId} providerCallId=${params.callSid} error=${formatErrorMessage(error)}`,
      );
    } finally {
      this.forcedConsultInFlightByCallId.delete(params.callId);
      const cleanupTimer = setTimeout(() => {
        if (this.forcedConsultsByCallId.get(params.callId) === state) {
          this.forcedConsultsByCallId.delete(params.callId);
        }
      }, FORCED_CONSULT_NATIVE_DEDUPE_MS);
      cleanupTimer.unref?.();
    }
  }

  private registerCallInManager(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry"> = {},
  ): CallRegistration | null {
    const timestamp = Date.now();
    const baseFields = {
      providerCallId: callSid,
      timestamp,
      direction: callerMeta.direction ?? "inbound",
      ...(callerMeta.from ? { from: callerMeta.from } : {}),
      ...(callerMeta.to ? { to: callerMeta.to } : {}),
    };

    const callRecord = this.resolveRealtimeCall(callSid, callerMeta, baseFields);
    if (!callRecord) {
      return null;
    }

    const initialGreeting = this.extractInitialGreeting(callRecord);
    console.log(
      `[voice-call] Realtime call ${callRecord.callId} initial greeting ${initialGreeting ? "queued" : "absent"}`,
    );
    if (callRecord.metadata) {
      delete callRecord.metadata.initialMessage;
    }

    this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId: callRecord.callId,
      type: "call.answered",
      ...baseFields,
    });

    return {
      callId: callRecord.callId,
      initialGreetingInstructions: buildGreetingInstructions(
        this.config.instructions,
        initialGreeting,
      ),
    };
  }

  private resolveRealtimeCall(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry">,
    baseFields: {
      providerCallId: string;
      timestamp: number;
      direction: "inbound" | "outbound";
      from?: string;
      to?: string;
    },
  ): CallRecord | null {
    if (callerMeta.callId) {
      const call = this.manager.getCall(callerMeta.callId);
      return call?.providerCallId === callSid ? call : null;
    }

    this.manager.processEvent({
      id: `realtime-initiated-${callSid}`,
      callId: callSid,
      type: "call.initiated",
      ...baseFields,
    });

    return this.manager.getCallByProviderCallId(callSid) ?? null;
  }

  private extractInitialGreeting(call: CallRecord): string | undefined {
    return typeof call.metadata?.initialMessage === "string"
      ? call.metadata.initialMessage
      : undefined;
  }

  private endCallInManager(callSid: string, callId: string, reason: "completed" | "error"): void {
    this.manager.processEvent({
      id: `realtime-ended-${callSid}-${Date.now()}`,
      type: "call.ended",
      callId,
      providerCallId: callSid,
      timestamp: Date.now(),
      reason,
    });
  }

  private async executeToolCall(
    bridge: ActiveRealtimeVoiceBridge,
    callId: string,
    bridgeCallId: string,
    name: string,
    args: unknown,
    turnId: string,
    emitTalkEvent?: (input: TalkEventInput) => TalkEvent,
  ): Promise<void> {
    const handler = this.toolHandlers.get(name);
    const startedAt = Date.now();
    const hasResultError = (result: unknown): boolean => {
      return Boolean(
        result && typeof result === "object" && !Array.isArray(result) && "error" in result,
      );
    };
    const emitFinalToolEvent = (result: unknown): void => {
      emitTalkEvent?.({
        type: hasResultError(result) ? "tool.error" : "tool.result",
        turnId,
        callId: bridgeCallId,
        payload: { name, result },
        final: true,
      });
    };
    const submitFinalToolResult = (result: unknown): void => {
      bridge.submitToolResult(bridgeCallId, result);
      emitFinalToolEvent(result);
    };
    const submitWorkingResponse = () => {
      if (
        handler &&
        name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
        bridge.bridge.supportsToolResultContinuation &&
        !this.config.fastContext.enabled
      ) {
        emitTalkEvent?.({
          type: "tool.progress",
          turnId,
          callId: bridgeCallId,
          payload: { name, status: "working" },
        });
        bridge.submitToolResult(
          bridgeCallId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          { willContinue: true },
        );
      }
    };
    if (name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      this.lastProviderConsultAtByCallId.set(callId, Date.now());
      const timer = this.forcedConsultTimersByCallId.get(callId);
      if (timer) {
        clearTimeout(timer);
        this.forcedConsultTimersByCallId.delete(callId);
      }
      const forcedConsult = this.forcedConsultsByCallId.get(callId);
      if (forcedConsult) {
        if (forcedConsult.completedAt) {
          submitFinalToolResult({
            status: "already_delivered",
            message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
          });
          return;
        }
        forcedConsult.sendSpeechPrompt = false;
        const result = await forcedConsult.promise.catch((error: unknown) => ({
          error: formatErrorMessage(error),
        }));
        submitFinalToolResult(result);
        return;
      }

      const existingNativeConsult = this.nativeConsultsInFlightByCallId.get(callId);
      if (existingNativeConsult) {
        console.log(
          `[voice-call] realtime tool call sharing in-flight agent consult callId=${callId} ageMs=${Date.now() - existingNativeConsult.startedAt}`,
        );
        submitWorkingResponse();
        submitFinalToolResult(await existingNativeConsult.promise);
        return;
      }

      submitWorkingResponse();
      const state: NativeConsultState = {
        startedAt,
        promise: Promise.resolve(),
      };
      state.promise = (async () => {
        await this.waitForConsultTranscriptSettle(callId, startedAt);
        const context = {
          partialUserTranscript: this.resolveUserTranscriptContext(callId),
        };
        state.partialUserTranscript = context.partialUserTranscript;
        const handlerArgs = withFallbackConsultQuestion(args, context.partialUserTranscript);
        console.log(
          `[voice-call] realtime tool call executing callId=${callId} tool=${name} hasHandler=${Boolean(handler)}`,
        );
        return !handler
          ? { error: `Tool "${name}" not available` }
          : await handler(handlerArgs, callId, context);
      })().catch((error: unknown) => ({
        error: formatErrorMessage(error),
      }));
      this.nativeConsultsInFlightByCallId.set(callId, state);
      try {
        const result = await state.promise;
        const status =
          result && typeof result === "object" && !Array.isArray(result) && "error" in result
            ? "error"
            : "ok";
        const error =
          status === "error" && result && typeof result === "object" && !Array.isArray(result)
            ? formatErrorMessage((result as { error?: unknown }).error ?? "unknown")
            : undefined;
        console.log(
          `[voice-call] realtime tool call completed callId=${callId} tool=${name} status=${status} elapsedMs=${Date.now() - startedAt}${error ? ` error=${error}` : ""}`,
        );
        submitFinalToolResult(result);
        if (status === "ok") {
          this.consumePartialUserTranscript(callId, state.partialUserTranscript);
        }
      } finally {
        if (this.nativeConsultsInFlightByCallId.get(callId) === state) {
          this.nativeConsultsInFlightByCallId.delete(callId);
        }
      }
      return;
    }
    console.log(
      `[voice-call] realtime tool call executing callId=${callId} tool=${name} hasHandler=${Boolean(handler)}`,
    );
    const context = {
      partialUserTranscript: this.resolveUserTranscriptContext(callId),
    };
    const handlerArgs =
      name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
        ? withFallbackConsultQuestion(args, context.partialUserTranscript)
        : args;
    const result = !handler
      ? { error: `Tool "${name}" not available` }
      : await handler(handlerArgs, callId, context).catch((error: unknown) => ({
          error: formatErrorMessage(error),
        }));
    const status =
      result && typeof result === "object" && !Array.isArray(result) && "error" in result
        ? "error"
        : "ok";
    const error =
      status === "error" && result && typeof result === "object" && !Array.isArray(result)
        ? formatErrorMessage((result as { error?: unknown }).error ?? "unknown")
        : undefined;
    console.log(
      `[voice-call] realtime tool call completed callId=${callId} tool=${name} status=${status} elapsedMs=${Date.now() - startedAt}${error ? ` error=${error}` : ""}`,
    );
    submitFinalToolResult(result);
    if (name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME && status === "ok") {
      this.consumePartialUserTranscript(callId, context.partialUserTranscript);
    }
  }
}
