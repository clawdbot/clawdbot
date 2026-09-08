import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER, type AuthRateLimiter } from "../auth-rate-limit.js";
import { sendJson, watchClientDisconnect } from "../http-common.js";
import { withSerializedRateLimitAttempt } from "../rate-limit-attempt-serialization.js";
import type { ArtifactTransferService } from "./artifact-transfer-service.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ArtifactTransferHttpCallback = (params: {
  req: IncomingMessage;
  res: ServerResponse;
  artifactKey: string;
  bearer: string;
}) => Promise<
  { kind: "unauthorized" } | { kind: "authorized"; handle: () => Promise<void> | void }
>;

export type ArtifactTransferHttpRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
};

function sendOpaqueNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

export async function handleArtifactTransferHttpRequest(
  params: ArtifactTransferHttpRequest & {
    classifyPath: (pathname: string) => "namespace" | "outside";
    routePrefix: string;
    callback?: ArtifactTransferHttpCallback;
  },
): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  if (!parsed || params.classifyPath(parsed.pathname) === "outside") {
    return false;
  }
  params.res.setHeader("Cache-Control", "no-store");
  const prefix = params.routePrefix;
  const artifactKey = parsed.pathname.startsWith(prefix)
    ? parsed.pathname.slice(prefix.length)
    : "";
  if (
    params.req.method !== "GET" ||
    !SHA256_PATTERN.test(artifactKey) ||
    parsed.search ||
    parsed.hash
  ) {
    sendOpaqueNotFound(params.res);
    return true;
  }
  const authorization = normalizeOptionalString(params.req.headers.authorization);
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? normalizeOptionalString(authorization.slice(7))
    : undefined;
  const admission = await withSerializedRateLimitAttempt<
    | { kind: "rate-limited"; retryAfterMs: number }
    | Awaited<ReturnType<ArtifactTransferHttpCallback>>
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
          ? await params.callback({ req: params.req, res: params.res, artifactKey, bearer })
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

export function createArtifactTransferHttpCallback(
  service: Omit<ArtifactTransferService, "prepare">,
): ArtifactTransferHttpCallback {
  return async ({ req, res, artifactKey, bearer }) => {
    const authorization = service.authorize({ token: bearer, artifactKey });
    if (!authorization) {
      return { kind: "unauthorized" };
    }
    return {
      kind: "authorized",
      handle: async () => {
        const clientAbort = new AbortController();
        const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort);
        const signal = AbortSignal.any([
          service.authorizationSignal(authorization),
          clientAbort.signal,
        ]);
        let fileHandle: FileHandle | undefined;
        try {
          const file = await service.openFile(authorization);
          fileHandle = file?.handle;
          if (!file || signal.aborted || !service.isAuthorizationCurrent(authorization)) {
            sendOpaqueNotFound(res);
            return;
          }
          const checkAuthority = new Transform({
            transform(chunk: Buffer, _encoding, next) {
              next(
                service.isAuthorizationCurrent(authorization)
                  ? null
                  : new Error("Worker artifact transfer authority closed"),
                chunk,
              );
            },
          });
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(file.bytes),
            "x-openclaw-content-sha256": file.sha256,
          });
          // An extra EOF read can outlive the client's Content-Length-complete response
          // and let owner revocation destroy its reused keep-alive socket.
          const stream = file.handle.createReadStream({
            start: 0,
            end: file.bytes - 1,
            autoClose: false,
          });
          await pipeline(stream, checkAuthority, res, { signal });
        } catch {
          if (!res.headersSent && !res.destroyed) {
            sendOpaqueNotFound(res);
          } else if (!res.destroyed) {
            res.destroy();
          }
        } finally {
          stopWatchingDisconnect();
          service.revoke(authorization);
          await fileHandle?.close();
        }
      },
    };
  };
}
