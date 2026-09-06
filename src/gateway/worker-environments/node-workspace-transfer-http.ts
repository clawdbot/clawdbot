import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { NODE_WORKSPACE_TRANSFER_PATH } from "../../worker/node-workspace-transfer-protocol.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER, type AuthRateLimiter } from "../auth-rate-limit.js";
import { classifyNodeWorkspaceTransferPath } from "../gateway-http-route-contracts.js";
import { sendJson, watchClientDisconnect } from "../http-common.js";
import { withSerializedRateLimitAttempt } from "../rate-limit-attempt-serialization.js";
import type {
  NodeWorkspaceTransferHttpCallback,
  NodeWorkspaceTransferHttpRoute,
} from "./node-workspace-transfer-http-contract.js";
import {
  isNodeWorkspaceTransferLimitError,
  nodeWorkspaceTransferInvalidReason,
  type NodeWorkspaceTransferService,
} from "./node-workspace-transfer-service.js";

export type { NodeWorkspaceTransferHttpCallback } from "./node-workspace-transfer-http-contract.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_ENVIRONMENT_ID_LENGTH = 256;
const OPAQUE_NOT_FOUND = { error: "not_found" } as const;

function decodeEnvironmentId(segment: string): string | undefined {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (
    !value ||
    value.length > MAX_ENVIRONMENT_ID_LENGTH ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return undefined;
  }
  return value;
}

function parseNodeWorkspaceTransferHttpRoute(
  pathname: string,
  method: string | undefined,
): NodeWorkspaceTransferHttpRoute | undefined {
  if (!pathname.startsWith(`${NODE_WORKSPACE_TRANSFER_PATH}/`)) {
    return undefined;
  }
  const segments = pathname.slice(NODE_WORKSPACE_TRANSFER_PATH.length + 1).split("/");
  const environmentId = segments[1] ? decodeEnvironmentId(segments[1]) : undefined;
  if (!environmentId) {
    return undefined;
  }
  if (
    method === "GET" &&
    segments.length === 5 &&
    segments[0] === "environments" &&
    segments[2] === "snapshots" &&
    segments[3] !== undefined &&
    SHA256_PATTERN.test(segments[3]) &&
    (segments[4] === "manifest" || segments[4] === "pack")
  ) {
    return {
      kind: segments[4],
      direction: "download",
      environmentId,
      manifestRef: `sha256:${segments[3]}`,
    };
  }
  if (
    method === "GET" &&
    segments.length === 4 &&
    segments[0] === "environments" &&
    segments[2] === "blobs" &&
    segments[3] !== undefined &&
    SHA256_PATTERN.test(segments[3])
  ) {
    return { kind: "blob", direction: "download", environmentId, sha256: segments[3] };
  }
  if (
    method === "POST" &&
    segments.length === 4 &&
    segments[0] === "environments" &&
    segments[2] === "reconciliations" &&
    segments[3] !== undefined &&
    SHA256_PATTERN.test(segments[3])
  ) {
    return {
      kind: "reconcile",
      direction: "upload",
      environmentId,
      baseManifestRef: `sha256:${segments[3]}`,
    };
  }
  return undefined;
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

function sendTransferRateLimited(res: ServerResponse, retryAfterMs: number): void {
  if (retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  }
  sendJson(res, 429, { error: "rate_limited" });
}

type TransferAdmission =
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "unauthorized" }
  | Extract<Awaited<ReturnType<NodeWorkspaceTransferHttpCallback>>, { kind: "authorized" }>;

/** Reserve and authenticate the node workspace transfer namespace before normal HTTP routing. */
export async function handleNodeWorkspaceTransferHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
  callback?: NodeWorkspaceTransferHttpCallback;
}): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  if (!parsed?.pathname || classifyNodeWorkspaceTransferPath(parsed.pathname) === "outside") {
    return false;
  }
  params.res.setHeader("Cache-Control", "no-store");
  const route = parseNodeWorkspaceTransferHttpRoute(parsed.pathname, params.req.method);
  if (!route || parsed.search) {
    sendOpaqueNotFound(params.res);
    return true;
  }
  const bearer = bearerToken(params.req);
  const admission = await withSerializedRateLimitAttempt<TransferAdmission>({
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
          ? await params.callback({ req: params.req, res: params.res, route, bearer })
          : ({ kind: "unauthorized" } as const);
      if (outcome.kind === "unauthorized") {
        params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
        return outcome;
      }
      params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      return outcome;
    },
  });
  if (admission.kind === "rate-limited") {
    sendTransferRateLimited(params.res, admission.retryAfterMs);
    return true;
  }
  if (admission.kind === "unauthorized") {
    sendOpaqueNotFound(params.res);
    return true;
  }
  await admission.handle();
  return true;
}

export function createNodeWorkspaceTransferHttpCallback(
  service: NodeWorkspaceTransferService,
): NodeWorkspaceTransferHttpCallback {
  return async ({ req, res, route, bearer }) => {
    const authorization = service.authorize({ route, token: bearer });
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
          AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        ]);
        const abortRequest = () => {
          if (!req.destroyed) {
            req.destroy(signal.reason instanceof Error ? signal.reason : undefined);
          }
        };
        signal.addEventListener("abort", abortRequest, { once: true });
        const stillCurrent = () => !signal.aborted && service.isAuthorizationCurrent(authorization);
        try {
          if (route.kind === "manifest" || route.kind === "pack") {
            const snapshot = service.snapshot(authorization);
            if (!snapshot) {
              sendOpaqueNotFound(res);
              return;
            }
            if (route.kind === "manifest") {
              const body = Buffer.from(snapshot.rawManifest);
              if (!stillCurrent()) {
                return;
              }
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-length": String(body.byteLength),
              });
              res.end(body);
              return;
            }
            const packPath = await service.pack(authorization);
            if (!packPath) {
              sendOpaqueNotFound(res);
              return;
            }
            const stats = await fsp.stat(packPath);
            if (!stillCurrent()) {
              return;
            }
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": String(stats.size),
            });
            await pipeline(fs.createReadStream(packPath), res, { signal });
            return;
          }
          if (route.kind === "blob") {
            const blob = service.blob(authorization);
            if (
              !blob ||
              !(await service.verifyBlob({
                path: blob.path,
                size: blob.size,
                sha256: blob.sha256,
              }))
            ) {
              sendOpaqueNotFound(res);
              return;
            }
            if (!stillCurrent()) {
              return;
            }
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": String(blob.size),
            });
            await pipeline(fs.createReadStream(blob.path), res, { signal });
            return;
          }
          try {
            const result = await service.receiveUpload({ authorization, request: req, signal });
            if (!stillCurrent()) {
              return;
            }
            const body = Buffer.from(JSON.stringify(result));
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(body.byteLength),
            });
            res.end(body);
          } catch (error) {
            if (signal.aborted || res.destroyed) {
              return;
            }
            const limit = isNodeWorkspaceTransferLimitError(error);
            const reason = nodeWorkspaceTransferInvalidReason(error);
            const body = Buffer.from(
              JSON.stringify({
                error: limit ? "workspace_transfer_limit" : "workspace_transfer_invalid",
                ...(reason ? { reason } : {}),
              }),
            );
            res.writeHead(limit ? 413 : 400, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(body.byteLength),
            });
            res.end(body);
          }
        } catch (error) {
          if (!signal.aborted && !res.destroyed) {
            throw error;
          }
        } finally {
          signal.removeEventListener("abort", abortRequest);
          stopWatchingDisconnect();
        }
      },
    };
  };
}
