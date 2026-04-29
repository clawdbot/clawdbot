import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { VOICECLAW_REALTIME_PATH } from "./paths.js";
import { VoiceClawRealtimeSession } from "./session.js";

export { VOICECLAW_REALTIME_PATH };

export const VOICECLAW_REALTIME_MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: VOICECLAW_REALTIME_MAX_PAYLOAD_BYTES,
});

export function handleVoiceClawRealtimeUpgrade(opts: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  auth: ResolvedGatewayAuth;
  config: OpenClawConfig;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  releasePreauthBudget: () => void;
}): void {
  wss.handleUpgrade(opts.req, opts.socket, opts.head, (ws) => {
    const session = new VoiceClawRealtimeSession({
      ws,
      req: opts.req,
      auth: opts.auth,
      config: opts.config,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      releasePreauthBudget: opts.releasePreauthBudget,
    });
    session.attach();
  });
}
