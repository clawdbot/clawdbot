// Voice Call plugin module implements realtime handler behavior.
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  calculateMulawRms,
  createRealtimeVoiceSessionHarness,
  createSpeechThresholdGate,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
  type RealtimeVoiceForcedConsultHandle,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceSessionHarness,
  type TalkEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import WebSocket, { WebSocketServer } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import {
  type StreamFrameAdapter,
  TelnyxStreamFrameAdapter,
  TwilioStreamFrameAdapter,
} from "./stream-frame-adapter.js";

export type ToolHandlerContext = {
  partialUserTranscript?: string;
};
type ToolHandlerFn = (
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
const FORCED_CONSULT_REASON = "provider_final_transcript_without_openclaw_agent_consult";
const CONSULT_TRANSCRIPT_SETTLE_MS = 350;
const CONSULT_TRANSCRIPT_SETTLE_MAX_MS = 1_000;
const MAX_PARTIAL_USER_TRANSCRIPT_CHARS = 1_200;
const RECENT_FINAL_USER_TRANSCRIPT_TTL_MS = 2_000;
const BARGE_IN_REQUIRED_LOUD_CHUNKS = 2;
const logger = createSubsystemLogger("voice-call/realtime");

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

function readConsultArgText(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConsultQuestionText(args: unknown): string | undefined {
  return readRealtimeVoiceConsultQuestion(args);
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

function resolveFinalTranscriptText(params: {
  partial: string | undefined;
  rawPartial: string | undefined;
  final: string;
}): string {
  const final = normalizeTranscriptText(params.final);
  const rawPartial = params.rawPartial ?? "";
  const partial = normalizeTranscriptText(params.partial ?? rawPartial);
  if (!partial) {
    return final;
  }
  if (!final) {
    return partial;
  }
  const compact = (value: string) => value.toLowerCase().replaceAll(/\s/g, "");
  const compactFinal = compact(final);
  const compactRaw = compact(rawPartial);
  const compactPartial = compact(partial);
  // A bounded partial buffer may only retain the end of a long complete final.
  // In that case the provider's final is authoritative; appending would duplicate the suffix.
  if (compactFinal.startsWith(compactPartial) || compactFinal.endsWith(compactPartial)) {
    return final;
  }
  if (compactPartial.endsWith(compactFinal)) {
    return partial;
  }
  if (compactRaw !== compactPartial) {
    return appendTranscriptText(partial, params.final);
  }
  return normalizeTranscriptText(`${rawPartial}${params.final}`);
}

function limitPartialUserTranscript(text: string): string {
  if (text.length <= MAX_PARTIAL_USER_TRANSCRIPT_CHARS) {
    return text;
  }
  const tail = sliceUtf16Safe(text, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS);
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
      : `${truncateUtf16Safe(trimmed, FORCED_CONSULT_RESULT_MAX_CHARS - 16).trimEnd()} [truncated]`;
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

type StreamSessionRequest = {
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
  instructions: string;
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
  private readonly rawPartialUserTranscriptsByCallId = new Map<string, string>();
  private readonly partialUserTranscriptUpdatedAtByCallId = new Map<string, number>();
  private readonly recentFinalUserTranscriptsByCallId = new Map<string, string>();
  private readonly recentFinalUserTranscriptTimersByCallId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly forcedConsultsByCallId = new Map<string, ForcedConsultState>();
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
    private readonly resolveInstructions?: (call: CallRecord) => string,
  ) {}

  setPublicUrl(url: string): void {
    try {
      const parsed = new URL(url);
      this.publicOrigin = parsed.host;
      const normalizedServePath = normalizeWebhookPath(this.servePath);
      const normalizedPublicPath = normalizeWebhookPath(parsed.pathname);
      const idx = normalizedPublicPath.indexOf(normalizedServePath);
      this.publicPathPrefix = idx > 0 ? normalizedPublicPath.slice(0, idx) : "";
    } catch {
      this.publicOrigin = null;
      this.publicPathPrefix = "";
    }
  }

  getStreamPathPattern(): string {
    return `${this.publicPathPrefix}${normalizeWebhookPath(this.config.streamPath ?? "/voice/stream/realtime")}`;
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
    const now = Date.now();
    const expiry = resolveExpiresAtMsFromDurationMs(STREAM_TOKEN_TTL_MS, { nowMs: now });
    if (expiry !== undefined) {
      this.pendingStreamTokens.set(token, { expiry, ...meta });
    }
    for (const [candidate, entry] of this.pendingStreamTokens) {
      if (!isFutureDateTimestampMs(entry.expiry, { nowMs: now })) {
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
    if (!isFutureDateTimestampMs(entry.expiry)) {
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

    const { callId, instructions, initialGreetingInstructions } = registration;
    const callRecord = this.manager.getCallByProviderCallId(callSid);
    const harness = createRealtimeVoiceSessionHarness({
      talk: {
        sessionId: `voice-call:${callId}:realtime`,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: this.realtimeProvider.id,
      },
      talkPayloads: {
        turnStarted: () => ({ callId, providerCallId: callSid }),
        turnEnded: (reason) => ({ callId, providerCallId: callSid, reason }),
        inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioStarted: () => ({ callId, providerCallId: callSid }),
        outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioDone: (reason) => ({ callId, providerCallId: callSid, reason }),
      },
      onTalkEvent: (event) => appendRecentTalkEventMetadata(callRecord, event),
    });
    const providerHandlesInputAudioBargeIn =
      this.realtimeProvider.capabilities?.handlesInputAudioBargeIn === true;
    const cancelOutputAudioForBargeIn = (
      source: "local" | "provider",
      interruptProvider?: (audioPlaybackActive: boolean) => void,
      clearedAudioBytes = 0,
    ): void => {
      const outputAudioActive = harness.talk.outputAudioActive;
      const pendingTelephonyAudio = audioPacer.hasPendingAudio();
      if (
        source === "provider" &&
        !outputAudioActive &&
        !pendingTelephonyAudio &&
        clearedAudioBytes === 0
      ) {
        return;
      }
      // Capture playback before provider interruption. Local fallback must clear
      // telephony even after pacing drains because the remote stream buffers audio.
      const interruptedTurnId = harness.talk.activeTurnId;
      interruptProvider?.(outputAudioActive || pendingTelephonyAudio);
      const shouldClearTelephony = source === "local" || pendingTelephonyAudio;
      const clearedBytes = clearedAudioBytes + (shouldClearTelephony ? audioPacer.clearAudio() : 0);
      console.log(
        `[voice-call] realtime outbound audio cleared by ${source} barge-in callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`,
      );
      if (!outputAudioActive || !interruptedTurnId) {
        return;
      }
      const reason = `${source}-barge-in`;
      harness.finishOutputAudio(reason);
      harness.talk.cancelTurn({
        turnId: interruptedTurnId,
        payload: { callId, providerCallId: callSid, reason },
      });
    };
    harness.emit({
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
    const speechDetector = createSpeechThresholdGate({
      rmsThreshold: 0.035,
      speechFrames: BARGE_IN_REQUIRED_LOUD_CHUNKS,
      silenceFrames: 12,
    });
    const interruptResponseOnInputAudio =
      typeof this.providerConfig.interruptResponseOnInputAudio === "boolean"
        ? this.providerConfig.interruptResponseOnInputAudio
        : undefined;
    const session = harness.createBridge({
      provider: this.realtimeProvider,
      cfg: this.coreConfig,
      providerConfig: this.providerConfig,
      interruptResponseOnInputAudio,
      instructions,
      tools: this.config.tools,
      initialGreetingInstructions,
      triggerGreetingOnReady: Boolean(initialGreetingInstructions),
      audioSink: {
        isOpen: () => ws.readyState === WebSocket.OPEN,
        sendAudio: (muLaw) => {
          harness.recordOutputAudio(muLaw);
          audioPacer.sendAudio(muLaw);
        },
        clearAudio: (reason) => {
          harness.flushOutput(() => {
            const clearedBytes = audioPacer.clearAudio();
            if (reason === "barge-in") {
              cancelOutputAudioForBargeIn("provider", undefined, clearedBytes);
              return;
            }
            console.log(
              `[voice-call] realtime outbound audio clear requested callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`,
            );
            harness.finishOutputAudio("clear");
          });
        },
        sendMark: (markName) => {
          audioPacer.sendMark(markName);
        },
      },
      onTranscript: (role, text, isFinal) => {
        const turnId = harness.ensureTurn();
        const eventType =
          role === "assistant"
            ? isFinal
              ? "output.text.done"
              : "output.text.delta"
            : isFinal
              ? "transcript.done"
              : "transcript.delta";
        const payload = role === "assistant" ? { text } : { role, text };
        harness.emit({
          type: eventType,
          turnId,
          payload,
          final: isFinal,
        });
        if (role === "user" && isFinal) {
          harness.emit({
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
          const transcript = resolveFinalTranscriptText({
            partial: this.partialUserTranscriptsByCallId.get(callId),
            rawPartial: this.rawPartialUserTranscriptsByCallId.get(callId),
            final: text,
          });
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
            harness,
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
          type: "call.assistant-speech",
          callId,
          providerCallId: callSid,
          timestamp: Date.now(),
          transcript: text,
        });
      },
      onToolCall: (toolEvent, sessionLocal) => {
        const turnId = harness.ensureTurn();
        harness.emit({
          type: "tool.call",
          turnId,
          itemId: toolEvent.itemId,
          callId: toolEvent.callId,
          payload: { name: toolEvent.name, args: toolEvent.args },
        });
        console.log(
          `[voice-call] realtime tool call received callId=${callId} providerCallId=${callSid} tool=${toolEvent.name}`,
        );
        return this.executeToolCall(
          sessionLocal,
          callId,
          toolEvent.callId || toolEvent.itemId,
          toolEvent.name,
          toolEvent.args,
          turnId,
          harness,
        );
      },
      onEvent: (event) => {
        if (event.type === "input_audio_buffer.speech_started") {
          harness.ensureTurn();
          return;
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          const turnId = harness.talk.activeTurnId;
          if (!turnId) {
            return;
          }
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: { callId, providerCallId: callSid, source: event.type },
            final: true,
          });
          return;
        }
        if (event.type === "response.done") {
          harness.finishOutputAudio("response.done");
          harness.endTurn("response.done");
          return;
        }
        if (event.type === "error") {
          harness.emit({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
      },
      onReady: () => {
        harness.emit({
          type: "session.ready",
          payload: { callId, providerCallId: callSid },
        });
      },
      onError: (error) => {
        console.error("[voice-call] realtime voice error:", error.message);
        harness.emit({
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
        harness.finishOutputAudio(reason);
        harness.emit({
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
      try {
        session.close();
      } finally {
        emitCallEnd(reason);
      }
    };
    this.activeBridgesByCallId.set(callId, session);
    this.activeBridgesByCallId.set(callSid, session);
    this.activeTelephonyClosersByCallId.set(callId, closeTelephony);
    this.activeTelephonyClosersByCallId.set(callSid, closeTelephony);
    const sendAudioToSession = session.sendAudio.bind(session);
    session.sendAudio = (audio) => {
      if (speechDetector.accept({ rms: calculateMulawRms(audio), peak: 0 })) {
        console.log(
          `[voice-call] realtime local speech detected callId=${callId} providerCallId=${callSid}`,
        );
        if (!providerHandlesInputAudioBargeIn) {
          cancelOutputAudioForBargeIn("local", (audioPlaybackActive) => {
            session.handleBargeIn({ audioPlaybackActive });
          });
        }
      }
      harness.recordInputAudio(audio);
      sendAudioToSession(audio);
    };
    const closeSession = session.close.bind(session);
    let sessionClosed = false;
    session.close = () => {
      if (sessionClosed) {
        return;
      }
      sessionClosed = true;
      // Providers may synchronously flush final transcript callbacks during close.
      // Keep the call and transcript state alive until those callbacks finish.
      try {
        closeSession();
      } finally {
        this.activeBridgesByCallId.delete(callId);
        this.activeBridgesByCallId.delete(callSid);
        this.activeTelephonyClosersByCallId.delete(callId);
        this.activeTelephonyClosersByCallId.delete(callSid);
        this.clearUserTranscriptState(callId);
        this.forcedConsultsByCallId.delete(callId);
        harness.close();
        audioPacer.close();
      }
    };

    session.connect().catch((error: unknown) => {
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
    const raw = limitPartialUserTranscript(
      `${this.rawPartialUserTranscriptsByCallId.get(callId) ?? ""}${text}`,
    );
    this.partialUserTranscriptsByCallId.set(callId, next);
    this.rawPartialUserTranscriptsByCallId.set(callId, raw);
    this.partialUserTranscriptUpdatedAtByCallId.set(callId, Date.now());
    return next;
  }

  private clearPartialUserTranscript(callId: string): void {
    this.partialUserTranscriptsByCallId.delete(callId);
    this.rawPartialUserTranscriptsByCallId.delete(callId);
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
        this.rawPartialUserTranscriptsByCallId.set(callId, remaining);
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
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(CONSULT_TRANSCRIPT_SETTLE_MS - quietFor, deadline - now));
      });
    }
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
    harness: RealtimeVoiceSessionHarness;
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
    const existingForcedConsult = this.forcedConsultsByCallId.get(params.callId);
    if (existingForcedConsult && !existingForcedConsult.completedAt) {
      return;
    }
    const coordinator = params.harness.forcedConsults;
    if (coordinator.hasRecentNativeConsult(question, { allowUnknownQuestion: true })) {
      return;
    }
    coordinator.clearPending();
    const pending = coordinator.prepare(question);
    if (!pending) {
      return;
    }
    coordinator.schedule(pending, FORCED_CONSULT_FALLBACK_DELAY_MS, (handle) => {
      const activeForcedConsult = this.forcedConsultsByCallId.get(params.callId);
      if (activeForcedConsult && !activeForcedConsult.completedAt) {
        return;
      }
      void this.runForcedAgentConsult({
        ...params,
        handle,
        handler,
      });
    });
  }

  private async runForcedAgentConsult(params: {
    harness: RealtimeVoiceSessionHarness;
    session: ActiveRealtimeVoiceBridge;
    callId: string;
    callSid: string;
    handle: RealtimeVoiceForcedConsultHandle;
    clearAudio: () => void;
    handler: ToolHandlerFn;
  }): Promise<void> {
    const coordinator = params.harness.forcedConsults;
    coordinator.markStarted(params.handle);
    const startedAt = Date.now();
    logger.debug(
      `[voice-call] realtime forced agent consult reason=${FORCED_CONSULT_REASON} consultPolicy=always callId=${params.callId} providerCallId=${params.callSid} chars=${params.handle.question.length}`,
    );
    console.log(
      `[voice-call] realtime forced agent consult starting callId=${params.callId} providerCallId=${params.callSid} chars=${params.handle.question.length}`,
    );
    params.clearAudio();
    const state: ForcedConsultState = {
      sendSpeechPrompt: true,
      promise: Promise.resolve().then(() =>
        params.handler(
          {
            question: params.handle.question,
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
      coordinator.markDelivered(params.handle);
      const text = readSpeakableRealtimeVoiceToolResult(result, {
        keys: ["text", "output"],
        maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
      });
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
      this.consumePartialUserTranscript(params.callId, params.handle.question);
    } catch (error) {
      console.warn(
        `[voice-call] realtime forced agent consult failed callId=${params.callId} providerCallId=${params.callSid} error=${formatErrorMessage(error)}`,
      );
    } finally {
      const cleanupTimer = setTimeout(() => {
        if (this.forcedConsultsByCallId.get(params.callId) === state) {
          this.forcedConsultsByCallId.delete(params.callId);
          coordinator.remove(params.handle);
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

    const instructions = this.resolveInstructions?.(callRecord) ?? this.config.instructions;
    return {
      callId: callRecord.callId,
      instructions,
      initialGreetingInstructions: buildGreetingInstructions(instructions, initialGreeting),
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
    harness: RealtimeVoiceSessionHarness,
  ): Promise<void> {
    const handler = this.toolHandlers.get(name);
    const startedAt = Date.now();
    const hasResultError = (result: unknown): boolean => {
      return Boolean(
        result && typeof result === "object" && !Array.isArray(result) && "error" in result,
      );
    };
    const emitFinalToolEvent = (result: unknown): void => {
      harness.emit({
        type: hasResultError(result) ? "tool.error" : "tool.result",
        turnId,
        callId: bridgeCallId,
        payload: { name, result },
        final: true,
      });
    };
    const submitFinalToolResult = async (result: unknown): Promise<void> => {
      await bridge.submitToolResult(bridgeCallId, result);
      emitFinalToolEvent(result);
    };
    const submitWorkingResponse = async (): Promise<void> => {
      if (
        handler &&
        name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
        bridge.bridge.supportsToolResultContinuation &&
        !this.config.fastContext.enabled
      ) {
        await bridge.submitToolResult(
          bridgeCallId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          { willContinue: true },
        );
        harness.emit({
          type: "tool.progress",
          turnId,
          callId: bridgeCallId,
          payload: { name, status: "working" },
        });
      }
    };
    if (name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      const coordinator = harness.forcedConsults;
      const forcedMatch = coordinator.recordNativeConsult(args, bridgeCallId);
      if (forcedMatch.kind === "none") {
        const pending = coordinator.consumePending();
        if (pending) {
          coordinator.remove(pending);
        }
      }
      const forcedConsult = this.forcedConsultsByCallId.get(callId);
      if (forcedMatch.kind === "already_delivered" && coordinator.isCancelled(forcedMatch.handle)) {
        if (forcedConsult) {
          forcedConsult.sendSpeechPrompt = false;
        }
        await submitFinalToolResult({
          status: "cancelled",
          message: "OpenClaw cancelled this consult before completion. Do not restart it.",
        });
        return;
      }
      if (forcedConsult) {
        if (forcedConsult.completedAt || forcedMatch.kind === "already_delivered") {
          await submitFinalToolResult({
            status: "already_delivered",
            message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
          });
          return;
        }
        forcedConsult.sendSpeechPrompt = false;
        const result = await forcedConsult.promise.catch((error: unknown) => ({
          error: formatErrorMessage(error),
        }));
        await submitFinalToolResult(result);
        return;
      }

      const existingNativeConsult = this.nativeConsultsInFlightByCallId.get(callId);
      if (existingNativeConsult) {
        console.log(
          `[voice-call] realtime tool call sharing in-flight agent consult callId=${callId} ageMs=${Date.now() - existingNativeConsult.startedAt}`,
        );
        await submitWorkingResponse();
        await submitFinalToolResult(await existingNativeConsult.promise);
        return;
      }

      const state: NativeConsultState = {
        startedAt,
        promise: Promise.resolve(),
      };
      const workingSubmission = submitWorkingResponse();
      state.promise = workingSubmission.then(async () => {
        try {
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
        } catch (error) {
          return {
            error: formatErrorMessage(error),
          };
        }
      });
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
        await submitFinalToolResult(result);
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
    await submitFinalToolResult(result);
    if (name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME && status === "ok") {
      this.consumePartialUserTranscript(callId, context.partialUserTranscript);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
