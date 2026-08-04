import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "../../config/types.js";
import { isLocalDirectRequest } from "../net.js";
import { checkBrowserOrigin, normalizeChromeExtensionOrigin } from "../origin-check.js";

const HTTP_FORBIDDEN = 403;

type GatewayVerifyClientParams = {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  getConfigSnapshot: () => OpenClawConfig;
};

/**
 * Pre-handshake WebSocket origin gate. Runs in `verifyClient` (before the HTTP
 * 101) and reuses the existing `checkBrowserOrigin` from the post-handshake
 * admission path, so both gates share one origin-policy contract.
 * Locality uses the canonical `isLocalDirectRequest` helper with the same
 * trusted-proxy inputs as the post-handshake admission path, so loopback
 * requests carrying forwarded/proxy headers are not treated as direct-local
 * clients. Non-browser clients send no Origin and pass through; they
 * authenticate post-handshake. Canonical Chrome extension (browser copilot)
 * origins also pass through; the post-handshake admission path skips its
 * generic origin check for them (`hasCopilotExtensionOrigin`) and validates
 * the exact origin against the paired device.
 */
export function createGatewayVerifyClient(params: GatewayVerifyClientParams) {
  const { log, getConfigSnapshot } = params;

  return (
    info: { origin: string; req: IncomingMessage },
    callback: (r: boolean, code?: number, msg?: string) => void,
  ) => {
    const { req } = info;
    const snapshot = getConfigSnapshot();
    const controlUi = snapshot.gateway?.controlUi;
    const requestOrigin = info.origin?.slice(0, 256);

    if (!requestOrigin || normalizeChromeExtensionOrigin(requestOrigin)) {
      callback(true);
      return;
    }

    const originCheck = checkBrowserOrigin({
      requestHost: req.headers.host?.slice(0, 256),
      origin: requestOrigin,
      allowedOrigins: controlUi?.allowedOrigins,
      allowHostHeaderOriginFallback: controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
      isLocalClient: isLocalDirectRequest(
        req,
        snapshot.gateway?.trustedProxies,
        snapshot.gateway?.allowRealIpFallback === true,
      ),
    });

    if (!originCheck.ok) {
      log.warn(`verifyClient: origin not allowed (${originCheck.reason})`);
      callback(false, HTTP_FORBIDDEN, "origin not allowed");
      return;
    }

    callback(true);
  };
}
