import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type {
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkSessionResult,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
  RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export function createRealtimeTalkTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveRealtimeTalkTransport(session);
  if (transport === "webrtc") {
    // SAFETY: The normalized transport selects the Gateway's WebRTC session payload.
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      // SAFETY: The normalized transport selects the Gateway's provider-WebSocket payload.
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      // SAFETY: The normalized transport selects the Gateway's relay session payload.
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  const unknownTransport = session.transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}

export function resolveRealtimeTalkTransport(session: RealtimeTalkSessionResult): string {
  return normalizeTalkTransport(session.transport) ?? "webrtc";
}
