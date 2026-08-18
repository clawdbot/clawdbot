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
import { resolveVoiceCallPublicPathPrefix, type VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import { REALTIME_VOICE_END_CALL_TOOL_NAME } from "../realtime-call-control.js";
import type { CallRecord, EndReason, NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import type { StreamDisconnectLifecycle } from "./stream-disconnect-grace.js";
import {
  type StreamFrameAdapter,
  TelnyxStreamFrameAdapter,
  TwilioStreamFrameAdapter,
} from "./stream-frame-adapter.js";

export type ToolHandlerContext = {
  partialUserTranscript?: string;
  abortSignal?: AbortSignal;
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
const REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS = 30_000;
const REALTIME_DISCONNECT_HANGUP_GRACE_MS = 2_000;
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

type RealtimeCallRegistration = {
  agentId: string;
  instructions: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

type ResolveRealtimeCallRegistration = (call: CallRecord) => RealtimeCallRegistration;

type ActiveRealtimeVoiceBridge = RealtimeVoiceBridgeSession;

type RealtimeSpeakResult = {
  success: boolean;
  error?: string;
};

type ForcedConsultState = {
  owner: ActiveRealtimeVoiceBridge;
  promise: Promise<unknown>;
  sendSpeechPrompt: boolean;
  cancelled: boolean;
  cancel: () => void;
  completedAt?: number;
};

type RealtimeConsultSession = {
  owner: ActiveRealtimeVoiceBridge;
  coordinator: RealtimeVoiceSessionHarness["forcedConsults"];
};

type NativeConsultState = {
  owner: ActiveRealtimeVoiceBridge;
  startedAt: number;
  promise: Promise<unknown>;
  cancellation: Promise<void>;
  cancelled: boolean;
  cancel: () => void;
  partialUserTranscript?: string;
};

type NativeConsultOutcome = { kind: "completed"; result: unknown } | { kind: "cancelled" };

type UserTranscriptState = {
  partial?: string;
  rawPartial?: string;
  partialUpdatedAt?: number;
  recentFinal?: string;
  recentFinalTimer?: ReturnType<typeof setTimeout>;
};

type UserTranscriptOwnerAdoption = {
  owner: UserTranscriptState;
  previous?: UserTranscriptState;
};

type RealtimeCallEndCause = "disconnect" | "shutdown" | "inactivity" | "error";

// Each socket keeps its exact binding; the call map only grants current-generation
// record termination. Replacement can retire old audio without a late close killing its successor.
type RealtimeTelephonyBinding = {
  bridge: ActiveRealtimeVoiceBridge;
  close: (cause: RealtimeCallEndCause) => void;
  endCall: () => void;
  noteMediaActivity: () => void;
  retire: () => void;
};

async function waitForNativeConsult(state: NativeConsultState): Promise<NativeConsultOutcome> {
  return await Promise.race([
    state.promise.then((result) => ({ kind: "completed", result }) as const),
    state.cancellation.then(() => ({ kind: "cancelled" }) as const),
  ]);
}

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
  private readonly activeSockets = new Set<WebSocket>();
  private readonly serverClosingSockets = new WeakSet<WebSocket>();
  private readonly activeBridgesByCallId = new Map<string, ActiveRealtimeVoiceBridge>();
  private readonly activeTelephonyBindingsByCallId = new Map<string, RealtimeTelephonyBinding>();
  private readonly userTranscriptStatesByCallId = new Map<string, UserTranscriptState>();
  private readonly forcedConsultsByCallId = new Map<string, ForcedConsultState>();
  private readonly consultSessionsByCallId = new Map<string, RealtimeConsultSession>();
  private readonly nativeConsultsInFlightByCallId = new Map<string, NativeConsultState>();
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private publicOrigin: string | null = null;
  private publicPathPrefix = "";

  constructor(
    private readonly config: VoiceCallRealtimeConfig,
    private readonly manager: CallManager,
    private readonly provider: VoiceCallProvider,
    private readonly resolveCallRegistration: ResolveRealtimeCallRegistration,
    private readonly servePath: string,
    private readonly streamDisconnectLifecycle: StreamDisconnectLifecycle,
    private readonly coreConfig?: OpenClawConfig,
  ) {}

  setPublicUrl(url: string): void {
    try {
      const parsed = new URL(url);
      this.publicOrigin = parsed.host;
      this.publicPathPrefix = resolveVoiceCallPublicPathPrefix(parsed.pathname, this.servePath);
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
    if (this.closing) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

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
      this.activeSockets.add(ws);
      let telephonyBinding: RealtimeTelephonyBinding | null = null;
      let initialized = false;
      let activeCallSid = "unknown";
      let activeStreamSid = "unknown";
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
            activeStreamSid = frame.streamId;
            const nextBinding = this.handleCall(
              frame.streamId,
              frame.providerCallId,
              ws,
              callerMeta,
              adapter,
            );
            if (!nextBinding) {
              return;
            }
            telephonyBinding = nextBinding;
            this.streamDisconnectLifecycle.connect(activeCallSid, activeStreamSid);
            return;
          }
          if (!telephonyBinding) {
            return;
          }
          if (frame.kind === "media") {
            const audio = Buffer.from(frame.payloadBase64, "base64");
            telephonyBinding.noteMediaActivity();
            telephonyBinding.bridge.sendAudio(audio);
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
              telephonyBinding.bridge.setMediaTimestamp(frame.timestampMs);
            }
            return;
          }
          if (frame.kind === "mark") {
            telephonyBinding.bridge.acknowledgeMark();
            return;
          }
          if (frame.kind === "error") {
            console.error(
              `[voice-call] realtime WS error frame providerCallId=${activeCallSid} code=${frame.code ?? "?"} title=${frame.title ?? ""} detail=${frame.detail ?? ""}`,
            );
            return;
          }
          if (frame.kind === "stop") {
            telephonyBinding.close("disconnect");
          }
        } catch (error) {
          console.error("[voice-call] realtime WS parse failed:", error);
        }
      });

      ws.on("close", () => {
        this.activeSockets.delete(ws);
        const reason = this.serverClosingSockets.has(ws) ? "shutdown" : "disconnect";
        telephonyBinding?.close(reason);
      });

      ws.on("error", (error) => {
        console.error("[voice-call] realtime WS error:", error);
        ws.terminate();
      });

      if (this.closing) {
        this.serverClosingSockets.add(ws);
        ws.terminate();
      }
    });
  }

  close(shutdownBarrier: Promise<unknown> = Promise.resolve()): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closing = true;
    this.pendingStreamTokens.clear();
    const sockets = [...this.activeSockets];
    this.closePromise = Promise.all([
      shutdownBarrier,
      ...sockets.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            this.serverClosingSockets.add(ws);
            ws.once("close", () => resolve());
            ws.terminate();
          }),
      ),
    ])
      .then(() => {
        this.pendingStreamTokens.clear();
      })
      .finally(() => {
        this.closing = false;
        this.closePromise = null;
      });
    return this.closePromise;
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
      const host = this.publicOrigin || DEFAULT_HOST;
      const streamPathPattern = this.getStreamPathPattern();
      const timer = setTimeout(() => {
        if (!this.pendingStreamTokens.has(token)) {
          return;
        }
        this.pendingStreamTokens.delete(token);
        if (this.closing) {
          return;
        }
        const call = meta.callId ? ` for call ${meta.callId}` : "";
        const endpoints = [meta.from ? `from ${meta.from}` : "", meta.to ? `to ${meta.to}` : ""]
          .filter(Boolean)
          .join(" ");
        const participants = endpoints ? ` (${endpoints})` : "";
        console.warn(
          `[voice-call] Realtime stream WebSocket never connected within ${STREAM_TOKEN_TTL_MS / 1000}s${call}${participants} — the provider could not reach wss://${host}${streamPathPattern}/<token>. Verify the stream path is exposed (tailscale serve/funnel --set-path).`,
        );
      }, STREAM_TOKEN_TTL_MS);
      timer.unref?.();
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
  ): RealtimeTelephonyBinding | null {
    const preparedCall = this.prepareCallInManager(callSid, callerMeta);
    if (!preparedCall) {
      ws.close(1008, "Caller rejected by policy");
      return null;
    }

    const { callRecord } = preparedCall;
    const callId = callRecord.callId;
    const hadPredecessorOnAdmission = this.activeBridgesByCallId.has(callId);
    const previousTelephonyBinding = this.activeTelephonyBindingsByCallId.get(callId);
    let callEndEmitted = false;
    const emitCallEnd = (cause: RealtimeCallEndCause) => {
      if (callEndEmitted) {
        return;
      }
      callEndEmitted = true;
      const reason: EndReason =
        cause === "error" ? "error" : cause === "inactivity" ? "timeout" : "completed";
      this.endCallInManager(callSid, callId, reason);
      if (cause !== "error" && cause !== "inactivity") {
        return;
      }
      void Promise.resolve(
        this.provider.hangupCall({ callId, providerCallId: callSid, reason }),
      ).catch((error: unknown) => {
        console.warn(
          `[voice-call] Failed to hang up realtime call ${callSid}: ${formatErrorMessage(error)}`,
        );
      });
    };

    let registration: RealtimeCallRegistration;
    try {
      registration = this.resolveCallRegistration(callRecord);
    } catch (error) {
      console.error(
        `[voice-call] Failed to resolve realtime call registration callId=${callId} providerCallId=${callSid}: ${formatErrorMessage(error)}`,
      );
      if (!hadPredecessorOnAdmission) {
        emitCallEnd("error");
      }
      ws.close(1011, "Check realtime configuration for routed agent");
      return null;
    }

    const { baseFields, initialGreeting } = preparedCall;
    if (callRecord.metadata) {
      delete callRecord.metadata.initialMessage;
    }
    this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId,
      type: "call.answered",
      ...baseFields,
    });
    const { agentId, instructions, provider: realtimeProvider, providerConfig } = registration;
    const initialGreetingInstructions = buildGreetingInstructions(instructions, initialGreeting);
    const harness = createRealtimeVoiceSessionHarness({
      talk: {
        sessionId: `voice-call:${callId}:realtime`,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: realtimeProvider.id,
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
    let providerHandlesInputAudioBargeIn =
      realtimeProvider.capabilities?.handlesInputAudioBargeIn === true;
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
      typeof providerConfig.interruptResponseOnInputAudio === "boolean"
        ? providerConfig.interruptResponseOnInputAudio
        : undefined;
    // Providers may close synchronously before createBridge returns; no consult can exist yet.
    const nativeConsultOwner: { current?: ActiveRealtimeVoiceBridge } = {};
    // Provisional ownership accepts callbacks fired during createBridge. Commit
    // retires the predecessor only after creation succeeds; failure restores it.
    const userTranscriptAdoption = this.beginUserTranscriptOwnerAdoption(callId);
    const userTranscriptOwner = userTranscriptAdoption.owner;
    const bridgeParams: Parameters<typeof harness.createBridge>[0] = {
      provider: realtimeProvider,
      cfg: this.coreConfig,
      agentId,
      providerConfig,
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
        const owner = nativeConsultOwner.current;
        if (
          !this.getUserTranscriptState(callId, userTranscriptOwner) ||
          (owner && !this.isActiveBridgeOwner(callId, owner))
        ) {
          return;
        }
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
            const transcript = this.recordPartialUserTranscript(callId, userTranscriptOwner, text);
            if (!transcript) {
              return;
            }
            console.log(
              `[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=false chars=${text.trim().length} aggregateChars=${transcript.length}`,
            );
          }
          return;
        }
        if (role === "user") {
          const state = this.getUserTranscriptState(callId, userTranscriptOwner);
          if (!state) {
            return;
          }
          const transcript = resolveFinalTranscriptText({
            partial: state.partial,
            rawPartial: state.rawPartial,
            final: text,
          });
          this.clearPartialUserTranscript(callId, userTranscriptOwner);
          this.setRecentFinalUserTranscript(callId, userTranscriptOwner, transcript);
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
            userTranscriptOwner,
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
          userTranscriptOwner,
        );
      },
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "session.continuity.reset") {
          // A fresh provider session cannot complete the prior session's text,
          // audio, tool work, or Talk turn.
          const turnId = harness.talk.activeTurnId;
          const owner = nativeConsultOwner.current;
          if (owner && this.isActiveBridgeOwner(callId, owner)) {
            this.resetUserTranscriptState(callId, userTranscriptOwner);
            this.resetConsultSessionForContinuity(callId, owner);
          }
          harness.flushOutput(() => {
            audioPacer.clearAudio();
            harness.finishOutputAudio(event.type);
          });
          if (turnId) {
            harness.talk.cancelTurn({
              turnId,
              payload: { callId, providerCallId: callSid, reason: event.type },
            });
          }
          return;
        }
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
        if (event.type === "error") {
          harness.emit({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
      },
      onResponseDone: (outcome) => {
        if (outcome.status === "failed" || outcome.status === "incomplete") {
          console.warn(`[voice-call] realtime response ${outcome.status}: ${outcome.message}`);
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
        const owner = nativeConsultOwner.current;
        const ownsCallState = owner ? this.isActiveBridgeOwner(callId, owner) : false;
        if (owner) {
          this.clearActiveBridgeMappings(callId, callSid, owner);
          this.cancelConsultSession(callId, owner);
        }
        if (ownsCallState) {
          this.clearUserTranscriptState(callId, userTranscriptOwner);
        }
        harness.finishOutputAudio(reason);
        harness.emit({
          type: "session.closed",
          payload: { reason },
          final: true,
        });
        if (reason !== "error") {
          return;
        }
        this.streamDisconnectLifecycle.retire(callSid, streamSid);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "Bridge disconnected");
        }
        // A provisional replacement may fail before its bridge owner is assigned.
        // The active predecessor still owns call termination until creation succeeds.
        if (
          (owner && !ownsCallState) ||
          (!owner && hadPredecessorOnAdmission && this.activeBridgesByCallId.has(callId))
        ) {
          return;
        }
        emitCallEnd("error");
      },
    };
    let session: ActiveRealtimeVoiceBridge;
    try {
      session = harness.createBridge(bridgeParams);
    } catch (error) {
      this.rollbackUserTranscriptOwnerAdoption(callId, userTranscriptAdoption);
      harness.close();
      audioPacer.close();
      // A failed provisional replacement must not terminate its active predecessor.
      if (!hadPredecessorOnAdmission || !this.activeBridgesByCallId.has(callId)) {
        emitCallEnd("error");
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "Failed to create realtime bridge");
      }
      console.error("[voice-call] Failed to create realtime bridge:", error);
      return null;
    }
    this.commitUserTranscriptOwnerAdoption(callId, userTranscriptAdoption);
    nativeConsultOwner.current = session;
    providerHandlesInputAudioBargeIn =
      session.bridge.handlesInputAudioBargeIn ?? providerHandlesInputAudioBargeIn;
    const previousConsultSession = this.consultSessionsByCallId.get(callId);
    if (previousConsultSession && previousConsultSession.owner !== session) {
      this.cancelConsultSession(callId, previousConsultSession.owner);
    }
    this.consultSessionsByCallId.set(callId, {
      owner: session,
      coordinator: harness.forcedConsults,
    });
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
        this.clearActiveBridgeMappings(callId, callSid, session);
        this.cancelConsultSession(callId, session);
        this.clearUserTranscriptState(callId, userTranscriptOwner);
        harness.close();
        audioPacer.close();
      }
    };

    let livenessTimer: ReturnType<typeof setTimeout> | undefined;
    const clearLivenessTimer = () => {
      if (livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimer = undefined;
      }
    };
    let bindingClosed = false;
    const closeBinding = (
      binding: RealtimeTelephonyBinding,
      cause?: RealtimeCallEndCause,
    ): void => {
      if (bindingClosed) {
        return;
      }
      bindingClosed = true;
      clearLivenessTimer();
      const ownsCall = this.activeTelephonyBindingsByCallId.get(callId) === binding;
      try {
        session.close();
      } catch (error) {
        console.warn(
          `[voice-call] Failed to close realtime bridge ${callSid}: ${formatErrorMessage(error)}`,
        );
      } finally {
        this.clearActiveTelephonyBinding(callId, binding);
        if (cause === "disconnect") {
          this.streamDisconnectLifecycle.disconnect(callSid, streamSid);
        } else {
          this.streamDisconnectLifecycle.retire(callSid, streamSid);
        }
        if (ownsCall && cause && cause !== "disconnect") {
          emitCallEnd(cause);
        }
      }
    };
    const telephonyBinding: RealtimeTelephonyBinding = {
      bridge: session,
      close: (cause) => closeBinding(telephonyBinding, cause),
      endCall: () => {
        // Close the provider session before the carrier socket so no pending
        // response can reach the caller after the hang-up request succeeds.
        closeBinding(telephonyBinding);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "Call ended");
        }
      },
      noteMediaActivity: () => {
        if (
          bindingClosed ||
          this.activeTelephonyBindingsByCallId.get(callId) !== telephonyBinding
        ) {
          return;
        }
        clearLivenessTimer();
        livenessTimer = setTimeout(() => {
          console.warn(
            `[voice-call] Realtime media inactive callId=${callId} providerCallId=${callSid} timeoutMs=${REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS} graceMs=${REALTIME_DISCONNECT_HANGUP_GRACE_MS}`,
          );
          livenessTimer = setTimeout(() => {
            telephonyBinding.close("inactivity");
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1000, "Media inactivity");
            }
          }, REALTIME_DISCONNECT_HANGUP_GRACE_MS);
          livenessTimer.unref?.();
        }, REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS);
        livenessTimer.unref?.();
      },
      retire: () => closeBinding(telephonyBinding),
    };
    this.activeBridgesByCallId.set(callId, session);
    this.activeBridgesByCallId.set(callSid, session);
    this.activeTelephonyBindingsByCallId.set(callId, telephonyBinding);
    telephonyBinding.noteMediaActivity();
    if (previousTelephonyBinding && previousTelephonyBinding !== telephonyBinding) {
      previousTelephonyBinding.retire();
    }

    session.connect().catch((error: unknown) => {
      console.error("[voice-call] Failed to connect realtime bridge:", error);
      const ownsCallState = this.isActiveBridgeOwner(callId, session);
      this.streamDisconnectLifecycle.retire(callSid, streamSid);
      try {
        session.close();
      } catch (closeError) {
        console.warn(
          `[voice-call] Failed to close realtime bridge ${callSid}: ${formatErrorMessage(closeError)}`,
        );
      } finally {
        if (ownsCallState) {
          emitCallEnd("error");
        }
        ws.close(1011, "Failed to connect");
      }
    });

    return telephonyBinding;
  }

  private beginUserTranscriptOwnerAdoption(callId: string): UserTranscriptOwnerAdoption {
    const adoption = {
      owner: {},
      previous: this.userTranscriptStatesByCallId.get(callId),
    } satisfies UserTranscriptOwnerAdoption;
    this.userTranscriptStatesByCallId.set(callId, adoption.owner);
    return adoption;
  }

  private commitUserTranscriptOwnerAdoption(
    callId: string,
    adoption: UserTranscriptOwnerAdoption,
  ): void {
    if (this.userTranscriptStatesByCallId.get(callId) !== adoption.owner) {
      return;
    }
    if (adoption.previous?.recentFinalTimer) {
      clearTimeout(adoption.previous.recentFinalTimer);
      adoption.previous.recentFinalTimer = undefined;
    }
  }

  private rollbackUserTranscriptOwnerAdoption(
    callId: string,
    adoption: UserTranscriptOwnerAdoption,
  ): void {
    if (this.userTranscriptStatesByCallId.get(callId) !== adoption.owner) {
      return;
    }
    if (adoption.owner.recentFinalTimer) {
      clearTimeout(adoption.owner.recentFinalTimer);
      adoption.owner.recentFinalTimer = undefined;
    }
    if (adoption.previous) {
      this.userTranscriptStatesByCallId.set(callId, adoption.previous);
      return;
    }
    this.userTranscriptStatesByCallId.delete(callId);
  }

  private getUserTranscriptState(
    callId: string,
    owner: UserTranscriptState,
  ): UserTranscriptState | undefined {
    const state = this.userTranscriptStatesByCallId.get(callId);
    return state === owner ? state : undefined;
  }

  private recordPartialUserTranscript(
    callId: string,
    owner: UserTranscriptState,
    text: string,
  ): string | undefined {
    const state = this.getUserTranscriptState(callId, owner);
    if (!state) {
      return undefined;
    }
    const next = limitPartialUserTranscript(appendTranscriptText(state.partial, text));
    const raw = limitPartialUserTranscript(`${state.rawPartial ?? ""}${text}`);
    state.partial = next;
    state.rawPartial = raw;
    state.partialUpdatedAt = Date.now();
    return next;
  }

  private clearPartialUserTranscript(callId: string, owner: UserTranscriptState): void {
    const state = this.getUserTranscriptState(callId, owner);
    if (!state) {
      return;
    }
    state.partial = undefined;
    state.rawPartial = undefined;
    state.partialUpdatedAt = undefined;
  }

  private setRecentFinalUserTranscript(
    callId: string,
    owner: UserTranscriptState,
    text: string,
  ): void {
    const state = this.getUserTranscriptState(callId, owner);
    if (!state) {
      return;
    }
    this.clearRecentFinalUserTranscript(callId, owner);
    state.recentFinal = text;
    const timer = setTimeout(() => {
      if (this.userTranscriptStatesByCallId.get(callId) !== state) {
        return;
      }
      if (state.recentFinal === text) {
        state.recentFinal = undefined;
      }
      if (state.recentFinalTimer === timer) {
        state.recentFinalTimer = undefined;
      }
    }, RECENT_FINAL_USER_TRANSCRIPT_TTL_MS);
    timer.unref?.();
    state.recentFinalTimer = timer;
  }

  private clearRecentFinalUserTranscript(callId: string, owner: UserTranscriptState): void {
    const state = this.getUserTranscriptState(callId, owner);
    if (!state) {
      return;
    }
    if (state.recentFinalTimer) {
      clearTimeout(state.recentFinalTimer);
      state.recentFinalTimer = undefined;
    }
    state.recentFinal = undefined;
  }

  private resetUserTranscriptState(callId: string, owner: UserTranscriptState): void {
    this.clearPartialUserTranscript(callId, owner);
    this.clearRecentFinalUserTranscript(callId, owner);
  }

  private clearUserTranscriptState(callId: string, owner: UserTranscriptState): void {
    const state = this.getUserTranscriptState(callId, owner);
    if (!state) {
      return;
    }
    if (state.recentFinalTimer) {
      clearTimeout(state.recentFinalTimer);
    }
    if (this.userTranscriptStatesByCallId.get(callId) === state) {
      this.userTranscriptStatesByCallId.delete(callId);
    }
  }

  private cancelNativeConsult(callId: string, owner: ActiveRealtimeVoiceBridge): void {
    const state = this.nativeConsultsInFlightByCallId.get(callId);
    if (!state || state.owner !== owner) {
      return;
    }
    state.cancelled = true;
    this.nativeConsultsInFlightByCallId.delete(callId);
    state.cancel();
  }

  private cancelForcedConsult(callId: string, owner: ActiveRealtimeVoiceBridge): void {
    const state = this.forcedConsultsByCallId.get(callId);
    if (!state || state.owner !== owner) {
      return;
    }
    state.cancelled = true;
    state.sendSpeechPrompt = false;
    state.cancel();
    this.forcedConsultsByCallId.delete(callId);
  }

  private resetConsultSession(callId: string, owner: ActiveRealtimeVoiceBridge): boolean {
    const session = this.consultSessionsByCallId.get(callId);
    if (!session || session.owner !== owner) {
      return false;
    }
    session.coordinator.clearPending();
    this.cancelForcedConsult(callId, owner);
    this.cancelNativeConsult(callId, owner);
    return true;
  }

  private resetConsultSessionForContinuity(
    callId: string,
    owner: ActiveRealtimeVoiceBridge,
  ): boolean {
    const session = this.consultSessionsByCallId.get(callId);
    if (!session || session.owner !== owner) {
      return false;
    }
    this.cancelForcedConsult(callId, owner);
    this.cancelNativeConsult(callId, owner);
    // A fresh provider session must not inherit cancelled/recent consult dedupe.
    session.coordinator.clear();
    return true;
  }

  private cancelConsultSession(callId: string, owner: ActiveRealtimeVoiceBridge | undefined): void {
    if (!owner || !this.resetConsultSession(callId, owner)) {
      return;
    }
    this.consultSessionsByCallId.delete(callId);
  }

  private isActiveBridgeOwner(callId: string, owner: ActiveRealtimeVoiceBridge): boolean {
    return this.activeBridgesByCallId.get(callId) === owner;
  }

  private clearActiveBridgeMappings(
    callId: string,
    callSid: string,
    owner: ActiveRealtimeVoiceBridge,
  ): void {
    for (const key of [callId, callSid]) {
      if (this.activeBridgesByCallId.get(key) !== owner) {
        continue;
      }
      this.activeBridgesByCallId.delete(key);
    }
  }

  private clearActiveTelephonyBinding(callId: string, binding: RealtimeTelephonyBinding): void {
    if (this.activeTelephonyBindingsByCallId.get(callId) === binding) {
      this.activeTelephonyBindingsByCallId.delete(callId);
    }
  }

  private resolveUserTranscriptContext(
    callId: string,
    owner: UserTranscriptState,
  ): string | undefined {
    const state = this.getUserTranscriptState(callId, owner);
    return state?.partial ?? state?.recentFinal;
  }

  private consumePartialUserTranscript(
    callId: string,
    owner: UserTranscriptState,
    consumed: string | undefined,
  ): void {
    const text = consumed?.trim();
    if (!text) {
      return;
    }
    const state = this.getUserTranscriptState(callId, owner);
    const current = state?.partial;
    if (!current) {
      return;
    }
    if (current === text) {
      this.clearPartialUserTranscript(callId, owner);
      return;
    }
    if (current.toLowerCase().startsWith(text.toLowerCase())) {
      const remaining = current.slice(text.length).trimStart();
      if (remaining) {
        state.partial = remaining;
        state.rawPartial = remaining;
      } else {
        this.clearPartialUserTranscript(callId, owner);
      }
    }
    const recent = state.recentFinal;
    if (!recent) {
      return;
    }
    if (recent === text || recent.toLowerCase().startsWith(text.toLowerCase())) {
      this.clearRecentFinalUserTranscript(callId, owner);
    }
  }

  private async waitForConsultTranscriptSettle(
    callId: string,
    owner: UserTranscriptState,
    startedAt: number,
  ): Promise<void> {
    const deadline = startedAt + CONSULT_TRANSCRIPT_SETTLE_MAX_MS;
    while (true) {
      const updatedAt = this.getUserTranscriptState(callId, owner)?.partialUpdatedAt;
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

  private scheduleForcedAgentConsult(params: {
    harness: RealtimeVoiceSessionHarness;
    session: ActiveRealtimeVoiceBridge;
    callId: string;
    callSid: string;
    transcript: string;
    userTranscriptOwner: UserTranscriptState;
    clearAudio: () => void;
  }): void {
    if (
      this.config.consultPolicy !== "always" ||
      this.activeBridgesByCallId.get(params.callId) !== params.session
    ) {
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
    userTranscriptOwner: UserTranscriptState;
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
    const abortController = new AbortController();
    const state: ForcedConsultState = {
      owner: params.session,
      sendSpeechPrompt: true,
      cancelled: false,
      // Forced consult delivery and generation share one owner. Teardown must abort
      // the agent run as well as retire provider delivery, or superseded work leaks.
      cancel: () => {
        abortController.abort(new Error("Realtime forced consult owner was cancelled."));
        coordinator.markCancelled(params.handle);
      },
      promise: Promise.resolve().then(() => {
        abortController.signal.throwIfAborted();
        return params.handler(
          {
            question: params.handle.question,
          },
          params.callId,
          { abortSignal: abortController.signal },
        );
      }),
    };
    this.forcedConsultsByCallId.set(params.callId, state);
    try {
      const result = await state.promise;
      if (state.cancelled || this.forcedConsultsByCallId.get(params.callId) !== state) {
        return;
      }
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
      this.consumePartialUserTranscript(
        params.callId,
        params.userTranscriptOwner,
        params.handle.question,
      );
    } catch (error) {
      if (!state.cancelled) {
        console.warn(
          `[voice-call] realtime forced agent consult failed callId=${params.callId} providerCallId=${params.callSid} error=${formatErrorMessage(error)}`,
        );
      }
    } finally {
      if (!state.cancelled) {
        if (this.forcedConsultsByCallId.get(params.callId) !== state) {
          coordinator.remove(params.handle);
        } else {
          const cleanupTimer = setTimeout(() => {
            if (this.forcedConsultsByCallId.get(params.callId) === state) {
              this.forcedConsultsByCallId.delete(params.callId);
              coordinator.remove(params.handle);
            }
          }, FORCED_CONSULT_NATIVE_DEDUPE_MS);
          cleanupTimer.unref?.();
        }
      }
    }
  }

  private prepareCallInManager(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry"> = {},
  ) {
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
    return { callRecord, baseFields, initialGreeting };
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

  private endCallInManager(callSid: string, callId: string, reason: EndReason): void {
    this.manager.processEvent({
      id: `realtime-ended-${callSid}-${Date.now()}`,
      type: "call.ended",
      callId,
      providerCallId: callSid,
      timestamp: Date.now(),
      reason,
    });
  }

  private async executeEndCallTool(params: {
    bridge: ActiveRealtimeVoiceBridge;
    callId: string;
    bridgeCallId: string;
    turnId: string;
    harness: RealtimeVoiceSessionHarness;
  }): Promise<void> {
    const binding = this.activeTelephonyBindingsByCallId.get(params.callId);
    if (
      !binding ||
      binding.bridge !== params.bridge ||
      !this.isActiveBridgeOwner(params.callId, params.bridge)
    ) {
      return;
    }

    let result: { success: boolean; error?: string };
    try {
      result = await this.manager.endCall(params.callId);
    } catch (error) {
      result = { success: false, error: formatErrorMessage(error) };
    }

    if (
      this.activeTelephonyBindingsByCallId.get(params.callId) !== binding ||
      !this.isActiveBridgeOwner(params.callId, params.bridge)
    ) {
      return;
    }
    if (!result.success) {
      const detail = result.error?.trim() || "the telephony provider returned no reason";
      const toolResult = {
        error: `Could not end the current phone call: ${detail}. Tell the caller the call could not be ended and they can hang up or ask you to try again.`,
      };
      await params.bridge.submitToolResult(params.bridgeCallId, toolResult);
      params.harness.emit({
        type: "tool.error",
        turnId: params.turnId,
        callId: params.bridgeCallId,
        payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: toolResult },
        final: true,
      });
      return;
    }

    params.harness.emit({
      type: "tool.result",
      turnId: params.turnId,
      callId: params.bridgeCallId,
      payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: { success: true } },
      final: true,
    });
    binding.endCall();
  }

  private async executeToolCall(
    bridge: ActiveRealtimeVoiceBridge,
    callId: string,
    bridgeCallId: string,
    name: string,
    args: unknown,
    turnId: string,
    harness: RealtimeVoiceSessionHarness,
    userTranscriptOwner: UserTranscriptState,
  ): Promise<void> {
    if (name === REALTIME_VOICE_END_CALL_TOOL_NAME) {
      await this.executeEndCallTool({ bridge, callId, bridgeCallId, turnId, harness });
      return;
    }
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
      if (this.activeBridgesByCallId.get(callId) !== bridge) {
        return;
      }
      const coordinator = harness.forcedConsults;
      const forcedMatch = coordinator.recordNativeConsult(args, bridgeCallId);
      if (forcedMatch.kind === "none") {
        const pending = coordinator.consumePending();
        if (pending) {
          coordinator.remove(pending);
        }
      }
      const forcedConsultState = this.forcedConsultsByCallId.get(callId);
      const forcedConsult =
        forcedConsultState?.owner === bridge && !forcedConsultState.cancelled
          ? forcedConsultState
          : undefined;
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
        if (
          forcedConsult.cancelled ||
          forcedConsult.owner !== bridge ||
          this.forcedConsultsByCallId.get(callId) !== forcedConsult
        ) {
          return;
        }
        await submitFinalToolResult(result);
        return;
      }

      const existingNativeConsult = this.nativeConsultsInFlightByCallId.get(callId);
      if (existingNativeConsult) {
        console.log(
          `[voice-call] realtime tool call sharing in-flight agent consult callId=${callId} ageMs=${Date.now() - existingNativeConsult.startedAt}`,
        );
        await submitWorkingResponse();
        const outcome = await waitForNativeConsult(existingNativeConsult);
        if (outcome.kind === "cancelled") {
          return;
        }
        await submitFinalToolResult(outcome.result);
        return;
      }

      const abortController = new AbortController();
      let releaseCancellation = () => {};
      const cancellation = new Promise<void>((resolve) => {
        releaseCancellation = resolve;
      });
      let completeConsult = (_result: unknown) => {};
      const consult = new Promise<unknown>((resolve) => {
        completeConsult = resolve;
      });
      const state: NativeConsultState = {
        owner: bridge,
        startedAt,
        promise: consult,
        cancellation,
        cancelled: false,
        // Provider continuity owns the consult lifetime, not only its eventual result.
        cancel: () => {
          abortController.abort(new Error("Realtime native consult owner was cancelled."));
          releaseCancellation();
        },
      };
      this.nativeConsultsInFlightByCallId.set(callId, state);
      void (async () => {
        try {
          await submitWorkingResponse();
          if (state.cancelled) {
            return undefined;
          }
          await Promise.race([
            this.waitForConsultTranscriptSettle(callId, userTranscriptOwner, startedAt),
            state.cancellation,
          ]);
          if (state.cancelled) {
            return undefined;
          }
          const context = {
            partialUserTranscript: this.resolveUserTranscriptContext(callId, userTranscriptOwner),
            abortSignal: abortController.signal,
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
      })().then(completeConsult);
      try {
        const outcome = await waitForNativeConsult(state);
        if (outcome.kind === "cancelled") {
          return;
        }
        const result = outcome.result;
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
          this.consumePartialUserTranscript(
            callId,
            userTranscriptOwner,
            state.partialUserTranscript,
          );
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
      partialUserTranscript: this.resolveUserTranscriptContext(callId, userTranscriptOwner),
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
      this.consumePartialUserTranscript(callId, userTranscriptOwner, context.partialUserTranscript);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
