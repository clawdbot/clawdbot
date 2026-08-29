import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { type RawData, WebSocket } from "ws";
import type {
  AnswerCallInput,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  SendDtmfInput,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { RealtimeCallHandler } from "../webhook/realtime-handler.js";
import { AsteriskAriClient } from "./asterisk-ari.js";
import {
  AsteriskAudioSocketServer,
  type AsteriskAudioSocketSession,
} from "./asterisk-audiosocket.js";
import {
  type AriChannel,
  type AriEvent,
  type AsteriskCallMetadata,
  type AsteriskEventDetails,
  buildAsteriskNormalizedEvent,
  mapAsteriskHangupCause,
  normalizeAsteriskState,
  parseAsteriskAriEvent,
} from "./asterisk-events.js";
import type { VoiceCallProvider } from "./base.js";

const AUDIO_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const ARI_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

type AsteriskProviderConfig = {
  baseUrl?: string;
  username?: string;
  password?: string;
  application?: string;
  endpoint?: string;
  audioSocket?: {
    bind?: string;
    host?: string;
    port?: number;
  };
};

type AsteriskProviderOptions = {
  ringTimeoutSec?: number;
};

type AsteriskMediaResources = {
  bridgeId: string;
  mediaChannelId: string;
};

export type AsteriskRealtimeHandler = {
  attachTelephonyStream: RealtimeCallHandler["attachTelephonyStream"];
  speak(callId: string, instructions: string): { success: boolean; error?: string };
};

type AudioSocketReadyWaiter = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  cancel: () => void;
};

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

export class AsteriskProvider implements VoiceCallProvider {
  readonly name = "asterisk" as const;

  private readonly ari: AsteriskAriClient;
  private readonly endpointTemplate: string;
  private readonly audioSocketHost: string;
  private readonly ringTimeoutSec: number;
  private readonly audioSocketServer: AsteriskAudioSocketServer;
  private readonly callsByProviderId = new Map<string, AsteriskCallMetadata>();
  private readonly providerIdByCallId = new Map<string, string>();
  private readonly mediaSetups = new Map<string, Promise<AsteriskMediaResources>>();
  private readonly mediaChannelIds = new Set<string>();
  private readonly answeredProviderCallIds = new Set<string>();
  private eventSocket: WebSocket | null = null;
  private eventSink: ((event: NormalizedEvent) => void) | null = null;
  private readonly audioSocketReadyWaiters = new Map<string, AudioSocketReadyWaiter>();
  private realtimeHandler: AsteriskRealtimeHandler | null = null;
  private eventQueue = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopping = false;
  private reconnectEnabled = false;

  constructor(config: AsteriskProviderConfig, options: AsteriskProviderOptions = {}) {
    if (!config.endpoint) {
      throw new Error("Asterisk endpoint template is required");
    }
    if (!config.endpoint.includes("{number}")) {
      throw new Error('Asterisk endpoint template must contain the "{number}" placeholder');
    }

    const audioSocket = {
      bind: config.audioSocket?.bind ?? "127.0.0.1",
      host: config.audioSocket?.host ?? "127.0.0.1",
      port: config.audioSocket?.port ?? 3335,
    };
    this.ari = new AsteriskAriClient(config);
    this.endpointTemplate = config.endpoint;
    this.audioSocketHost = `${audioSocket.host}:${audioSocket.port}`;
    this.ringTimeoutSec = options.ringTimeoutSec ?? 30;
    this.audioSocketServer = new AsteriskAudioSocketServer(
      { bind: audioSocket.bind, port: audioSocket.port },
      (session) => this.attachAudioSocketSession(session),
    );
  }

  setRealtimeHandler(handler: AsteriskRealtimeHandler): void {
    this.realtimeHandler = handler;
  }

  async startEventListener(onEvent: (event: NormalizedEvent) => void): Promise<void> {
    if (this.eventSink) {
      return;
    }
    this.eventSink = onEvent;
    this.stopping = false;
    try {
      await this.audioSocketServer.start();
      await this.connectEventSocket();
      this.reconnectEnabled = true;
    } catch (error) {
      this.eventSink = null;
      await this.audioSocketServer.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.eventSocket;
    this.eventSocket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
    for (const waiter of this.audioSocketReadyWaiters.values()) {
      waiter.reject(new Error("Asterisk provider is stopping"));
    }
    await this.eventQueue;
    await this.audioSocketServer.stop();
    this.eventSink = null;
  }

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return {
      ok: false,
      reason: "Asterisk events are accepted only from the authenticated ARI WebSocket",
    };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 405 };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (input.mode === "notify" || input.inlineTwiml) {
      throw new Error(
        "Asterisk AudioSocket supports conversation mode only; notify-mode TwiML is not supported",
      );
    }
    if (input.preConnectTwiml) {
      throw new Error(
        "Asterisk AudioSocket does not support pre-connect TwiML; send DTMF after the call answers",
      );
    }

    const metadata: AsteriskCallMetadata = {
      callId: input.callId,
      providerCallId: input.callId,
      direction: "outbound",
      from: input.from,
      to: input.to,
    };
    this.rememberCall(metadata);
    const endpoint = this.endpointTemplate.replaceAll("{number}", input.to);
    try {
      await this.ari.request<AriChannel>("POST", `/channels/${encodeURIComponent(input.callId)}`, {
        endpoint,
        app: this.ari.application,
        appArgs: `openclaw,outbound,${input.callId}`,
        callerId: input.from,
        timeout: String(this.ringTimeoutSec),
        formats: "slin",
      });
      return { providerCallId: input.callId, status: "initiated" };
    } catch (error) {
      this.forgetCall(input.callId);
      await this.ari
        .deleteResource(`/channels/${encodeURIComponent(input.callId)}`)
        .catch(() => undefined);
      throw error;
    }
  }

  async answerCall(input: AnswerCallInput): Promise<void> {
    const existing = this.callsByProviderId.get(input.providerCallId);
    if (existing) {
      this.providerIdByCallId.delete(existing.callId);
      existing.callId = input.callId;
      this.providerIdByCallId.set(input.callId, input.providerCallId);
    } else {
      this.rememberCall({
        callId: input.callId,
        providerCallId: input.providerCallId,
        direction: "inbound",
      });
    }
    await this.ari.request("POST", `/channels/${encodeURIComponent(input.providerCallId)}/answer`);
    await this.ensureMediaBridge(input.callId, input.providerCallId);
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.ari.deleteResource(`/channels/${encodeURIComponent(input.providerCallId)}`);
    await this.cleanupMedia(input.providerCallId);
    this.forgetCall(input.providerCallId);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const result = this.realtimeHandler?.speak(input.callId, input.text);
    if (!result?.success) {
      throw new Error(result?.error ?? "Asterisk realtime bridge is not active");
    }
  }

  async sendDtmf(input: SendDtmfInput): Promise<void> {
    await this.ari.request("POST", `/channels/${encodeURIComponent(input.providerCallId)}/dtmf`, {
      dtmf: input.digits,
    });
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    if (!this.realtimeHandler) {
      throw new Error("Asterisk realtime handler is not configured");
    }
  }

  async stopListening(_input: StopListeningInput): Promise<void> {}

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const channel = await this.ari.request<AriChannel | undefined>(
        "GET",
        `/channels/${encodeURIComponent(input.providerCallId)}`,
        undefined,
        true,
      );
      if (!channel) {
        return { status: "not-found", isTerminal: true };
      }
      const state = channel.state ?? "unknown";
      return {
        status: state,
        isTerminal: state.toLowerCase() === "busy",
      };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }

  private async connectEventSocket(): Promise<void> {
    const socket = this.ari.createEventSocket();
    this.eventSocket = socket;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.once("open", () => {
        opened = true;
        this.reconnectAttempt = 0;
        resolve();
      });
      socket.on("message", (data) => {
        const raw = rawDataToBuffer(data);
        this.eventQueue = this.eventQueue
          .then(async () => {
            await this.handleEventMessage(raw);
          })
          .catch((error: unknown) => {
            console.error(`[voice-call] Asterisk ARI event failed: ${formatErrorMessage(error)}`);
          });
      });
      socket.on("error", (error) => {
        if (!opened) {
          socket.terminate();
          reject(new Error(`Asterisk ARI WebSocket failed: ${error.message}`, { cause: error }));
          return;
        }
        console.error(`[voice-call] Asterisk ARI WebSocket error: ${error.message}`);
      });
      socket.once("close", () => {
        if (this.eventSocket === socket) {
          this.eventSocket = null;
        }
        if (!opened) {
          reject(new Error("Asterisk ARI WebSocket closed before opening"));
        } else if (this.reconnectEnabled && !this.stopping) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.reconnectEnabled) {
      return;
    }
    const delay =
      ARI_RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, ARI_RECONNECT_DELAYS_MS.length - 1)
      ] ?? 30_000;
    this.reconnectAttempt += 1;
    console.warn(`[voice-call] Asterisk ARI events disconnected; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectEventSocket().catch((error: unknown) => {
        console.error(
          `[voice-call] Asterisk ARI event reconnect failed: ${formatErrorMessage(error)}`,
        );
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async handleEventMessage(raw: Buffer): Promise<void> {
    const event = parseAsteriskAriEvent(raw);
    if (event.application && event.application !== this.ari.application) {
      return;
    }
    if (event.type === "ApplicationReplaced") {
      this.reconnectEnabled = false;
      console.error(
        `[voice-call] Asterisk ARI application "${this.ari.application}" was replaced by another connection`,
      );
      this.eventSocket?.close(1000, "ARI application replaced");
      return;
    }

    const channel = event.channel ?? event.peer;
    if (!channel?.id || this.isMediaChannel(channel.id)) {
      return;
    }
    if (event.type === "StasisStart") {
      await this.handleStasisStart(channel, event);
      return;
    }
    const metadata = this.callsByProviderId.get(channel.id);
    if (!metadata) {
      return;
    }

    if (event.type === "ChannelStateChange") {
      const eventType = normalizeAsteriskState(channel.state);
      if (eventType === "call.answered") {
        await this.attachMediaAndEmitAnswered(metadata, event);
      } else if (eventType === "call.ended") {
        this.emit(metadata, event, { type: "call.ended", reason: "busy" });
      } else if (eventType) {
        this.emit(metadata, event, { type: eventType });
      }
      return;
    }
    if (event.type === "Dial") {
      await this.handleDialEvent(metadata, event);
      return;
    }
    if (event.type === "ChannelDtmfReceived" && event.digit) {
      this.emit(metadata, event, { type: "call.dtmf", digits: event.digit });
      return;
    }
    if (event.type === "ChannelDestroyed") {
      this.emit(metadata, event, {
        type: "call.ended",
        reason: mapAsteriskHangupCause(event.cause),
      });
      await this.cleanupMedia(metadata.providerCallId);
      this.forgetCall(metadata.providerCallId);
    }
  }

  private async handleStasisStart(channel: AriChannel, event: AriEvent): Promise<void> {
    let metadata = this.callsByProviderId.get(channel.id);
    if (!metadata) {
      metadata = {
        callId: channel.id,
        providerCallId: channel.id,
        direction: "inbound",
        from: channel.caller?.number,
        to: channel.dialplan?.exten ?? channel.connected?.number,
      };
      this.rememberCall(metadata);
      this.emit(metadata, event, { type: "call.initiated" });
      return;
    }
    if (metadata.direction === "outbound" && channel.state?.toLowerCase() === "up") {
      await this.attachMediaAndEmitAnswered(metadata, event);
    }
  }

  private async handleDialEvent(metadata: AsteriskCallMetadata, event: AriEvent): Promise<void> {
    switch (event.dialstatus?.toUpperCase()) {
      case "RINGING":
      case "PROGRESS":
      case "PROCEEDING":
        this.emit(metadata, event, { type: "call.ringing" });
        return;
      case "ANSWER":
        await this.attachMediaAndEmitAnswered(metadata, event);
        return;
      case "BUSY":
        this.emit(metadata, event, { type: "call.ended", reason: "busy" });
        return;
      case "NOANSWER":
        this.emit(metadata, event, { type: "call.ended", reason: "no-answer" });
        return;
      case "CANCEL":
        this.emit(metadata, event, { type: "call.ended", reason: "hangup-user" });
        return;
      case "CONGESTION":
      case "CHANUNAVAIL":
        this.emit(metadata, event, { type: "call.ended", reason: "failed" });
        break;
      default:
        break;
    }
  }

  private async attachMediaAndEmitAnswered(
    metadata: AsteriskCallMetadata,
    event: AriEvent,
  ): Promise<void> {
    if (this.answeredProviderCallIds.has(metadata.providerCallId)) {
      return;
    }
    try {
      await this.ensureMediaBridge(metadata.callId, metadata.providerCallId);
      if (this.answeredProviderCallIds.has(metadata.providerCallId)) {
        return;
      }
      this.answeredProviderCallIds.add(metadata.providerCallId);
      this.emit(metadata, event, { type: "call.answered" });
    } catch (error) {
      this.emit(metadata, event, {
        type: "call.error",
        error: `Asterisk AudioSocket setup failed: ${formatErrorMessage(error)}`,
        retryable: false,
      });
    }
  }

  private emit(
    metadata: AsteriskCallMetadata,
    event: AriEvent,
    details: AsteriskEventDetails,
  ): void {
    this.eventSink?.(buildAsteriskNormalizedEvent({ metadata, event, details }));
  }

  private rememberCall(metadata: AsteriskCallMetadata): void {
    this.callsByProviderId.set(metadata.providerCallId, metadata);
    this.providerIdByCallId.set(metadata.callId, metadata.providerCallId);
  }

  private forgetCall(providerCallId: string): void {
    const metadata = this.callsByProviderId.get(providerCallId);
    if (metadata) {
      this.providerIdByCallId.delete(metadata.callId);
    }
    this.callsByProviderId.delete(providerCallId);
    this.answeredProviderCallIds.delete(providerCallId);
  }

  private isMediaChannel(channelId: string): boolean {
    return this.mediaChannelIds.has(channelId);
  }

  private attachAudioSocketSession(session: AsteriskAudioSocketSession) {
    const providerCallId = this.providerIdByCallId.get(session.callId);
    const metadata = providerCallId ? this.callsByProviderId.get(providerCallId) : undefined;
    const handler = this.realtimeHandler;
    if (!metadata || !handler) {
      return null;
    }
    const stream = handler.attachTelephonyStream({
      streamId: `asterisk-audiosocket:${session.callId}`,
      providerCallId: metadata.providerCallId,
      socket: session.carrier,
      adapter: session.adapter,
      callId: metadata.callId,
      from: metadata.from,
      to: metadata.to,
      direction: metadata.direction,
    });
    if (!stream) {
      return null;
    }
    this.audioSocketReadyWaiters.get(session.callId)?.resolve();
    return { stream, onDtmf: () => {} };
  }

  private ensureMediaBridge(
    callId: string,
    providerCallId: string,
  ): Promise<AsteriskMediaResources> {
    const existing = this.mediaSetups.get(providerCallId);
    if (existing) {
      return existing;
    }
    const setup = this.createMediaBridge(callId, providerCallId).catch((error: unknown) => {
      this.mediaSetups.delete(providerCallId);
      throw error;
    });
    this.mediaSetups.set(providerCallId, setup);
    return setup;
  }

  private async createMediaBridge(
    callId: string,
    providerCallId: string,
  ): Promise<AsteriskMediaResources> {
    const bridgeId = crypto.randomUUID();
    const mediaChannelId = crypto.randomUUID();
    this.mediaChannelIds.add(mediaChannelId);
    let bridgeCreated = false;
    let mediaCreated = false;
    let audioReady: AudioSocketReadyWaiter | undefined;
    try {
      await this.ari.request("POST", `/bridges/${bridgeId}`, {
        type: "mixing",
        name: `openclaw-${callId}`,
      });
      bridgeCreated = true;
      await this.ari.request("POST", `/bridges/${bridgeId}/addChannel`, {
        channel: providerCallId,
      });
      audioReady = this.createAudioSocketReadyWaiter(callId);
      await this.ari.request<AriChannel>("POST", "/channels/externalMedia", {
        channelId: mediaChannelId,
        app: this.ari.application,
        external_host: this.audioSocketHost,
        encapsulation: "audiosocket",
        transport: "tcp",
        connection_type: "client",
        format: "slin",
        direction: "both",
        data: callId,
      });
      mediaCreated = true;
      await this.ari.request("POST", `/bridges/${bridgeId}/addChannel`, {
        channel: mediaChannelId,
      });
      await audioReady.promise;
      return { bridgeId, mediaChannelId };
    } catch (error) {
      this.mediaChannelIds.delete(mediaChannelId);
      const cleanupErrors: unknown[] = [];
      if (mediaCreated) {
        await this.ari
          .deleteResource(`/channels/${mediaChannelId}`)
          .catch((cleanupError: unknown) => {
            cleanupErrors.push(cleanupError);
          });
      }
      if (bridgeCreated) {
        await this.ari.deleteResource(`/bridges/${bridgeId}`).catch((cleanupError: unknown) => {
          cleanupErrors.push(cleanupError);
        });
      }
      if (cleanupErrors.length > 0) {
        const cleanupMessage = cleanupErrors.map(formatErrorMessage).join("; ");
        throw new Error(`Asterisk media setup failed and cleanup also failed: ${cleanupMessage}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      audioReady?.cancel();
    }
  }

  private createAudioSocketReadyWaiter(callId: string): AudioSocketReadyWaiter {
    const existing = this.audioSocketReadyWaiters.get(callId);
    existing?.cancel();
    let settled = false;
    let resolvePromise: () => void = () => {};
    let rejectPromise: (error: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      this.audioSocketReadyWaiters.delete(callId);
      rejectPromise(
        new Error(
          `Asterisk did not connect AudioSocket within ${AUDIO_SOCKET_CONNECT_TIMEOUT_MS}ms`,
        ),
      );
    }, AUDIO_SOCKET_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    const waiter: AudioSocketReadyWaiter = {
      promise,
      resolve: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.audioSocketReadyWaiters.delete(callId);
        resolvePromise();
      },
      reject: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.audioSocketReadyWaiters.delete(callId);
        rejectPromise(error);
      },
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.audioSocketReadyWaiters.delete(callId);
      },
    };
    this.audioSocketReadyWaiters.set(callId, waiter);
    return waiter;
  }

  private async cleanupMedia(providerCallId: string): Promise<void> {
    const setup = this.mediaSetups.get(providerCallId);
    this.mediaSetups.delete(providerCallId);
    if (!setup) {
      return;
    }
    let resources: AsteriskMediaResources;
    try {
      resources = await setup;
    } catch {
      return;
    }
    this.mediaChannelIds.delete(resources.mediaChannelId);
    const results = await Promise.allSettled([
      this.ari.deleteResource(`/channels/${resources.mediaChannelId}`),
      this.ari.deleteResource(`/bridges/${resources.bridgeId}`),
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Asterisk media cleanup failed", { cause: errors[0] });
    }
  }
}
