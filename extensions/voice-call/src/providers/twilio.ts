import crypto from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { TwilioConfig } from "../config.js";
import { getHeader } from "../http-headers.js";
import type { MediaStreamHandler } from "../media-stream.js";
import { chunkAudio } from "../telephony-audio.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import { escapeXml, mapVoiceToPolly } from "../voice-mapping.js";
import type { VoiceCallProvider } from "./base.js";
import {
  isProviderStatusTerminal,
  mapProviderStatusToEndReason,
  normalizeProviderStatus,
} from "./shared/call-status.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";
import type { TwilioProviderOptions } from "./twilio.types.js";
import { twilioApiRequest } from "./twilio/api.js";
import { decideTwimlResponse, readTwimlRequestView } from "./twilio/twiml-policy.js";
import { verifyTwilioProviderWebhook } from "./twilio/webhook.js";
export type { TwilioProviderOptions } from "./twilio.types.js";

function createTwilioRequestDedupeKey(ctx: WebhookContext, verifiedRequestKey?: string): string {
  if (verifiedRequestKey) {
    return verifiedRequestKey;
  }

  const signature = getHeader(ctx.headers, "x-twilio-signature") ?? "";
  const params = new URLSearchParams(ctx.rawBody);
  const callSid = params.get("CallSid") ?? "";
  const callStatus = params.get("CallStatus") ?? "";
  const direction = params.get("Direction") ?? "";
  const callId = normalizeOptionalString(ctx.query?.callId) ?? "";
  const flow = normalizeOptionalString(ctx.query?.flow) ?? "";
  const turnToken = normalizeOptionalString(ctx.query?.turnToken) ?? "";
  return `twilio:fallback:${crypto
    .createHash("sha256")
    .update(
      `${signature}\n${callSid}\n${callStatus}\n${direction}\n${callId}\n${flow}\n${turnToken}\n${ctx.rawBody}`,
    )
    .digest("hex")}`;
}

type StreamSendResult = {
  sent: boolean;
};

export class TwilioProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;
  private static readonly TTS_SYNTH_TIMEOUT_MS = 8000;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly callWebhookUrls = new Map<string, string>();
  private readonly options: TwilioProviderOptions;

  /** Current public webhook URL (set when tunnel starts or from config) */
  private currentPublicUrl: string | null = null;

  /** Optional telephony TTS provider for streaming TTS */
  private ttsProvider: TelephonyTtsProvider | null = null;

  /** Optional media stream handler for sending audio */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  /** Map of call SID to stream SID for media streams */
  private callStreamMap = new Map<string, string>();
  /** Per-call tokens for media stream authentication */
  private streamAuthTokens = new Map<string, string>();

  /** Storage for TwiML content (for notify mode with URL-based TwiML) */
  private readonly twimlStorage = new Map<string, string>();
  /** Track notify-mode calls to avoid streaming on follow-up callbacks */
  private readonly notifyCalls = new Set<string>();
  private readonly activeStreamCalls = new Set<string>();

  /**
   * Delete stored TwiML for a given `callId`.
   *
   * We keep TwiML in-memory only long enough to satisfy the initial Twilio
   * webhook request (notify mode). Subsequent webhooks should not reuse it.
   */
  private deleteStoredTwiml(callId: string): void {
    this.twimlStorage.delete(callId);
    this.notifyCalls.delete(callId);
  }

  /**
   * Delete stored TwiML for a call, addressed by Twilio's provider call SID.
   *
   * This is used when we only have `providerCallId` (e.g. hangup).
   */
  private deleteStoredTwimlForProviderCall(providerCallId: string): void {
    const webhookUrl = this.callWebhookUrls.get(providerCallId);
    if (!webhookUrl) {
      return;
    }

    const callIdMatch = webhookUrl.match(/callId=([^&]+)/);
    if (!callIdMatch) {
      return;
    }

    this.deleteStoredTwiml(callIdMatch[1]);
    this.streamAuthTokens.delete(providerCallId);
  }

  constructor(config: TwilioConfig, options: TwilioProviderOptions = {}) {
    if (!config.accountSid) {
      throw new Error("Twilio Account SID is required");
    }
    if (!config.authToken) {
      throw new Error("Twilio Auth Token is required");
    }

    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
    this.options = options;

    if (options.publicUrl) {
      this.currentPublicUrl = options.publicUrl;
    }
  }

  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  setMediaStreamHandler(handler: MediaStreamHandler): void {
    this.mediaStreamHandler = handler;
  }

  registerCallStream(callSid: string, streamSid: string): void {
    this.callStreamMap.set(callSid, streamSid);
  }

  hasRegisteredStream(callSid: string): boolean {
    return this.callStreamMap.has(callSid);
  }

  unregisterCallStream(callSid: string, streamSid?: string): void {
    const currentStreamSid = this.callStreamMap.get(callSid);
    if (!currentStreamSid) {
      if (!streamSid) {
        this.activeStreamCalls.delete(callSid);
      }
      return;
    }
    if (streamSid && currentStreamSid !== streamSid) {
      return;
    }
    this.callStreamMap.delete(callSid);
    this.activeStreamCalls.delete(callSid);
  }

  isConversationStreamConnectEnabled(): boolean {
    return Boolean(this.mediaStreamHandler && this.getStreamUrl());
  }

  isValidStreamToken(callSid: string, token?: string): boolean {
    const expected = this.streamAuthTokens.get(callSid);
    if (!expected || !token) {
      return false;
    }
    return safeEqualSecret(expected, token);
  }

  /**
   * Clear TTS queue for a call (barge-in).
   * Used when user starts speaking to interrupt current TTS playback.
   */
  clearTtsQueue(callSid: string, reason = "unspecified"): void {
    const streamSid = this.callStreamMap.get(callSid);
    if (!streamSid || !this.mediaStreamHandler) {
      return;
    }
    this.mediaStreamHandler.clearTtsQueue(streamSid, reason);
  }

  /**
   * Make an authenticated request to the Twilio API.
   */
  private async apiRequest<T = unknown>(
    endpoint: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    return await twilioApiRequest<T>({
      baseUrl: this.baseUrl,
      accountSid: this.accountSid,
      authToken: this.authToken,
      endpoint,
      body: params,
      allowNotFound: options?.allowNotFound,
    });
  }

  /**
   * Verify Twilio webhook signature using HMAC-SHA1.
   *
   * Handles reverse proxy scenarios (Tailscale, nginx, ngrok) by reconstructing
   * the public URL from forwarding headers.
   *
   * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    return verifyTwilioProviderWebhook({
      ctx,
      authToken: this.authToken,
      currentPublicUrl: this.currentPublicUrl,
      options: this.options,
    });
  }

  /**
   * Parse Twilio webhook event into normalized format.
   */
  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery = normalizeOptionalString(ctx.query?.callId);
      const turnTokenFromQuery = normalizeOptionalString(ctx.query?.turnToken);
      const dedupeKey = createTwilioRequestDedupeKey(ctx, options?.verifiedRequestKey);
      const event = this.normalizeEvent(params, {
        callIdOverride: callIdFromQuery,
        dedupeKey,
        turnToken: turnTokenFromQuery,
      });

      // For Twilio, we must return TwiML. Most actions are driven by Calls API updates,
      // so the webhook response is typically a pause to keep the call alive.
      const twiml = this.generateTwimlResponse(ctx);

      return {
        events: event ? [event] : [],
        providerResponseBody: twiml,
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /**
   * Parse Twilio direction to normalized format.
   */
  private static parseDirection(direction: string | null): "inbound" | "outbound" | undefined {
    if (direction === "inbound") {
      return "inbound";
    }
    if (direction === "outbound-api" || direction === "outbound-dial") {
      return "outbound";
    }
    return undefined;
  }

  /**
   * Convert Twilio webhook params to normalized event format.
   */
  private normalizeEvent(
    params: URLSearchParams,
    options?: {
      callIdOverride?: string;
      dedupeKey?: string;
      turnToken?: string;
    },
  ): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";
    const callIdOverride = options?.callIdOverride;

    const baseEvent = {
      id: crypto.randomUUID(),
      dedupeKey: options?.dedupeKey,
      callId: callIdOverride || callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      turnToken: options?.turnToken,
      direction: TwilioProvider.parseDirection(params.get("Direction")),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    // Handle speech result (from <Gather>)
    const speechResult = params.get("SpeechResult");
    if (speechResult) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript: speechResult,
        isFinal: true,
        confidence: parseFloat(params.get("Confidence") || "0.9"),
      };
    }

    // Handle DTMF
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }

    // Handle call status changes
    const callStatus = normalizeProviderStatus(params.get("CallStatus"));
    if (callStatus === "initiated") {
      return { ...baseEvent, type: "call.initiated" };
    }
    if (callStatus === "ringing") {
      return { ...baseEvent, type: "call.ringing" };
    }
    if (callStatus === "in-progress") {
      return { ...baseEvent, type: "call.answered" };
    }

    const endReason = mapProviderStatusToEndReason(callStatus);
    if (endReason) {
      this.streamAuthTokens.delete(callSid);
      this.activeStreamCalls.delete(callSid);
      if (callIdOverride) {
        this.deleteStoredTwiml(callIdOverride);
      }
      return { ...baseEvent, type: "call.ended", reason: endReason };
    }

    return null;
  }

  private static readonly EMPTY_TWIML =
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  private static readonly PAUSE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;

  private static readonly QUEUE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you.</Say>
  <Enqueue waitUrl="/voice/hold-music">hold-queue</Enqueue>
</Response>`;

  /**
   * Generate TwiML response for webhook.
   * When a call is answered, connects to media stream for bidirectional audio.
   */
  private generateTwimlResponse(ctx?: WebhookContext): string {
    if (!ctx) {
      return TwilioProvider.EMPTY_TWIML;
    }

    const view = readTwimlRequestView(ctx);
    const storedTwiml = view.callIdFromQuery
      ? this.twimlStorage.get(view.callIdFromQuery)
      : undefined;
    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: Boolean(storedTwiml),
      isNotifyCall: view.callIdFromQuery ? this.notifyCalls.has(view.callIdFromQuery) : false,
      hasActiveStreams: this.activeStreamCalls.size > 0,
      canStream: Boolean(view.callSid && this.getStreamUrl()),
    });

    if (decision.consumeStoredTwimlCallId) {
      this.deleteStoredTwiml(decision.consumeStoredTwimlCallId);
    }
    if (decision.activateStreamCallSid) {
      this.activeStreamCalls.add(decision.activateStreamCallSid);
    }

    switch (decision.kind) {
      case "stored":
        return storedTwiml ?? TwilioProvider.EMPTY_TWIML;
      case "queue":
        return TwilioProvider.QUEUE_TWIML;
      case "pause":
        return TwilioProvider.PAUSE_TWIML;
      case "stream": {
        const streamUrl = view.callSid ? this.getStreamUrlForCall(view.callSid) : null;
        return streamUrl ? this.getStreamConnectXml(streamUrl) : TwilioProvider.PAUSE_TWIML;
      }
      case "empty":
      default:
        return TwilioProvider.EMPTY_TWIML;
    }
  }

  /**
   * Get the WebSocket URL for media streaming.
   * Derives from the public URL origin + stream path.
   */
  private getStreamUrl(): string | null {
    if (!this.currentPublicUrl || !this.options.streamPath) {
      return null;
    }

    // Extract just the origin (host) from the public URL, ignoring any path
    const url = new URL(this.currentPublicUrl);
    const origin = url.origin;

    // Convert https:// to wss:// for WebSocket
    const wsOrigin = origin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

    // Append the stream path
    const path = this.options.streamPath.startsWith("/")
      ? this.options.streamPath
      : `/${this.options.streamPath}`;

    return `${wsOrigin}${path}`;
  }

  private getStreamAuthToken(callSid: string): string {
    const existing = this.streamAuthTokens.get(callSid);
    if (existing) {
      return existing;
    }
    const token = crypto.randomBytes(16).toString("base64url");
    this.streamAuthTokens.set(callSid, token);
    return token;
  }

  private getStreamUrlForCall(callSid: string): string | null {
    const baseUrl = this.getStreamUrl();
    if (!baseUrl) {
      return null;
    }
    const token = this.getStreamAuthToken(callSid);
    const url = new URL(baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
  }

  /**
   * Generate TwiML to connect a call to a WebSocket media stream.
   * This enables bidirectional audio streaming for real-time STT/TTS.
   *
   * @param streamUrl - WebSocket URL (wss://...) for the media stream
   */
  getStreamConnectXml(streamUrl: string): string {
    // Extract token from URL and pass via <Parameter> instead of query string.
    // Twilio strips query params from WebSocket URLs, but delivers <Parameter>
    // values in the "start" message's customParameters field.
    const parsed = new URL(streamUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    const cleanUrl = parsed.toString();

    const paramXml = token ? `\n      <Parameter name="token" value="${escapeXml(token)}" />` : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(cleanUrl)}">${paramXml}
    </Stream>
  </Connect>
</Response>`;
  }

  /**
   * Initiate an outbound call via Twilio API.
   * If inlineTwiml is provided, uses that directly (for notify mode).
   * Otherwise, uses webhook URL for dynamic TwiML.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    // Create separate URL for status callbacks (required by Twilio)
    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status"); // Differentiate from TwiML requests

    // Store TwiML content if provided (for notify mode)
    // We now serve it from the webhook endpoint instead of sending inline
    if (input.inlineTwiml) {
      this.twimlStorage.set(input.callId, input.inlineTwiml);
      this.notifyCalls.add(input.callId);
    }

    // Build request params - always use URL-based TwiML.
    // Twilio silently ignores `StatusCallback` when using the inline `Twiml` parameter.
    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      Url: url.toString(), // TwiML serving endpoint
      StatusCallback: statusUrl.toString(), // Separate status callback endpoint
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };

    const result = await this.apiRequest<TwilioCallResponse>("/Calls.json", params);

    this.callWebhookUrls.set(result.sid, url.toString());

    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated",
    };
  }

  /**
   * Hang up a call via Twilio API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    this.deleteStoredTwimlForProviderCall(input.providerCallId);

    this.callWebhookUrls.delete(input.providerCallId);
    this.streamAuthTokens.delete(input.providerCallId);
    this.activeStreamCalls.delete(input.providerCallId);

    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true },
    );
  }

  /**
   * Play TTS audio via Twilio.
   *
   * Two modes:
   * 1. Core TTS + Media Streams: when an active stream exists, stream playback is required.
   *    If telephony TTS is unavailable in that state, playback fails rather than mixing paths.
   * 2. TwiML <Say>: fallback only when there is no active stream for the call.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const streamSid = this.callStreamMap.get(input.providerCallId);
    if (streamSid) {
      if (!this.ttsProvider || !this.mediaStreamHandler) {
        throw new Error(
          "Telephony TTS unavailable while media stream is active; refusing TwiML fallback",
        );
      }

      try {
        await this.playTtsViaStream(input.text, streamSid);
        return;
      } catch (err) {
        console.warn(
          `[voice-call] Telephony TTS failed:`,
          err instanceof Error ? err.message : err,
        );
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    // Fall back to TwiML <Say> only when no active stream exists.
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    console.warn(
      "[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active",
    );

    const pollyVoice = mapVoiceToPolly(input.voice);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}" language="${input.locale || "en-US"}">${escapeXml(input.text)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${escapeXml(webhookUrl)}" method="POST">
    <Say>.</Say>
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Generates audio with core TTS, converts to mu-law, and streams via WebSocket.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  private async playTtsViaStream(text: string, streamSid: string): Promise<void> {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }

    // Stream audio in 20ms chunks (160 bytes at 8kHz mu-law)
    const CHUNK_SIZE = 160;
    const CHUNK_DELAY_MS = 20;
    const SILENCE_CHUNK = Buffer.alloc(CHUNK_SIZE, 0xff);

    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;

    const normalizeSendResult = (raw: unknown): StreamSendResult => {
      if (!raw || typeof raw !== "object") {
        return { sent: true };
      }
      const typed = raw as {
        sent?: unknown;
      };
      return {
        sent: typed.sent === undefined ? true : Boolean(typed.sent),
      };
    };

    const sendAudioChunk = (audio: Buffer): StreamSendResult => {
      const raw = (handler as { sendAudio: (sid: string, chunk: Buffer) => unknown }).sendAudio(
        streamSid,
        audio,
      );
      return normalizeSendResult(raw);
    };

    const sendPlaybackMark = (name: string): StreamSendResult => {
      const raw = (handler as { sendMark: (sid: string, markName: string) => unknown }).sendMark(
        streamSid,
        name,
      );
      return normalizeSendResult(raw);
    };

    await handler.queueTts(streamSid, async (signal) => {
      const sendKeepAlive = () => {
        sendAudioChunk(SILENCE_CHUNK);
      };
      sendKeepAlive();
      const keepAlive = setInterval(() => {
        if (!signal.aborted) {
          sendKeepAlive();
        }
      }, CHUNK_DELAY_MS);

      // Generate audio with core TTS (returns mu-law at 8kHz)
      let muLawAudio: Buffer;
      let synthTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const synthPromise = ttsProvider.synthesizeForTelephony(text);
        const timeoutPromise = new Promise<Buffer>((_, reject) => {
          synthTimeout = setTimeout(() => {
            reject(
              new Error(
                `Telephony TTS synthesis timed out after ${TwilioProvider.TTS_SYNTH_TIMEOUT_MS}ms`,
              ),
            );
          }, TwilioProvider.TTS_SYNTH_TIMEOUT_MS);
        });
        muLawAudio = await Promise.race([synthPromise, timeoutPromise]);
      } finally {
        if (synthTimeout) {
          clearTimeout(synthTimeout);
        }
        clearInterval(keepAlive);
      }

      let chunkAttempts = 0;
      let chunkDelivered = 0;
      let nextChunkDueAt = Date.now() + CHUNK_DELAY_MS;
      for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
        if (signal.aborted) {
          break;
        }
        chunkAttempts += 1;
        const chunkResult = sendAudioChunk(chunk);
        if (chunkResult.sent) {
          chunkDelivered += 1;
        }

        // Drift-corrected pacing: schedule against an absolute clock to avoid cumulative delay.
        const waitMs = nextChunkDueAt - Date.now();
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
        }
        nextChunkDueAt += CHUNK_DELAY_MS;
        if (signal.aborted) {
          break;
        }
      }

      let markSent = true;
      if (!signal.aborted) {
        // Send a mark to track when audio finishes
        markSent = sendPlaybackMark(`tts-${Date.now()}`).sent;
      }

      if (!signal.aborted && chunkAttempts > 0 && (chunkDelivered === 0 || !markSent)) {
        const failures: string[] = [];
        if (chunkDelivered === 0) {
          failures.push("no audio chunks delivered");
        }
        if (!markSent) {
          failures.push("completion mark not delivered");
        }
        throw new Error(`Telephony stream playback failed: ${failures.join("; ")}`);
      }
    });
  }

  /**
   * Start listening for speech via Twilio <Gather>.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    const actionUrl = new URL(webhookUrl);
    if (input.turnToken) {
      actionUrl.searchParams.set("turnToken", input.turnToken);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" language="${input.language || "en-US"}" action="${escapeXml(actionUrl.toString())}" method="POST">
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  /**
   * Stop listening - for Twilio this is a no-op as <Gather> auto-ends.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // Twilio's <Gather> automatically stops on speech end
    // No explicit action needed
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const data = await guardedJsonApiRequest<{ status?: string }>({
        url: `${this.baseUrl}/Calls/${input.providerCallId}.json`,
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        },
        allowNotFound: true,
        allowedHostnames: ["api.twilio.com"],
        auditContext: "twilio-get-call-status",
        errorPrefix: "Twilio get call status error",
      });

      if (!data) {
        return { status: "not-found", isTerminal: true };
      }

      const status = normalizeProviderStatus(data.status);
      return { status, isTerminal: isProviderStatusTerminal(status) };
    } catch {
      // Transient error — keep the call and rely on timer fallback
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
}

// -----------------------------------------------------------------------------
// Twilio-specific types
// -----------------------------------------------------------------------------

interface TwilioCallResponse {
  sid: string;
  status: string;
  direction: string;
  from: string;
  to: string;
  uri: string;
}
