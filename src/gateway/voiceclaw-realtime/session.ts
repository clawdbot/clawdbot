import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { resolvePreauthHandshakeTimeoutMs } from "../handshake-timeouts.js";
import { VoiceClawGeminiLiveAdapter } from "./gemini-live.js";
import {
  createVoiceClawRealtimeToolRuntime,
  type VoiceClawRealtimeToolRuntime,
} from "./tool-runtime.js";
import type {
  VoiceClawClientEvent,
  VoiceClawRealtimeAdapter,
  VoiceClawServerEvent,
  VoiceClawSessionConfigEvent,
  VoiceClawToolCallEvent,
} from "./types.js";

const log = createSubsystemLogger("gateway").child("voiceclaw-realtime");

type VoiceClawRealtimeSessionOptions = {
  ws: WebSocket;
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  config: OpenClawConfig;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  releasePreauthBudget: () => void;
  adapterFactory?: () => VoiceClawRealtimeAdapter;
};

export class VoiceClawRealtimeSession {
  private readonly id = randomUUID();
  private readonly startedAt = Date.now();
  private readonly ws: WebSocket;
  private readonly req: IncomingMessage;
  private readonly auth: ResolvedGatewayAuth;
  private readonly gatewayConfig: OpenClawConfig;
  private readonly trustedProxies: string[];
  private readonly allowRealIpFallback: boolean;
  private readonly rateLimiter: AuthRateLimiter | undefined;
  private readonly releasePreauthBudget: () => void;
  private readonly adapterFactory: () => VoiceClawRealtimeAdapter;
  private adapter: VoiceClawRealtimeAdapter | null = null;
  private toolRuntime: VoiceClawRealtimeToolRuntime | null = null;
  private config: VoiceClawSessionConfigEvent | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private configStarted = false;

  constructor(opts: VoiceClawRealtimeSessionOptions) {
    this.ws = opts.ws;
    this.req = opts.req;
    this.auth = opts.auth;
    this.gatewayConfig = opts.config;
    this.trustedProxies = opts.trustedProxies;
    this.allowRealIpFallback = opts.allowRealIpFallback;
    this.rateLimiter = opts.rateLimiter;
    this.releasePreauthBudget = once(opts.releasePreauthBudget);
    this.adapterFactory = opts.adapterFactory ?? (() => new VoiceClawGeminiLiveAdapter());
  }

  attach(): void {
    this.handshakeTimer = setTimeout(
      () => {
        if (!this.config && !this.closed) {
          log.warn(`session ${this.id} handshake timed out`);
          this.ws.close(1000, "handshake timeout");
        }
      },
      resolvePreauthHandshakeTimeoutMs({
        configuredTimeoutMs: this.gatewayConfig.gateway?.handshakeTimeoutMs,
      }),
    );

    this.ws.on("message", (raw) => {
      void this.handleRawMessage(raw).catch((err) => {
        log.warn(`session ${this.id} message failed: ${String(err)}`);
        this.send({ type: "error", message: "internal error", code: 500 });
      });
    });
    this.ws.on("close", () => {
      void this.cleanup();
    });
    this.ws.on("error", (err) => {
      log.warn(`session ${this.id} websocket error: ${err.message}`);
    });
  }

  private async handleRawMessage(raw: RawData): Promise<void> {
    const event = parseClientEvent(raw);
    if (!event) {
      this.send({ type: "error", message: "invalid JSON event", code: 400 });
      return;
    }

    if (!this.config) {
      if (event.type !== "session.config") {
        this.send({ type: "error", message: "session.config required before media", code: 400 });
        return;
      }
      await this.startSession(event);
      return;
    }

    switch (event.type) {
      case "audio.append":
        this.adapter?.sendAudio(event.data);
        break;
      case "audio.commit":
        this.adapter?.commitAudio();
        break;
      case "frame.append":
        this.adapter?.sendFrame(event.data, event.mimeType);
        break;
      case "response.create":
        this.adapter?.createResponse();
        break;
      case "response.cancel":
        this.adapter?.cancelResponse();
        break;
      case "tool.result":
        this.adapter?.sendToolResult(event.callId, event.output);
        break;
      case "session.config":
        this.send({ type: "error", message: "session already configured", code: 400 });
        break;
    }
  }

  private async startSession(config: VoiceClawSessionConfigEvent): Promise<void> {
    if (this.configStarted) {
      return;
    }
    this.configStarted = true;
    this.clearHandshakeTimer();

    const authResult = await authorizeHttpGatewayConnect({
      auth: this.auth,
      connectAuth: config.apiKey ? { token: config.apiKey, password: config.apiKey } : null,
      req: this.req,
      trustedProxies: this.trustedProxies,
      allowRealIpFallback: this.allowRealIpFallback,
      rateLimiter: this.rateLimiter,
    });
    this.releasePreauthBudget();

    if (!authResult.ok) {
      this.send({ type: "error", message: "OpenClaw gateway authentication failed", code: 401 });
      this.ws.close(1008, "unauthorized");
      return;
    }
    const localDirect = isLocalDirectRequest(
      this.req,
      this.trustedProxies,
      this.allowRealIpFallback,
    );
    if (config.brainAgent !== "none" && this.auth.mode === "none" && !localDirect) {
      this.send({
        type: "error",
        message: "OpenClaw real-time brain requires gateway auth for non-local connections",
        code: 403,
      });
      this.ws.close(1008, "auth required");
      return;
    }
    const senderIsOwner = resolveRealtimeSenderIsOwner(authResult.method, localDirect);
    if (config.brainAgent !== "none" && !senderIsOwner) {
      this.send({
        type: "error",
        message: "OpenClaw real-time brain requires owner-equivalent gateway auth",
        code: 403,
      });
      this.ws.close(1008, "owner auth required");
      return;
    }

    this.config = {
      ...config,
      provider: "gemini",
      voice: config.voice || "Zephyr",
      brainAgent: config.brainAgent ?? "enabled",
    };
    this.adapter = this.adapterFactory();

    try {
      if (!process.env.GEMINI_API_KEY?.trim()) {
        throw new Error("GEMINI_API_KEY is required for VoiceClaw real-time brain mode");
      }
      this.toolRuntime =
        this.config.brainAgent === "none"
          ? null
          : createVoiceClawRealtimeToolRuntime({
              config: this.gatewayConfig,
              sessionId: this.id,
              sessionKey: this.resolveToolSessionKey(),
              modelId: this.config.model,
              senderIsOwner,
            });
      await this.adapter.connect(this.config, (event) => this.handleAdapterEvent(event), {
        tools: this.toolRuntime?.declarations ?? [],
      });
      this.send({ type: "session.ready", sessionId: this.id });
    } catch (err) {
      this.send({
        type: "error",
        message:
          err instanceof Error
            ? sanitizeErrorMessage(err.message)
            : "failed to start real-time brain session",
        code: 500,
      });
      this.ws.close(1011, "setup failed");
    }
  }

  private handleAdapterEvent(event: VoiceClawServerEvent): void {
    if (event.type === "tool.call") {
      this.handleToolCall(event);
      return;
    }
    if (event.type === "tool.cancelled") {
      for (const callId of event.callIds) {
        this.toolRuntime?.abortTool(callId);
      }
    }
    this.send(event);
    if (event.type === "error") {
      this.closeWithSummary(1011, "upstream error");
    }
  }

  private handleToolCall(event: VoiceClawToolCallEvent): void {
    if (
      this.toolRuntime?.handleToolCall(event, {
        beginAsyncToolCall: (callId) => this.adapter?.beginAsyncToolCall(callId),
        finishAsyncToolCall: (callId) => this.adapter?.finishAsyncToolCall(callId),
        sendToolResult: (callId, output) => this.adapter?.sendToolResult(callId, output),
        sendProgress: (callId, summary) => this.send({ type: "tool.progress", callId, summary }),
        injectContext: (text) => this.adapter?.injectContext(text),
      })
    ) {
      return;
    }

    this.adapter?.sendToolResult(
      event.callId,
      JSON.stringify({ error: `unknown tool: ${event.name}` }),
    );
  }

  private resolveToolSessionKey(): string {
    const configured = sanitizeSessionKey(this.config?.sessionKey);
    if (configured) {
      return `agent:main:voiceclaw:${configured}`;
    }
    return `agent:main:voiceclaw:${this.id}`;
  }

  private send(event: VoiceClawServerEvent): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  private clearHandshakeTimer(): void {
    this.handshakeTimer = clearTimer(this.handshakeTimer);
  }

  private closeWithSummary(code: number, reason: string): void {
    this.endSession();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, reason);
    }
  }

  private async cleanup(): Promise<void> {
    this.endSession();
  }

  private endSession(): void {
    if (this.closed) {
      return;
    }
    this.clearHandshakeTimer();
    this.releasePreauthBudget();
    this.toolRuntime?.abortAll();
    this.toolRuntime = null;
    const transcript = this.adapter?.getTranscript() ?? [];
    this.adapter?.disconnect();
    this.adapter = null;
    if (this.config && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: "session.ended",
        summary: "Real-time brain session ended.",
        durationSec: Math.round((Date.now() - this.startedAt) / 1000),
        turnCount: transcript.filter((entry) => entry.role === "user").length,
      });
    }
    this.closed = true;
  }
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) {
    clearTimeout(timer);
  }
  return null;
}

function parseClientEvent(raw: RawData): VoiceClawClientEvent | null {
  try {
    const parsed = JSON.parse(rawDataToString(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return null;
    }
    return parsed as VoiceClawClientEvent;
  } catch {
    return null;
  }
}

function sanitizeSessionKey(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128);
  return sanitized || null;
}

export function resolveRealtimeSenderIsOwner(
  method: GatewayAuthResult["method"] | undefined,
  localDirect: boolean,
): boolean {
  if (method === "token" || method === "password") {
    return true;
  }
  return method === "none" && localDirect;
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/([?&]key=)[^&\s]+/g, "$1***");
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    fn();
  };
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
