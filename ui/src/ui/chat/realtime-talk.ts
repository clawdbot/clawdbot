import type { GatewayBrowserClient } from "../gateway.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import {
  type RealtimeTalkCallbacks,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkJsonPcmWebSocketSessionResult,
  type RealtimeTalkSessionResult,
  type RealtimeTalkStatus,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export type { RealtimeTalkCallbacks, RealtimeTalkSessionResult, RealtimeTalkStatus };

function createTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveTransport(session);
  if (transport === "webrtc-sdp") {
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "json-pcm-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  if (transport === "managed-room") {
    throw new Error("Managed-room realtime Talk sessions are not available in this UI yet");
  }
  const unknownTransport = (session as { transport?: string }).transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}

function resolveTransport(session: RealtimeTalkSessionResult): string {
  if (session.transport) {
    return session.transport;
  }
  const raw = session as {
    provider?: string;
    protocol?: string;
    websocketUrl?: string;
  };
  const provider = raw.provider?.trim().toLowerCase();
  if (provider === "google" && (raw.protocol === "google-live-bidi" || raw.websocketUrl)) {
    return "json-pcm-websocket";
  }
  if (provider === "google") {
    throw new Error(buildGoogleWebRtcUnsupportedMessage());
  }
  return "webrtc-sdp";
}

function buildGoogleWebRtcUnsupportedMessage(): string {
  return [
    'Realtime voice provider "google" does not support browser WebRTC sessions.',
    "Control UI Talk can use Google through the gateway relay or a Google Live WebSocket session instead.",
    'Restart the gateway so it returns "gateway-relay" or "json-pcm-websocket", or switch Talk realtime to a WebRTC-capable provider such as OpenAI.',
  ].join(" ");
}

export class RealtimeTalkSession {
  private transport: RealtimeTalkTransport | null = null;
  private closed = false;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    const session = await this.client.request<RealtimeTalkSessionResult>("talk.realtime.session", {
      sessionKey: this.sessionKey,
    });
    if (this.closed) {
      return;
    }
    this.transport = createTransport(session, {
      client: this.client,
      sessionKey: this.sessionKey,
      callbacks: this.callbacks,
    });
    await this.transport.start();
  }

  stop(): void {
    this.closed = true;
    this.callbacks.onStatus?.("idle");
    this.transport?.stop();
    this.transport = null;
  }
}
