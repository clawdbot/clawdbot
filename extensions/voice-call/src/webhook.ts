import http from "node:http";
import { URL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  createWebhookInFlightLimiter,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../api.js";
import { normalizeVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { getHeader } from "./http-headers.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import { resolveConfiguredCapabilityProvider } from "./provider-runtime-resolution.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { isProviderStatusTerminal } from "./providers/shared/call-status.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { CallRecord, NormalizedEvent, WebhookContext } from "./types.js";
import type { WebhookResponsePayload } from "./webhook.types.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

const MAX_WEBHOOK_BODY_BYTES = WEBHOOK_BODY_READ_DEFAULTS.preAuth.maxBytes;
const WEBHOOK_BODY_TIMEOUT_MS = WEBHOOK_BODY_READ_DEFAULTS.preAuth.timeoutMs;
const STREAM_DISCONNECT_HANGUP_GRACE_MS = 2000;
const TRANSCRIPT_LOG_MAX_CHARS = 200;

type WebhookHeaderGateResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

function sanitizeTranscriptForLog(value: string): string {
  const sanitized = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= TRANSCRIPT_LOG_MAX_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, TRANSCRIPT_LOG_MAX_CHARS)}...`;
}

function buildRequestUrl(
  requestUrl: string | undefined,
  requestHost: string | undefined,
  fallbackHost = "localhost",
): URL {
  return new URL(requestUrl ?? "/", `http://${requestHost ?? fallbackHost}`);
}

function normalizeProxyIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const normalized = unwrapped.toLowerCase();
  const mappedIpv4Prefix = "::ffff:";
  if (normalized.startsWith(mappedIpv4Prefix)) {
    const mappedIpv4 = normalized.slice(mappedIpv4Prefix.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mappedIpv4)) {
      return mappedIpv4;
    }
  }
  return normalized;
}

function resolveForwardedClientIp(
  request: http.IncomingMessage,
  trustedProxyIPs: readonly string[],
): string | undefined {
  const normalizedTrustedProxyIps = new Set(
    trustedProxyIPs.map((ip) => normalizeProxyIp(ip)).filter((ip): ip is string => Boolean(ip)),
  );
  const forwardedFor = getHeader(request.headers, "x-forwarded-for");
  if (forwardedFor) {
    const forwardedIps = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (forwardedIps.length > 0) {
      if (normalizedTrustedProxyIps.size === 0) {
        return forwardedIps[0];
      }
      for (let index = forwardedIps.length - 1; index >= 0; index -= 1) {
        const hop = forwardedIps[index];
        if (!normalizedTrustedProxyIps.has(normalizeProxyIp(hop) ?? "")) {
          return hop;
        }
      }
      return forwardedIps[0];
    }
  }

  const realIp = getHeader(request.headers, "x-real-ip")?.trim();
  return realIp || undefined;
}

function normalizeWebhookResponse(parsed: {
  statusCode?: number;
  providerResponseHeaders?: Record<string, string>;
  providerResponseBody?: string;
}): WebhookResponsePayload {
  return {
    statusCode: parsed.statusCode ?? 200,
    headers: parsed.providerResponseHeaders,
    body: parsed.providerResponseBody ?? "OK",
  };
}

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private listeningUrl: string | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;
  private coreConfig: CoreConfig | null;
  private fullConfig: OpenClawConfig | null;
  private agentRuntime: CoreAgentDeps | null;
  private stopStaleCallReaper: (() => void) | null = null;
  private readonly webhookInFlightLimiter = createWebhookInFlightLimiter();

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;
  /** Delayed auto-hangup timers keyed by provider call ID after stream disconnect. */
  private pendingDisconnectHangups = new Map<string, ReturnType<typeof setTimeout>>();
  /** Realtime voice handler for duplex provider bridges. */
  private realtimeHandler: RealtimeCallHandler | null = null;

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
    fullConfig?: OpenClawConfig,
    agentRuntime?: CoreAgentDeps,
  ) {
    this.config = normalizeVoiceCallConfig(config);
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;
    this.fullConfig = fullConfig ?? null;
    this.agentRuntime = agentRuntime ?? null;
  }

  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null {
    return this.mediaStreamHandler;
  }

  getRealtimeHandler(): RealtimeCallHandler | null {
    return this.realtimeHandler;
  }

  setRealtimeHandler(handler: RealtimeCallHandler): void {
    this.realtimeHandler = handler;
  }

  private clearPendingDisconnectHangup(providerCallId: string): void {
    const existing = this.pendingDisconnectHangups.get(providerCallId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.pendingDisconnectHangups.delete(providerCallId);
  }

  private resolveMediaStreamClientIp(request: http.IncomingMessage): string | undefined {
    const remoteIp = request.socket.remoteAddress ?? undefined;
    const trustedProxyIPs = this.config.webhookSecurity.trustedProxyIPs.filter(Boolean);
    const normalizedTrustedProxyIps = new Set(
      trustedProxyIPs.map((ip) => normalizeProxyIp(ip)).filter((ip): ip is string => Boolean(ip)),
    );
    const normalizedRemoteIp = normalizeProxyIp(remoteIp);
    const fromTrustedProxy =
      normalizedTrustedProxyIps.size > 0 &&
      normalizedRemoteIp !== undefined &&
      normalizedTrustedProxyIps.has(normalizedRemoteIp);
    const shouldTrustForwardingHeaders =
      this.config.webhookSecurity.trustForwardingHeaders && fromTrustedProxy;

    if (shouldTrustForwardingHeaders) {
      const forwardedIp = resolveForwardedClientIp(request, trustedProxyIPs);
      if (forwardedIp) {
        return forwardedIp;
      }
    }

    return remoteIp;
  }

  private shouldSuppressBargeInForInitialMessage(call: CallRecord | undefined): boolean {
    if (!call || call.direction !== "outbound") {
      return false;
    }

    // Suppress only while the initial greeting is actively being played.
    // If playback fails and the call leaves "speaking", do not block auto-response.
    if (call.state !== "speaking") {
      return false;
    }

    const mode = (call.metadata?.mode as string | undefined) ?? "conversation";
    if (mode !== "conversation") {
      return false;
    }

    const initialMessage = normalizeOptionalString(call.metadata?.initialMessage) ?? "";
    return initialMessage.length > 0;
  }

  /**
   * Initialize media streaming with the selected realtime transcription provider.
   */
  private async initializeMediaStreaming(): Promise<void> {
    const streaming = this.config.streaming;
    const pluginConfig =
      this.fullConfig ?? (this.coreConfig as unknown as OpenClawConfig | undefined);
    const { getRealtimeTranscriptionProvider, listRealtimeTranscriptionProviders } =
      await import("./realtime-transcription.runtime.js");
    const resolution = resolveConfiguredCapabilityProvider({
      configuredProviderId: streaming.provider,
      providerConfigs: streaming.providers,
      cfg: pluginConfig,
      cfgForResolve: pluginConfig ?? ({} as OpenClawConfig),
      getConfiguredProvider: (providerId) =>
        getRealtimeTranscriptionProvider(providerId, pluginConfig),
      listProviders: () => listRealtimeTranscriptionProviders(pluginConfig),
      resolveProviderConfig: ({ provider, cfg, rawConfig }) =>
        provider.resolveConfig?.({ cfg, rawConfig }) ?? rawConfig,
      isProviderConfigured: ({ provider, cfg, providerConfig }) =>
        provider.isConfigured({ cfg, providerConfig }),
    });
    if (!resolution.ok && resolution.code === "missing-configured-provider") {
      console.warn(
        `[voice-call] Streaming enabled but realtime transcription provider "${resolution.configuredProviderId}" is not registered`,
      );
      return;
    }
    if (!resolution.ok && resolution.code === "no-registered-provider") {
      console.warn(
        "[voice-call] Streaming enabled but no realtime transcription provider is registered",
      );
      return;
    }
    if (!resolution.ok) {
      console.warn(
        `[voice-call] Streaming enabled but provider "${resolution.provider?.id}" is not configured`,
      );
      return;
    }
    const provider = resolution.provider;
    const providerConfig = resolution.providerConfig;

    const streamConfig: MediaStreamConfig = {
      transcriptionProvider: provider,
      providerConfig,
      preStartTimeoutMs: streaming.preStartTimeoutMs,
      maxPendingConnections: streaming.maxPendingConnections,
      maxPendingConnectionsPerIp: streaming.maxPendingConnectionsPerIp,
      maxConnections: streaming.maxConnections,
      resolveClientIp: (request) => this.resolveMediaStreamClientIp(request),
      shouldAcceptStream: ({ callId, token }) => {
        const call = this.manager.getCallByProviderCallId(callId);
        if (!call) {
          return false;
        }
        if (this.provider.name === "twilio") {
          const twilio = this.provider as TwilioProvider;
          if (!twilio.isValidStreamToken(callId, token)) {
            console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
            return false;
          }
        }
        return true;
      },
      onTranscript: (providerCallId, transcript) => {
        const safeTranscript = sanitizeTranscriptForLog(transcript);
        console.log(
          `[voice-call] Transcript for ${providerCallId}: ${safeTranscript} (chars=${transcript.length})`,
        );
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }
        const suppressBargeIn = this.shouldSuppressBargeInForInitialMessage(call);
        if (suppressBargeIn) {
          console.log(
            `[voice-call] Ignoring barge transcript while initial message is still playing (${providerCallId})`,
          );
          return;
        }

        // Clear TTS queue on barge-in (user started speaking, interrupt current playback)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        // Create a speech event and process it through the manager
        const event: NormalizedEvent = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true,
        };
        this.manager.processEvent(event);

        // Auto-respond in conversation mode (inbound always, outbound if mode is conversation)
        const callMode = call.metadata?.mode as string | undefined;
        const shouldRespond = call.direction === "inbound" || callMode === "conversation";
        if (shouldRespond) {
          this.handleInboundResponse(call.callId, transcript).catch((err) => {
            console.warn(`[voice-call] Failed to auto-respond:`, err);
          });
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name !== "twilio") {
          return;
        }
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (this.shouldSuppressBargeInForInitialMessage(call)) {
          return;
        }
        (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
      },
      onPartialTranscript: (callId, partial) => {
        const safePartial = sanitizeTranscriptForLog(partial);
        console.log(`[voice-call] Partial for ${callId}: ${safePartial} (chars=${partial.length})`);
      },
      onConnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        this.clearPendingDisconnectHangup(callId);

        // Register stream with provider for TTS routing
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }

        // Speak initial message immediately (no delay) to avoid stream timeout
        this.manager.speakInitialMessage(callId).catch((err) => {
          console.warn(`[voice-call] Failed to speak initial message:`, err);
        });
      },
      onDisconnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream disconnected: ${callId} (${streamSid})`);
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).unregisterCallStream(callId, streamSid);
        }

        this.clearPendingDisconnectHangup(callId);
        const timer = setTimeout(() => {
          this.pendingDisconnectHangups.delete(callId);
          const disconnectedCall = this.manager.getCallByProviderCallId(callId);
          if (!disconnectedCall) {
            return;
          }

          if (this.provider.name === "twilio") {
            const twilio = this.provider as TwilioProvider;
            if (twilio.hasRegisteredStream(callId)) {
              return;
            }
          }

          console.log(
            `[voice-call] Auto-ending call ${disconnectedCall.callId} after stream disconnect grace`,
          );
          void this.manager.endCall(disconnectedCall.callId).catch((err) => {
            console.warn(`[voice-call] Failed to auto-end call ${disconnectedCall.callId}:`, err);
          });
        }, STREAM_DISCONNECT_HANGUP_GRACE_MS);
        timer.unref?.();
        this.pendingDisconnectHangups.set(callId, timer);
      },
    };

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }

  /**
   * Start the webhook server.
   * Idempotent: returns immediately if the server is already listening.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming.streamPath;

    // Guard: if a server is already listening, return the existing URL.
    // This prevents EADDRINUSE when start() is called more than once on the
    // same instance (e.g. during config hot-reload or concurrent ensureRuntime).
    if (this.server?.listening) {
      return this.listeningUrl ?? this.resolveListeningUrl(bind, webhookPath);
    }

    if (this.config.streaming.enabled && !this.mediaStreamHandler) {
      await this.initializeMediaStreaming();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // Handle WebSocket upgrades for realtime voice and media streams.
      if (this.realtimeHandler || this.mediaStreamHandler) {
        this.server.on("upgrade", (request, socket, head) => {
          if (this.realtimeHandler && this.isRealtimeWebSocketUpgrade(request)) {
            this.realtimeHandler.handleWebSocketUpgrade(request, socket, head);
            return;
          }
          const path = this.getUpgradePathname(request);
          if (path === streamPath && this.mediaStreamHandler) {
            this.mediaStreamHandler?.handleUpgrade(request, socket, head);
          } else {
            socket.destroy();
          }
        });
      }

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = this.resolveListeningUrl(bind, webhookPath);
        this.listeningUrl = url;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          const address = this.server?.address();
          const actualPort =
            address && typeof address === "object" ? address.port : this.config.serve.port;
          console.log(
            `[voice-call] Media stream WebSocket on ws://${bind}:${actualPort}${streamPath}`,
          );
        }
        resolve(url);

        // Start the stale call reaper if configured
        this.stopStaleCallReaper = startStaleCallReaper({
          manager: this.manager,
          staleCallReaperSeconds: this.config.staleCallReaperSeconds,
        });
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    for (const timer of this.pendingDisconnectHangups.values()) {
      clearTimeout(timer);
    }
    this.pendingDisconnectHangups.clear();
    this.webhookInFlightLimiter.clear();

    if (this.stopStaleCallReaper) {
      this.stopStaleCallReaper();
      this.stopStaleCallReaper = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.listeningUrl = null;
          resolve();
        });
      } else {
        this.listeningUrl = null;
        resolve();
      }
    });
  }

  private resolveListeningUrl(bind: string, webhookPath: string): string {
    const address = this.server?.address();
    if (address && typeof address === "object") {
      const host = address.address && address.address.length > 0 ? address.address : bind;
      const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return `http://${normalizedHost}:${address.port}${webhookPath}`;
    }
    return `http://${bind}:${this.config.serve.port}${webhookPath}`;
  }

  private getUpgradePathname(request: http.IncomingMessage): string | null {
    try {
      return buildRequestUrl(request.url, request.headers.host).pathname;
    } catch {
      return null;
    }
  }

  private normalizeWebhookPathForMatch(pathname: string): string {
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

  private isWebhookPathMatch(requestPath: string, configuredPath: string): boolean {
    return (
      this.normalizeWebhookPathForMatch(requestPath) ===
      this.normalizeWebhookPathForMatch(configuredPath)
    );
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const payload = await this.runWebhookPipeline(req, webhookPath);
    this.writeWebhookResponse(res, payload);
  }

  private async runWebhookPipeline(
    req: http.IncomingMessage,
    webhookPath: string,
  ): Promise<WebhookResponsePayload> {
    const url = buildRequestUrl(req.url, req.headers.host);

    if (url.pathname === "/voice/hold-music") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">All agents are currently busy. Please hold.</Say>
  <Play loop="0">https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3</Play>
</Response>`,
      };
    }

    if (!this.isWebhookPathMatch(url.pathname, webhookPath)) {
      return { statusCode: 404, body: "Not Found" };
    }

    if (req.method !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const headerGate = this.verifyPreAuthWebhookHeaders(req.headers);
    if (!headerGate.ok) {
      console.warn(`[voice-call] Webhook rejected before body read: ${headerGate.reason}`);
      return { statusCode: 401, body: "Unauthorized" };
    }

    const inFlightKey = req.socket.remoteAddress ?? "";
    if (!this.webhookInFlightLimiter.tryAcquire(inFlightKey)) {
      console.warn(`[voice-call] Webhook rejected before body read: too many in-flight requests`);
      return { statusCode: 429, body: "Too Many Requests" };
    }

    try {
      let body = "";
      try {
        body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES, WEBHOOK_BODY_TIMEOUT_MS);
      } catch (err) {
        if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
          return { statusCode: 413, body: "Payload Too Large" };
        }
        if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
          return { statusCode: 408, body: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") };
        }
        throw err;
      }

      const ctx: WebhookContext = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        rawBody: body,
        url: url.toString(),
        method: "POST",
        query: Object.fromEntries(url.searchParams),
        remoteAddress: req.socket.remoteAddress ?? undefined,
      };

      const verification = this.provider.verifyWebhook(ctx);
      if (!verification.ok) {
        console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
        return { statusCode: 401, body: "Unauthorized" };
      }
      if (!verification.verifiedRequestKey) {
        console.warn("[voice-call] Webhook verification succeeded without request identity key");
        return { statusCode: 401, body: "Unauthorized" };
      }

      if (this.shouldShortCircuitToRealtimeTwiml(ctx)) {
        return this.realtimeHandler!.buildTwiMLPayload(req, new URLSearchParams(ctx.rawBody));
      }

      const parsed = this.provider.parseWebhookEvent(ctx, {
        verifiedRequestKey: verification.verifiedRequestKey,
      });

      if (verification.isReplay) {
        console.warn("[voice-call] Replay detected; skipping event side effects");
      } else {
        this.processParsedEvents(parsed.events);
      }

      return normalizeWebhookResponse(parsed);
    } finally {
      this.webhookInFlightLimiter.release(inFlightKey);
    }
  }

  private verifyPreAuthWebhookHeaders(headers: http.IncomingHttpHeaders): WebhookHeaderGateResult {
    if (this.config.skipSignatureVerification) {
      return { ok: true };
    }
    switch (this.provider.name) {
      case "telnyx": {
        const signature = getHeader(headers, "telnyx-signature-ed25519");
        const timestamp = getHeader(headers, "telnyx-timestamp");
        if (signature && timestamp) {
          return { ok: true };
        }
        return { ok: false, reason: "missing Telnyx signature or timestamp header" };
      }
      case "twilio":
        if (getHeader(headers, "x-twilio-signature")) {
          return { ok: true };
        }
        return { ok: false, reason: "missing X-Twilio-Signature header" };
      case "plivo": {
        const hasV3 =
          Boolean(getHeader(headers, "x-plivo-signature-v3")) &&
          Boolean(getHeader(headers, "x-plivo-signature-v3-nonce"));
        const hasV2 =
          Boolean(getHeader(headers, "x-plivo-signature-v2")) &&
          Boolean(getHeader(headers, "x-plivo-signature-v2-nonce"));
        if (hasV3 || hasV2) {
          return { ok: true };
        }
        return { ok: false, reason: "missing Plivo signature headers" };
      }
      default:
        return { ok: true };
    }
  }

  private isRealtimeWebSocketUpgrade(req: http.IncomingMessage): boolean {
    try {
      const pathname = buildRequestUrl(req.url, req.headers.host).pathname;
      const pattern = this.realtimeHandler?.getStreamPathPattern();
      return Boolean(pattern && pathname.startsWith(pattern));
    } catch {
      return false;
    }
  }

  private shouldShortCircuitToRealtimeTwiml(ctx: WebhookContext): boolean {
    if (!this.realtimeHandler || this.provider.name !== "twilio") {
      return false;
    }

    const params = new URLSearchParams(ctx.rawBody);
    const direction = params.get("Direction");
    const isInbound = !direction || direction === "inbound";
    if (!isInbound) {
      return false;
    }

    if (ctx.query?.type === "status") {
      return false;
    }

    const callStatus = params.get("CallStatus");
    if (callStatus && isProviderStatusTerminal(callStatus)) {
      return false;
    }

    // Replays must return the same TwiML body so Twilio retries reconnect cleanly.
    // The one-time token still changes, but the behavior stays identical.
    return !params.get("SpeechResult") && !params.get("Digits");
  }

  private processParsedEvents(events: NormalizedEvent[]): void {
    for (const event of events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }
  }

  private writeWebhookResponse(res: http.ServerResponse, payload: WebhookResponsePayload): void {
    res.statusCode = payload.statusCode;
    if (payload.headers) {
      for (const [key, value] of Object.entries(payload.headers)) {
        res.setHeader(key, value);
      }
    }
    res.end(payload.body);
  }

  /**
   * Read request body as string with timeout protection.
   */
  private readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    timeoutMs = WEBHOOK_BODY_TIMEOUT_MS,
  ): Promise<string> {
    return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  private async handleInboundResponse(callId: string, userMessage: string): Promise<void> {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      return;
    }
    if (!this.agentRuntime) {
      console.warn("[voice-call] Agent runtime missing; skipping auto-response");
      return;
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        agentRuntime: this.agentRuntime,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage,
      });

      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (result.text) {
        console.log(`[voice-call] AI response: "${result.text}"`);
        await this.manager.speak(callId, result.text);
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }
}
