import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { NODE_WORKER_BUNDLE_TRANSFER_PATH } from "../../worker/node-bundle-install-protocol.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER, type AuthRateLimiter } from "../auth-rate-limit.js";
import { classifyNodeWorkerBundleTransferPath } from "../gateway-http-route-contracts.js";
import { sendJson, watchClientDisconnect } from "../http-common.js";
import { withSerializedRateLimitAttempt } from "../rate-limit-attempt-serialization.js";
import type { NodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_NOT_FOUND = { error: "not_found" } as const;

type NodeWorkerBundleTransferHttpCallbackResult =
  | { kind: "unauthorized" }
  | { kind: "authorized"; handle: () => Promise<void> | void };

export type NodeWorkerBundleTransferHttpCallback = (params: {
  req: IncomingMessage;
  res: ServerResponse;
  bundleHash: string;
  bearer: string;
}) => Promise<NodeWorkerBundleTransferHttpCallbackResult>;

function parseRoute(pathname: string, method: string | undefined): string | undefined {
  if (method !== "GET" || !pathname.startsWith(`${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/`)) {
    return undefined;
  }
  const hash = pathname.slice(`${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/`.length);
  return SHA256_PATTERN.test(hash) ? hash : undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = normalizeOptionalString(req.headers.authorization);
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return normalizeOptionalString(authorization.slice(7));
}

function sendOpaqueNotFound(res: ServerResponse): void {
  sendJson(res, 404, OPAQUE_NOT_FOUND);
}

export async function handleNodeWorkerBundleTransferHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
  callback?: NodeWorkerBundleTransferHttpCallback;
}): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  if (!parsed?.pathname || classifyNodeWorkerBundleTransferPath(parsed.pathname) === "outside") {
    return false;
  }
  params.res.setHeader("Cache-Control", "no-store");
  const bundleHash = parseRoute(parsed.pathname, params.req.method);
  if (!bundleHash || parsed.search) {
    sendOpaqueNotFound(params.res);
    return true;
  }
  const bearer = bearerToken(params.req);
  const admission = await withSerializedRateLimitAttempt<
    | { kind: "rate-limited"; retryAfterMs: number }
    | { kind: "unauthorized" }
    | Extract<NodeWorkerBundleTransferHttpCallbackResult, { kind: "authorized" }>
  >({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER,
    run: async () => {
      const rateCheck = params.rateLimiter?.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER,
      );
      if (rateCheck && !rateCheck.allowed) {
        return { kind: "rate-limited", retryAfterMs: rateCheck.retryAfterMs };
      }
      const outcome =
        bearer && params.callback
          ? await params.callback({ req: params.req, res: params.res, bundleHash, bearer })
          : ({ kind: "unauthorized" } as const);
      if (outcome.kind === "unauthorized") {
        params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      } else {
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      }
      return outcome;
    },
  });
  if (admission.kind === "rate-limited") {
    if (admission.retryAfterMs > 0) {
      params.res.setHeader("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
    }
    sendJson(params.res, 429, { error: "rate_limited" });
    return true;
  }
  if (admission.kind === "unauthorized") {
    sendOpaqueNotFound(params.res);
    return true;
  }
  await admission.handle();
  return true;
}

export function createNodeWorkerBundleTransferHttpCallback(
  service: NodeWorkerBundleTransferService,
): NodeWorkerBundleTransferHttpCallback {
  return async ({ req, res, bundleHash, bearer }) => {
    const authorization = service.authorize({ token: bearer, bundleHash });
    if (!authorization) {
      return { kind: "unauthorized" };
    }
    return {
      kind: "authorized",
      handle: async () => {
        const clientAbort = new AbortController();
        const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort);
        const timeoutMs = Math.max(1, authorization.expiresAtMs - Date.now());
        const signal = AbortSignal.any([
          service.authorizationSignal(authorization),
          clientAbort.signal,
          AbortSignal.timeout(timeoutMs),
        ]);
        try {
          const file = await service.file(authorization);
          if (!file || signal.aborted || !service.isAuthorizationCurrent(authorization)) {
            sendOpaqueNotFound(res);
            return;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(file.bytes),
            "x-openclaw-content-sha256": file.sha256,
          });
          await pipeline(fs.createReadStream(file.path), res, { signal });
        } catch (error) {
          if (!signal.aborted && !res.destroyed) {
            throw error;
          }
        } finally {
          stopWatchingDisconnect();
          service.revoke(authorization);
        }
      },
    };
  };
}
