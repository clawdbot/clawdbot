import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { WebSocketServer } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";

export type ToolHandlerFn = (args: unknown, callId: string) => Promise<unknown>;

const STREAM_TOKEN_TTL_MS = 30_000;
const DEFAULT_HOST = "localhost:8443";
const MAX_REALTIME_MESSAGE_BYTES = 256 * 1024;

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
    return baseInstructions;
  }
  const intro =
    "Start the call by greeting the caller naturally. Include this greeting in your first spoken reply:";
  return baseInstructions
    ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"`
    : `${intro} "${trimmedGreeting}"`;
}

type PendingStreamToken = {
  expiry: number;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};

type CallRegistration = {
  callId: string;
  initialGreetingInstructions?: string;
};

type ActiveRealtimeVoiceBridge = RealtimeVoiceBridgeSession;

export class RealtimeCallHandler {
  private readonly toolHandlers = new Map<string, ToolHandlerFn>();
  private readonly pendingStreamTokens = new Map<string, PendingStreamToken>();
  private publicOrigin: string | null = null;
  private publicPathPrefix = "";

  constructor(
    private readonly config: VoiceCallRealtimeConfig,
    private readonly manager: CallManager,
    private readonly provider: VoiceCallProvider,
    private readonly realtimeProvider: RealtimeVoiceProviderPlugin,
    private readonly providerConfig: RealtimeVoiceProviderConfig,
    private readonly servePath: string,
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
    const host = this.publicOrigin || req.headers.host || DEFAULT_HOST;
    const rawDirection = params?.get("Direction");
    const token = this.issueStreamToken({
      from: params?.get("From") ?? undefined,
      to: params?.get("To") ?? undefined,
      direction: rawDirection === "outbound-api" ? "outbound" : "inbound",
    });
    const wsUrl = `wss://${host}${this.getStreamPathPattern()}/${token}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml,
    };
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

    const wss = new WebSocketServer({
      noServer: true,
      // Reject oversized realtime frames before JSON parsing or bridge setup runs.
      maxPayload: MAX_REALTIME_MESSAGE_BYTES,
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      let bridge: ActiveRealtimeVoiceBridge | null = null;
      let initialized = false;

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (!initialized && msg.event === "start") {
            initialized = true;
            const startData =
              typeof msg.start === "object" && msg.start !== null
                ? (msg.start as Record<string, unknown>)
                : undefined;
            const streamSid =
              typeof startData?.streamSid === "string" ? startData.streamSid : "unknown";
            const callSid = typeof startData?.callSid === "string" ? startData.callSid : "unknown";
            const nextBridge = this.handleCall(streamSid, callSid, ws, callerMeta);
            if (!nextBridge) {
              return;
            }
            bridge = nextBridge;
            return;
          }
          if (!bridge) {
            return;
          }
          const mediaData =
            typeof msg.media === "object" && msg.media !== null
              ? (msg.media as Record<string, unknown>)
              : undefined;
          if (msg.event === "media" && typeof mediaData?.payload === "string") {
            bridge.sendAudio(Buffer.from(mediaData.payload, "base64"));
            if (typeof mediaData.timestamp === "number") {
              bridge.setMediaTimestamp(mediaData.timestamp);
            } else if (typeof mediaData.timestamp === "string") {
              bridge.setMediaTimestamp(Number.parseInt(mediaData.timestamp, 10));
            }
            return;
          }
          if (msg.event === "mark") {
            bridge.acknowledgeMark();
            return;
          }
          if (msg.event === "stop") {
            bridge.close();
          }
        } catch (error) {
          console.error("[voice-call] realtime WS parse failed:", error);
        }
      });

      ws.on("close", () => {
        bridge?.close();
      });

      ws.on("error", (error) => {
        console.error("[voice-call] realtime WS error:", error);
      });
    });
  }

  registerToolHandler(name: string, fn: ToolHandlerFn): void {
    this.toolHandlers.set(name, fn);
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
    };
  }

  private handleCall(
    streamSid: string,
    callSid: string,
    ws: WebSocket,
    callerMeta: Omit<PendingStreamToken, "expiry">,
  ): ActiveRealtimeVoiceBridge | null {
    const registration = this.registerCallInManager(callSid, callerMeta);
    if (!registration) {
      ws.close(1008, "Caller rejected by policy");
      return null;
    }

    const { callId, initialGreetingInstructions } = registration;
    let callEndEmitted = false;
    const emitCallEnd = (reason: "completed" | "error") => {
      if (callEndEmitted) {
        return;
      }
      callEndEmitted = true;
      this.endCallInManager(callSid, callId, reason);
    };

    const bridge = createRealtimeVoiceBridgeSession({
      provider: this.realtimeProvider,
      providerConfig: this.providerConfig,
      instructions: this.config.instructions,
      tools: this.config.tools,
      initialGreetingInstructions,
      triggerGreetingOnReady: true,
      audioSink: {
        isOpen: () => ws.readyState === WebSocket.OPEN,
        sendAudio: (muLaw) => {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: muLaw.toString("base64") },
            }),
          );
        },
        clearAudio: () => {
          ws.send(JSON.stringify({ event: "clear", streamSid }));
        },
        sendMark: (markName) => {
          ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: markName } }));
        },
      },
      onTranscript: (role, text, isFinal) => {
        if (!isFinal) {
          return;
        }
        if (role === "user") {
          const event: NormalizedEvent = {
            id: `realtime-speech-${callSid}-${Date.now()}`,
            type: "call.speech",
            callId,
            providerCallId: callSid,
            timestamp: Date.now(),
            transcript: text,
            isFinal: true,
          };
          this.manager.processEvent(event);
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
        void this.executeToolCall(
          session,
          callId,
          toolEvent.callId || toolEvent.itemId,
          toolEvent.name,
          toolEvent.args,
        );
      },
      onError: (error) => {
        console.error("[voice-call] realtime voice error:", error.message);
      },
      onClose: (reason) => {
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

    bridge.connect().catch((error: Error) => {
      console.error("[voice-call] Failed to connect realtime bridge:", error);
      bridge.close();
      emitCallEnd("error");
      ws.close(1011, "Failed to connect");
    });

    return bridge;
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

    this.manager.processEvent({
      id: `realtime-initiated-${callSid}`,
      callId: callSid,
      type: "call.initiated",
      ...baseFields,
    });

    const callRecord = this.manager.getCallByProviderCallId(callSid);
    if (!callRecord) {
      return null;
    }

    const initialGreeting = this.extractInitialGreeting(callRecord);
    if (callRecord.metadata) {
      delete callRecord.metadata.initialMessage;
    }

    this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId: callSid,
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
  ): Promise<void> {
    const handler = this.toolHandlers.get(name);
    const result = !handler
      ? { error: `Tool "${name}" not available` }
      : await handler(args, callId).catch((error: unknown) => ({
          error: formatErrorMessage(error),
        }));
    bridge.submitToolResult(bridgeCallId, result);
  }
}
