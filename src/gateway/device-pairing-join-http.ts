// Public single-use exchange for device-pairing join codes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { redeemDevicePairingJoinCode } from "../infra/device-pairing-join-code.js";
import { isDevicePairingJoinCode } from "../pairing/join-code.js";
import { AUTH_RATE_LIMIT_SCOPE_DEVICE_JOIN, type AuthRateLimiter } from "./auth-rate-limit.js";
import { sendJson } from "./http-common.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";

const NOT_FOUND_BODY = { error: "not_found" } as const;

function sendJoinNotFound(res: ServerResponse): void {
  sendJson(res, 404, NOT_FOUND_BODY);
}

/** Handle the core-owned /j namespace before hooks, plugins, and the Control UI SPA. */
export async function handleDevicePairingJoinHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  shortcode: string;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  params.res.setHeader("Cache-Control", "no-store");

  await withSerializedRateLimitAttempt({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_DEVICE_JOIN,
    run: async () => {
      const rateCheck = params.rateLimiter?.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_DEVICE_JOIN,
      );
      if (rateCheck && !rateCheck.allowed) {
        if (rateCheck.retryAfterMs > 0) {
          params.res.setHeader("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
        }
        sendJson(params.res, 429, { error: "rate_limited" });
        return;
      }

      const validRequest =
        params.req.method === "GET" && !parsed?.search && isDevicePairingJoinCode(params.shortcode);
      const payload = validRequest
        ? redeemDevicePairingJoinCode({ shortcode: params.shortcode })
        : null;
      if (!payload) {
        params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_JOIN);
        sendJoinNotFound(params.res);
        return;
      }

      params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_JOIN);
      sendJson(params.res, 200, payload);
    },
  });
  return true;
}
